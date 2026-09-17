/**
 * 把 agents 层的纯工具定义接到 DSH 工具注册表。
 *
 * 适配层不组装执行组合根：插件可能早于 trade-exec 加载，端口必须在真正
 * 执行工具时再解析，否则一个启动顺序的竞态就会把工具永久绑定到 undefined。
 */

import { defineTool, type ParameterSchemaSpec, type ValueSchemaSpec } from '@deepseek-ai/dsh-tools'
import type { Context } from '@deepseek-ai/cordis'
import type { AgentSetup } from '@deepseek-ai/dsh-agent'
import {
  IMPLEMENTED_TOOL_NAMES,
  TOOL_DEFINITIONS,
  type ToolDefinition,
} from '../agents/tools.js'
import { restrictFor, ROLE_SPECS, SIDE_EFFECT_TOOLS, type RoleName } from '../agents/roles.js'
import type { TradePorts } from '../exec/ports.js'

export interface DshToolAdapterOptions {
  readonly portsProvider: () => TradePorts | undefined
}

type RecordValue = Record<string, unknown>
type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue }

function isRecord(value: unknown): value is RecordValue {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function invalidSchema(path: string, reason: string): never {
  throw new TypeError(`工具参数 schema ${path} 无效：${reason}`)
}

function copyDescription(raw: RecordValue, path: string): { readonly description?: string } {
  const value = raw.description
  if (value === undefined) return {}
  if (typeof value !== 'string') invalidSchema(path, 'description 必须是字符串')
  return { description: value }
}

function copyRequired(raw: RecordValue, path: string): { readonly required?: true } {
  const value = raw.required
  if (value === undefined || value === false) return {}
  if (value !== true) invalidSchema(path, 'required 必须是布尔值')
  return { required: true }
}

function assertKnownKeys(raw: RecordValue, path: string, allowRequired: boolean): void {
  const allowed = new Set(allowRequired
    ? ['type', 'required', 'description', 'enum', 'items']
    : ['type', 'description', 'enum', 'items'])
  const unknown = Object.keys(raw).find((key) => !allowed.has(key))
  if (unknown !== undefined) invalidSchema(path, `不认识的字段 ${unknown}`)
}

function copyEnum(raw: RecordValue, type: 'string' | 'number' | 'boolean', path: string):
  | { readonly enum?: readonly string[] }
  | { readonly enum?: readonly number[] }
  | { readonly enum?: readonly boolean[] } {
  const value = raw.enum
  if (value === undefined) return {}
  if (!Array.isArray(value)) invalidSchema(path, 'enum 必须是数组')

  for (const item of value) {
    const valid =
      (type === 'string' && typeof item === 'string') ||
      (type === 'number' && typeof item === 'number' && Number.isFinite(item)) ||
      (type === 'boolean' && typeof item === 'boolean')
    if (!valid) invalidSchema(path, `enum 元素必须匹配 type=${type}`)
  }

  if (type === 'string') return { enum: value as readonly string[] }
  if (type === 'number') return { enum: value as readonly number[] }
  return { enum: value as readonly boolean[] }
}

function mapValueSchema(raw: unknown, path: string, allowRequired = false): ValueSchemaSpec {
  if (!isRecord(raw)) invalidSchema(path, '必须是对象')
  assertKnownKeys(raw, path, allowRequired)

  const type = raw.type
  if (type === 'array') {
    const items = raw.items
    if (items === undefined) {
      const description = copyDescription(raw, path)
      if (Object.hasOwn(raw, 'enum')) invalidSchema(path, 'array 不支持 enum')
      return { type: 'array', ...copyRequired(raw, path), ...description }
    }
    const description = copyDescription(raw, path)
    if (Object.hasOwn(raw, 'enum')) invalidSchema(path, 'array 不支持 enum')
    return {
      type: 'array',
      ...copyRequired(raw, path),
      ...description,
      items: mapValueSchema(items, `${path}.items`),
    }
  }

  if (type !== 'string' && type !== 'number' && type !== 'boolean') {
    invalidSchema(path, 'type 必须是 string、number、boolean 或 array')
  }

  if (Object.hasOwn(raw, 'items')) invalidSchema(path, `${type} 不支持 items`)
  return {
    type,
    ...(allowRequired ? copyRequired(raw, path) : {}),
    ...copyDescription(raw, path),
    ...copyEnum(raw, type, path),
  } as ValueSchemaSpec
}

function toParameterSchema(parameters: Readonly<Record<string, unknown>>): ParameterSchemaSpec {
  const mapped: Record<string, ValueSchemaSpec & { readonly required?: true }> = {}
  for (const [key, value] of Object.entries(parameters)) {
    if (!isRecord(value)) invalidSchema(key, '参数定义必须是对象')
    mapped[key] = mapValueSchema(value, key, true) as ValueSchemaSpec & { readonly required?: true }
  }
  return mapped
}

/** 把一个纯 ToolDefinition 变成 DSH registry 可接受的定义。 */
export function toDshTool(def: ToolDefinition, options: DshToolAdapterOptions) {
  const parameters = toParameterSchema(def.parameters)
  return defineTool({
    name: def.name,
    description: def.description,
    parameters,
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (_args, value) => [{
        type: 'text',
        text: typeof value === 'string' ? value : JSON.stringify(value) ?? 'null',
      }],
    },
    async execute(args) {
      const ports = options.portsProvider()
      if (ports === undefined) throw new Error('交易组合根尚未就绪，请稍后重试')
      return (await def.execute(args as Readonly<Record<string, unknown>>, ports)) as Record<string, JsonValue>
    },
  })
}

/** 按角色收窄已实现工具，并在只读角色上做副作用硬断言。 */
export function toolNamesFor(role: RoleName, implementedTools: readonly string[]): readonly string[] {
  const spec = ROLE_SPECS[role]
  const sideEffectSet = new Set<string>(SIDE_EFFECT_TOOLS)
  const forbidden = spec.tools.filter((name) => sideEffectSet.has(name))
  if (!spec.allowsSideEffects && forbidden.length > 0) {
    throw new Error(`只读角色 ${role} 不得注册副作用工具：${forbidden.join(', ')}`)
  }
  const implemented = new Set(implementedTools)
  return spec.tools.filter((name) => implemented.has(name))
}

/** 插件名册统一从已实现集合取交集，避免把诚实清单里的占位工具暴露给模型。 */
export function implementedToolNames(names: readonly string[]): readonly string[] {
  const implemented = new Set(IMPLEMENTED_TOOL_NAMES)
  return names.filter((name) => implemented.has(name))
}

/**
 * 为真实 agent 组合一份角色级工具限制。
 *
 * 该限制必须装在 agent 的 scoped context 上：全局 `ctx.tools.restrict()` 会把所有
 * agent 一起遮掉。调用方传入当前真正可用的工具集合（例如 T2.9 接线后可包含
 * workflow 专用工具）；把白名单在 setup 创建时冻结，并让 create/resume 复用同一闭包，
 * 可避免恢复路径忘记收窄而意外继承全局工具（plan §5.4/T2.8）。
 */
export function setupRoleToolRestriction(
  role: RoleName,
  implementedTools: readonly string[],
): AgentSetup {
  const restriction = restrictFor(role, implementedTools)
  return (agentCtx) => {
    agentCtx.tools.restrict(restriction)
  }
}

/** 在 effect 中注册并保留每个注册动作的精确注销句柄。 */
export function registerToolSet(
  ctx: Context,
  names: readonly string[],
  options: DshToolAdapterOptions,
  label: string,
): void {
  ctx.effect(() => {
    const unregister: Array<() => void> = []
    try {
      for (const name of names) {
        const def = TOOL_DEFINITIONS.find((candidate) => candidate.name === name)
        if (def === undefined) throw new Error(`工具名册引用了未实现工具：${name}`)
        unregister.push(ctx.tools.register(toDshTool(def, options)))
      }
    } catch (error) {
      for (const dispose of unregister.reverse()) dispose()
      throw error
    }
    return () => {
      for (const dispose of unregister.reverse()) dispose()
    }
  }, label)
}
