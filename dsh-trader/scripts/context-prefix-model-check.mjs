#!/usr/bin/env node
/** 历史完整快照的真实 provider 回放，仅测协议/缓存；不启动交易或刷新旧事实时点。 */
import assert from 'node:assert/strict'
import { appendFileSync,existsSync,mkdirSync,readFileSync,statSync,writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { join,resolve } from 'node:path'
import Database from 'better-sqlite3'
import { Context } from '@deepseek-ai/cordis'
import LlmRuntime from '@deepseek-ai/dsh-llm'
import CredentialsLocal from '@deepseek-ai/dsh-credentials-local'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import { runDecisionWorkflowStages,DECISION_WORKFLOW_PROMPT_VERSION } from '../lib/agents/decision-workflow.js'
import { assertDecisionContext } from '../lib/agents/decision-context.js'
import { estimateCost,lunaGatewayReferencePrice } from '../lib/cost.js'
import { readLunaGatewayConfig,lunaProviderConfig,traceResponsesWs,referenceProbeCost } from './model-connection-config.mjs'
import * as WsProvider from '../lib/plugins/sub2api-responses-ws.js'

assert.ok(process.argv[2] && process.argv[3], 'usage: context-prefix-model-check.mjs realSourceDb newOutputDir')
const source=resolve(process.argv[2]),output=resolve(process.argv[3]);assert.ok(!existsSync(output),'new directory required; never replay an interrupted attempt')
mkdirSync(output,{recursive:true,mode:0o700});assert.equal(statSync(output).mode&0o077,0)
const hash=()=>createHash('sha256').update(readFileSync(source)).digest('hex'),before=hash()
const db=new Database(source,{readonly:true})
const row=db.prepare("SELECT c.canonical_json,r.run_id FROM decision_contexts c JOIN decision_runs r ON r.context_id=c.context_id WHERE r.cost_known=1 AND json_extract(r.final_json,'$.failure') IS NULL ORDER BY r.created_at LIMIT 1").get();db.close()
assert.ok(row,'nonempty fully completed, known-usage historical source required')
const frozen=JSON.parse(row.canonical_json);assertDecisionContext(frozen)
const gateway=readLunaGatewayConfig(),price=lunaGatewayReferencePrice(Date.now()),maxTokens=32768
const identity=`replay-${createHash('sha256').update(`${source}|${gateway.model}|${DECISION_WORKFLOW_PROMPT_VERSION}`).digest('hex')}`
const report={startedAt:Date.now(),source,sourceHash:before,sourceRunId:row.run_id,contextHash:frozen.contextHash,
 historicalAsOf:frozen.asOf,scope:'historical provider replay; no forward/economic sample',model:gateway.model,
 reasoningEffort:'max',maxTokens,referenceBudgetUsd:.30,sessionId:identity,reservations:[],rounds:[],providerRequests:0,
 realExchangeOrdersSubmitted:0,gatewayInvoiceVerified:false,build:JSON.parse(readFileSync(new URL('../lib/build-manifest.json',import.meta.url))),passed:false}
const secrets=['TRADER_API_KEY','TRADER_API_SECRET','SUB2API_KEY','DEEPSEEK_API_KEY'].map(name=>process.env[name]).filter(Boolean)
const safe=value=>{let text=JSON.stringify(value);for(const secret of secrets)text=text.replaceAll(secret,'[REDACTED]').replaceAll(encodeURIComponent(secret),'[REDACTED]');return JSON.parse(text)}
const log=(kind,detail)=>appendFileSync(join(output,'events.jsonl'),JSON.stringify(safe({at:Date.now(),kind,detail}))+'\n',{mode:0o600})
const restore=await traceResponsesWs((kind,detail)=>log(kind,detail),request=>{
 assert.ok(report.providerRequests<4,'maximum three stages plus one repair')
 assert.equal(request.model,'gpt-6-luna');assert.equal(request.reasoning?.effort,'max')
 assert.equal(request.prompt_cache_key,identity);assert.equal(request.store,false);assert.equal(request.previous_response_id,undefined)
 assert.deepEqual(request.tools.map(tool=>tool.name),['submit_decision_envelope','submit_risk_critique'])
 report.providerRequests++
})
const ctx=new Context();let credentialsFiber,llmFiber,providerFiber
try{
 credentialsFiber=await ctx.plugin(CredentialsLocal,{dshHome:process.env.DSH_HOME??'/home/ubuntu/.dsh',watch:false})
 assert.ok((await ctx.credentials.resolve(credentialRef(gateway.apiKeyEnv)))?.value,'authorized credential unavailable')
 llmFiber=await ctx.plugin(LlmRuntime)
 providerFiber=await ctx.plugin({apply:WsProvider.apply,inject:WsProvider.inject},lunaProviderConfig(gateway,maxTokens))
 const result=await runDecisionWorkflowStages({strategy:'critique',context:frozen,sessionId:identity,
  model:{stream:options=>ctx.llm.stream(options)},route:{provider:WsProvider.SUB2API_RESPONSES_WS_PROVIDER,model:gateway.model,maxTokens,maxChars:180000},
  signal:AbortSignal.timeout(900000),
  beforeCall:async(request,stage)=>{
   const reserve=estimateCost({tokensIn:request.estimatedInputTokens,tokensCached:0,tokensOut:maxTokens},[price],gateway.model,report.startedAt)
   assert.equal(reserve.known,true)
   assert.ok(report.reservations.reduce((sum,row)=>sum+row.upperUsd,0)+reserve.usd<=report.referenceBudgetUsd,'reference budget exceeded')
   report.reservations.push({stage,requestHash:request.requestHash,upperUsd:reserve.usd});log('model.reserved',report.reservations.at(-1))
  },
  onModelCall:async call=>{if(call.usage)report.rounds.push({stage:call.stage,usage:call.usage});log('model.accounted',call)},
  onModelFailure:async call=>log('model.failed',call),
 })
 report.result=result;assert.equal(result.failure,undefined,'historical model workflow must validate')
 assert.ok(report.providerRequests>=3 && result.final,'nonempty complete critique required')
 report.passed=true
}catch(error){report.error=String(error)}finally{
 Object.assign(report,referenceProbeCost(report.rounds,report.reservations,price,gateway.model,report.startedAt))
 report.sourceUnmodified=hash()===before;assert.ok(report.sourceUnmodified)
 report.finishedAt=Date.now();writeFileSync(join(output,'report.json'),JSON.stringify(safe(report),null,2)+'\n',{mode:0o600,flag:'wx'})
 await providerFiber?.dispose();await llmFiber?.dispose();await credentialsFiber?.dispose();restore()
}
console.log(JSON.stringify({passed:report.passed,providerRequests:report.providerRequests,knownUsageCalls:report.knownUsageCalls,
 referenceEstimateUsd:report.referenceEstimateUsd,unresolvedUpperReservationUsd:report.unresolvedUpperReservationUsd,error:report.error??null}))
if(!report.passed)process.exitCode=1
