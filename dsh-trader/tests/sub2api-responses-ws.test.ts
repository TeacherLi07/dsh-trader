import { once } from 'node:events'
import { createServer, type IncomingMessage, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterEach, describe, expect, it } from 'vitest'
import { WebSocket, WebSocketServer } from 'ws'
import {
  ReasoningEffortId,
  createSystemMessage,
  createUserMessage,
  type GenerateOptions,
  type StreamChunk,
} from '@deepseek-ai/dsh-llm'
import { DEEPSEEK_PRICE_SEED, selectPrice } from '../src/cost.js'
import type { ResponseStreamEvent } from 'openai/resources/responses/responses'
import {
  SUB2API_RESPONSES_WS_PROVIDER,
  Sub2ApiResponsesWebSocketAdapter,
  resolveResponsesWebSocketProxy,
  type Sub2ApiResponsesWsConfig,
} from '../src/plugins/sub2api-responses-ws.js'

const FAKE_KEY = 'sk-fake-loopback-only-key'
const MODEL_ALIAS = 'sub2api:gpt-5.6-sol'
const WIRE_MODEL_ID = 'gpt-5.6-sol'

function header(request: IncomingMessage, name: string): string | undefined {
  const value = request.headers[name]
  return Array.isArray(value) ? value[0] : value
}

interface LoopbackGateway {
  readonly baseURL: string
  readonly requests: unknown[]
  readonly httpFallbacks: string[]
  readonly upgradeHeaders: Array<{ readonly authorization?: string; readonly beta?: string; readonly userAgent?: string }>
  readonly handshakes: () => number
  close(): Promise<void>
}

let activeGateways: LoopbackGateway[] = []

function requestOptions(overrides: Partial<GenerateOptions> = {}): GenerateOptions {
  return {
    provider: SUB2API_RESPONSES_WS_PROVIDER,
    model: MODEL_ALIAS,
    messages: [
      createSystemMessage('Return one structured decision.', 'test-provider'),
      createUserMessage({
        content: [{ type: 'text', text: 'Use this non-empty frozen market context.' }],
        source: { kind: 'user' },
      }),
    ],
    tools: [{
      name: 'submit_decision_envelope',
      description: 'Return the decision object.',
      parameters: {
        type: 'object', additionalProperties: false,
        properties: { outcome: { enum: ['act', 'no_trade', 'review'] } },
        required: ['outcome'],
      },
    }],
    reasoningEffort: ReasoningEffortId('high'),
    temperature: 0,
    maxTokens: 32_768,
    ...overrides,
  }
}

function adapter(baseURL: string): Sub2ApiResponsesWebSocketAdapter {
  const config: Sub2ApiResponsesWsConfig = {
    enabled: true,
    baseURL,
    apiKeyEnv: 'SUB2API_OPENAI_API_KEY',
    connectTimeoutMs: 3_000,
    models: [{
      id: MODEL_ALIAS,
      wireModelId: WIRE_MODEL_ID,
      name: 'Gateway GPT 5.6 Sol',
      contextWindow: 262_144,
      maxTokens: 65_536,
      reasoningEfforts: ['high'],
      defaultReasoningEffort: 'high',
    }],
  }
  return new Sub2ApiResponsesWebSocketAdapter(config, {
    resolveApiKey: async () => FAKE_KEY,
    now: () => 1_800_000_000_000,
  })
}

async function startGateway(
  onRequest: (socket: WebSocket, request: IncomingMessage, payload: Record<string, unknown>) => void,
): Promise<LoopbackGateway> {
  const requests: unknown[] = []
  const httpFallbacks: string[] = []
  const upgradeHeaders: Array<{ readonly authorization?: string; readonly beta?: string; readonly userAgent?: string }> = []
  let handshakeCount = 0
  const server = createServer((request, response) => {
    httpFallbacks.push(`${request.method ?? 'UNKNOWN'} ${request.url ?? ''}`)
    request.resume()
    response.writeHead(404).end()
  })
  const webSockets = new WebSocketServer({ noServer: true })
  server.on('upgrade', (request, socket, head) => {
    if (request.url !== '/v1/responses') {
      socket.destroy()
      return
    }
    handshakeCount += 1
    upgradeHeaders.push({
      authorization: header(request, 'authorization'),
      beta: header(request, 'openai-beta'),
      userAgent: header(request, 'user-agent'),
    })
    webSockets.handleUpgrade(request, socket, head, (webSocket) => {
      webSockets.emit('connection', webSocket, request)
      webSocket.on('message', (data) => {
        const payload = JSON.parse(data.toString()) as Record<string, unknown>
        requests.push(payload)
        onRequest(webSocket, request, payload)
      })
    })
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const address = server.address() as AddressInfo
  const gateway: LoopbackGateway = {
    baseURL: `http://127.0.0.1:${address.port}`,
    requests,
    httpFallbacks,
    upgradeHeaders,
    handshakes: () => handshakeCount,
    close: async () => {
      for (const socket of webSockets.clients) socket.terminate()
      await new Promise<void>((resolve, reject) => webSockets.close((error) => error === undefined ? resolve() : reject(error)))
      await new Promise<void>((resolve, reject) => server.close((error) => error === undefined ? resolve() : reject(error)))
    },
  }
  activeGateways.push(gateway)
  return gateway
}

function sendResponseCompleted(socket: WebSocket): void {
  const outputItem = {
    id: 'fc_item_1', type: 'function_call', status: 'completed', call_id: 'call_1',
    name: 'submit_decision_envelope', arguments: '{"outcome":"no_trade"}',
  }
  const events: ResponseStreamEvent[] = [
    {
      type: 'response.created', sequence_number: 0,
      response: { id: 'resp_1', object: 'response', created_at: 1, status: 'in_progress', model: WIRE_MODEL_ID, output: [] },
    } as unknown as ResponseStreamEvent,
    { type: 'response.output_item.added', sequence_number: 1, output_index: 0, item: { ...outputItem, arguments: '' } } as unknown as ResponseStreamEvent,
    { type: 'response.function_call_arguments.delta', sequence_number: 2, output_index: 0, item_id: 'fc_item_1', delta: '{"outcome":' } as unknown as ResponseStreamEvent,
    { type: 'response.function_call_arguments.delta', sequence_number: 3, output_index: 0, item_id: 'fc_item_1', delta: '"no_trade"}' } as unknown as ResponseStreamEvent,
    { type: 'response.function_call_arguments.done', sequence_number: 4, output_index: 0, item_id: 'fc_item_1', arguments: '{"outcome":"no_trade"}' } as unknown as ResponseStreamEvent,
    { type: 'response.output_item.done', sequence_number: 5, output_index: 0, item: outputItem } as unknown as ResponseStreamEvent,
    {
      type: 'response.completed', sequence_number: 6,
      response: {
        id: 'resp_1', object: 'response', created_at: 1, status: 'completed', model: WIRE_MODEL_ID,
        output: [outputItem],
        usage: {
          input_tokens: 20, output_tokens: 8, total_tokens: 28,
          input_tokens_details: { cached_tokens: 0 }, output_tokens_details: { reasoning_tokens: 0 },
        },
      },
    } as unknown as ResponseStreamEvent,
  ]
  for (const event of events) socket.send(JSON.stringify(event))
}

function sendTextResponse(socket: WebSocket, usage: unknown): void {
  const outputItem = {
    id: 'msg_text_1', type: 'message', status: 'completed', role: 'assistant',
    content: [{ type: 'output_text', text: 'SAFE_REPLY', annotations: [] }],
  }
  const events: unknown[] = [
    { type: 'response.created', sequence_number: 0, response: { id: 'resp_text', status: 'in_progress', output: [] } },
    { type: 'response.output_item.added', sequence_number: 1, output_index: 0, item: { ...outputItem, status: 'in_progress', content: [] } },
    { type: 'response.output_text.delta', sequence_number: 2, output_index: 0, item_id: 'msg_text_1', content_index: 0, delta: 'SAFE_REPLY' },
    { type: 'response.output_item.done', sequence_number: 3, output_index: 0, item: outputItem },
    {
      type: 'response.completed', sequence_number: 4,
      response: { id: 'resp_text', status: 'completed', output: [outputItem], usage },
    },
  ]
  for (const event of events) socket.send(JSON.stringify(event))
}

afterEach(async () => {
  await Promise.all(activeGateways.splice(0).map((gateway) => gateway.close()))
})

describe('Sub2API Responses WebSocket provider', () => {
  it('routes secure sockets through HTTPS_PROXY and bypasses loopback/NO_PROXY', () => {
    expect(resolveResponsesWebSocketProxy('https://gateway.example/v1', {
      HTTPS_PROXY: 'http://proxy.example:3128', NO_PROXY: '',
    })).toBe('http://proxy.example:3128')
    expect(resolveResponsesWebSocketProxy('https://gateway.example/v1', {
      HTTPS_PROXY: 'http://proxy.example:3128', NO_PROXY: '.example',
    })).toBeUndefined()
    expect(resolveResponsesWebSocketProxy('http://127.0.0.1:8080/v1', {
      HTTPS_PROXY: 'http://proxy.example:3128',
    })).toBeUndefined()
  })

  it('uses SDK Responses WS, maps tool events through pi-ai, and keeps the billing alias off the wire', async () => {
    const gateway = await startGateway((socket) => sendResponseCompleted(socket))
    const model = adapter(gateway.baseURL)
    const chunks: StreamChunk[] = []
    for await (const chunk of model.stream(requestOptions())) chunks.push(chunk)

    expect(gateway.handshakes()).toBe(1)
    expect(gateway.upgradeHeaders[0]).toMatchObject({
      authorization: `Bearer ${FAKE_KEY}`,
      beta: 'responses_websockets=2026-02-06',
    })
    expect(gateway.upgradeHeaders[0]?.userAgent).toContain('deepseek-harness')
    expect(gateway.httpFallbacks).toEqual([])
    expect(gateway.requests).toHaveLength(1)
    expect(JSON.stringify(gateway.requests[0])).not.toContain(FAKE_KEY)
    expect(gateway.requests[0]).toMatchObject({
      type: 'response.create',
      model: WIRE_MODEL_ID,
      max_output_tokens: 32_768,
      reasoning: { effort: 'high' },
      store: false,
      tool_choice: 'required',
    })
    expect((gateway.requests[0] as { input?: unknown[] }).input?.length).toBeGreaterThan(0)
    expect((gateway.requests[0] as { tools?: unknown[] }).tools).toHaveLength(1)
    expect((gateway.requests[0] as { tools?: Array<Record<string, unknown>> }).tools?.[0]).not.toHaveProperty('strict')
    expect(selectPrice(DEEPSEEK_PRICE_SEED, MODEL_ALIAS, Date.UTC(2026, 9, 3))).toBeUndefined()
    expect(chunks.some((chunk) => chunk.type === 'tool-call-delta' && chunk.argumentsDelta.includes('no_trade'))).toBe(true)
    expect(chunks.some((chunk) => chunk.type === 'usage' && chunk.usage.totalTokens === 28)).toBe(true)
    expect(chunks.at(-1)).toMatchObject({ type: 'finish', reason: { kind: 'tool-calls' } })
    expect(model.providerRetryPolicy(SUB2API_RESPONSES_WS_PROVIDER)).toMatchObject({ mode: 'normal', maxRetries: 0 })
  })

  it('does not reconnect or fall back to HTTP when the socket closes after a non-empty request', async () => {
    const gateway = await startGateway((socket, _request, payload) => {
      if (payload.type === 'response.create') socket.close(1011, 'upstream interrupted')
    })
    const model = adapter(gateway.baseURL)
    const chunks: StreamChunk[] = []
    for await (const chunk of model.stream(requestOptions())) chunks.push(chunk)

    expect(gateway.requests).toHaveLength(1)
    expect(gateway.handshakes()).toBe(1)
    expect(gateway.httpFallbacks).toEqual([])
    expect(chunks.at(-1)).toMatchObject({
      type: 'finish',
      reason: { kind: 'error', failure: { code: 'OUTCOME_UNKNOWN' } },
    })
    const finish = chunks.at(-1)
    if (finish?.type !== 'finish' || finish.reason.kind !== 'error') throw new Error('expected unresolved provider error finish')
    expect(finish.reason.failure.message).toMatch(/outcome and cost are unresolved/)
  })

  it('keeps a post-submit abort unresolved and never retries or switches transports', async () => {
    const controller = new AbortController()
    const gateway = await startGateway((socket, _request, payload) => {
      if (payload.type === 'response.create') controller.abort('test cancellation after dispatch')
    })
    const chunks: StreamChunk[] = []
    for await (const chunk of adapter(gateway.baseURL).stream(requestOptions({ signal: controller.signal }))) chunks.push(chunk)

    expect(gateway.requests).toHaveLength(1)
    expect(gateway.handshakes()).toBe(1)
    expect(gateway.httpFallbacks).toEqual([])
    const finish = chunks.at(-1)
    if (finish?.type !== 'finish' || finish.reason.kind !== 'error') throw new Error('expected unresolved abort finish')
    expect(finish.reason.failure.code).toBe('OUTCOME_UNKNOWN')
    expect(finish.reason.failure.message).toMatch(/outcome and cost are unresolved/)
  })

  it('redacts an API key echoed in a provider failure before exposing the finish chunk', async () => {
    const echoedKey = FAKE_KEY
    const gateway = await startGateway((socket, _request, payload) => {
      if (payload.type !== 'response.create') return
      const event = {
        type: 'response.failed', sequence_number: 1,
        response: {
          id: 'resp_failed', object: 'response', created_at: 1, status: 'failed', model: WIRE_MODEL_ID, output: [],
          error: { code: 'gateway_error', message: `upstream rejected credential ${echoedKey}` },
        },
      }
      socket.send(JSON.stringify(event))
    })
    const chunks: StreamChunk[] = []
    for await (const chunk of adapter(gateway.baseURL).stream(requestOptions())) chunks.push(chunk)

    const finish = chunks.at(-1)
    expect(finish?.type).toBe('finish')
    if (finish?.type !== 'finish' || finish.reason.kind !== 'error') throw new Error('expected provider error finish')
    expect(finish.reason.failure.message).not.toContain(echoedKey)
    expect(finish.reason.failure.message).toContain('[redacted]')
  })

  it.each([
    ['null usage', null],
    ['empty usage object', {}],
    ['negative input count', { input_tokens: -1, output_tokens: 2, total_tokens: 1, input_tokens_details: { cached_tokens: 0 } }],
    ['non-integer output count', { input_tokens: 2, output_tokens: 1.5, total_tokens: 3.5, input_tokens_details: { cached_tokens: 0 } }],
    ['unsafe input count', { input_tokens: Number.MAX_SAFE_INTEGER + 1, output_tokens: 1, total_tokens: Number.MAX_SAFE_INTEGER + 2, input_tokens_details: { cached_tokens: 0 } }],
    ['cached count greater than input', { input_tokens: 2, output_tokens: 1, total_tokens: 3, input_tokens_details: { cached_tokens: 3 } }],
  ])('keeps non-authoritative %s usage unknown while preserving visible output', async (_label, usage) => {
    const gateway = await startGateway((socket) => sendTextResponse(socket, usage))
    const chunks: StreamChunk[] = []
    for await (const chunk of adapter(gateway.baseURL).stream(requestOptions())) chunks.push(chunk)

    expect(chunks.some((chunk) => chunk.type === 'text-delta' && chunk.text.includes('SAFE_REPLY'))).toBe(true)
    expect(chunks.some((chunk) => chunk.type === 'usage')).toBe(false)
    expect(chunks.at(-1)).toMatchObject({ type: 'finish', reason: { kind: 'stop' } })
  })
})
