#!/usr/bin/env node
/** Codex 中授权的 Luna/max 网关 WS 工具往返；不注入交易 runtime，按官方参考估算而非声称实付。 */
import assert from 'node:assert/strict'
import { appendFileSync, existsSync, mkdirSync, statSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import LlmRuntime, { createAssistantMessage, createToolResultMessage, createSystemMessage } from '@deepseek-ai/dsh-llm'
import CredentialsLocal from '@deepseek-ai/dsh-credentials-local'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import { estimateCost, lunaGatewayReferencePrice } from '../lib/cost.js'
import { randomUUID } from 'node:crypto'
import { DECISION_ENVELOPE_TOOL, parseDecisionEnvelopeCandidate } from '../lib/agents/decision-envelope.js'
import { DECISION_WORKFLOW_TOOLS } from '../lib/agents/decision-workflow.js'
import { freezeDecisionContext } from '../lib/agents/decision-context.js'
import { readLunaGatewayConfig, lunaProviderConfig, traceResponsesWs, referenceProbeCost } from './model-connection-config.mjs'
import * as WsProvider from '../lib/plugins/sub2api-responses-ws.js'

const output = resolve(process.argv[2] ?? '/tmp/sub2api-connection-check')
mkdirSync(output, { recursive: true, mode: 0o700 })
assert.equal(statSync(output).mode & 0o077, 0, 'private output directory required')
const reportPath = join(output, 'report.json')
assert.ok(!existsSync(reportPath) && !existsSync(join(output, 'ws.jsonl')), 'refuse to replay or overwrite prior submitted evidence')
const home = process.env.DSH_HOME ?? '/home/ubuntu/.dsh'
const configured = readLunaGatewayConfig(process.argv[3])
const completeSchema = process.argv.includes('--complete-schema')
const sessionId = randomUUID()
const clientRequestIds = [randomUUID(), randomUUID()]
const submissionTool = completeSchema ? DECISION_ENVELOPE_TOOL : { name: 'submit_connection_result', description: 'Return connection status only; no side effects.',
  parameters: { type: 'object', additionalProperties: false, properties: { status: { type: 'string', enum: ['OK'] } }, required: ['status'] } }
const price = lunaGatewayReferencePrice(Date.now())
const report = { startedAt: Date.now(), provider: WsProvider.SUB2API_RESPONSES_WS_PROVIDER,
  model: configured.model, endpoint: configured.baseURL, sourceConfig: configured.sourceConfig,
  maxTokens: 8192, reasoningEffort: configured.reasoningEffort,
  referencePrice: price, costKnown: false, gatewayPriceVerified: false, realExchangeOrdersSubmitted: 0,
  strictTools: true, completeSchema, namedToolChoice: true, toolCatalogSize: completeSchema ? DECISION_WORKFLOW_TOOLS.length : 1, syntheticContractProbe: completeSchema, sessionId, clientRequestIds,
  observedHandshakes: [], submittedRequests: 0, referenceBudgetUsd: 0.05, reservations: [], chunks: [], rounds: [], passed: false }
let key
const redact = (value) => {
  let text = JSON.stringify(value)
  if (key) text = text.replaceAll(key, '[REDACTED]').replaceAll(encodeURIComponent(key), '[REDACTED]')
  return JSON.parse(text)
}
const log = (kind, detail) => {
  if (kind === 'ws.connect') {
    const ordinal = report.observedHandshakes.length
    assert.ok(ordinal < clientRequestIds.length, 'no extra WebSocket handshake permitted')
    assert.equal(detail.headers['x-client-request-id'], clientRequestIds[ordinal])
    assert.equal(detail.headers['session-id'], sessionId)
    assert.equal(detail.headers['thread-id'], sessionId)
    assert.equal(detail.headers.originator, 'codex_cli_rs')
    assert.ok(detail.headers['user-agent']?.startsWith('codex_cli_rs/'))
    report.observedHandshakes.push(detail)
  }
  appendFileSync(join(output, 'ws.jsonl'), JSON.stringify(redact({ at: Date.now(), kind, detail })) + '\n', { mode: 0o600 })
}
const restoreWs = await traceResponsesWs(log, (event) => {
  assert.ok(report.submittedRequests < 2, 'no resubmission or extra probe turn permitted')
  const reserve = estimateCost({ tokensIn: Buffer.byteLength(JSON.stringify(event), 'utf8') + 4_096,
    tokensCached: 0, tokensOut: event.max_output_tokens }, [price], report.model, report.startedAt)
  assert.equal(reserve.known, true)
  assert.ok(report.reservations.reduce((sum, row) => sum + row.upperUsd, 0) + reserve.usd <= report.referenceBudgetUsd, 'reference probe budget exceeded')
  report.submittedRequests += 1
  const clientRequestId = clientRequestIds[report.submittedRequests - 1]
  assert.equal(report.observedHandshakes[report.submittedRequests - 1]?.headers['x-client-request-id'], clientRequestId)
  report.reservations.push({ requestOrdinal: report.submittedRequests, clientRequestId, upperUsd: reserve.usd })
  log('probe.reserved', report.reservations.at(-1))
  assert.equal(event.model, configured.wireModelId)
  assert.equal(event.reasoning?.effort, 'max', 'reasoning effort must reach wire unchanged')
  assert.equal(event.temperature, undefined, 'reasoning model sampling compatibility')
  assert.equal(event.prompt_cache_key, sessionId)
  assert.equal(event.client_metadata?.session_id, sessionId)
  assert.equal(event.client_metadata?.thread_id, sessionId)
  if (event.tools?.length) assert.equal(event.tools[0].strict, true)
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
    sessionId, clientRequestId: clientRequestIds[0], maxTokens: report.maxTokens, temperature: 0, signal: AbortSignal.timeout(180_000),
    system: completeSchema
      ? 'Use submit_decision_envelope exactly once for a schema contract probe. Outcome no_trade, nonempty thesis, empty claims/rejectedAlternatives/uncertainties, confidence 0.5, riskFraction 0.1. No plan or trade action is needed; optional fields may be null. This probe has no execution tools.'
      : 'Use the submit_connection_result tool exactly once with status OK. No other output.',
    messages: [{ role: 'user', content: [{ type: 'text', text: 'Confirm this WebSocket Responses connection.' }] }],
    tools: completeSchema ? [...DECISION_WORKFLOW_TOOLS] : [submissionTool],
    toolChoice: { type: 'function', name: submissionTool.name },
  })) { report.chunks.push(chunk); log('chunk', chunk) }
  const usage = report.chunks.find(chunk => chunk.type === 'usage')?.usage
  if (usage) { report.rounds.push({ kind: 'tool', usage }); report.usage = usage }
  const providerFailure = report.chunks.find(chunk => chunk.type === 'finish' && chunk.reason?.kind === 'error')?.reason?.failure
  if (providerFailure) throw new Error(`${providerFailure.code}: ${providerFailure.message}`)
  const tool = report.chunks.find((chunk) => chunk.type === 'block-end' && chunk.block.type === 'tool-call')
  assert.ok(tool, 'nonempty structured tool output required')
  if (completeSchema) {
    const asOf = Date.now()
    const sections = Object.fromEntries(['mandate','market','derivatives','benchmark','portfolio','activePlan','history','lessons','predictions']
      .map(name => [name, { asOf, source: 'synthetic provider contract probe; no trading evidence', missing: [], value: {} }]))
    const context = freezeDecisionContext({ symbol: 'ADA/USDT:USDT', primaryTimeframe: '1h', asOf, sections })
    const parsed = parseDecisionEnvelopeCandidate(JSON.parse(tool.block.arguments), context)
    assert.ok(parsed.ok, 'full original DecisionEnvelope validator must accept the provider contract result')
    assert.equal(parsed.candidate.outcome, 'no_trade')
    report.contractValidated = true
  } else assert.equal(JSON.parse(tool.block.arguments).status, 'OK')
  assert.ok(usage && usage.totalTokens > 0, 'nonempty authoritative usage required')
  const history = createAssistantMessage({ content: [tool.block], source: { provider: report.provider, model: report.model } })
  const followup = []
  for await (const chunk of ctx.llm.stream({ provider: report.provider, model: report.model,
    sessionId, clientRequestId: clientRequestIds[1], maxTokens: report.maxTokens, temperature: 0, signal: AbortSignal.timeout(180_000),
    system: 'After receiving the connection tool result, reply CONNECTION_OK exactly.',
    messages: [{ role: 'user', content: [{ type: 'text', text: 'Confirm the connection via the status tool.' }] },
      history, createToolResultMessage({ callId: tool.block.id, isError: false,
        content: [{ type: 'text', text: completeSchema ? '{"validation":"OK","outcome":"no_trade"}' : '{"status":"OK"}' }] }),
      createSystemMessage('Return CONNECTION_OK exactly after reading the tool result.', 'provider-contract-probe')],
  })) { followup.push(chunk); log('followup.chunk', chunk) }
  const followupUsage = followup.find(chunk => chunk.type === 'usage')?.usage
  if (followupUsage) report.rounds.push({ kind: 'tool-result-history', usage: followupUsage, chunks: followup })
  const followupFailure = followup.find(chunk => chunk.type === 'finish' && chunk.reason?.kind === 'error')?.reason?.failure
  if (followupFailure) throw new Error(`${followupFailure.code}: ${followupFailure.message}`)
  assert.ok(followupUsage?.totalTokens > 0, 'nonempty multi-turn terminal usage required')
  assert.ok(followup.some((chunk) => chunk.type === 'block-end' && chunk.block.type === 'text' &&
    chunk.block.text.includes('CONNECTION_OK')), 'real tool result must be consumed in second turn')
  report.usage = usage
  assert.equal(report.chunks.at(-1)?.reason?.kind, 'tool-calls')
  assert.equal(report.submittedRequests, 2, 'one submission per turn; no resubmission permitted')
  assert.equal(report.observedHandshakes.length, 2, 'nonempty actual socket observations required')
  assert.equal(new Set(report.reservations.map(row => row.clientRequestId)).size, 2)
  report.requestIdentityVerified = true
  report.passed = true
} catch (error) {
  report.error = String(error)
} finally {
  Object.assign(report, referenceProbeCost(report.rounds, report.reservations, price, report.model, report.startedAt))
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
