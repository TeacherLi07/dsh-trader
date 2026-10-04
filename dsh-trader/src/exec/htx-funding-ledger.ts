/** V5账单读取只证明收到哪些支付记录；持仓归因、留存范围和延迟发布仍由结算层核验。 */
import type { Clock } from '../clock.js'
import { fingerprint } from '../util/canonical.js'

export const HTX_V5_BILLS_DOCUMENTATION = 'https://www.htx.com/oplt/api/open_api/interface/detail?interface_id=8cb89359-77b5-11ed-9966-19b930b8bee'

export interface FundingLedgerScope {
  /** 由签名传输绑定的非密钥账户标识，不能用合约名代替账户身份。 */
  readonly accountId: string
  readonly contractCode: string
  readonly marginMode: 'cross' | 'isolated'
  readonly quoteCurrency: string
}
export interface HtxFundingPayment {
  readonly id: string
  readonly type: '30' | '31'
  readonly currency: string
  readonly contractCode: string
  readonly marginMode: 'cross' | 'isolated'
  readonly createdAt: number
  /** 保留交易所原始现金流；不是已分配给decision的FundingCost。 */
  readonly cashFlowQuote: number
}
export interface HtxFundingLedgerResult {
  readonly scope: FundingLedgerScope
  readonly from: number
  readonly until: number
  readonly retrievedAt: number
  readonly pages: number
  readonly paginationExhausted: true
  readonly payments: readonly HtxFundingPayment[]
  readonly responseHashes: readonly string[]
  readonly evidenceHash: string
  readonly source: string
}
export type HtxV5BillsTransport = (params: Readonly<Record<string, string | number>>) => Promise<unknown>

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}
function decimalId(value: unknown): value is string {
  return typeof value === 'string' && /^[1-9]\d{0,39}$/.test(value)
}
function integerMillis(value: unknown): number | undefined {
  if (typeof value !== 'string' || !/^(0|[1-9]\d*)$/.test(value)) return undefined
  const n = Number(value)
  return Number.isSafeInteger(n) && n >= 0 ? n : undefined
}
function decimalAmount(value: unknown): number | undefined {
  if (typeof value !== 'string' || !/^-?(?:0|[1-9]\d*)(?:\.\d+)?$/.test(value)) return undefined
  const n = Number(value)
  return Number.isFinite(n) ? n : undefined
}
function parsePayment(value: unknown, scope: FundingLedgerScope, from: number, until: number): HtxFundingPayment {
  if (!record(value) || !decimalId(value['id']) || (value['type'] !== '30' && value['type'] !== '31')) {
    throw new Error('HTX资金费账单ID或type无效')
  }
  if (value['contract_code'] !== scope.contractCode || value['margin_mode'] !== scope.marginMode || value['currency'] !== scope.quoteCurrency) {
    throw new Error('HTX资金费账单合约、保证金模式或计价币不匹配')
  }
  const createdAt = integerMillis(value['created_time']), cashFlowQuote = decimalAmount(value['amount'])
  if (createdAt === undefined || createdAt < from || createdAt >= until || cashFlowQuote === undefined) {
    throw new Error('HTX资金费账单时间或金额无效')
  }
  // V5金融记录用有符号现金流；收入/支出与符号冲突时不能靠绝对值修补。
  if ((value['type'] === '30' && cashFlowQuote < 0) || (value['type'] === '31' && cashFlowQuote > 0)) {
    throw new Error('HTX资金费type与现金流方向矛盾')
  }
  return { id: value['id'], type: value['type'], currency: scope.quoteCurrency,
    contractCode: scope.contractCode, marginMode: scope.marginMode, createdAt, cashFlowQuote }
}

export class HtxFundingLedger {
  constructor(
    private readonly transport: HtxV5BillsTransport,
    private readonly clock: Clock,
    private readonly scope: FundingLedgerScope,
    private readonly maximumPages = 100,
    private readonly pageSize = 100,
  ) {
    if (!/^[A-Za-z0-9._:-]{1,128}$/.test(scope.accountId) || !/^[A-Z0-9]+-USDT$/.test(scope.contractCode) ||
        !['cross', 'isolated'].includes(scope.marginMode) || scope.quoteCurrency !== 'USDT' ||
        !Number.isSafeInteger(maximumPages) || maximumPages < 1 ||
        !Number.isSafeInteger(pageSize) || pageSize < 1 || pageSize > 100) {
      throw new Error('HTX资金费账户范围或分页上限无效')
    }
    this.scope = Object.freeze({ ...scope })
  }

  async read(from: number, until: number): Promise<HtxFundingLedgerResult> {
    if (!Number.isSafeInteger(from) || from < 0 || !Number.isSafeInteger(until) || until <= from || until > this.clock.now()) {
      throw new Error('HTX资金费区间必须是已到期的[from, until)')
    }
    const payments: HtxFundingPayment[] = [], responseHashes: string[] = [], seen = new Set<string>()
    let anchor: string | undefined
    for (let page = 1; page <= this.maximumPages; page++) {
      // 实测显式from=0报1067；首次省略，只从已经核验的账单ID推进游标。
      const raw = await this.transport({ contract_code: this.scope.contractCode, margin_mode: this.scope.marginMode,
        type: '30,31', start_time: String(from), end_time: String(until - 1), limit: this.pageSize, direct: 'prev',
        ...(anchor === undefined ? {} : { from: anchor }) })
      if (!record(raw) || raw['code'] !== 200 || !Array.isArray(raw['data']) || raw['data'].length > this.pageSize) {
        throw new Error('HTX资金费响应未确认成功、缺少data或超过页上限')
      }
      responseHashes.push(fingerprint(raw))
      let last = anchor
      for (const row of raw['data']) {
        const item = parsePayment(row, this.scope, from, until)
        if (seen.has(item.id) || (last !== undefined && BigInt(item.id) >= BigInt(last))) {
          throw new Error('HTX资金费游标未严格向旧ID推进或账单重复')
        }
        seen.add(item.id); payments.push(item); last = item.id
      }
      // 短页也可能由服务端分页策略造成；继续直到明确空页，不能用请求limit猜测末页。
      if (raw['data'].length === 0) {
        const result = { scope: this.scope, from, until, retrievedAt: this.clock.now(), pages: page,
          paginationExhausted: true as const, payments, responseHashes, source: HTX_V5_BILLS_DOCUMENTATION }
        return { ...result, evidenceHash: fingerprint(result) }
      }
      if (last === undefined) throw new Error('HTX资金费非空页缺少游标')
      anchor = last
    }
    throw new Error('HTX资金费达到分页上限，不能将截断数据当作完整账单')
  }
}
