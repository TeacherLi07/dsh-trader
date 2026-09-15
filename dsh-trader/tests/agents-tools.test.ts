import Database from 'better-sqlite3'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ReplayClock } from '../src/clock.js'
import { EXAMPLE_LIMITS, type RiskLimits } from '../src/config.js'
import { migrate } from '../src/db/schema.js'
import { BarArchive } from '../src/market/archive.js'
import { FeatureArchive } from '../src/market/feature-archive.js'
import { FeaturePipeline } from '../src/market/features.js'
import { normalizeCandles } from '../src/market/normalize.js'
import { PaperBroker } from '../src/exec/paper.js'
import { DecisionJournal } from '../src/exec/journal.js'
import { PlanStore } from '../src/plan/store.js'
import {
  IMPLEMENTED_TOOL_NAMES,
  TOOL_DEFINITIONS,
  ToolArgumentError,
  toolByName,
  type ToolPorts,
} from '../src/agents/tools.js'
import { SIDE_EFFECT_TOOLS, assertRoleSurface } from '../src/agents/roles.js'
import { randomSeries } from './helpers/market.js'

const SYMBOL = 'BTC/USDT'
const TF = '1h'
const HOUR = 3_600_000
const START = 1_700_000_000_000

const LIMITS: RiskLimits = {
  ...EXAMPLE_LIMITS,
  perOrderCapUsd: 5_000,
  maxExposureUsd: 50_000,
  maxOpenOrders: 50,
}

let db: Database.Database
let ports: ToolPorts
let broker: PaperBroker
let lastClose = 0

function setup(options: { readonly limits?: RiskLimits | null } = {}): void {
  db = new Database(':memory:')
  migrate(db)
  const clock = new ReplayClock(START)
  const bars = new BarArchive(db)
  const features = new FeatureArchive(db)
  const plans = new PlanStore(db)
  const journal = new DecisionJournal(db)

  const candles = normalizeCandles(randomSeries(START, 60), SYMBOL, TF, START + 60 * HOUR).candles
  bars.upsertClosed(candles, { source: 'test', fetchedAt: START })
  const pipeline = new FeaturePipeline(features)
  for (const candle of candles) pipeline.onClosedCandle(candle)
  lastClose = candles[candles.length - 1]!.close

  broker = new PaperBroker({
    clock,
    book: { price: () => lastClose },
    initialEquityQuote: 10_000,
    slippageBps: 0,
    feeBps: 0,
  })

  ports = {
    db,
    bars,
    features,
    plans,
    journal,
    broker,
    clock,
    limits: options.limits === undefined ? LIMITS : options.limits,
    mode: 'paper',
    riskPct: 0.002,
  }
}

beforeEach(() => setup())
afterEach(() => db.close())

function call(name: string, args: Record<string, unknown> = {}): Promise<unknown> {
  const tool = toolByName(name)
  if (tool === undefined) throw new Error(`unknown tool ${name}`)
  return tool.execute(args, ports)
}

describe('tool registry', () => {
  it('has unique names and matches the roles allow-lists', () => {
    const names = TOOL_DEFINITIONS.map((tool) => tool.name)
    expect(new Set(names).size).toBe(names.length)
    expect(names).toEqual(IMPLEMENTED_TOOL_NAMES)
    expect(() => assertRoleSurface({ implementedTools: IMPLEMENTED_TOOL_NAMES })).not.toThrow()
  })

  it('marks exactly the execution tools as side-effecting', () => {
    const sideEffects = TOOL_DEFINITIONS.filter((tool) => tool.sideEffect).map((tool) => tool.name).sort()
    expect(sideEffects).toEqual([
      'trade_cancel',
      'trade_execute_order',
      'trade_plan_card',
      'trade_prediction_watch',
      'trade_record_decision',
    ])
    expect(SIDE_EFFECT_TOOLS).toContain('trade_execute_order')
  })
})

describe('read-only tools', () => {
  it('trade_market returns only stored closed bars plus the latest snapshot', async () => {
    const result = (await call('trade_market', { symbol: SYMBOL, timeframe: TF, bars: 10 })) as {
      count: number
      bars: { openTime: number }[]
      snapshot: Record<string, number | null> | null
      fingerprint: string | null
    }
    expect(result.count).toBe(10)
    expect(result.bars.every((bar) => typeof bar.openTime === 'number')).toBe(true)
    expect(result.snapshot?.rsi14).not.toBeNull()
    expect(result.fingerprint).toMatch(/^sha256:/)
  })

  it('trade_market caps the requested bar count', async () => {
    const result = (await call('trade_market', { symbol: SYMBOL, timeframe: TF, bars: 100_000 })) as {
      count: number
    }
    expect(result.count).toBeLessThanOrEqual(500)
  })

  it('trade_portfolio re-reads the account instead of trusting context', async () => {
    const result = (await call('trade_portfolio')) as { account: { equityQuote: number }; positions: unknown[] }
    expect(result.account.equityQuote).toBeCloseTo(10_000, 6)
    expect(result.positions).toEqual([])
  })

  it('trade_limits surfaces the waiver state', async () => {
    expect(await call('trade_limits')).toMatchObject({ mode: 'paper', waiver: false })
    setup({ limits: null })
    expect(await call('trade_limits')).toMatchObject({ waiver: true })
  })

  it('trade_recall reads decisions and lessons', async () => {
    ports.journal.recordDecision({
      decisionId: 'd1',
      symbol: SYMBOL,
      decidedAt: START,
      contextHash: 'ctx',
      action: 'no_trade',
      executed: false,
      rationale: 'nothing to do',
    })
    const result = (await call('trade_recall', { symbol: SYMBOL })) as {
      decisions: { decisionId: string }[]
    }
    expect(result.decisions.map((decision) => decision.decisionId)).toEqual(['d1'])
  })
})

describe('trade_propose_order (proposal only)', () => {
  it('derives size from the risk formula and never touches the exchange', async () => {
    const placed: unknown[] = []
    const originalPlace = broker.placeOrder.bind(broker)
    const originalProtect = broker.placeProtective.bind(broker)
    broker.placeOrder = async (request) => {
      placed.push(request)
      return originalPlace(request)
    }
    broker.placeProtective = async (request) => {
      placed.push(request)
      return originalProtect(request)
    }

    const result = (await call('trade_propose_order', {
      symbol: SYMBOL,
      timeframe: TF,
      side: 'long',
      method: 'market',
      stopMethod: 'atr',
      stopValue: 2,
    })) as {
      valid: boolean
      entryPrice: number
      stopPrice: number
      sizing: { qty: number; notionalUsd: number }
    }

    expect(result.valid).toBe(true)
    expect(result.stopPrice).toBeLessThan(result.entryPrice)
    expect(result.sizing.qty).toBeGreaterThan(0)
    // 关键：提议阶段绝不能下单
    expect(placed).toEqual([])
    expect(await broker.getPositions()).toEqual([])
  })

  it('refuses to propose without a feature snapshot instead of guessing a price', async () => {
    const result = await call('trade_propose_order', {
      symbol: 'NOPE/USDT',
      timeframe: TF,
      side: 'long',
      method: 'market',
      stopMethod: 'atr',
      stopValue: 2,
    })
    expect(result).toMatchObject({ valid: false })
  })

  it('rejects malformed arguments loudly', async () => {
    await expect(
      call('trade_propose_order', { symbol: SYMBOL, timeframe: TF, side: 'sideways' }),
    ).rejects.toThrow(ToolArgumentError)
  })
})

describe('trade_execute_order (double-checked, then executed)', () => {
  const openArgs = {
    decisionId: 'dec-1',
    symbol: SYMBOL,
    timeframe: TF,
    action: 'open',
    side: 'long',
    method: 'market',
    stopMethod: 'atr',
    stopValue: 2,
  }

  it('runs the gate again, places the order, and records intent/order/fill', async () => {
    const result = (await call('trade_execute_order', openArgs)) as {
      executed: boolean
      clientOrderId: string
      state: string
    }

    expect(result.executed).toBe(true)
    expect(result.state).toBe('filled')
    expect(result.clientOrderId).toBe('co:dec-1:open:BTC/USDT')

    const positions = await broker.getPositions()
    expect(positions).toHaveLength(1)
    expect(positions[0]!.qty).toBeGreaterThan(0)

    // 两条意图：下单 + 成交后立即挂的保护单（保护单也必须有审计行，否则恢复会当它是孤儿单）
    expect(ports.journal.intentIds()).toEqual(
      expect.arrayContaining(['oi:dec-1:open:BTC/USDT', 'pi:dec-1:open:BTC/USDT']),
    )
    expect(ports.journal.intentIds()).toHaveLength(2)
    expect(ports.journal.fillIds()).toHaveLength(1)
    const decision = ports.journal.recentDecisions()[0]
    expect(decision?.decisionId).toBe('dec-1:open:BTC/USDT')
    expect(decision?.outcomeId).toBeNull()

    const row = db
      .prepare('SELECT executed FROM decisions WHERE decision_id = ?')
      .get('dec-1:open:BTC/USDT') as { executed: number }
    expect(row.executed).toBe(1)
  })

  it('places a protective order immediately after an opening fill', async () => {
    await call('trade_execute_order', openArgs)
    const openOrders = await broker.getOpenOrders(SYMBOL)
    expect(openOrders.length).toBeGreaterThanOrEqual(1)
  })

  it('is refused by the hard gate when the order would exceed the cap, and records the denial', async () => {
    setup({ limits: { ...LIMITS, perOrderCapUsd: 100 } })
    const result = (await call('trade_execute_order', openArgs)) as { executed: boolean; reason: string }

    expect(result.executed).toBe(false)
    expect(result.reason).toContain('超过单笔上限')
    expect(await broker.getPositions()).toEqual([])
    expect(ports.journal.intentIds()).toEqual([])
    // 被拒也要留痕（审计优先）
    expect(ports.journal.recentDecisions()[0]?.rationale).toContain('超过单笔上限')
  })

  it('refuses a repeated decision id (idempotency at the gate)', async () => {
    await call('trade_execute_order', openArgs)
    const second = (await call('trade_execute_order', openArgs)) as { executed: boolean; reason: string }
    expect(second.executed).toBe(false)
    expect(second.reason).toContain('幂等')
    // 下单意图 + 保护单意图；第二次调用不得新增任何意图
    expect(ports.journal.intentIds()).toHaveLength(2)
  })

  it('决策的 context_hash 由代码给出，模型无法伪造（T1.5）', async () => {
    // 端口里带了本轮组装出的 ctxHash ⇒ 决策按它落库
    ports = { ...ports, contextHash: 'sha256:assembled' }
    await call('trade_execute_order', openArgs)
    expect(ports.journal.recentDecisions()[0]?.contextHash).toBe('sha256:assembled')

    // 模型就算自己塞一个 contextHash 入参也不会被采用
    await call('trade_record_decision', {
      decisionId: 'd-model-claim',
      symbol: SYMBOL,
      action: 'no_trade',
      contextHash: 'sha256:伪造的',
    })
    expect(ports.journal.recentDecisions()[0]?.contextHash).toBe('sha256:assembled')
  })

  it('没有组装过上下文时，占位符显式标明"未组装"而不是伪装成真哈希', async () => {
    await call('trade_record_decision', {
      decisionId: 'd-fallback',
      symbol: SYMBOL,
      action: 'no_trade',
    })
    expect(ports.journal.recentDecisions()[0]?.contextHash).toBe('unassembled-manual:d-fallback')
  })

  it('reduces and closes a live position by fraction', async () => {
    await call('trade_execute_order', openArgs)
    const opened = (await broker.getPositions())[0]!.qty

    const reduced = (await call('trade_execute_order', {
      decisionId: 'dec-2',
      symbol: SYMBOL,
      timeframe: TF,
      action: 'reduce',
      fraction: 0.5,
    })) as { executed: boolean }
    expect(reduced.executed).toBe(true)
    expect((await broker.getPositions())[0]!.qty).toBeCloseTo(opened / 2, 9)

    const closed = (await call('trade_execute_order', {
      decisionId: 'dec-3',
      symbol: SYMBOL,
      timeframe: TF,
      action: 'close',
    })) as { executed: boolean }
    expect(closed.executed).toBe(true)
    expect(await broker.getPositions()).toEqual([])
  })

  it('refuses to reduce when there is no position', async () => {
    const result = (await call('trade_execute_order', {
      decisionId: 'dec-x',
      symbol: SYMBOL,
      timeframe: TF,
      action: 'reduce',
      fraction: 0.5,
    })) as { executed: boolean; reason: string }
    expect(result.executed).toBe(false)
    expect(result.reason).toContain('没有')
  })
})

describe('trade_risk_check and trade_cancel', () => {
  it('projects exposure and leverage without placing anything', async () => {
    const result = (await call('trade_risk_check', { notionalUsd: 1_000, symbol: SYMBOL })) as {
      verdict: { kind: string }
      projectedExposureUsd: number
      projectedLeverage: number
    }
    expect(result.verdict.kind).toBe('allow')
    expect(result.projectedExposureUsd).toBeCloseTo(1_000, 6)
    expect(result.projectedLeverage).toBeCloseTo(0.1, 6)
  })

  it('trade_cancel clears open orders', async () => {
    await call('trade_execute_order', {
      decisionId: 'dec-cancel',
      symbol: SYMBOL,
      timeframe: TF,
      action: 'open',
      side: 'long',
      method: 'limit',
      limitPrice: lastClose * 0.5, // 远离市价 ⇒ 挂单不动
      stopMethod: 'atr',
      stopValue: 2,
    })
    const before = await broker.getOpenOrders()
    expect(before.length).toBeGreaterThan(0)
    await call('trade_cancel', { symbol: SYMBOL })
    expect(await broker.getOpenOrders()).toEqual([])
  })
})

describe('trade_plan_card（无人值守回路的入口：判断 → 可执行计划卡）', () => {
  const validCard = (): string =>
    JSON.stringify({
      thesis: 'test: 收盘站上 ema20 则做多',
      confidence: 0.5,
      commitments: [
        {
          id: 'c1',
          seq: 1,
          tf: TF,
          when: 'position.qty == 0 and bar.close > ema20',
          then: { action: 'open', side: 'long', method: 'market', stop: { method: 'atr', k: 2 } },
        },
      ],
      invalidation: [
        { id: 'inv1', tf: TF, when: 'bar.close < ema20', then: { action: 'close' } },
      ],
      forbidden: [],
      noTrade: false,
    })

  it('校验通过即落库；同一内容重复提交是幂等 no-op', async () => {
    const tool = toolByName('trade_plan_card')
    expect(tool).toBeDefined()
    const first = (await tool?.execute(
      { symbol: SYMBOL, windowEndsInHours: 4, cardJson: validCard() },
      ports,
    )) as { saved: boolean; status: string; planId: string; contentHash: string }
    expect(first.saved).toBe(true)
    expect(first.planId.startsWith('pc-')).toBe(true)

    const second = (await tool?.execute(
      { symbol: SYMBOL, windowEndsInHours: 4, cardJson: validCard() },
      ports,
    )) as { status: string }
    expect(second.status).toBe('unchanged')
  })

  it('结构非法（when 语法错 / 缺 action 必需字段）一律拒绝，绝不落库', async () => {
    const tool = toolByName('trade_plan_card')
    const bad = JSON.stringify({
      thesis: 'bad',
      confidence: 0.5,
      commitments: [{ id: 'c1', seq: 1, tf: TF, when: 'bar.close >', then: { action: 'open' } }],
      invalidation: [],
    })
    await expect(
      tool?.execute({ symbol: SYMBOL, windowEndsInHours: 4, cardJson: bad }, ports),
    ).rejects.toThrow(ToolArgumentError)
    expect(ports.plans.active(SYMBOL)).toBeUndefined()
  })

  it('cardJson 不是 JSON 对象时拒绝（不猜）', async () => {
    const tool = toolByName('trade_plan_card')
    await expect(
      tool?.execute({ symbol: SYMBOL, windowEndsInHours: 4, cardJson: '[]' }, ports),
    ).rejects.toThrow(ToolArgumentError)
  })
})
