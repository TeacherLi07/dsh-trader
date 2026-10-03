/** 验收脚本共用配置；只读取端点元数据，认证仍经 DSH credentials 的环境变量引用。 */
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { resolve } from 'node:path'

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
  return { enabled: true, baseURL: gateway.baseURL, apiKeyEnv: gateway.apiKeyEnv, connectTimeoutMs: 20_000,
    models: [{ id: gateway.model, wireModelId: gateway.wireModelId, name: 'GPT-6 Luna (Sub2API)',
      contextWindow: 1_050_000, maxTokens, reasoningEfforts: ['none', 'low', 'medium', 'high', 'xhigh', 'max'],
      defaultReasoningEffort: gateway.reasoningEffort }] }
}

/** 原始事件只由调用方的脱敏私有日志持有；不触碰认证头或自动重发。 */
export async function traceResponsesWs(log, onCreate = () => {}) {
  const { ResponsesWS } = await import('openai/resources/responses/ws')
  const send = ResponsesWS.prototype.send
  const stream = ResponsesWS.prototype.stream
  ResponsesWS.prototype.send = function (event) {
    if (event.type === 'response.create') onCreate(event)
    log('ws.send', event)
    return send.call(this, event)
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
  return () => { ResponsesWS.prototype.send = send; ResponsesWS.prototype.stream = stream }
}
