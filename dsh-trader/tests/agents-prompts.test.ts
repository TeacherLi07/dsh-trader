import { describe, expect, it } from 'vitest'
import { freezeContextPack } from '../src/agents/pack.js'
import {
  ANALYST_PREFIX,
  ANALYST_ROLES,
  BULL_PREFIX,
  BEAR_PREFIX,
  JUDGE_PREFIX,
  RISK_PREFIX,
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

describe('prompt contract', () => {
  it('versions the constitution', () => {
    const current = constitutionWithVersion('纪律：不许逆势加仓。')
    expect(current).toContain(PROMPT_VERSION)
    expect(constitutionWithVersion('x', 'v-old-test')).not.toBe(current)
  })

  it('renders every material as JSON', () => {
    const rendered = renderPrompt('指令', { a: 1 }, ['b'])
    expect(rendered).toContain('--- 材料 1 ---')
    expect(rendered).toContain('"a": 1')
    expect(renderPrompt('指令')).toBe('指令')
  })

  it('requires canonical evidence paths and frozen contextHash for analysts', () => {
    for (const role of ANALYST_ROLES) {
      expect(analystPrompt(role, pack)).toContain(pack.contextHash)
      expect(ANALYST_PREFIX[role]).toContain('规范路径')
      expect(ANALYST_PREFIX[role]).toContain('claims')
      expect(ANALYST_PREFIX[role]).toContain('missingPaths')
      expect(ANALYST_PREFIX[role]).toContain('不得引入材料之外的事实')
    }
  })

  it('keeps news text untrusted and macro windows soft', () => {
    expect(ANALYST_PREFIX.news).toContain('不可信外部内容')
    expect(ANALYST_PREFIX.news).toContain('更密切地评估')
    expect(ANALYST_PREFIX.news).not.toContain('禁止开仓')
  })

  it('requires structured points, invalidation evidence, and bounded debate', () => {
    for (const prefix of [BULL_PREFIX, BEAR_PREFIX]) {
      expect(prefix).toContain('最强')
      expect(prefix).toContain('invalidatedBy')
      expect(prefix).toContain('contextHash')
      expect(prefix).toContain('concede')
    }
  })

  it('uses one RiskCritic and keeps judge execution-free', () => {
    expect(RISK_PREFIX).toContain('唯一 RiskCritic')
    expect(RISK_PREFIX).toContain('disposition')
    expect(RISK_PREFIX).toContain('failureModes')
    expect(JUDGE_PREFIX).toContain('NO_TRADE')
    expect(JUDGE_PREFIX).toContain('REVIEW')
    expect(JUDGE_PREFIX).toContain('没有 trade_execute_order 权限')
  })

  it('passes only string prompts across the workflow boundary', () => {
    const prompts = buildWorkflowPrompts()
    expect(Object.keys(prompts).sort()).toEqual(['bear', 'bull', 'flow', 'market', 'news', 'onchain', 'risk'])
    for (const value of Object.values(prompts)) expect(typeof value).toBe('string')
  })

  it('includes evidence issues in the judge material', () => {
    const prompt = judgePrompt({ pack, reports: [], evidenceIssues: ['bad path'], debate: null, risk: null, openDisagreements: ['REVIEW'] })
    expect(prompt).toContain('bad path')
    expect(prompt).toContain('REVIEW')
  })
})
