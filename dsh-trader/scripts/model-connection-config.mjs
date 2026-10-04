/** 验收脚本共用配置；只读取端点元数据，认证仍经 DSH credentials 的环境变量引用。 */
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { resolve } from 'node:path'
import { estimateCost } from '../lib/cost.js'

export function readLunaGatewayConfig(path = resolve(process.env.HOME, '.codex/config.toml')) {
  const fields = JSON.parse(execFileSync('python3', ['-c', `
import json, sys, tomllib
with open(sys.argv[1], 'rb') as f: config=tomllib.load(f)
name=config.get('model_provider')
p=config.get('model_providers',{}).get(name,{})
print(json.dumps({'provider':name,'baseURL':p.get('base_url'),'wireApi':p.get('wire_api'),'supportsWebsockets':p.get('supports_websockets')}))
`, path], { encoding: 'utf8' }))
  assert.equal(fields.wireApi, 'responses', 'configured provider must use Responses')
  assert.equal(fields.supportsWebsockets, true, 'configured provider must declare WebSocket support')
  const url = new URL(fields.baseURL)
  assert.equal(url.protocol, 'https:', 'gateway must use HTTPS')
  assert.equal(url.hostname, 'ai.teacherli.net', 'expected authorized teacherli gateway')
  assert.ok(!url.username && !url.password && !url.search && !url.hash, 'gateway URL must not contain authentication or query data')
  assert.ok(['', '/', '/v1', '/v1/'].includes(url.pathname), 'gateway must be an API base URL')
  return { sourceConfig: resolve(path), configuredProvider: fields.provider, baseURL: url.href,
    apiKeyEnv: 'SUB2API_KEY', wireModelId: 'gpt-6-luna', model: 'sub2api:gpt-6-luna', reasoningEffort: 'max' }
}

export function lunaProviderConfig(gateway, maxTokens) {
  assert.ok(Number.isSafeInteger(maxTokens) && maxTokens > 0 && maxTokens <= 128_000)
  return { enabled: true, strictTools: true, baseURL: gateway.baseURL, apiKeyEnv: gateway.apiKeyEnv, connectTimeoutMs: 20_000,
    models: [{ id: gateway.model, wireModelId: gateway.wireModelId, name: 'GPT-6 Luna (Sub2API)',
      contextWindow: 1_050_000, maxTokens, reasoningEfforts: ['none', 'low', 'medium', 'high', 'xhigh', 'max'],
      defaultReasoningEffort: gateway.reasoningEffort }] }
}

/** 原始事件只由调用方的脱敏私有日志持有；不触碰认证头或自动重发。 */
export async function traceResponsesWs(log, onCreate = () => {}) {
  const { ResponsesWS } = await import('openai/resources/responses/ws')
  const send = ResponsesWS.prototype.send
  const stream = ResponsesWS.prototype.stream
  const createSocket = ResponsesWS.prototype._createSocket
  const observedHeaders = new Set([
    'x-client-request-id', 'session-id', 'thread-id', 'originator', 'version', 'user-agent', 'openai-beta',
  ])
  ResponsesWS.prototype.send = function (event) {
    if (event.type === 'response.create') onCreate(event)
    log('ws.send', event)
    return send.call(this, event)
  }
  // SDK 在这里把认证头与调用方 headers 合并后交给 ws.WebSocket；只投影准许的关联字段。
  ResponsesWS.prototype._createSocket = function (url, authHeaders) {
    const requestUrl = new URL(String(url))
    const mergedHeaders = { ...authHeaders, ...this._wsOptions?.headers }
    const safeHeaders = {}
    for (const [key, value] of Object.entries(mergedHeaders)) {
      const name = key.toLowerCase()
      if (observedHeaders.has(name) && typeof value === 'string' && value.length <= 1024) {
        safeHeaders[name] = value
      }
    }
    log('ws.connect', { origin: requestUrl.origin, path: requestUrl.pathname, headers: safeHeaders })
    return createSocket.call(this, url, authHeaders)
  }
  ResponsesWS.prototype.stream = function (...args) {
    const events = stream.apply(this, args)
    return { async *[Symbol.asyncIterator]() {
      for await (const event of events) {
        log('ws.event', event.type === 'error' ? { type: event.type, error: String(event.error) } : event)
        yield event
      }
    } }
  }
  let restored = false
  return () => {
    if (restored) return
    restored = true
    ResponsesWS.prototype.send = send
    ResponsesWS.prototype._createSocket = createSocket
    ResponsesWS.prototype.stream = stream
  }
}


/** 先核算已返回的权威 usage，再判断输出是否合格；结构失败不能抹去已计费调用。 */
export function referenceProbeCost(rounds, reservations, price, model, at) {
  const costs = rounds.map(({ usage }) => estimateCost({
    tokensIn: usage.inputTokens + (usage.cacheReadTokens ?? 0) + (usage.cacheWriteTokens ?? 0),
    tokensCached: usage.cacheReadTokens ?? 0, tokensOut: usage.outputTokens,
  }, [price], model, at))
  return {
    knownUsageCalls: rounds.length,
    referenceEstimateUsd: costs.every(cost => cost.known) ? costs.reduce((sum, cost) => sum + cost.usd, 0) : null,
    unresolvedUpperReservationUsd: reservations.slice(rounds.length).reduce((sum, row) => sum + row.upperUsd, 0),
  }
}
