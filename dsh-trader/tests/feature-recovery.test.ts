import Database from 'better-sqlite3'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdtempSync,rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach,beforeEach,describe,expect,it } from 'vitest'
import { ReplayClock } from '../src/clock.js'
import { migrate,SCHEMA_VERSION } from '../src/db/schema.js'
import { BarArchive } from '../src/market/archive.js'
import { FeatureArchive } from '../src/market/feature-archive.js'
import { FeatureEngine,FeaturePipeline } from '../src/market/features.js'
import { FeatureRecovery } from '../src/market/feature-recovery.js'
import { MarketObservationStore } from '../src/market/observations.js'
import type { Candle } from '../src/market/types.js'
const symbol='ADA/USDT:USDT',tf='1h',step=3600000
let db:Database.Database,bars:BarArchive,features:FeatureArchive,clock:ReplayClock,recovery:FeatureRecovery,candles:Candle[]
beforeEach(()=>{
 db=new Database(':memory:');migrate(db);bars=new BarArchive(db);features=new FeatureArchive(db);clock=new ReplayClock(200*step)
 recovery=new FeatureRecovery(db,clock);candles=Array.from({length:80},(_,i)=>({symbol,timeframe:tf,openTime:i*step,closeTime:(i+1)*step,
  open:100+i,high:102+i,low:99+i,close:101+i,volume:10+i,closed:true}))
 bars.upsertClosed(candles,{source:'fixture',fetchedAt:clock.now()});const engine=new FeatureEngine()
 for(const [i,candle] of candles.entries()){
  features.upsert(engine.onClosedCandle(candle,{timestamp:candle.closeTime,openInterest:100+i,fundingRate:.001}),clock.now())
  bars.markProcessed(candle,clock.now())
 }
 clock.advanceTo(clock.now()+1000)
 const changed={...candles[55]!,high:190,close:185};candles[55]=changed;bars.upsertClosed([changed],{source:'revision',fetchedAt:clock.now()})
})
afterEach(()=>db.close())
describe('人工特征恢复',()=>{
 it('查看不写库；特征重建幂等、PIT仅从恢复时刻可见，确认前游标仍隔离，确认后不漏新bar',()=>{
  const before=db.prepare('SELECT COUNT(*) n FROM market_observations').get() as {n:number}
  const plan=recovery.inspect(symbol,tf);expect(plan.bars).toBe(80);expect(plan.affectedBars).toBe(25)
  expect(db.prepare('SELECT COUNT(*) n FROM market_observations').get()).toEqual(before)
  const latest=candles.at(-1)!,store=new MarketObservationStore(db),tombstone=store.recent('feature',symbol,tf,clock.now(),100).at(-1)!
  expect(tombstone.source).toBe('feature-pipeline-invalidation')
  clock.advanceTo(clock.now()+1000);const receipt=recovery.rebuild(symbol,tf,plan.recoveryId,'重建修订后的完整历史')
  expect(receipt.confirmed_at).toBeNull();expect(bars.unprocessedClosedBars(symbol,tf)).toHaveLength(25)
  expect(bars.requiresFeatureRecovery(latest)).toBe(true)
  const expected=new FeatureEngine();let last
  for(const [i,candle] of candles.entries())last=expected.onClosedCandle(candle,{timestamp:candle.closeTime,openInterest:100+i,fundingRate:.001})
  expect(features.latest(symbol,tf)).toEqual(last)
  expect(store.recent('feature',symbol,tf,receipt.rebuilt_at-1,100).at(-1)!.source).toBe('feature-pipeline-invalidation')
  const observations=db.prepare('SELECT COUNT(*) n FROM market_observations').get()
  expect(recovery.rebuild(symbol,tf,plan.recoveryId,'重复重建')).toEqual(receipt)
  expect(db.prepare('SELECT COUNT(*) n FROM market_observations').get()).toEqual(observations)
  const fresh={...latest,openTime:latest.closeTime,closeTime:latest.closeTime+step}
  bars.upsertClosed([fresh],{source:'new',fetchedAt:clock.now()})
  recovery.confirmCursor(symbol,tf,plan.recoveryId,'确认只跳过历史回调')
  expect(bars.unprocessedClosedBars(symbol,tf)).toEqual([fresh])
  expect(bars.requiresFeatureRecovery(fresh)).toBe(false)
  const audits=db.prepare('SELECT COUNT(*) n FROM audit_events').get()
  recovery.confirmCursor(symbol,tf,plan.recoveryId,'重复确认')
  expect(db.prepare('SELECT COUNT(*) n FROM audit_events').get()).toEqual(audits)
  const pipeline=new FeaturePipeline(features);expect(pipeline.restoreProcessed(bars,symbol,tf)).toBe(80)
  expect(pipeline.onClosedCandle(fresh)).toEqual(expected.onClosedCandle(fresh))
 })
 it('新的修订拒绝旧计划/确认；失败有审计且不能部分写入游标',()=>{
  const plan=recovery.inspect(symbol,tf);recovery.rebuild(symbol,tf,plan.recoveryId,'第一次重建')
  clock.advanceTo(clock.now()+1000);const revised={...candles[60]!,high:200,close:195};bars.upsertClosed([revised],{source:'another revision',fetchedAt:clock.now()})
  expect(()=>recovery.confirmCursor(symbol,tf,plan.recoveryId,'不能确认旧结果')).toThrow(/已变化/)
  expect(bars.unprocessedClosedBars(symbol,tf).length).toBeGreaterThan(0)
  expect(db.prepare("SELECT COUNT(*) n FROM audit_events WHERE kind='market.feature_recovery_rejected'").get()).toEqual({n:1})
  expect(recovery.inspect(symbol,tf).recoveryId).not.toBe(plan.recoveryId)
 })
 it('缺口、空原因、投影篡改与未重建确认均拒绝，不伪装为成功',()=>{
  const plan=recovery.inspect(symbol,tf)
  expect(()=>recovery.confirmCursor(symbol,tf,plan.recoveryId,'无重建')).toThrow(/先完成/)
  expect(()=>recovery.rebuild(symbol,tf,plan.recoveryId,' ')).toThrow(/原因/)
  recovery.rebuild(symbol,tf,plan.recoveryId,'合法重建')
  db.prepare("UPDATE features SET snapshot_json='{}' WHERE symbol=? AND timeframe=? AND open_time=?").run(symbol,tf,candles[55]!.openTime)
  expect(()=>recovery.confirmCursor(symbol,tf,plan.recoveryId,'投影已变')).toThrow(/不一致/)
  db.prepare('DELETE FROM features WHERE symbol=? AND timeframe=? AND open_time=?').run(symbol,tf,candles[20]!.openTime)
  db.prepare('DELETE FROM bar_processing WHERE symbol=? AND timeframe=? AND open_time=?').run(symbol,tf,candles[20]!.openTime)
  db.prepare('DELETE FROM bars WHERE symbol=? AND timeframe=? AND open_time=?').run(symbol,tf,candles[20]!.openTime)
  expect(()=>recovery.inspect(symbol,tf)).toThrow(/缺口/)
 })
 it('已确认凭据不可删除或改写，旧确认不能消除新的隔离',()=>{
  const plan=recovery.inspect(symbol,tf);recovery.rebuild(symbol,tf,plan.recoveryId,'重建')
  expect(()=>db.prepare('UPDATE market_feature_recoveries SET confirmed_at=rebuilt_at,confirm_reason=NULL').run()).toThrow()
  recovery.confirmCursor(symbol,tf,plan.recoveryId,'确认')
  expect(()=>db.prepare('DELETE FROM market_feature_recoveries').run()).toThrow(/immutable/)
  expect(()=>db.prepare("UPDATE market_feature_recoveries SET result_hash='tamper'").run()).toThrow(/once/)
  clock.advanceTo(clock.now()+1000);bars.upsertClosed([{...candles[65]!,high:220,close:210}],{source:'new revision',fetchedAt:clock.now()})
  recovery.confirmCursor(symbol,tf,plan.recoveryId,'重复旧确认')
  expect(recovery.isolationActive(symbol,tf)).toBe(true)
  expect(bars.unprocessedClosedBars(symbol,tf)).toHaveLength(15)
 })
 it('跨过1000行分页后，重启的下一根特征与不中断全量状态一致，50根截断确实不同',()=>{
  const other='DOGE/USDT:USDT';clock.advanceTo(2000*step)
  const many=Array.from({length:1005},(_,i)=>{const value=100+10*Math.sin(i/9)+i*.001;return {symbol:other,timeframe:tf,
    openTime:i*step,closeTime:(i+1)*step,open:value,close:value+.5,high:value+2,low:value-2,volume:20,closed:true}})
  bars.upsertClosed(many,{source:'long history',fetchedAt:clock.now()});const expected=new FeatureEngine(),truncated=new FeatureEngine()
  for(const candle of many){features.upsert(expected.onClosedCandle(candle),clock.now());bars.markProcessed(candle,clock.now())}
  for(const candle of many.slice(-50))truncated.onClosedCandle(candle)
  const next={...many.at(-1)!,openTime:1005*step,closeTime:1006*step}
  bars.upsertClosed([next],{source:'new',fetchedAt:clock.now()})
  const pipeline=new FeaturePipeline(features);expect(pipeline.restoreProcessed(bars,other,tf)).toBe(1005)
  const actual=pipeline.onClosedCandle(next),golden=expected.onClosedCandle(next)
  expect(actual).toEqual(golden)
  expect(truncated.onClosedCandle(next).values.ema50).not.toBe(golden.values.ema50)
 })
 it('重建提交后SIGKILL，重启仍隔离且不重新重建，人工确认才推进历史游标',async()=>{
  const directory=mkdtempSync(join(tmpdir(),'feature-recovery-kill-')),path=join(directory,'state.sqlite')
  await db.backup(path)
  const script=`import Database from 'better-sqlite3';import {FeatureRecovery,ReplayClock} from './lib/internal-api.js';
    const db=new Database(process.argv[1]),recovery=new FeatureRecovery(db,new ReplayClock(Number(process.argv[2])));
    const plan=recovery.inspect('ADA/USDT:USDT','1h');recovery.rebuild('ADA/USDT:USDT','1h',plan.recoveryId,'SIGKILL fixture');
    console.log(JSON.stringify({ready:true,id:plan.recoveryId}));setInterval(()=>{},1000);`
  const child=spawn(process.execPath,['--input-type=module','-e',script,path,String(clock.now())],{stdio:['ignore','pipe','pipe'],env:{PATH:process.env.PATH}})
  try{
    const [data]=await once(child.stdout,'data');const ready=JSON.parse(String(data)) as {ready:boolean;id:string}
    expect(ready.ready).toBe(true);const exit=once(child,'exit');child.kill('SIGKILL');expect((await exit)[1]).toBe('SIGKILL')
    const restarted=new Database(path)
    try{
      const recovered=new FeatureRecovery(restarted,clock),archive=new BarArchive(restarted)
      expect(recovered.isolationActive(symbol,tf)).toBe(true)
      expect(recovered.receipt(ready.id)?.confirmed_at).toBeNull()
      const events=restarted.prepare('SELECT COUNT(*) n FROM audit_events').get()
      recovered.rebuild(symbol,tf,ready.id,'重启幂等重建')
      expect(restarted.prepare('SELECT COUNT(*) n FROM audit_events').get()).toEqual(events)
      recovered.confirmCursor(symbol,tf,ready.id,'重启后确认')
      expect(archive.unprocessedClosedBars(symbol,tf)).toHaveLength(0)
      expect(recovered.isolationActive(symbol,tf)).toBe(false)
    }finally{restarted.close()}
  }finally{if(child.exitCode===null&&child.signalCode===null)child.kill('SIGKILL');rmSync(directory,{recursive:true,force:true})}
 },15000)
 it('完整历史超限、未来可见时刻与错误标的凭据均拒绝',()=>{
  expect(()=>new FeatureRecovery(db,clock,60).inspect(symbol,tf)).toThrow(/上限/)
  expect(()=>new FeatureRecovery(db,new ReplayClock(0)).inspect(symbol,tf)).toThrow(/可见/)
  const plan=recovery.inspect(symbol,tf);recovery.rebuild(symbol,tf,plan.recoveryId,'重建')
  expect(()=>recovery.confirmCursor('OTHER',tf,plan.recoveryId,'错误作用域')).toThrow(/其它标的/)
  expect(recovery.receipt(plan.recoveryId)?.confirmed_at).toBeNull()
 })
 it('历史没有原始衍生品输入时仍为未知，不能复制当前值或填零',()=>{
  const other='ETH/USDT:USDT',rows=candles.map(candle=>({...candle,symbol:other})),engine=new FeatureEngine()
  bars.upsertClosed(rows,{source:'no derivatives',fetchedAt:clock.now()})
  for(const row of rows){features.upsert(engine.onClosedCandle(row),clock.now());bars.markProcessed(row,clock.now())}
  bars.upsertClosed([{...rows[60]!,high:230,close:220}],{source:'revision',fetchedAt:clock.now()})
  const plan=recovery.inspect(other,tf);expect(plan.missingDerivativeInputs).toBe(80)
  recovery.rebuild(other,tf,plan.recoveryId,'只用已归档输入')
  expect(features.latest(other,tf)?.values).toMatchObject({fundingRate:null,oiChangePct:null,liqNotional:null,basisBps:null})
 })
 it('v10升级至v11不损失原数据，凭据唯一且约束状态',()=>{
  db.exec('DROP TABLE market_feature_recoveries; PRAGMA user_version=10');const count=bars.count();migrate(db);migrate(db)
  expect(db.pragma('user_version',{simple:true})).toBe(SCHEMA_VERSION);expect(bars.count()).toBe(count)
  expect(db.prepare('SELECT COUNT(*) n FROM market_feature_recoveries').get()).toEqual({n:0})
 })
})
