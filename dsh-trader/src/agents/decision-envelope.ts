/** R3 的唯一模型裁决工件与确定性资格检查（plan §3.1 / §6）。 */

import type { DecisionContext } from './decision-context.js'
import { computeSize, stopPriceFor } from '../exec/sizing.js'
import { createDslContext, referencedPaths } from '../plan/evaluate.js'
import { compileExpression, type Primitive } from '../plan/dsl.js'
import {
  ACTION_KINDS,
  computeContentHash,
  TIMEFRAMES,
  validatePlanAction,
  validatePlanCard,
  type ActionKind,
  type Commitment,
  type Invalidation,
  type OpenAction,
  type PlanAction,
  type PlanCard,
} from '../plan/schema.js'
import { fingerprint } from '../util/canonical.js'

export type ClaimKind = 'observation' | 'inference' | 'assumption'

export interface EvidenceClaim {
  readonly kind: ClaimKind
  readonly statement: string
  readonly evidencePaths: readonly string[]
}

export interface DecisionPlanDraft {
  readonly thesis: string
  readonly confidence: number
  readonly keyLevels: PlanCard['keyLevels']
  readonly invalidation: readonly Invalidation[]
  readonly commitments: readonly Commitment[]
  readonly forbidden: readonly ActionKind[]
  readonly noTrade: boolean
}

export interface CritiqueIssue {
  readonly critiqueId: string
  readonly severity: 'P0' | 'P1' | 'P2'
  readonly statement: string
  readonly evidencePaths: readonly string[]
}

export interface CritiqueResponse {
  readonly critiqueId: string
  readonly disposition: 'accept' | 'reject'
  readonly reason: string
}

/** 模型不得设置 runId/contextHash/symbol；这些身份全部由代码绑定。 */
export interface DecisionEnvelopeCandidate {
  readonly outcome: 'act' | 'no_trade' | 'review'
  readonly thesis: string
  readonly rejectedAlternatives: readonly string[]
  readonly claims: readonly EvidenceClaim[]
  readonly uncertainties: readonly string[]
  readonly confidence: number
  readonly riskFraction: number
  readonly immediateAction?: PlanAction
  readonly plan?: DecisionPlanDraft
  readonly critiqueResponses?: readonly CritiqueResponse[]
}

export interface DecisionEnvelope extends DecisionEnvelopeCandidate {
  readonly runId: string
  readonly contextHash: string
  readonly symbol: string
  readonly primaryTimeframe: '1h'
}

export type EligibilityState = 'risk_gate_required' | 'decision_only'

export interface EligibilityResult {
  readonly state: EligibilityState
  readonly reasons: readonly string[]
  readonly validatedEvidencePaths: readonly string[]
}

export type DecisionEnvelopeParseResult =
  | { readonly ok: true; readonly candidate: DecisionEnvelopeCandidate; readonly evidenceIssues: readonly string[] }
  | { readonly ok: false; readonly errors: readonly string[] }

const ACTION_SCHEMA = {
  oneOf: [
    { type: 'object', additionalProperties: false, properties: { action: { const: 'noop' } }, required: ['action'] },
    { type: 'object', additionalProperties: false, properties: { action: { const: 'close' } }, required: ['action'] },
    { type: 'object', additionalProperties: false, properties: {
      action: { const: 'open' }, side: { enum: ['long', 'short'] }, method: { enum: ['market', 'limit'] },
      limitOffsetBps: { type: 'number', minimum: 0 },
      stop: { oneOf: [
        { type: 'object', additionalProperties: false, properties: { method: { const: 'atr' }, k: { type: 'number', exclusiveMinimum: 0 } }, required: ['method', 'k'] },
        { type: 'object', additionalProperties: false, properties: { method: { const: 'structure' }, level: { type: 'number', exclusiveMinimum: 0 } }, required: ['method', 'level'] },
      ] },
      target: { type: 'object', additionalProperties: false, properties: { rMultiple: { type: 'number', exclusiveMinimum: 0 } }, required: ['rMultiple'] },
    }, required: ['action', 'side', 'method', 'stop'] },
    { type: 'object', additionalProperties: false, properties: {
      action: { const: 'reduce' }, fraction: { type: 'number', exclusiveMinimum: 0, exclusiveMaximum: 1 }, method: { enum: ['market', 'limit'] },
    }, required: ['action', 'fraction'] },
    { type: 'object', additionalProperties: false, properties: { action: { const: 'set_stop' }, price: { type: 'number', exclusiveMinimum: 0 } }, required: ['action', 'price'] },
    { type: 'object', additionalProperties: false, properties: { action: { const: 'set_target' }, price: { type: 'number', exclusiveMinimum: 0 } }, required: ['action', 'price'] },
    { type: 'object', additionalProperties: false, properties: { action: { const: 'set_trailing' }, percent: { type: 'number', exclusiveMinimum: 0 } }, required: ['action', 'percent'] },
    { type: 'object', additionalProperties: false, properties: { action: { const: 'cancel_all' }, scope: { enum: ['symbol', 'all'] } }, required: ['action', 'scope'] },
    { type: 'object', additionalProperties: false, properties: { action: { const: 'halt' }, reason: { type: 'string' } }, required: ['action'] },
    { type: 'object', additionalProperties: false, properties: { action: { const: 'escalate' }, reason: { type: 'string', minLength: 1 } }, required: ['action', 'reason'] },
  ],
} as const

export const DECISION_ENVELOPE_TOOL = {
  name: 'submit_decision_envelope',
  description: '提交本轮唯一的类型化裁决；证据引用必须使用冻结 DecisionContext 的 JSON Pointer。',
  parameters: {
    type: 'object',
    additionalProperties: false,
    properties: {
      outcome: { enum: ['act', 'no_trade', 'review'] },
      thesis: { type: 'string', minLength: 1, maxLength: 8_000 },
      rejectedAlternatives: { type: 'array', items: { type: 'string', maxLength: 2_000 }, maxItems: 20 },
      claims: { type: 'array', maxItems: 40, items: {
        type: 'object', additionalProperties: false,
        properties: {
          kind: { enum: ['observation', 'inference', 'assumption'] },
          statement: { type: 'string', minLength: 1, maxLength: 2_000 },
          evidencePaths: { type: 'array', items: { type: 'string', minLength: 1 }, maxItems: 20 },
        }, required: ['kind', 'statement', 'evidencePaths'],
      } },
      uncertainties: { type: 'array', items: { type: 'string', maxLength: 2_000 }, maxItems: 40 },
      confidence: { type: 'number', minimum: 0, maximum: 1 },
      riskFraction: { type: 'number', exclusiveMinimum: 0, maximum: 1 },
      immediateAction: ACTION_SCHEMA,
      plan: { type: 'object', additionalProperties: false, properties: {
        thesis: { type: 'string', minLength: 1, maxLength: 8_000 },
        confidence: { type: 'number', minimum: 0, maximum: 1 },
        keyLevels: { type: 'array', items: { type: 'object', additionalProperties: false,
          properties: { kind: { enum: ['support', 'resistance', 'pivot'] }, price: { type: 'number', exclusiveMinimum: 0 } },
          required: ['kind', 'price'],
        }, maxItems: 32 },
        invalidation: { type: 'array', maxItems: 32, items: { type: 'object', additionalProperties: false,
          properties: { id: { type: 'string', minLength: 1 }, tf: { enum: TIMEFRAMES }, when: { type: 'string', minLength: 1 }, then: ACTION_SCHEMA },
          required: ['id', 'tf', 'when', 'then'],
        } },
        commitments: { type: 'array', maxItems: 64, items: { type: 'object', additionalProperties: false,
          properties: {
            id: { type: 'string', minLength: 1 }, seq: { type: 'integer', minimum: 0 }, tf: { enum: TIMEFRAMES },
            when: { type: 'string', minLength: 1 }, then: ACTION_SCHEMA,
            maxSlippageBps: { type: 'number', exclusiveMinimum: 0 }, cooldownMs: { type: 'integer', minimum: 0 },
          }, required: ['id', 'seq', 'tf', 'when', 'then'],
        } },
        forbidden: { type: 'array', uniqueItems: true, items: { enum: ACTION_KINDS } },
        noTrade: { type: 'boolean' },
      }, required: ['thesis', 'confidence', 'keyLevels', 'invalidation', 'commitments', 'forbidden', 'noTrade'] },
      critiqueResponses: { type: 'array', maxItems: 40, items: { type: 'object', additionalProperties: false,
        properties: { critiqueId: { type: 'string', minLength: 1 }, disposition: { enum: ['accept', 'reject'] }, reason: { type: 'string', minLength: 1, maxLength: 2_000 } },
        required: ['critiqueId', 'disposition', 'reason'],
      } },
    },
    required: ['outcome', 'thesis', 'rejectedAlternatives', 'claims', 'uncertainties', 'confidence', 'riskFraction'],
  },
} as const

/** 工具名、说明或 schema 任一变化都不得复用旧 terminal run。 */
export const DECISION_ENVELOPE_SCHEMA_VERSION = fingerprint(DECISION_ENVELOPE_TOOL)

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function recordAt(root: unknown, ...keys: readonly string[]): Record<string, unknown> | undefined {
  let value = root
  for (const key of keys) {
    if (!isRecord(value)) return undefined
    value = value[key]
  }
  return isRecord(value) ? value : undefined
}

function visibleDslBar(
  context: DecisionContext,
  timeframe: string,
  previous: boolean,
): Record<string, unknown> | undefined {
  const slice = recordAt(context.sections.market.value, 'timeframes', timeframe)
  const bars = slice?.['bars']
  if (!Array.isArray(bars) || slice?.['status'] === 'stale') return undefined
  const index = bars.length - (previous ? 2 : 1)
  const selected = bars[index]
  if (!isRecord(selected)) return undefined
  const openTime = finiteNumber(selected['openTime'])
  const closeTime = finiteNumber(selected['closeTime'])
  const availableAt = finiteNumber(selected['availableAt'])
  if (openTime === undefined || closeTime === undefined || availableAt === undefined ||
      !Number.isSafeInteger(openTime) || !Number.isSafeInteger(closeTime) || !Number.isSafeInteger(availableAt) ||
      openTime >= closeTime || closeTime > context.asOf || availableAt < closeTime || availableAt > context.asOf) return undefined
  if (previous) {
    const current = bars.at(-1)
    if (!isRecord(current)) return undefined
    const currentOpenTime = finiteNumber(current['openTime'])
    if (currentOpenTime === undefined || currentOpenTime !== closeTime) return undefined
  }
  return selected
}

function availableFeature(
  context: DecisionContext,
  timeframe: string,
  key: string,
  previous = false,
): Primitive | undefined {
  const feature = recordAt(context.sections.market.value, 'timeframes', timeframe, 'features', key)
  const fact = previous && feature !== undefined && isRecord(feature['previous'])
    ? feature['previous'] : previous ? undefined : feature
  const expectedBar = visibleDslBar(context, timeframe, previous)
  if (fact === undefined || fact['status'] !== 'ok' || expectedBar === undefined) return undefined
  const value = fact['value']
  if (typeof value !== 'boolean' && (typeof value !== 'number' || !Number.isFinite(value))) return undefined
  const asOf = finiteNumber(fact['asOf'])
  const availableAt = finiteNumber(fact['availableAt'])
  const expectedEventTime = finiteNumber(expectedBar['closeTime'])
  if (asOf === undefined || availableAt === undefined || expectedEventTime === undefined ||
      asOf !== expectedEventTime || availableAt < asOf || availableAt > context.asOf) return undefined
  return value
}

function availableBarValue(
  context: DecisionContext,
  timeframe: string,
  key: string,
  previous = false,
): Primitive | undefined {
  const bar = visibleDslBar(context, timeframe, previous)
  if (bar === undefined) return undefined
  const value = bar[key]
  return typeof value === 'boolean' || (typeof value === 'number' && Number.isFinite(value)) ? value : undefined
}

function decisionDslPathValue(context: DecisionContext, timeframe: string, path: string, previous = false): Primitive | undefined {
  const barPaths: Readonly<Record<string, string>> = {
    'bar.open': 'open', 'bar.high': 'high', 'bar.low': 'low', 'bar.close': 'close', 'bar.volume': 'volume',
  }
  const barKey = barPaths[path]
  if (barKey !== undefined) return availableBarValue(context, timeframe, barKey, previous)
  if (path === 'price.last') return availableBarValue(context, timeframe, 'close', previous)

  const featurePaths: Readonly<Record<string, string>> = {
    ema20: 'ema20', ema50: 'ema50', rsi14: 'rsi14', atr14: 'atr14', adx14: 'adx14',
    vwap20: 'vwap20', zscore20: 'zscore20', volRealized20: 'volRealized20',
    'funding.rate': 'fundingRate', 'oi.changePct': 'oiChangePct',
    'liq.notional': 'liqNotional', 'basis.bps': 'basisBps',
  }
  const featureKey = featurePaths[path]
  if (featureKey !== undefined) return availableFeature(context, timeframe, featureKey, previous)
  if (previous) return undefined

  if (path === 'equity.quote' || path.startsWith('position.')) {
    const portfolio = context.sections.portfolio.value
    if (!isRecord(portfolio)) return undefined
    const missing = context.sections.portfolio.missing
    if ((finiteNumber(portfolio['hiddenPositionCount']) ?? 0) > 0 ||
        (finiteNumber(portfolio['hiddenOpenOrderCount']) ?? 0) > 0 ||
        portfolio['positionsReadErrorType'] !== null || portfolio['openOrdersReadErrorType'] !== null) return undefined
    if (missing.some((item) => item.startsWith('account.') || item.startsWith('positions.') || item.startsWith('openOrders.'))) return undefined
    const account = isRecord(portfolio['account']) ? portfolio['account'] : undefined
    if (account === undefined) return undefined
    if (path === 'equity.quote') return finiteNumber(account['equityQuote'])
    const positions = portfolio['positions']
    if (!Array.isArray(positions)) return undefined
    const position = positions.find((item) => isRecord(item) && item['symbol'] === context.symbol)
    if (position === undefined) {
      if (path === 'position.qty' || path === 'position.avgPrice' || path === 'position.unrealizedPnl') return 0
      return undefined
    }
    if (!isRecord(position)) return undefined
    if (path === 'position.qty') return finiteNumber(position['qty'])
    if (path === 'position.avgPrice') return finiteNumber(position['avgPrice'])
    if (path === 'position.unrealizedPnl') return finiteNumber(position['unrealizedPnlUsd'])
    return undefined
  }
  if (path === 'plan.ageMs' || path === 'window.sinceMs') return 0

  const pmMatch = /^pm\.([a-z][a-z0-9_]{0,40})\.(prob|mid|spread|volume24h|change1h|change24h|ageMs)$/.exec(path)
  if (pmMatch !== null) {
    const metric = pmMatch[2]
    if (metric === undefined) return undefined
    const predictions = context.sections.predictions.value
    if (!isRecord(predictions) || predictions['state'] !== 'available' || !Array.isArray(predictions['items'])) return undefined
    const item = predictions['items'].find((candidate) => isRecord(candidate) && candidate['alias'] === pmMatch[1])
    if (!isRecord(item)) return undefined
    const observedAt = finiteNumber(item['quoteObservedAt'])
    const ageMs = finiteNumber(item['ageMs'])
    const config = recordAt(context.sections.mandate.value, 'contextConfig')
    const maxAge = finiteNumber(config?.['marketGraceMs'])
    if (observedAt === undefined || observedAt > context.asOf || ageMs === undefined || maxAge === undefined || ageMs > maxAge) return undefined
    if (metric === 'prob') {
      const probability = item['probability']
      return isRecord(probability) && probability['status'] === 'ok' ? finiteNumber(probability['value']) : undefined
    }
    return finiteNumber(metric === 'ageMs' ? item['ageMs'] : item[metric])
  }
  return undefined
}

function openPlanDependencyIssues(context: DecisionContext, envelope: DecisionEnvelopeCandidate): string[] {
  const conditions = [
    ...(envelope.plan?.commitments ?? []).filter((item) => actionHasOpen(item.then)),
    ...(envelope.plan?.invalidation ?? []).filter((item) => actionHasOpen(item.then)),
  ]
  const issues: string[] = []
  for (const condition of conditions) {
    const label = `plan.${condition.id}`
    try {
      const compiled = compileExpression(condition.when)
      const runtime = recordAt(context.sections.mandate.value, 'runtime')
      const configuredTimeframes = runtime?.['timeframes']
      if (Array.isArray(configuredTimeframes) && !configuredTimeframes.includes(condition.tf)) {
        issues.push(`${label} timeframe 未配置：${condition.tf}`)
      }
      const paths = referencedPaths(condition.when)
      const values: Record<string, Primitive> = {}
      for (const path of paths) {
        const value = decisionDslPathValue(context, condition.tf, path)
        if (value === undefined) {
          issues.push(`${label} DSL 依赖缺失/过期/未知：${path}`)
        } else {
          values[path] = value
        }
      }
      const previousValues: Record<string, Primitive> = {}
      const requiresPrevious = /\bcross(?:Above|Below)\s*\(/.test(condition.when)
      for (const path of paths) {
        const value = decisionDslPathValue(context, condition.tf, path, true)
        if (value !== undefined) previousValues[path] = value
        else if (requiresPrevious) issues.push(`${label} DSL 前值缺失/过期/未对齐：${path}`)
      }
      const evaluated = compiled(createDslContext(values, undefined, previousValues))
      if (!evaluated.ok) issues.push(`${label} DSL 当前不可求值：${evaluated.reason}`)
    } catch (error) {
      issues.push(`${label} DSL 编译失败：${error instanceof Error ? error.message : String(error)}`)
    }
  }
  return issues
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string')
}

function hasOnlyKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  return Object.keys(value).every((key) => allowed.includes(key))
}

function pointerValue(root: unknown, pointer: string): unknown {
  if (!pointer.startsWith('/')) return undefined
  const parts = pointer.slice(1).split('/').map((part) => part.replaceAll('~1', '/').replaceAll('~0', '~'))
  let cursor: unknown = root
  for (const part of parts) {
    if (part === '__proto__' || part === 'prototype' || part === 'constructor') return undefined
    if (Array.isArray(cursor) && /^(0|[1-9]\d*)$/.test(part)) cursor = cursor[Number(part)]
    else if (isRecord(cursor) && Object.prototype.hasOwnProperty.call(cursor, part)) cursor = cursor[part]
    else return undefined
  }
  return cursor
}

function evidenceValueAvailable(value: unknown): boolean {
  if (value === null || value === undefined) return false
  if (typeof value === 'number') return Number.isFinite(value)
  if (Array.isArray(value) || isRecord(value)) {
    if (isRecord(value) && typeof value['status'] === 'string' && value['status'] !== 'ok') return false
    if (isRecord(value) && Object.prototype.hasOwnProperty.call(value, 'value') && value['value'] === null) return false
    return false // 引用必须落到一个事实叶子，而不是把整个 context 分区当作证据。
  }
  return true
}

function actionHasOpen(action: unknown): action is OpenAction {
  return isRecord(action) && action['action'] === 'open'
}

export function parseDecisionEnvelopeCandidate(value: unknown, context: DecisionContext): DecisionEnvelopeParseResult {
  if (!isRecord(value)) return { ok: false, errors: ['envelope 必须是对象'] }
  const allowed = ['outcome', 'thesis', 'rejectedAlternatives', 'claims', 'uncertainties', 'confidence', 'riskFraction', 'immediateAction', 'plan', 'critiqueResponses']
  const errors: string[] = []
  if (!hasOnlyKeys(value, allowed)) errors.push('envelope 包含未授权字段')
  if (!['act', 'no_trade', 'review'].includes(String(value['outcome']))) errors.push('outcome 非法')
  if (typeof value['thesis'] !== 'string' || value['thesis'].trim() === '' || value['thesis'].length > 8_000) errors.push('thesis 无效')
  if (!isStringArray(value['rejectedAlternatives']) || value['rejectedAlternatives'].length > 20) errors.push('rejectedAlternatives 无效')
  if (!isStringArray(value['uncertainties']) || value['uncertainties'].length > 40) errors.push('uncertainties 无效')
  if (typeof value['confidence'] !== 'number' || !Number.isFinite(value['confidence']) || value['confidence'] < 0 || value['confidence'] > 1) errors.push('confidence 必须在 [0,1] 内')
  if (typeof value['riskFraction'] !== 'number' || !Number.isFinite(value['riskFraction']) || value['riskFraction'] <= 0 || value['riskFraction'] > 1) errors.push('riskFraction 必须在 (0,1] 内')

  const actions: unknown[] = []
  if (value['immediateAction'] !== undefined) actions.push(value['immediateAction'])
  let plan: DecisionPlanDraft | undefined
  if (value['plan'] !== undefined) {
    if (!isRecord(value['plan']) || !hasOnlyKeys(value['plan'], ['thesis', 'confidence', 'keyLevels', 'invalidation', 'commitments', 'forbidden', 'noTrade'])) {
      errors.push('plan draft 形状非法')
    } else {
      const draft = value['plan']
      if (typeof draft['thesis'] !== 'string' || draft['thesis'].trim() === '') errors.push('plan.thesis 无效')
      if (typeof draft['confidence'] !== 'number' || !Number.isFinite(draft['confidence']) || draft['confidence'] < 0 || draft['confidence'] > 1) errors.push('plan.confidence 无效')
      if (!Array.isArray(draft['keyLevels']) || !Array.isArray(draft['invalidation']) || !Array.isArray(draft['commitments']) || !Array.isArray(draft['forbidden']) || typeof draft['noTrade'] !== 'boolean') errors.push('plan 缺少必要字段')
      else {
        for (const [index, item] of [...draft['invalidation'], ...draft['commitments']].entries()) {
          if (!isRecord(item)) { errors.push(`plan.conditions[${index}] 无效`); continue }
          actions.push(item['then'])
        }
        plan = draft as unknown as DecisionPlanDraft
      }
    }
  }
  for (const [index, action] of actions.entries()) {
    if (isRecord(action) && Object.prototype.hasOwnProperty.call(action, 'riskFraction')) {
      errors.push(`actions[${index}] 不得设置独立风险比例，使用 envelope.riskFraction`)
    }
    const actionErrors = validatePlanAction(action)
    errors.push(...actionErrors.map((error) => `actions[${index}].${error}`))
  }
  if (value['immediateAction'] !== undefined && validatePlanAction(value['immediateAction']).length > 0) errors.push('immediateAction 结构非法')

  let critiqueResponses: readonly CritiqueResponse[] | undefined
  if (value['critiqueResponses'] !== undefined) {
    if (!Array.isArray(value['critiqueResponses']) || value['critiqueResponses'].some((item) =>
      !isRecord(item) || !hasOnlyKeys(item, ['critiqueId', 'disposition', 'reason']) ||
      typeof item['critiqueId'] !== 'string' || item['critiqueId'].trim() === '' ||
      (item['disposition'] !== 'accept' && item['disposition'] !== 'reject') ||
      typeof item['reason'] !== 'string' || item['reason'].trim() === '',
    )) errors.push('critiqueResponses 形状非法')
    else critiqueResponses = value['critiqueResponses'] as CritiqueResponse[]
  }

  if (value['outcome'] !== 'act' && (actionHasOpen(value['immediateAction']) ||
      plan?.commitments.some((commitment) => isRecord(commitment) && actionHasOpen(commitment['then'])) === true)) {
    errors.push('no_trade/review 不得携带开仓动作')
  }
  if (value['outcome'] !== 'act' && plan !== undefined && plan.noTrade !== true) {
    errors.push('no_trade/review 的 plan 必须明确 noTrade=true')
  }
  if (plan?.noTrade === true && (actionHasOpen(value['immediateAction']) ||
      plan.commitments.some((commitment) => isRecord(commitment) && actionHasOpen(commitment['then'])))) {
    errors.push('noTrade plan 不得包含开仓动作')
  }
  if (plan?.invalidation.some((item) => isRecord(item) && actionHasOpen(item['then'])) === true) {
    errors.push('invalidation 失效条件不得增加敞口')
  }
  if (actionHasOpen(value['immediateAction']) &&
      plan?.commitments.some((commitment) => isRecord(commitment) && actionHasOpen(commitment['then'])) === true) {
    errors.push('同一 envelope 不得同时即时开仓并承诺开仓')
  }
  if (value['outcome'] === 'act' && value['immediateAction'] === undefined && plan === undefined) errors.push('act 必须包含 immediateAction 或 plan')
  if (errors.length > 0) return { ok: false, errors }

  const claims = value['claims']
  if (!Array.isArray(claims)) return { ok: false, errors: ['claims 必须是数组'] }
  const evidenceIssues: string[] = []
  for (const [index, claim] of claims.entries()) {
    if (!isRecord(claim) || !hasOnlyKeys(claim, ['kind', 'statement', 'evidencePaths']) ||
        !['observation', 'inference', 'assumption'].includes(String(claim['kind'])) ||
        typeof claim['statement'] !== 'string' || claim['statement'].trim() === '' || !isStringArray(claim['evidencePaths'])) {
      return { ok: false, errors: [`claims[${index}] 形状非法`] }
    }
    if ((claim['kind'] === 'observation' || claim['kind'] === 'inference') && claim['evidencePaths'].length === 0) {
      evidenceIssues.push(`claims[${index}] 缺少证据路径`)
    }
    for (const path of claim['evidencePaths']) {
      const referenced = pointerValue(context, path)
      if (!evidenceValueAvailable(referenced)) evidenceIssues.push(`claims[${index}] 引用缺失/过期/非叶子事实：${path}`)
    }
  }

  const candidate: DecisionEnvelopeCandidate = {
    outcome: value['outcome'] as DecisionEnvelopeCandidate['outcome'],
    thesis: value['thesis'] as string,
    rejectedAlternatives: value['rejectedAlternatives'] as string[],
    claims: claims as EvidenceClaim[],
    uncertainties: value['uncertainties'] as string[],
    confidence: value['confidence'] as number,
    riskFraction: value['riskFraction'] as number,
    ...(value['immediateAction'] === undefined ? {} : { immediateAction: value['immediateAction'] as PlanAction }),
    ...(plan === undefined ? {} : { plan }),
    ...(critiqueResponses === undefined ? {} : { critiqueResponses }),
  }
  return { ok: true, candidate, evidenceIssues }
}

export function bindDecisionEnvelope(
  candidate: DecisionEnvelopeCandidate,
  input: { readonly runId: string; readonly context: DecisionContext },
): DecisionEnvelope {
  return {
    ...candidate,
    runId: input.runId,
    contextHash: input.context.contextHash,
    symbol: input.context.symbol,
    primaryTimeframe: input.context.primaryTimeframe,
  }
}

export function evaluateDecisionEligibility(
  context: DecisionContext,
  envelope: DecisionEnvelopeCandidate,
  evidenceIssues: readonly string[],
  options: { readonly predictionEvent?: boolean } = {},
): EligibilityResult {
  const reasons = [...evidenceIssues]
  if (envelope.outcome !== 'act') return { state: 'decision_only', reasons, validatedEvidencePaths: [] }
  const openActions = [
    ...(actionHasOpen(envelope.immediateAction) ? [envelope.immediateAction] : []),
    ...(envelope.plan?.commitments.flatMap((item) => actionHasOpen(item.then) ? [item.then] : []) ?? []),
    ...(envelope.plan?.invalidation.flatMap((item) => actionHasOpen(item.then) ? [item.then] : []) ?? []),
  ]
  if (openActions.length === 0) return { state: 'decision_only', reasons, validatedEvidencePaths: [] }
  reasons.push(...openPlanDependencyIssues(context, envelope))

  const portfolio = isRecord(context.sections.portfolio.value) ? context.sections.portfolio.value : undefined
  const account = portfolio !== undefined && isRecord(portfolio['account']) ? portfolio['account'] : undefined
  const reconciliation = portfolio !== undefined && isRecord(portfolio['reconciliation']) ? portfolio['reconciliation'] : undefined
  const mandate = isRecord(context.sections.mandate.value) ? context.sections.mandate.value : undefined
  const specification = mandate !== undefined && isRecord(mandate['contractSpecification']) && isRecord(mandate['contractSpecification']['value'])
    ? mandate['contractSpecification']['value']
    : undefined
  const market = isRecord(context.sections.market.value) ? context.sections.market.value : undefined
  const timeframes = market !== undefined && isRecord(market['timeframes']) ? market['timeframes'] : undefined
  const primaryMarket = timeframes !== undefined && isRecord(timeframes['1h']) ? timeframes['1h'] : undefined
  const features = primaryMarket !== undefined && isRecord(primaryMarket['features']) ? primaryMarket['features'] : undefined
  const close = features !== undefined && isRecord(features['close']) ? features['close'] : undefined
  const runtime = mandate !== undefined && isRecord(mandate['runtime']) ? mandate['runtime'] : undefined
  const limits = runtime !== undefined && isRecord(runtime['limits']) ? runtime['limits'] : undefined
  const remainingLimits = portfolio !== undefined && isRecord(portfolio['remainingLimits']) ? portfolio['remainingLimits'] : undefined
  const now = context.asOf
  const predictions = context.sections.predictions.value
  const config = mandate !== undefined && isRecord(mandate['contextConfig']) ? mandate['contextConfig'] : undefined
  const maxAccountAgeMs = config !== undefined && typeof config['accountMaxAgeMs'] === 'number' ? config['accountMaxAgeMs'] : 0
  const maxSpecAgeMs = config !== undefined && typeof config['specMaxAgeMs'] === 'number' ? config['specMaxAgeMs'] : 0

  if (portfolio !== undefined) {
    if ((finiteNumber(portfolio['hiddenPositionCount']) ?? 0) > 0) reasons.push('portfolio contains hidden position snapshots')
    if ((finiteNumber(portfolio['hiddenOpenOrderCount']) ?? 0) > 0) reasons.push('portfolio contains hidden open-order snapshots')
    for (const [kind, field] of [['position', 'positions'], ['open order', 'openOrders']] as const) {
      const rows = portfolio[field]
      if (!Array.isArray(rows)) continue
      for (const [index, item] of rows.entries()) {
        if (!isRecord(item)) {
          reasons.push(`portfolio ${kind}[${index}] snapshot invalid`)
          continue
        }
        const observedAt = finiteNumber(item['observedAt'])
        if (observedAt === undefined) reasons.push(`portfolio ${kind}[${index}] observedAt missing/invalid`)
        else if (observedAt > now) reasons.push(`portfolio ${kind}[${index}] observedAt is in the future`)
        else if (now - observedAt > maxAccountAgeMs) reasons.push(`portfolio ${kind}[${index}] snapshot stale`)
      }
    }
  }

  if (account === undefined || !Number.isFinite(account['equityQuote']) || Number(account['equityQuote']) <= 0) reasons.push('portfolio.account.equityQuote unavailable')
  if (account === undefined || !Number.isFinite(account['pendingExposureUsd']) || Number(account['pendingExposureUsd']) < 0) reasons.push('portfolio.account.pendingExposureUsd unavailable')
  if (account === undefined || !Number.isFinite(account['observedAt']) || now - Number(account['observedAt']) > maxAccountAgeMs) reasons.push('portfolio.account stale')
  if (runtime?.['mode'] === 'live_auto' && (account === undefined || !Number.isFinite(account['freeMarginQuote']))) reasons.push('portfolio.account.freeMarginQuote unavailable')
  if (portfolio === undefined || portfolio['positionsReadErrorType'] !== null || portfolio['openOrdersReadErrorType'] !== null) reasons.push('portfolio positions/orders read incomplete')
  if (portfolio === undefined || portfolio['unresolvedIntentsTruncated'] !== false) reasons.push('unresolved intents truncated or unknown')
  if (portfolio !== undefined && Array.isArray(portfolio['unresolvedIntents']) &&
      portfolio['unresolvedIntents'].some((item) => isRecord(item) && item['state'] === 'unknown')) reasons.push('unresolved order intent is unknown')
  if (portfolio === undefined || !Array.isArray(portfolio['frozenSymbols']) || portfolio['frozenSymbols'].length > 0) reasons.push('portfolio frozen')
  if (portfolio === undefined || portfolio['halted'] !== false) reasons.push('portfolio halted or unknown')
  if (reconciliation === undefined || reconciliation['state'] !== 'consistent' || reconciliation['freezeTrading'] !== false) reasons.push('reconciliation not fresh and consistent')
  if (primaryMarket === undefined || close === undefined || close['status'] !== 'ok') reasons.push('primary market price unavailable')
  if (specification === undefined || specification['linear'] !== true ||
      !Number.isFinite(specification['contractSize']) || Number(specification['contractSize']) <= 0 ||
      !Number.isFinite(specification['amountStepContracts']) || Number(specification['amountStepContracts']) <= 0) reasons.push('linear market specification unavailable')
  if (specification === undefined || !Number.isFinite(specification['priceStep']) || Number(specification['priceStep']) <= 0 ||
      !Number.isFinite(specification['minAmountContracts']) || Number(specification['minAmountContracts']) <= 0 ||
      !Number.isFinite(specification['minNotionalQuote']) || Number(specification['minNotionalQuote']) < 0) {
    reasons.push('market minimum order specification unavailable')
  }
  if (mandate !== undefined && isRecord(mandate['contractSpecification']) && isRecord(mandate['contractSpecification']['observation'])) {
    const specTime = mandate['contractSpecification']['observation']['eventTime']
    if (!Number.isFinite(specTime) || now - Number(specTime) > maxSpecAgeMs) reasons.push('linear market specification stale')
  } else reasons.push('linear market specification timestamp unavailable')
  if (limits === undefined || !Number.isFinite(limits['perOrderCapUsd']) || !Number.isFinite(limits['maxExposureUsd'])) reasons.push('risk limits unavailable')
  if (remainingLimits === undefined || !Number.isFinite(remainingLimits['exposureUsd']) || Number(remainingLimits['exposureUsd']) <= 0) reasons.push('remaining exposure limit unavailable')
  if (portfolio !== undefined && Array.isArray(portfolio['protectionStatus']) &&
      portfolio['protectionStatus'].some((item) => isRecord(item) && item['state'] !== 'flat' && item['state'] !== 'reported')) {
    reasons.push('existing position protection missing')
  }
  if (options.predictionEvent === true || (isRecord(predictions) && predictions['state'] === 'available')) {
    // 证据指针只能证明某个价格被引用，不能证明它在语义上独立支持方向。
    // R5 尚未验收可复算的场内信号门槛前，PM W3 只允许复核/减险，不授权新增敞口。
    reasons.push('PM W3 事件尚无经验证的独立场内开仓门槛；该触发只允许复核或减险')
  }
  const atrPlanOpen = envelope.plan?.commitments.some((item) => actionHasOpen(item.then) && item.then.stop.method === 'atr') === true
  const atrInvalidationOpen = envelope.plan?.invalidation.some((item) => actionHasOpen(item.then) && item.then.stop.method === 'atr') === true
  const atrImmediateOpen = actionHasOpen(envelope.immediateAction) && envelope.immediateAction.stop.method === 'atr'
  if ((atrPlanOpen || atrInvalidationOpen || atrImmediateOpen) &&
      (features?.['atr14'] === undefined || !isRecord(features['atr14']) || features['atr14']['status'] !== 'ok')) reasons.push('ATR stop dependency unavailable')

  // eligibility 必须复算实际定仓并应用交易所张数步进；仅有 contractSize/step 但没有最小量规格，
  // 会把必然被交易所拒绝的微型订单误标成可开仓。ccxt 的 amount 是张数，内部执行数量则是基础币。
  const entryPrice = close !== undefined && close['status'] === 'ok' && typeof close['value'] === 'number'
    ? close['value']
    : Number.NaN
  const equityQuote = account !== undefined && typeof account['equityQuote'] === 'number'
    ? account['equityQuote']
    : Number.NaN
  const riskPct = runtime !== undefined && typeof runtime['riskPct'] === 'number' ? runtime['riskPct'] : Number.NaN
  const contractSize = specification !== undefined && typeof specification['contractSize'] === 'number'
    ? specification['contractSize']
    : Number.NaN
  const amountStepContracts = specification !== undefined && typeof specification['amountStepContracts'] === 'number'
    ? specification['amountStepContracts']
    : Number.NaN
  const minAmountContracts = specification !== undefined && typeof specification['minAmountContracts'] === 'number'
    ? specification['minAmountContracts']
    : Number.NaN
  const minNotionalQuote = specification !== undefined && typeof specification['minNotionalQuote'] === 'number'
    ? specification['minNotionalQuote']
    : Number.NaN
  const perOrderCapUsd = limits !== undefined && typeof limits['perOrderCapUsd'] === 'number'
    ? limits['perOrderCapUsd']
    : Number.NaN
  const remainingExposureUsd = remainingLimits !== undefined && typeof remainingLimits['exposureUsd'] === 'number'
    ? remainingLimits['exposureUsd']
    : Number.NaN
  const atr = features !== undefined && isRecord(features['atr14']) && features['atr14']['status'] === 'ok' &&
    typeof features['atr14']['value'] === 'number' ? features['atr14']['value'] : null
  const sizingInputsAvailable = Number.isFinite(entryPrice) && entryPrice > 0 &&
    Number.isFinite(equityQuote) && equityQuote > 0 && Number.isFinite(riskPct) && riskPct > 0 &&
    Number.isFinite(contractSize) && contractSize > 0 && Number.isFinite(amountStepContracts) && amountStepContracts > 0 &&
    Number.isFinite(minAmountContracts) && minAmountContracts > 0 &&
    Number.isFinite(minNotionalQuote) && minNotionalQuote >= 0 &&
    Number.isFinite(perOrderCapUsd) && perOrderCapUsd > 0 &&
    Number.isFinite(remainingExposureUsd) && remainingExposureUsd > 0
  if (!sizingInputsAvailable) {
    reasons.push('open sizing inputs unavailable')
  } else {
    const maxNotionalUsd = Math.min(perOrderCapUsd, remainingExposureUsd)
    for (const [index, action] of openActions.entries()) {
      const stopPrice = stopPriceFor(entryPrice, action.side, action.stop, atr)
      if (stopPrice === undefined) {
        reasons.push(`open[${index}] stop cannot be derived from fresh market data`)
        continue
      }
      const sizing = computeSize({
        equityQuote,
        riskPct: riskPct * envelope.riskFraction,
        entryPrice,
        stopPrice,
        qtyStep: amountStepContracts * contractSize,
        minQty: minAmountContracts * contractSize,
        maxNotionalUsd,
      })
      if (!sizing.ok) {
        reasons.push(`open[${index}] quantity/notional not executable: ${sizing.reason}`)
        continue
      }
      const contracts = sizing.qty / contractSize
      if (contracts + 1e-9 < minAmountContracts) reasons.push(`open[${index}] quantity is below market minimum`)
      if (sizing.notionalUsd + 1e-9 < minNotionalQuote) reasons.push(`open[${index}] notional is below market minimum`)
    }
  }
  const validatedEvidencePaths = [...new Set(envelope.claims.flatMap((claim) => claim.evidencePaths)
    .filter((path) => evidenceValueAvailable(pointerValue(context, path))))]
  return {
    state: reasons.length === 0 ? 'risk_gate_required' : 'decision_only',
    reasons: [...new Set(reasons)],
    validatedEvidencePaths,
  }
}

/** R3 将模型 plan draft 与代码拥有的身份/时间/风险比例绑定后，复用唯一 PlanCard 校验器。 */
export function materializeDecisionPlan(
  envelope: DecisionEnvelope,
  input: { readonly createdAt: number; readonly windowEndsAt: number; readonly planId: string },
): ReturnType<typeof validatePlanCard> | undefined {
  if (envelope.plan === undefined) return undefined
  const scaleAction = (action: PlanAction): PlanAction => action.action === 'open'
    ? { ...action, riskFraction: envelope.riskFraction }
    : action
  const base = {
    ...envelope.plan,
    planId: input.planId,
    runId: envelope.runId,
    symbol: envelope.symbol,
    createdAt: input.createdAt,
    windowEndsAt: input.windowEndsAt,
    confidence: envelope.confidence,
    commitments: envelope.plan.commitments.map((item) => ({ ...item, then: scaleAction(item.then) })),
    invalidation: envelope.plan.invalidation.map((item) => ({ ...item, then: scaleAction(item.then) })),
    author: 'model' as const,
    authority: 'model' as const,
  }
  return validatePlanCard({ ...base, contentHash: computeContentHash(base) })
}
