#!/usr/bin/env node
/** Codex 中授权的 Luna/max 网关 WS 工具往返；不注入交易 runtime，按官方参考估算而非声称实付。 */
import assert from 'node:assert/strict'
import { appendFileSync, existsSync, mkdirSync, statSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import LlmRuntime, { createAssistantMessage, createToolResultMessage } from '@deepseek-ai/dsh-llm'
import CredentialsLocal from '@deepseek-ai/dsh-credentials-local'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import { estimateCost, lunaGatewayReferencePrice } from '../lib/cost.js'
import { readLunaGatewayConfig, lunaProviderConfig, traceResponsesWs } from './model-connection-config.mjs'
import * as WsProvider from '../lib/plugins/sub2api-responses-ws.js'

const output = resolve(process.argv[2] ?? '/tmp/sub2api-connection-check')
mkdirSync(output, { recursive: true, mode: 0o700 })
assert.equal(statSync(output).mode & 0o077, 0, 'private output directory required')
const reportPath = join(output, 'report.json')
assert.ok(!existsSync(reportPath), 'refuse to overwrite evidence')
const home = process.env.DSH_HOME ?? '/home/ubuntu/.dsh'
const configured = readLunaGatewayConfig(process.argv[3])
const price = lunaGatewayReferencePrice(Date.now())
const report = { startedAt: Date.now(), provider: WsProvider.SUB2API_RESPONSES_WS_PROVIDER,
  model: configured.model, endpoint: configured.baseURL, sourceConfig: configured.sourceConfig,
  maxTokens: 8192, reasoningEffort: configured.reasoningEffort,
  referencePrice: price, costKnown: false, gatewayPriceVerified: false, realExchangeOrdersSubmitted: 0,
  submittedRequests: 0, chunks: [], rounds: [], passed: false }
let key
const redact = (value) => {
  let text = JSON.stringify(value)
  if (key) text = text.replaceAll(key, '[REDACTED]').replaceAll(encodeURIComponent(key), '[REDACTED]')
  return JSON.parse(text)
}
const log = (kind, detail) => appendFileSync(join(output, 'ws.jsonl'),
  JSON.stringify(redact({ at: Date.now(), kind, detail })) + '\n', { mode: 0o600 })
const restoreWs = await traceResponsesWs(log, (event) => {
  report.submittedRequests += 1
  assert.equal(event.model, configured.wireModelId)
  assert.equal(event.reasoning?.effort, 'max', 'reasoning effort must reach wire unchanged')
  assert.equal(event.temperature, undefined, 'reasoning model sampling compatibility')
})
const ctx = new Context()
let llmFiber, credentialsFiber, providerFiber
try {
  credentialsFiber = await ctx.plugin(CredentialsLocal, { dshHome: home, watch: false })
  const resolved = await ctx.credentials.resolve(credentialRef(configured.apiKeyEnv))
  assert.ok(resolved?.value, 'Sub2API credential ref unavailable')
  key = resolved.value
  report.credentialSource = resolved.source
  llmFiber = await ctx.plugin(LlmRuntime)
  providerFiber = await ctx.plugin({ apply: WsProvider.apply, inject: WsProvider.inject }, lunaProviderConfig(configured, report.maxTokens))
  const models = await ctx.llm.listModels(report.provider)
  assert.ok(models.some((model) => model.id === report.model), 'WS route model registration required')
  for await (const chunk of ctx.llm.stream({ provider: report.provider, model: report.model,
    maxTokens: report.maxTokens, temperature: 0, signal: AbortSignal.timeout(180_000),
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
  report.rounds.push({ kind: 'tool', usage })
  const history = createAssistantMessage({ content: [tool.block], source: { provider: report.provider, model: report.model } })
  const followup = []
  for await (const chunk of ctx.llm.stream({ provider: report.provider, model: report.model,
    maxTokens: report.maxTokens, temperature: 0, signal: AbortSignal.timeout(180_000),
    system: 'After receiving the connection tool result, reply CONNECTION_OK exactly.',
    messages: [{ role: 'user', content: [{ type: 'text', text: 'Confirm the connection via the status tool.' }] },
      history, createToolResultMessage({ callId: tool.block.id, isError: false,
        content: [{ type: 'text', text: '{"status":"OK"}' }] })],
  })) { followup.push(chunk); log('followup.chunk', chunk) }
  const followupUsage = followup.find((chunk) => chunk.type === 'usage')?.usage
  assert.ok(followupUsage?.totalTokens > 0, 'nonempty multi-turn terminal usage required')
  assert.ok(followup.some((chunk) => chunk.type === 'block-end' && chunk.block.type === 'text' &&
    chunk.block.text.includes('CONNECTION_OK')), 'real tool result must be consumed in second turn')
  report.rounds.push({ kind: 'tool-result-history', usage: followupUsage, chunks: followup })
  report.usage = usage
  report.referenceEstimateUsd = report.rounds.reduce((sum, row) => {
    const cost = estimateCost({ tokensIn: row.usage.inputTokens + (row.usage.cacheReadTokens ?? 0) + (row.usage.cacheWriteTokens ?? 0),
      tokensCached: row.usage.cacheReadTokens ?? 0,
      tokensOut: row.usage.outputTokens }, [price], report.model, report.startedAt)
    assert.equal(cost.known, true)
    return sum + cost.usd
  }, 0)
  assert.equal(report.chunks.at(-1)?.reason?.kind, 'tool-calls')
  assert.equal(report.submittedRequests, 2, 'one submission per turn; no resubmission permitted')
  report.passed = true
} catch (error) {
  report.error = String(error)
} finally {
  report.finishedAt = Date.now()
  writeFileSync(reportPath, JSON.stringify(redact(report), null, 2) + '\n', { mode: 0o600 })
  await providerFiber?.dispose()
  await llmFiber?.dispose()
  await credentialsFiber?.dispose()
  restoreWs()
}
console.log(JSON.stringify(redact({ passed: report.passed, submittedRequests: report.submittedRequests,
  usage: report.usage, referenceEstimateUsd: report.referenceEstimateUsd, costKnown: report.costKnown, error: report.error }), null, 2))
if (!report.passed) process.exitCode = 1
