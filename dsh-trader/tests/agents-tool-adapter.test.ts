import { describe, expect, it } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent, CreateAgentOptions, ResumeAgentOptions } from '@deepseek-ai/dsh-agent'
import type { ToolRestriction } from '@deepseek-ai/dsh-tools'
import {
  IMPLEMENTED_TOOL_NAMES,
  type ToolDefinition,
  type ToolPorts,
} from '../src/agents/tools.js'
import { ROLE_SPECS, SIDE_EFFECT_TOOLS } from '../src/agents/roles.js'
import { setupRoleToolRestriction, toDshTool, toolNamesFor } from '../src/plugins/tools-adapter.js'
import { DESK_TOOL_NAMES } from '../src/plugins/tools-desk.js'
import { RUNTIME_IMPLEMENTED_TOOL_NAMES } from '../src/agents/tool-roster.js'
import { RESEARCH_TOOL_NAMES } from '../src/plugins/tools-research.js'
import { RISK_TOOL_NAMES } from '../src/plugins/tools-risk.js'
import { deskAgentLifecycleOptions } from '../src/plugins/supervisor.js'
import type { TradePorts } from '../src/exec/ports.js'

function definition(
  parameters: Readonly<Record<string, unknown>> = {},
  execute: ToolDefinition['execute'] = async () => ({ ok: true }),
): ToolDefinition {
  return {
    name: 'test_adapter_tool',
    description: 'adapter test',
    sideEffect: false,
    parameters,
    execute,
  }
}

describe('agents tool adapter', () => {
  it('maps scalar, enum, required, and string-array parameters without losing schema data', () => {
    const tool = toDshTool(
      definition({
        text: { type: 'string', required: true, description: 'text input' },
        amount: { type: 'number', enum: [1, 2] },
        enabled: { type: 'boolean', required: true },
        mode: { type: 'string', enum: ['fast', 'safe'] },
        tags: { type: 'array', items: { type: 'string' } },
      }),
      { portsProvider: () => undefined },
    )

    const parameters = tool.parameters as {
      readonly properties: Readonly<Record<string, unknown>>
      readonly required?: readonly string[]
    }
    expect(Object.keys(parameters.properties)).toHaveLength(5)
    expect(parameters.properties.text).toMatchObject({
      type: 'string',
      description: 'text input',
    })
    expect(parameters.properties.amount).toMatchObject({ type: 'number', enum: [1, 2] })
    expect(parameters.properties.enabled).toMatchObject({ type: 'boolean' })
    expect(parameters.properties.mode).toMatchObject({ type: 'string', enum: ['fast', 'safe'] })
    expect(parameters.properties.tags).toMatchObject({ type: 'array', items: { type: 'string' } })
    expect(parameters.required).toEqual(['text', 'enabled'])
  })

  it('rejects an unrecognized schema shape instead of silently weakening it', () => {
    expect(() =>
      toDshTool(
        definition({ value: { type: 'not-a-json-type' } }),
        { portsProvider: () => undefined },
      ),
    ).toThrow(/type/)
  })

  it('renders both string and object results as text blocks', () => {
    const tool = toDshTool(definition(), { portsProvider: () => undefined })

    expect(tool.output.render({}, 'done')).toEqual([{ type: 'text', text: 'done' }])
    expect(tool.output.render({}, { accepted: true })).toEqual([
      { type: 'text', text: '{"accepted":true}' },
    ])
  })

  it('fails closed with a readable error when the execution ports are not ready', async () => {
    const tool = toDshTool(definition(), { portsProvider: () => undefined })

    await expect(tool.execute({}, {} as never)).rejects.toThrow('交易组合根尚未就绪，请稍后重试')
  })

  it('resolves ready ports at execution time and forwards args to the original definition', async () => {
    const ports = {} as TradePorts
    let receivedArgs: Readonly<Record<string, unknown>> | undefined
    let receivedPorts: ToolPorts | undefined
    const tool = toDshTool(
      definition(
        { payload: { type: 'string', required: true } },
        async (args, resolvedPorts) => {
          receivedArgs = args
          receivedPorts = resolvedPorts
          return { forwarded: true }
        },
      ),
      { portsProvider: () => ports },
    )

    await expect(tool.execute({ payload: 'hello' }, {} as never)).resolves.toEqual({ forwarded: true })
    expect(receivedArgs).toEqual({ payload: 'hello' })
    expect(receivedPorts).toBe(ports)
  })
})

describe('tool rosters', () => {
  it('keeps read-only roles free of every side-effect tool', () => {
    const implemented = toolNamesFor('research', IMPLEMENTED_TOOL_NAMES)
    expect(implemented.length).toBeGreaterThan(0)
    expect(implemented.some((name) => SIDE_EFFECT_TOOLS.includes(name as never))).toBe(false)
    expect(ROLE_SPECS.research.allowsSideEffects).toBe(false)
  })

  it('partitions all implemented tools into disjoint plugin registration rosters', () => {
    const research = [...RESEARCH_TOOL_NAMES]
    const risk = [...RISK_TOOL_NAMES]
    const desk = [...DESK_TOOL_NAMES]
    const rosters = [research, risk, desk]

    expect(IMPLEMENTED_TOOL_NAMES.length).toBeGreaterThan(0)
    for (const roster of rosters) expect(roster.length).toBeGreaterThan(0)

    const overlap = (left: readonly string[], right: readonly string[]): string[] =>
      left.filter((name) => right.includes(name))
    expect(overlap(research, risk)).toEqual([])
    expect(overlap(research, desk)).toEqual([])
    expect(overlap(risk, desk)).toEqual([])

    const union = [...new Set(rosters.flat())].sort()
    expect(union).toEqual([...RUNTIME_IMPLEMENTED_TOOL_NAMES].sort())
  })
})

describe('runtime role restrictions (T2.8)', () => {
  interface RestrictCapture {
    readonly filters: ToolRestriction[]
  }

  function scopedContext(capture: RestrictCapture): Context {
    return {
      tools: {
        restrict(filter: ToolRestriction): () => void {
          capture.filters.push(filter)
          return () => undefined
        },
      },
    } as unknown as Context
  }

  const agent = { id: 'runtime-permissions-test' } as unknown as Agent

  it('captures and executes the same restriction setup from create and resume options', async () => {
    const lifecycle = deskAgentLifecycleOptions({
      sessionId: 'desk-session',
      agentOptions: { provider: 'test-provider', model: 'test-model' },
      deskCwd: '/workspace/dsh-trader',
      availableToolNames: [...IMPLEMENTED_TOOL_NAMES, 'trade_workflow_run'],
    })
    const captured: Array<CreateAgentOptions | ResumeAgentOptions> = []
    const capture: RestrictCapture = { filters: [] }
    const scope = scopedContext(capture)

    // 模拟 AgentRegistry 的两个真实入口：分别捕获 options，再执行 factory 提供的 setup。
    const invoke = async (options: CreateAgentOptions | ResumeAgentOptions): Promise<void> => {
      captured.push(options)
      await options.setup?.(scope, agent)
    }
    await invoke(lifecycle.resume)
    await invoke(lifecycle.create)

    expect(captured).toHaveLength(2)
    expect(captured[0]!.setup).toBe(captured[1]!.setup)
    expect(capture.filters).toHaveLength(2)
    expect(capture.filters[0]).toEqual(capture.filters[1])
    expect(capture.filters[0]!.allow).toContain('trade_plan_card')
    expect(capture.filters[0]!.allow).toContain('trade_workflow_run')
    expect(capture.filters[0]!.allow).not.toContain('trade_execute_order')
  })

  it('keeps every read-only role helper free of every side-effect tool', async () => {
    const readOnlyRoles = ['analyst', 'research', 'trader', 'risk', 'meta'] as const
    const capture: RestrictCapture = { filters: [] }
    const scope = scopedContext(capture)

    for (const role of readOnlyRoles) {
      const setup = setupRoleToolRestriction(role, IMPLEMENTED_TOOL_NAMES)
      await setup(scope, agent)
    }

    expect(capture.filters).toHaveLength(readOnlyRoles.length)
    for (const filter of capture.filters) {
      const allowed = filter.allow ?? []
      expect(SIDE_EFFECT_TOOLS.some((tool) => allowed.includes(tool))).toBe(false)
    }
  })
})
