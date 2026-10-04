import { execFileSync } from 'node:child_process'
import { once } from 'node:events'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import OpenAI from 'openai'
import { WebSocketServer } from 'ws'

const directories: string[] = []
afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }) })
const helperUrl = new URL('../scripts/model-connection-config.mjs', import.meta.url).href
function readFixture(baseURL = 'https://ai.teacherli.net', wire = 'responses', websocket = true): Record<string, unknown> {
  const directory = mkdtempSync(join(tmpdir(), 'luna-config-'))
  directories.push(directory)
  const path = join(directory, 'config.toml')
  writeFileSync(path, `model_provider = "gateway"\nmodel = "irrelevant-default"\nmodel_reasoning_effort = "high"\n[model_providers.gateway]\nbase_url = "${baseURL}"\nwire_api = "${wire}"\nsupports_websockets = ${websocket}\napi_key = "FAKE_SECRET_SHOULD_NOT_LEAVE_CONFIG"\n`)
  return JSON.parse(execFileSync(process.execPath, ['--input-type=module', '-e',
    `import {readLunaGatewayConfig,lunaProviderConfig} from ${JSON.stringify(helperUrl)};
    const config=readLunaGatewayConfig(process.argv[1]);
    console.log(JSON.stringify({config,provider:lunaProviderConfig(config,32768)}));`, path],
  { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })) as Record<string, unknown>
}

describe('真实连接配置按本轮授权固定来源', () => {
  it('读取所选 provider，但显式模型、max 和环境引用优先于 Codex 默认模型', () => {
    const result = readFixture()
    expect(result).toMatchObject({ config: { baseURL: 'https://ai.teacherli.net/', apiKeyEnv: 'SUB2API_KEY',
      model: 'sub2api:gpt-6-luna', wireModelId: 'gpt-6-luna', reasoningEffort: 'max' },
      provider: { strictTools: true, models: [{ defaultReasoningEffort: 'max', contextWindow: 1_050_000, maxTokens: 32768 }] } })
    expect(JSON.stringify(result)).not.toContain('FAKE_SECRET')
    expect(JSON.stringify(result)).not.toContain('irrelevant-default')
  })
  it('兼容已有 /v1 base URL', () => {
    expect(readFixture('https://ai.teacherli.net/v1')).toMatchObject({ config: { baseURL: 'https://ai.teacherli.net/v1' } })
  })
  it.each(['http://ai.teacherli.net', 'https://other.invalid', 'https://fake:fake@ai.teacherli.net',
    'https://ai.teacherli.net?key=fake', 'https://ai.teacherli.net/responses'])('拒绝未授权或含认证信息端点 %s', (url) => {
    expect(() => readFixture(url)).toThrow()
  })
  it('拒绝没有明确 WS 能力或错误协议的配置', () => {
    expect(() => readFixture(undefined, 'chat', true)).toThrow()
    expect(() => readFixture(undefined, 'responses', false)).toThrow()
  })
})

describe('真实 Responses WS header 观测', () => {
  it('只记录 allowlist header 与 URL origin/path，并在退出后恢复 OpenAI SDK 原型', async () => {
    const helper = await import(helperUrl)
    const { ResponsesWS } = await import('openai/resources/responses/ws')
    const prototype = ResponsesWS.prototype as unknown as Record<string, unknown>
    const original = {
      send: prototype['send'],
      stream: prototype['stream'],
      createSocket: prototype['_createSocket'],
    }
    const server = createServer()
    const sockets = new WebSocketServer({ noServer: true })
    let upgradeUrl: string | undefined
    let upgradeAuthorization: string | undefined
    let receivedRequest: unknown
    server.on('upgrade', (request, socket, head) => {
      upgradeUrl = request.url
      upgradeAuthorization = request.headers['authorization']
      sockets.handleUpgrade(request, socket, head, (ws) => {
        sockets.emit('connection', ws, request)
        ws.on('message', (data) => {
          receivedRequest = JSON.parse(data.toString()) as unknown
          ws.send(JSON.stringify({ type: 'response.created', sequence_number: 0,
            response: { id: 'resp_local_header_probe', object: 'response', status: 'in_progress', output: [] } }))
          ws.close(1000, 'local-loopback-complete')
        })
      })
    })
    server.listen(0, '127.0.0.1')
    await once(server, 'listening')
    const address = server.address() as AddressInfo
    const apiKey = 'sk-local-loopback-header-secret'
    const queryMarker = 'never-log-this-query'
    const observations: Array<{ readonly kind: string; readonly detail: unknown }> = []
    const created: unknown[] = []
    const restore = await helper.traceResponsesWs(
      (kind: string, detail: unknown) => observations.push({ kind, detail }),
      (event: unknown) => created.push(event),
    )

    let ws: InstanceType<typeof ResponsesWS> | undefined
    let iterator: AsyncIterator<unknown> | undefined
    try {
      const client = new OpenAI({ apiKey, baseURL: `http://127.0.0.1:${address.port}/v1`, maxRetries: 0,
        defaultQuery: { probe_marker: queryMarker } })
      const socketOptions = {
        reconnect: null,
        maxQueueSize: 0,
        headers: {
          'x-client-request-id': 'attempt-header-0001',
          'session-id': 'cohort-header-v1',
          'thread-id': 'cohort-header-v1',
          originator: 'codex_cli_rs',
          version: '0.160.0',
          'User-Agent': 'codex_cli_rs/0.160.0 loopback',
          'OpenAI-Beta': 'responses_websockets=2026-02-06',
          'x-unapproved-header': 'must-not-be-recorded',
        },
      }
      ws = new ResponsesWS(client, socketOptions)
      ws.on('error', () => {})
      iterator = ws.stream()[Symbol.asyncIterator]()
      let opened = await iterator.next()
      while (!opened.done && (opened.value as { type?: string } | undefined)?.type !== 'open') opened = await iterator.next()
      expect(opened.done).toBe(false)
      expect(opened.value).toMatchObject({ type: 'open' })
      ws.send({ type: 'response.create', model: 'local-loopback', input: [] })
      const response = await iterator.next()
      expect(response.value).toMatchObject({ type: 'message', message: { type: 'response.created' } })
      const closed = await iterator.next()
      expect(closed.value).toMatchObject({ type: 'close' })

      const connect = observations.find((item) => item.kind === 'ws.connect')
      expect(connect?.detail).toEqual({
        origin: `ws://127.0.0.1:${address.port}`,
        path: '/v1/responses',
        headers: {
          'x-client-request-id': 'attempt-header-0001',
          'session-id': 'cohort-header-v1',
          'thread-id': 'cohort-header-v1',
          originator: 'codex_cli_rs',
          version: '0.160.0',
          'user-agent': 'codex_cli_rs/0.160.0 loopback',
          'openai-beta': 'responses_websockets=2026-02-06',
        },
      })
      expect(upgradeAuthorization?.startsWith('Bearer ')).toBe(true)
      expect(upgradeUrl).toContain(`probe_marker=${queryMarker}`)
      expect(receivedRequest).toMatchObject({ type: 'response.create', model: 'local-loopback' })
      expect(created).toHaveLength(1)
      expect(JSON.stringify(observations)).not.toContain(apiKey)
      expect(JSON.stringify(observations)).not.toContain(queryMarker)
      expect(JSON.stringify(observations)).not.toContain('must-not-be-recorded')
      expect(JSON.stringify(observations).toLowerCase()).not.toContain('authorization')
    } finally {
      restore()
      try { ws?.close({ code: 1000, reason: 'test-cleanup' }) } catch { /* close 后清理仍继续。 */ }
      await iterator?.return?.()
      for (const socket of sockets.clients) socket.terminate()
      await new Promise<void>((resolve, reject) => sockets.close((error) => error === undefined ? resolve() : reject(error)))
      await new Promise<void>((resolve, reject) => server.close((error) => error === undefined ? resolve() : reject(error)))
    }
    expect(prototype['send']).toBe(original.send)
    expect(prototype['stream']).toBe(original.stream)
    expect(prototype['_createSocket']).toBe(original.createSocket)
    expect(observations.filter((item) => item.kind === 'ws.connect')).toHaveLength(1)
  })
})


describe('真实连接脚本的整轮时间上限', () => {
  it.each(['0', '-1', 'NaN', '1800001'])('拒绝越界上限 %s，且在凭据/网络前拒绝', (timeout) => {
    let stderr = ''
    try {
      execFileSync(process.execPath, [new URL('../scripts/real-connection-check.mjs', import.meta.url).pathname,
        '--decision-timeout-ms', timeout], { env: {}, stdio: ['ignore', 'pipe', 'pipe'] })
    } catch (error) {
      stderr = String((error as { stderr?: unknown }).stderr)
    }
    expect(stderr).toContain('decision timeout must be 1..1800000 ms')
    expect(stderr).not.toContain('HTX credentials missing')
  })
})
