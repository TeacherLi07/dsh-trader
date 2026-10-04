#!/usr/bin/env node
/** 真实bar归档副本上的恢复故障注入；原DB只读，处理游标为标注的工程fixture。 */
import assert from 'node:assert/strict'
import { copyFileSync,chmodSync,existsSync,mkdirSync,readFileSync,writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { resolve,join } from 'node:path'
import Database from 'better-sqlite3'
import { BarArchive,FeatureArchive,FeatureRecovery,FeaturePipeline,ReplayClock,migrate } from '../lib/internal-api.js'
assert.ok(process.argv[2]&&process.argv[3],'usage: feature-recovery-check.mjs realSourceDb newOutputDirectory')
const source=resolve(process.argv[2]),output=resolve(process.argv[3]),hash=()=>createHash('sha256').update(readFileSync(source)).digest('hex'),before=hash()
assert.ok(!existsSync(output),'new private directory required');mkdirSync(output,{recursive:true,mode:0o700})
const copy=join(output,'recovery.sqlite');copyFileSync(source,copy);chmodSync(copy,0o600)
const db=new Database(copy);migrate(db)
const ledger=JSON.stringify(db.prepare('SELECT * FROM budget_ledger ORDER BY day,scope').all())
const orders=db.prepare('SELECT COUNT(*) n FROM order_intents').get().n
let networkCalls=0;const previousFetch=globalThis.fetch
globalThis.fetch=async()=>{networkCalls++;throw Error('feature recovery attempted network')}
try {
 const bars=new BarArchive(db),features=new FeatureArchive(db),clock=new ReplayClock(Date.now())
 const selected=db.prepare('SELECT symbol,timeframe,COUNT(*) n FROM bars GROUP BY symbol,timeframe HAVING COUNT(*)>=60 ORDER BY symbol,timeframe LIMIT 1').get()
 assert.ok(selected,'nonempty real series required');const {symbol,timeframe}=selected
 const series=bars.closedBars(symbol,timeframe,{limit:bars.count(symbol,timeframe)})
 assert.equal(series.length,selected.n)
 // 先在副本形成明确的已处理前缀；这不声称真实生产feed曾处理这些归档行。
 for(const candle of series)bars.markProcessed(candle,clock.now())
 const original=series[Math.floor(series.length*2/3)],revised={...original,high:original.high*(1+1e-6)}
 bars.upsertClosed([revised],{source:'synthetic recovery fault over real bars',fetchedAt:clock.now()})
 const recovery=new FeatureRecovery(db,clock),plan=recovery.inspect(symbol,timeframe)
 assert.ok(plan.affectedBars>0);clock.advanceTo(clock.now()+1)
 const rebuilt=recovery.rebuild(symbol,timeframe,plan.recoveryId,'真实数据副本故障注入，仅重建特征')
 assert.equal(rebuilt.confirmed_at,null);assert.equal(recovery.isolationActive(symbol,timeframe),true)
 assert.equal(bars.unprocessedClosedBars(symbol,timeframe).length,plan.affectedBars)
 clock.advanceTo(clock.now()+1);recovery.confirmCursor(symbol,timeframe,plan.recoveryId,'确认跳过受影响历史回调')
 assert.equal(recovery.isolationActive(symbol,timeframe),false)
 assert.equal(bars.unprocessedClosedBars(symbol,timeframe).length,0)
 const audits=db.prepare("SELECT kind FROM audit_events WHERE kind IN ('market.features_rebuilt','market.feature_cursor_confirmed') ORDER BY seq").all()
 assert.equal(audits.length,2)
 recovery.rebuild(symbol,timeframe,plan.recoveryId,'幂等重建');recovery.confirmCursor(symbol,timeframe,plan.recoveryId,'幂等确认')
 assert.equal(db.prepare("SELECT COUNT(*) n FROM audit_events WHERE kind IN ('market.features_rebuilt','market.feature_cursor_confirmed')").get().n,2)
 assert.equal(JSON.stringify(db.prepare('SELECT * FROM budget_ledger ORDER BY day,scope').all()),ledger)
 assert.equal(db.prepare('SELECT COUNT(*) n FROM order_intents').get().n,orders)
 const recovered=new FeaturePipeline(features);assert.equal(recovered.restoreProcessed(bars,symbol,timeframe),series.length)
 assert.equal(networkCalls,0)
 assert.equal(hash(),before,'original source DB changed')
 const report={passed:true,source,sourceHash:before,sourceUnmodified:true,symbol,timeframe,realBars:series.length,
  syntheticCursorAndRevisionFixture:true,affectedBars:plan.affectedBars,receipt:recovery.receipt(plan.recoveryId),audits,
  modelCalls:0,networkCalls,executionCallbacks:0,newOrderIntents:0,budgetUnchanged:true,restartRestoredBars:series.length}
 writeFileSync(join(output,'report.json'),JSON.stringify(report,null,2)+'\n',{flag:'wx',mode:0o600});console.log(JSON.stringify(report))
}finally{globalThis.fetch=previousFetch;db.close()}
