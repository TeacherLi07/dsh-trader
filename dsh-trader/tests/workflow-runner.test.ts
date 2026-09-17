import { describe, expect, it } from 'vitest'
import type { TradePorts } from '../src/exec/ports.js'
import type { JudgmentResult } from '../src/agents/types.js'
import type { SubagentRun, SubagentStartRequest } from '@deepseek-ai/dsh-subagent'
import { buildJudgmentPack, createWorkflowTool, runJudgmentWorkflow, workflowFeatureMap } from '../src/plugins/workflow-runner.js'

const CLOSE = 100
const AS_OF = 1_700_000_000_000
const SNAPSHOT = {
  symbol: 'BTC/USDT',
  timeframe: '1h',
  openTime: AS_OF - 7_200_000,
  closeTime: AS_OF - 3_600_000,
  values: {
    open: 99,
    high: 101,
    low: 98,
    close: CLOSE,
    volume: 10,
    ema20: 98,
    ema50: null,
    rsi14: 55,
    atr14: 2,
    adx14: null,
    vwap20: 99,
    zscore20: null,
    volRealized20: null,
    fundingRate: 0.0001,
    oiChangePct: null,
    liqNotional: null,
    basisBps: -3,
  },
  fingerprint: 'sha256:snapshot',
}

const AUDITS: unknown[] = []

function ports(): TradePorts {
  AUDITS.length = 0
  return {
    symbols: ['BTC/USDT'],
    timeframes: ['1h'],
    benchmark: 'BTC/USDT',
    clock: { now: () => AS_OF } as never,
    features: { latest: () => SNAPSHOT } as never,
    broker: {
      getAccount: async () => ({ venue: 'paper', equityQuote: 10_000, totalExposureUsd: 0, openOrders: 2, leverage: 0, dailyLossUsd: 0, drawdownUsd: 0, consecutiveLosses: 0, spreadBps: 0, observedAt: AS_OF }),
      getPositions: async () => [{ symbol: 'BTC/USDT', qty: 0, avgPrice: 0, unrealizedPnlUsd: 0 }],
    } as never,
    plans: { active: () => ({ planId: 'p1', contentHash: 'sha256:plan', symbol: 'BTC/USDT' }) } as never,
    journal: {
      recentLessons: () => [{ lessonId: 'lesson-valid', decisionId: 'd1', symbol: 'BTC/USDT', text: 'x', evidenceRefs: [], regimeBucket: null, createdAt: AS_OF - 100, expiresAt: null }],
      appendAudit: (event: unknown) => { AUDITS.push(event); return 'audit' },
    } as never,
    db: {} as never,
    bars: {} as never,
    limits: null,
    mode: 'paper',
    riskPct: 0.002,
  }
}

function report(pack: Awaited<ReturnType<typeof buildJudgmentPack>>, agent: string, path: string) {
  return {
    agent,
    contextHash: pack.contextHash,
    verdict: 'bullish',
    keyNumbers: { [path]: pack.features[path] },
    claims: [{ kind: 'observation', statement: '可核验', evidencePaths: [path] }],
    missingPaths: [],
    summary: agent,
    artifactRef: `artifact://${agent}`,
  }
}

function argument(contextHash: string) {
  return {
    contextHash,
    points: [{ statement: '支持', evidencePaths: ['bar.close'], invalidatedBy: { statement: '失效', evidencePaths: ['bar.close'] } }],
    concede: true,
  }
}

describe('trade_workflow_run production runner', () => {
  it('builds complete features and freshness from snapshot plus injected clock', async () => {
    const map = workflowFeatureMap(SNAPSHOT, AS_OF)
    expect(map['bar.close']).toBe(CLOSE)
    expect(map['ema50']).toBeNull()
    expect(map['data.snapshotOpenTime']).toBe(SNAPSHOT.openTime)
    expect(map['data.snapshotCloseTime']).toBe(SNAPSHOT.closeTime)
    expect(map['data.ageMs']).toBe(3_600_000)

    const pack = await buildJudgmentPack(ports(), 'BTC/USDT', '1h')
    expect(pack.features['data.ageMs']).toBe(3_600_000)
    expect(pack.features['equity.quote']).toBe(10_000)
    expect(pack.features['position.qty']).toBe(0)
    expect(pack.features['position.avgPrice']).toBe(0)
    expect(pack.features['position.unrealizedPnl']).toBe(0)
    expect(pack.features['account.openOrders']).toBe(2)
    expect(pack.features['account.leverage']).toBe(0)
    expect(pack.lessons).toEqual([{ lessonId: 'lesson-valid' }])
    expect(pack.plan).toEqual({ planId: 'p1', contentHash: 'sha256:plan' })
  })

  it('passes fixed script, schema, zero-tool filter and returns structured result to judge', async () => {
    const testPorts = ports()
    const pack = await buildJudgmentPack(testPorts, 'BTC/USDT', '1h')
    const calls: Array<{ label: string; schema: unknown; filter: unknown; maxDepth: number }> = []
    const fake = {
      start: async (_provider: string, request: SubagentStartRequest): Promise<SubagentRun> => {
        const label = String(request.label)
        calls.push({ label, schema: request.outputSchema, filter: request.toolFilter, maxDepth: request.maxDepth as number })
        const value = label === 'market'
          ? report(pack, 'market', 'bar.close')
          : label === 'flow'
            ? report(pack, 'flow', 'funding.rate')
            : label === 'news'
              ? report(pack, 'news', 'bar.close')
              : label === 'onchain'
                ? report(pack, 'onchain', 'basis.bps')
                : label === 'bull' || label === 'bear'
                  ? argument(pack.contextHash)
                  : { contextHash: pack.contextHash, disposition: 'proceed', failureModes: [], missingEvidence: [] }
        return {
          id: `child-${calls.length}` as never,
          localAgent: undefined,
          result: Promise.resolve({ stopReason: 'completed', output: [], structured: value }),
          dispose: async () => undefined,
        }
      },
    }

    const result = await runJudgmentWorkflow(testPorts, 'BTC/USDT', '1h', {
      subagents: fake,
      parent: { id: 'desk' } as never,
      signal: new AbortController().signal,
    })
    expect((result as JudgmentResult).contextHash).toBe(pack.contextHash)
    expect(result.risk?.disposition).toBe('proceed')
    expect(calls).toHaveLength(7)
    expect(calls.map((call) => call.filter)).toEqual(calls.map(() => ({ allow: [] })))
    expect(calls.every((call) => call.maxDepth === 1)).toBe(true)
    expect(calls.every((call) => typeof call.schema === 'object')).toBe(true)
  })

  it('rejects unknown symbol and preserves failed workflow audit', async () => {
    const testPorts = ports()
    const tool = createWorkflowTool(() => testPorts, { start: async () => { throw new Error('fake child unavailable') } })
    await expect(tool.execute({ symbol: 'ETH/USDT', timeframe: '1h' }, { agent: { id: 'desk' } } as never)).rejects.toThrow(/不在配置标的池/)
    expect(AUDITS.some((event) => (event as { kind?: string }).kind === 'judgment_workflow_failed')).toBe(true)
  })
})
