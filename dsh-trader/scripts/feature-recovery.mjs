#!/usr/bin/env node
/** 离线人工恢复入口：inspect 默认只读；先停止profile，完成confirm后重启以恢复完整增量前缀。 */
import assert from 'node:assert/strict'
import { resolve } from 'node:path'
import Database from 'better-sqlite3'
import { FeatureRecovery,migrate,systemClock } from '../lib/internal-api.js'
const args=process.argv.slice(2),limit=args.find(arg=>arg.startsWith('--max-bars='))
const [path,symbol,timeframe,operation='inspect',id,...reasonParts]=args.filter(arg=>!arg.startsWith('--max-bars='))
const maximumBars=limit===undefined?200000:Number(limit.slice('--max-bars='.length))
assert.ok(path&&symbol&&timeframe,'usage: feature-recovery.mjs db symbol timeframe [inspect|rebuild|confirm] [recoveryId] [reason]')
assert.ok(['inspect','rebuild','confirm'].includes(operation),'invalid operation')
const db=new Database(resolve(path),{readonly:operation==='inspect',fileMustExist:true})
try{
 if(operation!=='inspect')migrate(db)
 const recovery=new FeatureRecovery(db,systemClock(),maximumBars),reason=reasonParts.join(' ')
 const result=operation==='inspect'?recovery.inspect(symbol,timeframe)
  :operation==='rebuild'?recovery.rebuild(symbol,timeframe,id,reason):recovery.confirmCursor(symbol,timeframe,id,reason)
 console.log(JSON.stringify({operation,result,isolationActive:recovery.isolationActive(symbol,timeframe),modelsInvoked:0,executionCallbacks:0},null,2))
}finally{db.close()}
