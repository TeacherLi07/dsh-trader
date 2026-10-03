/** Sub2API Responses WS v2 的独立 DSH LLM adapter。 */

import type { Context } from '@deepseek-ai/cordis'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import {
  LlmAdapter,
  LlmError,
  ReasoningEffortId,
  ToolCallId,
  assertUsableApiKey,
  attributionHeaders,
  resolveRetryPolicy,
  type GenerateOptions,
  type LlmModelInfo,
  type LlmProviderInfo,
  type LlmResolvedModelInfo,
  type ResolvedRetryPolicy,
  type StreamChunk,
  type TokenUsage,
} from '@deepseek-ai/dsh-llm'
import {
  convertResponsesMessages,
  convertResponsesTools,
  processResponsesStream,
} from '@earendil-works/pi-ai/api/openai-responses-shared'
import { AssistantMessageEventStream } from '@earendil-works/pi-ai/utils/event-stream'
import type {
  AssistantMessage,
  AssistantMessageEvent,
  Context as PiAiContext,
  Model as PiAiModel,
  Usage as PiAiUsage,
} from '@earendil-works/pi-ai'
import OpenAI from 'openai'
import { ResponsesWS } from 'openai/resources/responses/ws'
import type { ResponsesWSBaseOptions } from 'openai/resources/responses/ws-base'
import type { ClientOptions } from 'ws'
import { HttpsProxyAgent } from 'https-proxy-agent'
import type {
  ResponseStreamEvent,
  ResponsesClientEvent,
} from 'openai/resources/responses/responses'
import z from '@deepseek-ai/schemastery'
import { systemClock } from '../clock.js'

export const name = 'llm-sub2api-responses-ws'
export const inject = ['llm', 'credentials']

export const SUB2API_RESPONSES_WS_PROVIDER = 'sub2api-openai-ws' as const
const OPENAI_RESPONSES_WS_BETA = 'responses_websockets=2026-02-06'
const ALLOWED_REASONING_EFFORTS = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const

export type ResponsesReasoningEffort = (typeof ALLOWED_REASONING_EFFORTS)[number]

export interface Sub2ApiWsModelConfig {
  readonly id: string
  /** 来源 alias 与上游 ID 分离，避免同名模型被错误归入官方价目。 */
  readonly wireModelId: string
  readonly name: string
  readonly contextWindow: number
  readonly maxTokens: number
  readonly reasoningEfforts: readonly ResponsesReasoningEffort[]
  readonly defaultReasoningEffort?: ResponsesReasoningEffort
}

export interface Sub2ApiResponsesWsConfig {
  readonly enabled: boolean
  /** Sub2API 配置使用 bare host；为兼容官方 SDK 统一补上 /v1。 */
  readonly baseURL: string
  /** 仅携带凭据引用，防止配置包含实际密钥。 */
  readonly apiKeyEnv: string
  readonly connectTimeoutMs: number
  readonly models: readonly Sub2ApiWsModelConfig[]
}

const modelSchema = z.object({
  id: z.string().required(),
  wireModelId: z.string().required(),
  name: z.string().required(),
  contextWindow: z.number().required(),
  maxTokens: z.number().required(),
  reasoningEfforts: z.array(z.string()).default([]),
  defaultReasoningEffort: z.string(),
})

export const Config = z.object({
  enabled: z.boolean().default(false),
  baseURL: z.string().default(''),
  apiKeyEnv: z.string().default('SUB2API_KEY'),
  connectTimeoutMs: z.number().default(10_000),
  models: z.array(modelSchema).default([]),
})

interface ProviderDependencies {
  readonly resolveApiKey: () => Promise<string | undefined>
  readonly now: () => number
}

interface SocketStreamEvent {
  readonly type: string
  readonly message?: ResponseStreamEvent
  readonly error?: unknown
}

interface ResolvedSub2ApiWsModel extends Sub2ApiWsModelConfig {}

function normalizeBaseURL(raw: string): string {
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    throw new Error('Sub2API WebSocket provider baseURL 必须是 URL')
  }
  const localHttp = url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]', '::1'].includes(url.hostname)
  if (url.protocol !== 'https:' && !localHttp) throw new Error('Sub2API WebSocket provider 只允许 HTTPS（本机测试可用 HTTP）')
  if (url.username !== '' || url.password !== '' || url.search !== '' || url.hash !== '') {
    throw new Error('Sub2API WebSocket provider baseURL 不得包含凭据、query 或 hash')
  }
  const path = url.pathname.replace(/\/$/, '')
  if (path === '') url.pathname = '/v1'
  else if (!path.endsWith('/v1')) throw new Error('Sub2API WebSocket provider baseURL 必须是 bare host 或以 /v1 结尾')
  return url.toString().replace(/\/$/, '')
}

function isLoopback(hostname: string): boolean {
  return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1' || hostname === '[::1]'
}

function matchesNoProxy(hostname: string, port: string, raw: string | undefined): boolean {
  if (raw === undefined || raw.trim() === '') return false
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, '')
  return raw.split(/[\s,]+/).some((entry) => {
    const rule = entry.trim().toLowerCase()
    if (rule === '' || rule === '*') return rule === '*'
    let ruleHost = rule
    let rulePort = ''
    if (rule.startsWith('[')) {
      const end = rule.indexOf(']')
      if (end >= 0) {
        ruleHost = rule.slice(1, end)
        rulePort = rule.slice(end + 1).replace(/^:/, '')
      }
    } else {
      const separator = rule.lastIndexOf(':')
      if (separator > 0 && /^\d+$/.test(rule.slice(separator + 1))) {
        ruleHost = rule.slice(0, separator)
        rulePort = rule.slice(separator + 1)
      }
    }
    ruleHost = ruleHost.replace(/^\./, '').replace(/^\[|\]$/g, '')
    const hostMatches = host === ruleHost || host.endsWith(`.${ruleHost}`)
    return hostMatches && (rulePort === '' || rulePort === port)
  })
}

export function resolveResponsesWebSocketProxy(baseURL: string, environment: NodeJS.ProcessEnv = process.env): string | undefined {
  const target = new URL(baseURL)
  const targetPort = target.port || (target.protocol === 'https:' ? '443' : '80')
  if (isLoopback(target.hostname) || matchesNoProxy(target.hostname, targetPort, environment.NO_PROXY ?? environment.no_proxy)) return undefined
  const proxy = environment.HTTPS_PROXY ?? environment.https_proxy ?? environment.ALL_PROXY ?? environment.all_proxy
  if (proxy === undefined || proxy.trim() === '') return undefined
  return proxy
}

function websocketProxyAgent(baseURL: string): HttpsProxyAgent<string> | undefined {
  const proxy = resolveResponsesWebSocketProxy(baseURL)
  if (proxy === undefined) return undefined
  try {
    return new HttpsProxyAgent(proxy)
  } catch {
    // 不把可能含认证信息的代理 URL 放进任何错误文本。
    throw new LlmError('HTTPS proxy configuration is invalid for the Sub2API WebSocket route', 'INVALID_CONFIG')
  }
}

function validateModels(models: readonly Sub2ApiWsModelConfig[]): ReadonlyMap<string, ResolvedSub2ApiWsModel> {
  if (models.length === 0) throw new Error('Sub2API WebSocket provider enabled 时必须声明非空 models')
  const result = new Map<string, ResolvedSub2ApiWsModel>()
  for (const model of models) {
    if (!model.id.startsWith('sub2api:') || model.id.length <= 'sub2api:'.length) {
      throw new Error('Sub2API provider model id 必须使用 sub2api:<gateway-model> 命名空间')
    }
    if (model.wireModelId.trim() === '' || model.name.trim() === '') throw new Error('Sub2API provider model wireModelId/name 不能为空')
    for (const [field, value] of Object.entries({ contextWindow: model.contextWindow, maxTokens: model.maxTokens })) {
      if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`Sub2API provider model ${field} 必须是正整数`)
    }
    if (result.has(model.id)) throw new Error(`Sub2API provider model id 重复：${model.id}`)
    const efforts = [...new Set(model.reasoningEfforts)]
    for (const effort of efforts) {
      if (!(ALLOWED_REASONING_EFFORTS as readonly string[]).includes(effort)) {
        throw new Error(`Sub2API provider model reasoning effort 不支持：${effort}`)
      }
    }
    if (model.defaultReasoningEffort !== undefined && !efforts.includes(model.defaultReasoningEffort)) {
      throw new Error(`Sub2API provider model defaultReasoningEffort 必须出现在 reasoningEfforts 中：${model.id}`)
    }
    result.set(model.id, { ...model, reasoningEfforts: efforts })
  }
  return result
}

function piModel(model: ResolvedSub2ApiWsModel, baseURL: string): PiAiModel<'openai-responses'> {
  return {
    // pi-ai 用 wire ID 构造输入/输出事件；DSH route 使用 sub2api: alias 查价。
    id: model.wireModelId,
    name: model.name,
    api: 'openai-responses',
    provider: 'openai',
    baseUrl: baseURL,
    reasoning: model.reasoningEfforts.some((effort) => effort !== 'none'),
    thinkingLevelMap: Object.fromEntries(model.reasoningEfforts.map((effort) => [effort === 'none' ? 'off' : effort, effort])),
    input: ['text'],
    // pi-ai 的临时响应对象要求 cost 描述；此值不离开 adapter，项目账本仍独立按 route model 查价。
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: model.contextWindow,
    maxTokens: model.maxTokens,
  }
}

function flattenText(blocks: readonly GenerateOptions['messages'][number]['content'][number][]): string {
  return blocks.map((block) => {
    if (block.type !== 'text') throw new LlmError('Sub2API Responses WS route does not support image or file content', 'UNSUPPORTED_CONTENT')
    return block.text
  }).join('')
}

function flattenToolResult(blocks: readonly GenerateOptions['messages'][number]['content'][number][]): string {
  return blocks.map((block) => {
    if (block.type === 'text') return block.text
    if (block.type === 'tool-result') return flattenToolResult(block.content)
    throw new LlmError('Sub2API Responses WS route does not support image or file tool results', 'UNSUPPORTED_CONTENT')
  }).join('')
}

function emptyPiUsage(): PiAiUsage {
  return {
    input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  }
}

/** 与官方 DSH pi-ai adapter 相同地映射 system/user/assistant/tool-result history。 */
function toPiAiContext(options: GenerateOptions): PiAiContext {
  let systemPrompt = options.system
  let sourceMessages = options.messages
  if (systemPrompt === undefined && sourceMessages[0]?.role === 'system') {
    systemPrompt = flattenText(sourceMessages[0].content)
    sourceMessages = sourceMessages.slice(1)
  }
  const messages: PiAiContext['messages'] = []
  const toolNames = new Map<string, string>()
  for (const message of sourceMessages) {
    if (message.role === 'system') {
      messages.push({ role: 'user', content: flattenText(message.content), timestamp: 0 })
      continue
    }
    if (message.role === 'assistant') {
      const content: AssistantMessage['content'] = message.content.map((block) => {
        switch (block.type) {
          case 'text': return { type: 'text', text: block.text }
          case 'reasoning': return { type: 'thinking', thinking: block.text }
          case 'tool-call': {
            let args: unknown
            try {
              args = block.arguments === '' ? {} : JSON.parse(block.arguments)
            } catch {
              throw new LlmError('Sub2API Responses WS assistant history has invalid tool-call JSON', 'INVALID_REQUEST')
            }
            if (typeof args !== 'object' || args === null || Array.isArray(args)) {
              throw new LlmError('Sub2API Responses WS assistant tool-call arguments must be a JSON object', 'INVALID_REQUEST')
            }
            toolNames.set(String(block.id), block.name)
            return { type: 'toolCall', id: String(block.id), name: block.name, arguments: args as Record<string, unknown> }
          }
          default:
            throw new LlmError('Sub2API Responses WS assistant history contains unsupported content', 'UNSUPPORTED_CONTENT')
        }
      })
      const hasToolCall = content.some((block) => block.type === 'toolCall')
      const source = message.source.kind === 'model' ? message.source : undefined
      messages.push({
        role: 'assistant', content, api: 'dsh-foreign',
        provider: source?.provider ?? 'dsh-foreign', model: source?.model ?? 'dsh-foreign',
        usage: emptyPiUsage(), stopReason: hasToolCall ? 'toolUse' : 'stop', timestamp: 0,
      })
      continue
    }
    const text = flattenText(message.content.filter((block) => block.type !== 'tool-result'))
    const results = message.content.filter((block) => block.type === 'tool-result')
    if (text.length > 0 || results.length === 0) messages.push({ role: 'user', content: text, timestamp: 0 })
    for (const result of results) {
      const toolCallId = String(result.toolCallId)
      messages.push({
        role: 'toolResult', toolCallId, toolName: toolNames.get(toolCallId) ?? 'unknown',
        content: [{ type: 'text', text: flattenToolResult(result.content) || '(no output)' }],
        isError: result.isError ?? false, timestamp: 0,
      })
    }
  }
  return {
    ...(systemPrompt === undefined ? {} : { systemPrompt }),
    messages,
    ...(options.tools === undefined ? {} : { tools: options.tools.map((tool) => ({ ...tool })) }),
  }
}

function isNonnegativeSafeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && typeof value === 'number' && value >= 0
}

function verifiedResponseUsage(value: unknown): TokenUsage | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
  const usage = value as Record<string, unknown>
  const input = usage['input_tokens']
  const output = usage['output_tokens']
  const total = usage['total_tokens']
  const inputDetails = usage['input_tokens_details']
  const outputDetails = usage['output_tokens_details']
  if (!isNonnegativeSafeInteger(input) || !isNonnegativeSafeInteger(output) || !isNonnegativeSafeInteger(total)) return undefined
  if (total !== input + output || typeof inputDetails !== 'object' || inputDetails === null || Array.isArray(inputDetails)) return undefined
  const cached = (inputDetails as Record<string, unknown>)['cached_tokens']
  if (!isNonnegativeSafeInteger(cached) || cached > input) return undefined
  const cacheWriteValue = (inputDetails as Record<string, unknown>)['cache_write_tokens']
  const cacheWrite = cacheWriteValue === undefined ? 0 : cacheWriteValue
  if (!isNonnegativeSafeInteger(cacheWrite) || cached + cacheWrite > input) return undefined
  let reasoningTokens: number | undefined
  if (outputDetails !== undefined) {
    if (typeof outputDetails !== 'object' || outputDetails === null || Array.isArray(outputDetails)) return undefined
    const reasoning = (outputDetails as Record<string, unknown>)['reasoning_tokens']
    if (reasoning !== undefined) {
      if (!isNonnegativeSafeInteger(reasoning) || reasoning > output) return undefined
      reasoningTokens = reasoning
    }
  }
  return {
    inputTokens: input - cached - cacheWrite,
    outputTokens: output,
    totalTokens: total,
    ...(cached === 0 ? {} : { cacheReadTokens: cached }),
    ...(cacheWrite === 0 ? {} : { cacheWriteTokens: cacheWrite }),
    ...(reasoningTokens === undefined || reasoningTokens === 0 ? {} : { reasoningTokens }),
  }
}

function redactSecret(message: string, secret: string): string {
  return secret.length === 0 ? message : message.split(secret).join('[redacted]').split(encodeURIComponent(secret)).join('[redacted]')
}

function chunksFromPiEvent(
  event: AssistantMessageEvent,
  input: { readonly authoritativeUsage?: TokenUsage; readonly failureCode: string },
): readonly StreamChunk[] {
  switch (event.type) {
    case 'start':
      return []
    case 'text_start':
      return [{ type: 'block-start', index: event.contentIndex, blockType: 'text' }]
    case 'text_delta':
      return [{ type: 'text-delta', index: event.contentIndex, text: event.delta }]
    case 'text_end':
      return [{ type: 'block-end', index: event.contentIndex, block: { type: 'text', text: event.content } }]
    case 'thinking_start':
      return [{ type: 'block-start', index: event.contentIndex, blockType: 'reasoning' }]
    case 'thinking_delta':
      return [{ type: 'reasoning-delta', index: event.contentIndex, text: event.delta }]
    case 'thinking_end':
      return [{ type: 'block-end', index: event.contentIndex, block: { type: 'reasoning', text: event.content } }]
    case 'toolcall_start': {
      const partial = event.partial.content[event.contentIndex]
      if (partial?.type !== 'toolCall' || partial.id === '' || partial.name === '') {
        throw new LlmError('Responses WS returned a tool call without stable identity', 'INVALID_RESPONSE')
      }
      return [{ type: 'block-start', index: event.contentIndex, blockType: 'tool-call' }]
    }
    case 'toolcall_delta': {
      const partial = event.partial.content[event.contentIndex]
      if (partial?.type !== 'toolCall' || partial.id === '') throw new LlmError('Responses WS tool-call delta lost its identity', 'INVALID_RESPONSE')
      return [{
        type: 'tool-call-delta', index: event.contentIndex, id: ToolCallId(partial.id),
        ...(partial.name === '' ? {} : { name: partial.name }), argumentsDelta: event.delta,
      }]
    }
    case 'toolcall_end':
      return [{
        type: 'block-end', index: event.contentIndex,
        block: {
          type: 'tool-call', id: ToolCallId(event.toolCall.id), name: event.toolCall.name,
          arguments: JSON.stringify(event.toolCall.arguments ?? {}),
        },
      }]
    case 'done':
      if (event.reason === 'deferred') throw new LlmError('Sub2API Responses deferred output is unsupported', 'UNSUPPORTED_RESPONSE')
      return [
        ...(input.authoritativeUsage === undefined ? [] : [{ type: 'usage' as const, usage: input.authoritativeUsage }]),
        { type: 'finish', reason: event.reason === 'length' ? { kind: 'max-tokens' } : event.reason === 'toolUse' ? { kind: 'tool-calls' } : { kind: 'stop' } },
      ]
    case 'error':
      if (input.failureCode === 'OUTCOME_UNKNOWN') {
        return [{ type: 'finish', reason: { kind: 'error', failure: { code: input.failureCode, message: event.error.errorMessage ?? 'Sub2API WebSocket outcome unresolved' } } }]
      }
      return [{
        type: 'finish',
        reason: event.reason === 'aborted'
          ? { kind: 'aborted', failure: { code: 'ABORTED', message: 'Sub2API WebSocket request aborted' } }
          : { kind: 'error', failure: { code: input.failureCode, message: event.error.errorMessage ?? 'Sub2API WebSocket request failed' } },
      }]
  }
}

function responseIsTerminal(event: ResponseStreamEvent): boolean {
  return event.type === 'response.completed' || event.type === 'response.incomplete' || event.type === 'response.failed'
}

function makeResponseCreateEvent(
  options: GenerateOptions,
  configuredModel: ResolvedSub2ApiWsModel,
  model: PiAiModel<'openai-responses'>,
): ResponsesClientEvent {
  const context = toPiAiContext(options)
  const input = convertResponsesMessages(model, context, new Set(['openai']))
  const tools = context.tools === undefined ? [] : convertResponsesTools(context.tools, { supportsStrictMode: false })
  const effort = options.reasoningEffort?.toString() ?? configuredModel.defaultReasoningEffort
  if (effort !== undefined && !configuredModel.reasoningEfforts.includes(effort as ResponsesReasoningEffort)) {
    throw new LlmError(`Sub2API model does not support requested reasoning effort ${effort}`, 'UNSUPPORTED_REASONING_EFFORT')
  }
  const reasoningEnabled = effort !== undefined && effort !== 'none'
  // SDK 联合类型可能落后于网关支持的值，因此保留经过配置白名单验证的原始 wire 值。
  const reasoning = effort === undefined
    ? undefined
    : { effort: effort as unknown as NonNullable<ResponsesClientEvent['reasoning']>['effort'] }
  return {
    type: 'response.create',
    model: configuredModel.wireModelId,
    input,
    store: false,
    truncation: 'disabled',
    max_output_tokens: options.maxTokens ?? configuredModel.maxTokens,
    ...(options.temperature === undefined || reasoningEnabled ? {} : { temperature: options.temperature }),
    ...(tools.length === 0 ? {} : { tools, tool_choice: 'required', parallel_tool_calls: false }),
    ...(reasoning === undefined ? {} : { reasoning }),
  }
}

export class Sub2ApiResponsesWebSocketAdapter extends LlmAdapter {
  readonly #baseURL: string
  readonly #apiKeyEnv: string
  readonly #connectTimeoutMs: number
  readonly #models: ReadonlyMap<string, ResolvedSub2ApiWsModel>
  readonly #resolveApiKey: ProviderDependencies['resolveApiKey']
  readonly #now: ProviderDependencies['now']
  readonly #retryPolicy: ResolvedRetryPolicy

  constructor(config: Sub2ApiResponsesWsConfig, dependencies: ProviderDependencies) {
    super()
    this.#baseURL = normalizeBaseURL(config.baseURL)
    this.#apiKeyEnv = config.apiKeyEnv
    this.#connectTimeoutMs = config.connectTimeoutMs
    this.#models = validateModels(config.models)
    this.#resolveApiKey = dependencies.resolveApiKey
    this.#now = dependencies.now
    this.#retryPolicy = resolveRetryPolicy({ mode: 'normal', maxRetries: 0 }, `${SUB2API_RESPONSES_WS_PROVIDER}.retryPolicy`)
  }

  override providerInfo(provider: string): LlmProviderInfo {
    if (provider !== SUB2API_RESPONSES_WS_PROVIDER) throw new LlmError(`Sub2API WebSocket adapter does not own ${provider}`, 'NO_ADAPTER')
    return { id: provider, name: 'Sub2API OpenAI Responses WebSocket' }
  }

  override providerRetryPolicy(provider: string): ResolvedRetryPolicy | undefined {
    return provider === SUB2API_RESPONSES_WS_PROVIDER ? this.#retryPolicy : undefined
  }

  override listModels(provider: string): Promise<readonly LlmModelInfo[]> {
    return Promise.resolve().then(() => {
      this.#assertProvider(provider)
      return [...this.#models.values()].map((model) => ({ provider, id: model.id, name: model.name, inputModalities: ['text'] as const }))
    })
  }

  override resolveModel(provider: string, modelId: string): Promise<LlmResolvedModelInfo> {
    return Promise.resolve().then(() => {
      this.#assertProvider(provider)
      const model = this.#models.get(modelId)
      if (model === undefined) throw new LlmError(`Sub2API WebSocket model is not configured: ${modelId}`, 'UNKNOWN_MODEL')
      const efforts = model.reasoningEfforts.map((effort) => ({ id: ReasoningEffortId(effort), name: effort }))
      return {
        provider,
        id: model.id,
        name: model.name,
        inputModalities: ['text'] as const,
        context: { contextWindow: model.contextWindow },
        defaultMaxTokens: model.maxTokens,
        ...(efforts.length === 0 ? {} : { reasoning: {
          efforts,
          ...(model.defaultReasoningEffort === undefined ? {} : { defaultEffort: ReasoningEffortId(model.defaultReasoningEffort) }),
        } }),
      }
    })
  }

  override async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.#assertProvider(options.provider)
    if (options.signal?.aborted) throw new LlmError('Sub2API WebSocket request already aborted before connection', 'ABORTED')
    if (options.stop !== undefined) throw new LlmError('Sub2API Responses WebSocket route does not support stop sequences', 'UNSUPPORTED_OPTION')
    const configuredModel = this.#models.get(options.model)
    if (configuredModel === undefined) throw new LlmError(`Sub2API WebSocket model is not configured: ${options.model}`, 'UNKNOWN_MODEL')

    const resolved = await this.#resolveApiKey()
    if (resolved === undefined) throw new LlmError(`Sub2API credential reference is not configured: ${this.#apiKeyEnv}`, 'MISSING_CREDENTIAL')
    const apiKey = assertUsableApiKey(resolved, name, this.#apiKeyEnv)
    const model = piModel(configuredModel, this.#baseURL)
    const client = new OpenAI({ apiKey, baseURL: this.#baseURL, maxRetries: 0, defaultHeaders: attributionHeaders() })
    const proxyAgent = websocketProxyAgent(this.#baseURL)
    // DSH 会复用全局 SDK；其目录可能没有 @types/ws。用本包的 ClientOptions 保留握手参数校验。
    const socketOptions: ClientOptions & ResponsesWSBaseOptions = {
      reconnect: null,
      maxQueueSize: 0,
      ...(proxyAgent === undefined ? {} : { agent: proxyAgent }),
      headers: { ...attributionHeaders(), 'OpenAI-Beta': OPENAI_RESPONSES_WS_BETA },
    }
    const socket = new ResponsesWS(client, socketOptions)
    const socketEvents = socket.stream()
    const socketIterator = socketEvents[Symbol.asyncIterator]()
    const output: AssistantMessage = {
      role: 'assistant', content: [], api: 'openai-responses', provider: 'openai', model: model.id,
      usage: {
        input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: 'pending', timestamp: this.#now(),
    }
    const assistantEvents = new AssistantMessageEventStream()
    let requestSent = false
    let terminalEvent: ResponseStreamEvent['type'] | undefined
    let authoritativeUsage: TokenUsage | undefined
    let failureCode = 'PROVIDER_ERROR'
    let abortListener: (() => void) | undefined

    const responseEvents = async function* (): AsyncGenerator<ResponseStreamEvent> {
      while (true) {
        const next = await socketIterator.next() as IteratorResult<SocketStreamEvent>
        if (next.done) break
        const raw = next.value
        if (raw.type === 'message' && raw.message !== undefined) {
          if (responseIsTerminal(raw.message)) {
            terminalEvent = raw.message.type
            if (raw.message.type === 'response.completed' || raw.message.type === 'response.incomplete') {
              authoritativeUsage = verifiedResponseUsage(raw.message.response.usage)
            }
          }
          yield raw.message
          if (terminalEvent !== undefined) return
        } else if (raw.type === 'error') {
          failureCode = requestSent ? 'OUTCOME_UNKNOWN' : 'TRANSPORT'
          const detail = redactSecret(raw.error instanceof Error ? raw.error.message : String(raw.error), apiKey)
          throw new LlmError(requestSent
            ? `Sub2API WebSocket failed after response.create; provider outcome and cost are unresolved (${detail})`
            : `Sub2API WebSocket failed before response.create was sent (${detail})`, failureCode)
        } else if (raw.type === 'close') {
          if (terminalEvent === undefined) {
            failureCode = requestSent ? 'OUTCOME_UNKNOWN' : 'TRANSPORT'
            throw new LlmError(requestSent
              ? 'Sub2API WebSocket closed after response.create without a terminal event; provider outcome and cost are unresolved'
              : 'Sub2API WebSocket closed before response.create was sent', failureCode)
          }
          return
        }
      }
      if (terminalEvent === undefined) {
        failureCode = requestSent ? 'OUTCOME_UNKNOWN' : 'TRANSPORT'
        throw new LlmError(requestSent
          ? 'Sub2API WebSocket ended after response.create without a terminal event; provider outcome and cost are unresolved'
          : 'Sub2API WebSocket ended before response.create was sent', failureCode)
      }
    }

    try {
      await waitForSocketOpen(socketIterator, socket, this.#connectTimeoutMs, options.signal)
      if (options.signal?.aborted) throw new LlmError('Sub2API WebSocket request aborted before response.create', 'ABORTED')
      const request = makeResponseCreateEvent(options, configuredModel, model)
      requestSent = true
      socket.send(request)
      abortListener = () => socket.close({ code: 1000, reason: 'caller-aborted' })
      options.signal?.addEventListener('abort', abortListener, { once: true })

      const processing = processResponsesStream(responseEvents(), output, assistantEvents, model)
        .then(() => {
          if (output.stopReason === 'error' || output.stopReason === 'aborted') {
            assistantEvents.push({ type: 'error', reason: output.stopReason, error: output })
          } else {
            assistantEvents.push({ type: 'done', reason: output.stopReason as 'stop' | 'length' | 'toolUse', message: output })
          }
        })
        .catch((error: unknown) => {
          if (terminalEvent === undefined && requestSent) failureCode = 'OUTCOME_UNKNOWN'
          output.stopReason = options.signal?.aborted ? 'aborted' : 'error'
          const detail = error instanceof Error ? error.message : String(error)
          output.errorMessage = terminalEvent === 'response.failed'
            ? `Sub2API returned response.failed: ${redactSecret(detail, apiKey)}`
            : requestSent
              ? `Sub2API WebSocket ended without a confirmed terminal response; provider outcome and cost are unresolved (${redactSecret(detail, apiKey)})`
              : `Sub2API WebSocket request failed before generation was submitted (${redactSecret(detail, apiKey)})`
          assistantEvents.push({ type: 'error', reason: output.stopReason, error: output })
        })

      for await (const event of assistantEvents) {
        for (const chunk of chunksFromPiEvent(event, { authoritativeUsage, failureCode })) yield chunk
      }
      await processing
    } finally {
      if (options.signal !== undefined && abortListener !== undefined) options.signal.removeEventListener('abort', abortListener)
      socket.close({ code: 1000, reason: 'request-finished' })
      proxyAgent?.destroy()
      try {
        await socketIterator.return?.()
      } catch {
        // 关闭后的清理失败不能改写已确定的结果。
      }
    }
  }

  #assertProvider(provider: string): void {
    if (provider !== SUB2API_RESPONSES_WS_PROVIDER) throw new LlmError(`Sub2API WebSocket adapter does not own ${provider}`, 'NO_ADAPTER')
  }
}

async function waitForSocketOpen(
  events: AsyncIterator<SocketStreamEvent>,
  socket: ResponsesWS,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined
  let abortListener: (() => void) | undefined
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      socket.close({ code: 4000, reason: 'connect-timeout' })
      reject(new LlmError(`Sub2API WebSocket connection timed out after ${timeoutMs}ms`, 'TIMEOUT'))
    }, timeoutMs)
  })
  const aborted = new Promise<never>((_resolve, reject) => {
    if (signal === undefined) return
    abortListener = () => {
      socket.close({ code: 1000, reason: 'caller-aborted' })
      reject(new LlmError('Sub2API WebSocket connection aborted before request submission', 'ABORTED'))
    }
    signal.addEventListener('abort', abortListener, { once: true })
  })
  try {
    while (true) {
      const next = await Promise.race([events.next(), timeout, aborted])
      if (next.done) throw new LlmError('Sub2API WebSocket closed before connection was ready', 'TRANSPORT')
      if (next.value.type === 'open') return
      if (next.value.type === 'error') throw new LlmError('Sub2API WebSocket handshake failed', 'TRANSPORT')
      if (next.value.type === 'close') throw new LlmError('Sub2API WebSocket closed during handshake', 'TRANSPORT')
    }
  } finally {
    if (timer !== undefined) clearTimeout(timer)
    if (signal !== undefined && abortListener !== undefined) signal.removeEventListener('abort', abortListener)
  }
}

export function apply(ctx: Context, config: Sub2ApiResponsesWsConfig): void {
  if (!config.enabled) return
  if (!Number.isSafeInteger(config.connectTimeoutMs) || config.connectTimeoutMs <= 0) {
    throw new Error('Sub2API WebSocket connectTimeoutMs 必须为正整数')
  }
  const baseURL = normalizeBaseURL(config.baseURL)
  const models = validateModels(config.models)
  const clock = systemClock()
  const adapter = new Sub2ApiResponsesWebSocketAdapter({ ...config, baseURL, models: [...models.values()] }, {
    now: () => clock.now(),
    resolveApiKey: async () => {
      const ref = credentialRef(config.apiKeyEnv)
      const resolved = await ctx.credentials.resolve(ref)
      return resolved?.value
    },
  })
  const dispose = ctx.llm.registerAdapter([SUB2API_RESPONSES_WS_PROVIDER], adapter)
  ctx.effect(() => dispose, 'llm.sub2api-responses-ws.dispose')
}
