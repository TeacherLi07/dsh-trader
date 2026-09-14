import { describe, expect, it } from 'vitest'
import {
  DEFAULT_GATE_THRESHOLDS,
  computeArmMetrics,
  evaluateChannelGate,
  maxDrawdown,
  pairDifferences,
  pairedBootstrapCi,
  renderGateReport,
  standInJudge,
  type ArmInput,
} from '../src/supervisor/ab.js'

/** 24 笔、净额为正且波动平缓的基线臂 —— 满足 minPairedSamples(20)。 */
const BASE: readonly number[] = [
  6, -3, 8, 5, -4, 9, 7, -2, 10, 4, -5, 6, 11, -3, 8, 5, 12, -4, 7, 9, -2, 6, 10, 5,
]
const arm = (over: Partial<ArmInput> = {}): ArmInput => ({
  tradePnl: BASE,
  executionDeviations: 0,
  bars: DEFAULT_GATE_THRESHOLDS.minBars,
  triggers: DEFAULT_GATE_THRESHOLDS.minTriggers,
  ...over,
})

const verdictOf = (a: ArmInput, b: ArmInput) => {
  const metricsA = computeArmMetrics(a)
  const metricsB = computeArmMetrics(b)
  const ci = pairedBootstrapCi(pairDifferences(a.tradePnl, b.tradePnl), {
    iterations: 2_000,
    confidence: 0.95,
    seed: 7,
  })
  return { metricsA, metricsB, ci, verdict: evaluateChannelGate(metricsA, metricsB, ci) }
}

describe('maxDrawdown', () => {
  it('从峰值算最大回撤，正数表示幅度', () => {
    // 权益 10 → 5 → 25 → 17；峰值 10、10、25、25 ⇒ 回撤 0、5、0、8
    expect(maxDrawdown([10, -5, 20, -8])).toBe(8)
    expect(maxDrawdown([5, 5, 5])).toBe(0)
    expect(maxDrawdown([-1, -1])).toBe(2)
    expect(maxDrawdown([])).toBe(0)
  })

  it('在持续上涨中正确重置峰值', () => {
    expect(maxDrawdown([1, 2, 3, -1, -1])).toBe(2)
  })
})

describe('computeArmMetrics', () => {
  it('汇总成交笔数、净额、回撤与执行偏离', () => {
    const metrics = computeArmMetrics(arm({ tradePnl: [10, -5, 20, -8], executionDeviations: 3 }))
    expect(metrics.trades).toBe(4)
    expect(metrics.netPnlUsd).toBe(17)
    expect(metrics.maxDrawdownUsd).toBe(8)
    expect(metrics.executionDeviations).toBe(3)
    expect(metrics.judgment).toEqual({ reviewed: 0, approved: 0, vetoed: 0 })
  })
})

describe('pairedBootstrapCi', () => {
  it('固定种子 ⇒ 可复算（回放必须能重现结论）', () => {
    const diffs = [1, 2, 3, 4, 5, -1, -2, 3, 4, 5]
    const first = pairedBootstrapCi(diffs, { iterations: 1_000, seed: 42 })
    const second = pairedBootstrapCi(diffs, { iterations: 1_000, seed: 42 })
    expect(first).toEqual(second)
    // 换种子 ⇒ 重采样路径不同；用多个种子避免"分位点恰好相同"的偶然
    const others = [43, 44, 45, 46, 47].map((seed) => pairedBootstrapCi(diffs, { iterations: 1_000, seed }))
    expect(others.some((ci) => ci.upper !== first.upper)).toBe(true)
  })

  it('全为正的差值 ⇒ CI 下界 > 0', () => {
    const ci = pairedBootstrapCi([5, 6, 7, 8, 9, 10], { iterations: 2_000, seed: 1 })
    expect(ci.mean).toBeCloseTo(7.5, 10)
    expect(ci.lower).toBeGreaterThan(0)
  })

  it('均值≈0 且波动大 ⇒ CI 下界 ≤ 0（证不出正贡献）', () => {
    const ci = pairedBootstrapCi([10, -10, 10, -10, 10, -10, 10, -10], { iterations: 2_000, seed: 1 })
    expect(ci.lower).toBeLessThanOrEqual(0)
  })

  it('空样本返回零区间而不是抛错（上层据此判"结论无效"）', () => {
    expect(pairedBootstrapCi([])).toMatchObject({ mean: 0, lower: 0, upper: 0, samples: 0 })
  })
})

describe('pairDifferences', () => {
  it('按共同前缀配对为 B−A', () => {
    expect(pairDifferences([1, 2, 3], [2, 2, 2])).toEqual([1, 0, -1])
  })

  it('样本量不同时取较短者，不补零（补零会伪造样本）', () => {
    expect(pairDifferences([1, 2, 3, 4], [1, 1])).toEqual([0, -1])
  })
})

describe('evaluateChannelGate（plan §10 预注册判据）', () => {
  // 24 笔 ⇒ 满足 minPairedSamples(20)，bootstrap 不退化为噪声
  const B_BETTER = BASE.map((value) => value + 3)
  const B_NO_GAIN = [...BASE]
  /**
   * 净额与 B_BETTER 相同（每笔仍 +3，只是把两笔挪动位置）⇒ 均值差 = +3、CI 下界 > 0，
   * 但中途挖出一个深坑 ⇒ 回撤远超 A。用来验证"不许用更大回撤换收益"。
   */
  const B_RISKY = (() => {
    const out = [...B_BETTER]
    out[5] = -60
    out[10] = (out[10] as number) + 60
    return out
  })()

  it('CI 下界 > 0 且回撤不超限 ⇒ 保留 W2/W3', () => {
    const { verdict } = verdictOf(arm(), arm({ tradePnl: B_BETTER, judgment: { reviewed: 24, approved: 20, vetoed: 4 } }))
    expect(verdict.inconclusive).toEqual([])
    expect(verdict.ci.lower).toBeGreaterThan(0)
    expect(verdict.keep).toBe(true)
    expect(verdict.failures).toEqual([])
  })

  it('CI 下界 ≤ 0（判断通道零贡献）⇒ 关闭并降级为纯机械执行', () => {
    const { verdict } = verdictOf(arm(), arm({ tradePnl: B_NO_GAIN, judgment: { reviewed: 24, approved: 24, vetoed: 0 } }))
    expect(verdict.inconclusive).toEqual([])
    expect(verdict.ci.lower).toBe(0)
    expect(verdict.keep).toBe(false)
    expect(verdict.failures.join('\n')).toContain('CI 下界')
  })

  it('净收益更好但回撤超过 A×1.2 ⇒ 仍关闭（不许用更大回撤换收益）', () => {
    const { verdict } = verdictOf(
      arm(),
      arm({ tradePnl: B_RISKY, judgment: { reviewed: 24, approved: 20, vetoed: 4 } }),
    )
    // 深坑让回撤比远超上限；此处只关心"回撤这一条"能否独立否决
    expect(verdict.drawdownRatio).toBeGreaterThan(1.2)
    expect(verdict.keep).toBe(false)
    expect(verdict.failures.join('\n')).toContain('最大回撤')
  })

  it('A 无回撤而 B 有回撤 ⇒ 比值视为无穷，判不达标', () => {
    // A 严格递增 ⇒ 回撤 0；B 有回撤 ⇒ 比值只能是无穷，不能假装成有限数
    const monotone = Array.from({ length: 24 }, (_, index) => index + 1)
    const { verdict } = verdictOf(
      arm({ tradePnl: monotone }),
      arm({ tradePnl: [5, -1, 5, ...monotone.slice(3)], judgment: { reviewed: 24, approved: 24, vetoed: 0 } }),
    )
    expect(verdict.drawdownRatio).toBe(Number.POSITIVE_INFINITY)
    expect(verdict.keep).toBe(false)
  })

  it('可配对逐笔太少 ⇒ 结论无效（bootstrap 在 n=1 上退化）', () => {
    const { verdict } = verdictOf(arm({ tradePnl: [1] }), arm({ tradePnl: [9], judgment: { reviewed: 1, approved: 1, vetoed: 0 } }))
    expect(verdict.inconclusive.join('\n')).toContain('bootstrap')
    expect(verdict.keep).toBe(false)
  })

  it('样本量不足 ⇒ 结论无效，且**绝不允许保留**（§10 的 bar/触发是"或"关系）', () => {
    const { verdict } = verdictOf(
      arm({ bars: 100, triggers: 5 }),
      arm({ tradePnl: B_BETTER, judgment: { reviewed: 24, approved: 24, vetoed: 0 } }),
    )
    expect(verdict.inconclusive).toHaveLength(1)
    expect(verdict.inconclusive[0]).toContain('至少满足其一')
    expect(verdict.keep).toBe(false)
    expect(renderGateReport(verdict, { judge: 'stand-in' })).toContain('结论无效')
  })

  it('样本量：bar 够多即可（不必同时满足触发次数）', () => {
    const { verdict } = verdictOf(
      arm({ bars: DEFAULT_GATE_THRESHOLDS.minBars, triggers: 3 }),
      arm({ tradePnl: B_BETTER, judgment: { reviewed: 24, approved: 24, vetoed: 0 } }),
    )
    expect(verdict.inconclusive).toEqual([])
    expect(verdict.keep).toBe(true)
  })

  it('样本量：触发次数够多即可（不必同时满足天数）', () => {
    const { verdict } = verdictOf(
      arm({ bars: 10, triggers: DEFAULT_GATE_THRESHOLDS.minTriggers }),
      arm({ tradePnl: B_BETTER, judgment: { reviewed: 24, approved: 24, vetoed: 0 } }),
    )
    expect(verdict.inconclusive).toEqual([])
    expect(verdict.keep).toBe(true)
  })

  it('判断通道一次都没经手 ⇒ B 臂没被检验，结论无效', () => {
    const { verdict } = verdictOf(arm(), arm({ tradePnl: B_BETTER }))
    expect(verdict.inconclusive.join('\n')).toContain('没被检验')
    expect(verdict.keep).toBe(false)
  })

  it('阈值可配（同一数据：回撤系数收紧后就被拦下）', () => {
    const a = computeArmMetrics(arm())
    const b = computeArmMetrics(arm({ tradePnl: B_BETTER, judgment: { reviewed: 24, approved: 24, vetoed: 0 } }))
    const ci = pairedBootstrapCi(pairDifferences(BASE, B_BETTER), { iterations: 2_000, seed: 3 })
    // 实测回撤比 = 2/5 = 0.4：默认 1.2 放行，收到 0.3 就被拦下
    expect(verdictOf(arm(), arm({ tradePnl: B_BETTER, judgment: { reviewed: 24, approved: 24, vetoed: 0 } })).verdict.drawdownRatio).toBeCloseTo(0.4, 10)
    expect(evaluateChannelGate(a, b, ci, DEFAULT_GATE_THRESHOLDS).keep).toBe(true)
    expect(evaluateChannelGate(a, b, ci, { ...DEFAULT_GATE_THRESHOLDS, maxDrawdownRatio: 0.3 }).keep).toBe(false)
  })
})

describe('renderGateReport', () => {
  it('报告含两臂指标、CI、阈值与明确判定，并标注判断通道实现', () => {
    const { verdict } = verdictOf(
      arm(),
      arm({ tradePnl: BASE.map((value) => value + 3), judgment: { reviewed: 24, approved: 20, vetoed: 4 } }),
    )
    const report = renderGateReport(verdict, { judge: 'stand-in' })
    expect(report).toContain('A（纯机械）')
    expect(report).toContain('B（+判断通道）')
    expect(report).toContain('bootstrap')
    expect(report).toContain('保留 W2/W3')
    expect(report).toContain('stand-in')
  })
})

describe('standInJudge（确定性替身，非 LLM）', () => {
  const input = (over: Record<string, unknown> = {}) => ({
    symbol: 'BTC/USDT',
    timeframe: '1h',
    barTs: 0,
    planId: 'pc-1',
    conditionId: 'c-open',
    expression: 'rsi14 < 45',
    action: { action: 'open' as const, side: 'long' as const, method: 'market' as const, stop: { method: 'atr' as const, k: 2 }, riskPct: 0.002 },
    referencePrice: 70_000,
    atr: 700,
    equityQuote: 10_000,
    positionQty: 0,
    ...over,
  })

  it('无持仓且止损距离足够 ⇒ 通过', async () => {
    expect(await standInJudge()(input() as never)).toEqual({ approve: true, reason: 'stand-in:通过' })
  })

  it('已有持仓 ⇒ 拒绝加仓', async () => {
    const verdict = await standInJudge()(input({ positionQty: 1 }) as never)
    expect(verdict.approve).toBe(false)
    expect(verdict.reason).toContain('拒绝加仓')
  })

  it('止损距离过窄 ⇒ 拒绝（这种单子必然撞上限）', async () => {
    const verdict = await standInJudge()(input({ atr: 10 }) as never)
    expect(verdict.approve).toBe(false)
    expect(verdict.reason).toContain('止损距离')
  })

  it('非开仓动作不设限，且同样输入必得同样结论', async () => {
    const close = input({ action: { action: 'close' }, positionQty: 1, atr: 1 })
    expect((await standInJudge()(close as never)).approve).toBe(true)
    const first = await standInJudge()(input({ atr: 10 }) as never)
    const second = await standInJudge()(input({ atr: 10 }) as never)
    expect(first).toEqual(second)
  })
})
