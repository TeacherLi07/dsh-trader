import { describe, expect, it } from 'vitest'
import {
  DESK_TOOL_BUDGET,
  KNOWN_TOOL_NAMES,
  ROLES,
  ROLE_SPECS,
  RoleSpecError,
  SIDE_EFFECT_TOOLS,
  assertRoleSurface,
  missingTools,
  modelFor,
  restrictFor,
  sideEffectToolsFor,
} from '../src/agents/roles.js'
import { IMPLEMENTED_TOOL_NAMES } from '../src/agents/tools.js'

const ROUTING = {
  deep: { provider: 'deepseek-official', model: 'deepseek-reasoner' },
  quick: { provider: 'deepseek-official', model: 'deepseek-flash' },
}

describe('role surface (T1.2)', () => {
  it('passes its own structural checks against what is actually implemented', () => {
    expect(() => assertRoleSurface({ implementedTools: IMPLEMENTED_TOOL_NAMES })).not.toThrow()
  })

  it('never gives a read-only role a tool that changes exchange state or the decision log', () => {
    for (const role of ['analyst', 'research', 'trader', 'risk', 'meta'] as const) {
      expect(sideEffectToolsFor(role)).toEqual([])
      expect(ROLE_SPECS[role].allowsSideEffects).toBe(false)
    }
  })

  it('gives the judge — and only the judge — the execution tools', () => {
    expect(ROLE_SPECS.judge.allowsSideEffects).toBe(true)
    expect(ROLE_SPECS.judge.tools).toContain('trade_execute_order')
    expect(ROLE_SPECS.judge.tools).toContain('trade_cancel')
    expect(ROLE_SPECS.judge.tools).toContain('trade_record_decision')

    for (const role of ROLES) {
      if (role === 'judge') continue
      expect(ROLE_SPECS[role].tools).not.toContain('trade_execute_order')
    }
  })

  it('keeps the desk tool surface within the selection-accuracy budget', () => {
    expect(ROLE_SPECS.judge.tools.length).toBeLessThanOrEqual(DESK_TOOL_BUDGET)
    expect(() => assertRoleSurface({ implementedTools: IMPLEMENTED_TOOL_NAMES, budget: 5 })).toThrow(
      RoleSpecError,
    )
  })

  it('only references tools that are in the planned toolbox', () => {
    const known = new Set<string>(KNOWN_TOOL_NAMES)
    for (const role of ROLES) {
      for (const tool of ROLE_SPECS[role].tools) expect(known.has(tool)).toBe(true)
    }
    for (const tool of SIDE_EFFECT_TOOLS) expect(known.has(tool)).toBe(true)
  })

  it('reports the unimplemented tools instead of pretending the surface is complete', () => {
    const missing = missingTools(IMPLEMENTED_TOOL_NAMES)
    expect(missing).toContain('trade_derivatives')
    expect(missing).toContain('trade_regime')
    expect(missing).toContain('trade_stress_test')
    expect(missing).toContain('trade_workflow_run')
    // 已实现的绝不能出现在"缺失"里
    for (const implemented of IMPLEMENTED_TOOL_NAMES) expect(missing).not.toContain(implemented)
  })

  it('routes roles to model tiers', () => {
    expect(modelFor('judge', ROUTING)).toBe(ROUTING.deep)
    expect(modelFor('trader', ROUTING)).toBe(ROUTING.deep)
    expect(modelFor('meta', ROUTING)).toBe(ROUTING.deep)
    expect(modelFor('analyst', ROUTING)).toBe(ROUTING.quick)
    expect(modelFor('research', ROUTING)).toBe(ROUTING.quick)
    expect(modelFor('risk', ROUTING)).toBe(ROUTING.quick)
  })

  it('builds a restrict() allow-list limited to implemented tools', () => {
    const analyst = restrictFor('analyst', IMPLEMENTED_TOOL_NAMES)
    expect(analyst.allow).toContain('trade_market')
    expect(analyst.allow).not.toContain('trade_derivatives')

    const judge = restrictFor('judge', IMPLEMENTED_TOOL_NAMES)
    expect(judge.allow).toContain('trade_execute_order')
    expect(judge.allow).not.toContain('trade_workflow_run')
  })
})
