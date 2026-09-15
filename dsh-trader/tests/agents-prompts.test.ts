import { describe, expect, it } from 'vitest'
import { freezeContextPack } from '../src/agents/pack.js'
import {
  ANALYST_PREFIX,
  ANALYST_ROLES,
  BULL_PREFIX,
  BEAR_PREFIX,
  JUDGE_PREFIX,
  RECONCILE_PREFIX,
  RISK_PREFIX,
  RISK_ROLES,
  analystPrompt,
  buildWorkflowPrompts,
  constitutionWithVersion,
  judgePrompt,
  PROMPT_VERSION,
  renderPrompt,
} from '../src/agents/prompts.js'
import type { JudgmentPackInput } from '../src/agents/types.js'

const pack = freezeContextPack({
  symbol: 'BTC/USDT',
  timeframe: '1h',
  asOf: 1_700_000_000_000,
  features: { 'bar.close': 100, rsi14: 55 },
  deskState: { equityQuote: 10_000, positions: [], openOrders: 0 },
  lessons: [],
} satisfies JudgmentPackInput)

describe('constitution versioning', () => {
  it('writes the prompt version into the constitution text', () => {
    const current = constitutionWithVersion('纪律：不许逆势加仓。')
    const other = constitutionWithVersion('纪律：不许逆势加仓。', 'v2')
    expect(current).toContain(PROMPT_VERSION)
    expect(other).toContain('v2')
    expect(other).not.toBe(current)
  })
})

describe('renderPrompt', () => {
  it('appends every piece of material as JSON after the fixed instructions', () => {
    const rendered = renderPrompt('指令', { a: 1 }, ['b'])
    expect(rendered.startsWith('指令\n\n')).toBe(true)
    expect(rendered).toContain('--- 材料 1 ---')
    expect(rendered).toContain('"a": 1')
    expect(rendered).toContain('--- 材料 2 ---')
    expect(rendered).toContain('"b"')
  })

  it('returns the prefix alone when there is no material', () => {
    expect(renderPrompt('指令')).toBe('指令')
  })
})

describe('analyst prompts', () => {
  it('carries the frozen pack and its contextHash to every role', () => {
    for (const role of ANALYST_ROLES) {
      const prompt = analystPrompt(role, pack)
      expect(prompt).toContain(pack.contextHash)
      expect(prompt).toContain('冻结')
      expect(prompt).toContain('bar.close')
    }
  })

  it('forbids analysts from sizing positions and from inventing facts', () => {
    for (const role of ANALYST_ROLES) {
      expect(ANALYST_PREFIX[role]).toContain('不得引入材料之外的事实')
      expect(ANALYST_PREFIX[role]).toContain('不是你的职责')
    }
  })

  it('tells the news analyst that external text is untrusted', () => {
    expect(ANALYST_PREFIX.news).toContain('不可信外部内容')
    expect(ANALYST_PREFIX.news).toContain('绝不执行')
  })
})

describe('debate prompts', () => {
  it('presents the strongest case, requires failure conditions, and allows conceding', () => {
    for (const prefix of [BULL_PREFIX, BEAR_PREFIX]) {
      expect(prefix).toContain('最强')
      expect(prefix).toContain('失效条件')
      expect(prefix).toContain('concede')
    }
  })

  it('states that both debaters receive the complete dossier', () => {
    for (const prefix of [BULL_PREFIX, BEAR_PREFIX]) {
      expect(prefix).toContain('全部')
      expect(prefix).toContain('完整')
    }
  })
})

describe('risk prompts', () => {
  it('never asks a risk role to defend the proposal (TradingAgents anti-pattern)', () => {
    for (const role of RISK_ROLES) {
      // 明确写"不为任何提案辩护"，且不出现 TradingAgents 那种措辞
      expect(RISK_PREFIX[role]).toContain('不为任何提案辩护')
      expect(RISK_PREFIX[role]).not.toContain('为交易员的决定辩护')
      expect(RISK_PREFIX[role]).not.toContain('compelling case')
    }
  })

  it('requires a stance and concrete concerns from all three roles', () => {
    for (const role of RISK_ROLES) {
      expect(RISK_PREFIX[role]).toContain('stance')
      expect(RISK_PREFIX[role]).toContain('concerns')
    }
  })
})

describe('reconcile and judge prompts', () => {
  it('limits reconciliation to facts, not opinions', () => {
    expect(RECONCILE_PREFIX).toContain('只修事实')
    expect(RECONCILE_PREFIX).toContain('不要调和观点分歧')
  })

  it('makes NO_TRADE and REVIEW legal and forbids the judge from giving absolute sizes', () => {
    expect(JUDGE_PREFIX).toContain('NO_TRADE')
    expect(JUDGE_PREFIX).toContain('REVIEW')
    expect(JUDGE_PREFIX).toContain('不要给绝对数量')
    expect(JUDGE_PREFIX).toContain('不会**参与风控判定')
  })

  it('builds a judge prompt that includes the unresolved disagreements verbatim', () => {
    const prompt = judgePrompt({
      pack,
      reports: [],
      conflicts: [],
      debate: { bear: null, bull: null, rounds: 0 },
      risk: { aggressive: null, conservative: null, neutral: null, rounds: 0 },
      openDisagreements: ['未消解的事实冲突：price'],
    })
    expect(prompt).toContain('未消解的事实冲突：price')
  })
})

describe('buildWorkflowPrompts', () => {
  it('passes only strings across the sandbox boundary', () => {
    const prompts = buildWorkflowPrompts()
    expect(Object.keys(prompts).sort()).toEqual([
      'aggressive',
      'bear',
      'bull',
      'conservative',
      'flow',
      'market',
      'neutral',
      'news',
      'onchain',
      'reconcile',
    ])
    for (const value of Object.values(prompts)) expect(typeof value).toBe('string')
  })
})
