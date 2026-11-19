import test from 'node:test'
import assert from 'node:assert/strict'
import {build} from 'esbuild'
const output=await build({entryPoints:['worker/src/liveCandidates.ts'],bundle:true,platform:'node',format:'esm',write:false})
const {liveCandidates,liveEntry}=await import('data:text/javascript;base64,'+Buffer.from(output.outputFiles[0].contents).toString('base64'))
const scan='2026-11-19T00:40:00.000Z'
const now=new Date('2026-11-19T00:41:00.000Z')
const candidate=(code,trigger)=>({code,name:code,status:'관찰 후보',entryTrigger:trigger,score:6})
test('live shortlist excludes unaffordable paper picks and keeps lower-priced candidates',()=>{
 const signals=[candidate('181710',72172),candidate('003550',90590),candidate('028670',5140)]
 const pending=liveCandidates(signals,scan)
 assert.deepEqual(pending,[{code:'028670',name:'028670',trigger:5140,scanAt:scan}])
 const fill=liveEntry(pending[0],{code:'028670',price:5150,checked_at:now.toISOString()},now)
 assert.equal(fill.quantity,1)
 assert.equal(fill.side,'BUY')
 assert.match(fill.id,/live-entry-028670-/)
})
test('live entry requires a later fresh quote, valid tick, and budget including cash headroom',()=>{
 const pending={code:'028670',name:'test',trigger:49500,scanAt:scan}
 const q={code:pending.code,price:49500,checked_at:now.toISOString()}
 assert.ok(liveEntry(pending,q,now))
 assert.equal(liveEntry(pending,{...q,checked_at:scan},now),null)
 assert.equal(liveEntry(pending,{...q,checked_at:'2026-11-19T00:40:01Z'},now),null)
 assert.equal(liveEntry(pending,{...q,error:'TIMEOUT'},now),null)
 assert.equal(liveEntry(pending,{...q,price:49900},now),null)
 assert.equal(liveEntry({...pending,trigger:49501},{...q,price:49502},now),null)
 assert.equal(liveEntry({...pending,scanAt:'2026-11-18T00:40:00Z'},q,now),null)
})
