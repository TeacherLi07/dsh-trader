#!/usr/bin/env node
/** 已配置 Sub2API 的一次有界 WS 工具调用；不注入交易 runtime，不猜测网关价格。 */
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { appendFileSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import LlmRuntime from '@deepseek-ai/dsh-llm'
import CredentialsLocal from '@deepseek-ai/dsh-credentials-local'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import { ResponsesWS } from 'openai/resources/responses/ws'
import * as WsProvider from '../lib/plugins/sub2api-responses-ws.js'

const require = createRequire(import.meta.resolve('@deepseek-ai/dsh-credentials-local'))
const { parse } = require('yaml')
const output = resolve(process.argv[2] ?? '/tmp/sub2api-connection-check')
mkdirSync(output, { recursive: true, mode: 0o700 })
assert.equal(statSync(output).mode & 0o077, 0, 'private output directory required')
const reportPath = join(output, 'report.json')
assert.ok(!existsSync(reportPath), 'refuse to overwrite evidence')
const home = process.env.DSH_HOME ?? '/home/ubuntu/.dsh'
const settings = parse(readFileSync(join(home, 'settings.yaml'), 'utf8'))
const configured = settings['llm-pi-ai']?.providers?.['sub2api-openai']
assert.ok(configured?.baseURL && configured.apiKeyEnv, 'configured Sub2API endpoint/ref required')
const wireModelId = 'gpt-5.6-sol'
const metadata = configured.models?.find((model) => model.id === wireModelId)
assert.ok(metadata, 'configured gateway model required')
const report = { startedAt: Date.now(), provider: WsProvider.SUB2API_RESPONSES_WS_PROVIDER,
  model: `sub2api:${wireModelId}`, maxTokens: 512, reasoningEffort: 'high',
  costKnown: false, gatewayPriceVerified: false, realExchangeOrdersSubmitted: 0,
  submittedRequests: 0, chunks: [], passed: false }
let key
const redact = (value) => {
  let text = JSON.stringify(value)
  if (key) text = text.replaceAll(key, '[REDACTED]').replaceAll(encodeURIComponent(key), '[REDACTED]')
  return JSON.parse(text)
}
const log = (kind, detail) => appendFileSync(join(output, 'ws.jsonl'),
  JSON.stringify(redact({ at: Date.now(), kind, detail })) + '\n', { mode: 0o600 })
const originalSend = ResponsesWS.prototype.send
const originalStream = ResponsesWS.prototype.stream
ResponsesWS.prototype.send = function (event) {
  if (event.type === 'response.create') report.submittedRequests += 1
  log('send', event)
  return originalSend.call(this, event)
}
ResponsesWS.prototype.stream = function (...args) {
  const stream = originalStream.apply(this, args)
  return { async *[Symbol.asyncIterator]() {
    for await (const event of stream) {
      log('event', event.type === 'error' ? { type: event.type, error: String(event.error) } : event)
      yield event
    }
  } }
}
const ctx = new Context()
let llmFiber, credentialsFiber, providerFiber
try {
  credentialsFiber = await ctx.plugin(CredentialsLocal, { dshHome: home, watch: false })
  const resolved = await ctx.credentials.resolve(credentialRef(configured.apiKeyEnv))
  assert.ok(resolved?.value, 'Sub2API credential ref unavailable')
  key = resolved.value
  report.credentialSource = resolved.source
  llmFiber = await ctx.plugin(LlmRuntime)
  providerFiber = await ctx.plugin({ apply: WsProvider.apply, inject: WsProvider.inject }, {
    enabled: true, baseURL: configured.baseURL, apiKeyEnv: configured.apiKeyEnv, connectTimeoutMs: 10_000,
    models: [{ id: report.model, wireModelId, name: metadata.name ?? wireModelId,
      contextWindow: metadata.contextWindow, maxTokens: report.maxTokens,
      reasoningEfforts: ['high'], defaultReasoningEffort: 'high' }],
  })
  const models = await ctx.llm.listModels(report.provider)
  assert.ok(models.some((model) => model.id === report.model), 'WS route model registration required')
  for await (const chunk of ctx.llm.stream({ provider: report.provider, model: report.model,
    maxTokens: report.maxTokens, signal: AbortSignal.timeout(60_000),
    system: 'Use the submit_connection_result tool exactly once with status OK. No other output.',
    messages: [{ role: 'user', content: [{ type: 'text', text: 'Confirm this WebSocket Responses connection.' }] }],
    tools: [{ name: 'submit_connection_result', description: 'Return connection status only; no side effects.',
      parameters: { type: 'object', additionalProperties: false,
        properties: { status: { type: 'string', enum: ['OK'] } }, required: ['status'] } }],
  })) { report.chunks.push(chunk); log('chunk', chunk) }
  const tool = report.chunks.find((chunk) => chunk.type === 'block-end' && chunk.block.type === 'tool-call')
  assert.ok(tool, 'nonempty structured tool output required')
  assert.equal(JSON.parse(tool.block.arguments).status, 'OK')
  const usage = report.chunks.find((chunk) => chunk.type === 'usage')?.usage
  assert.ok(usage && usage.totalTokens > 0, 'nonempty authoritative usage required')
  report.usage = usage
  assert.equal(report.chunks.at(-1)?.reason?.kind, 'tool-calls')
  assert.equal(report.submittedRequests, 1, 'no resubmission permitted')
  report.passed = true
} catch (error) {
  report.error = String(error)
} finally {
  report.finishedAt = Date.now()
  writeFileSync(reportPath, JSON.stringify(redact(report), null, 2) + '\n', { mode: 0o600 })
  await providerFiber?.dispose()
  await llmFiber?.dispose()
  await credentialsFiber?.dispose()
  ResponsesWS.prototype.send = originalSend
  ResponsesWS.prototype.stream = originalStream
}
console.log(JSON.stringify(redact({ passed: report.passed, submittedRequests: report.submittedRequests,
  usage: report.usage, costKnown: report.costKnown, error: report.error }), null, 2))
if (!report.passed) process.exitCode = 1
