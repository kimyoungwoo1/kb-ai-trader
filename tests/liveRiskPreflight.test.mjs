import test from 'node:test'
import assert from 'node:assert/strict'
import { build } from 'esbuild'
const bundled=await build({entryPoints:['worker/src/liveRiskPreflight.ts'],bundle:true,platform:'node',format:'esm',write:false})
const {parseBuyingPower,evaluateBuyPreview,readKbBuyingPower}=
 await import('data:text/javascript;base64,'+Buffer.from(bundled.outputFiles[0].contents).toString('base64'))
const now=new Date('2026-11-09T00:32:00Z')
const pass={orderableCash:281959,buyingPower:280000}
const options={now,dailyBuys:0,activeTrialOrders:0,otherTrialSymbols:0}
const response=(value)=>({dataHeader:{resultCode:'200',processFlag:'A',processCode:'0011'},dataBody:{ordr_psbl_csh:String(value),mx_ordr_psbl_amt:'250000'}})

test('KB SSQM1802 read-only response parses cash and buying power without guessing',()=>{
 assert.deepEqual(parseBuyingPower(response('000000000000281959')),{orderableCash:281959,buyingPower:250000})
 assert.throws(()=>parseBuyingPower({dataBody:{ordr_psbl_csh:'10000'}}),/업무 응답/)
 assert.throws(()=>parseBuyingPower({...response('10000'),dataBody:{ordr_psbl_csh:'10000'}}),/누락/)
 assert.throws(()=>parseBuyingPower(response('999999999999999999')),/누락/)
})
test('50k total including cash headroom, no extra buy, no unknown order',()=>{
 const good=evaluateBuyPreview('005930',9000,1,pass,options)
 assert.equal(good.permitted,true)
 assert.equal(good.notional,9000)
 assert.equal(good.feeBuffer,90)
 assert.equal(good.requiredCash,9090)
 assert.equal(evaluateBuyPreview('005930',49504,1,pass,options).requiredCash,50000)
 assert.equal(evaluateBuyPreview('005930',49504,1,pass,options).permitted,true)
 assert.equal(evaluateBuyPreview('005930',49505,1,pass,options).permitted,false)
 assert.equal(evaluateBuyPreview('005930',9000,2,pass,options).permitted,false)
 assert.equal(evaluateBuyPreview('005930',9000,1,pass,{...options,dailyBuys:1}).permitted,false)
 assert.equal(evaluateBuyPreview('005930',9000,1,pass,{...options,activeTrialOrders:1}).permitted,false)
 assert.equal(evaluateBuyPreview('005930',9000,1,pass,{...options,otherTrialSymbols:1}).permitted,false)
})
test('missing authoritative balances, missing D1 counts, cash shortage and market closed always fail closed',()=>{
 assert.equal(evaluateBuyPreview('005930',9000,1,null,options).permitted,false)
 assert.equal(evaluateBuyPreview('005930',9000,1,pass,{now}).permitted,false)
 assert.equal(evaluateBuyPreview('005930',9000,1,{orderableCash:100,buyingPower:280000},options).permitted,false)
 assert.equal(evaluateBuyPreview('005930',9000,1,pass,{...options,now:new Date('2026-11-08T23:40:00Z')}).permitted,false)
 assert.equal(evaluateBuyPreview('bad',9000,1,pass,options).permitted,false)
})
test('real KB buying power lookup is strictly read-only; never calls a trading endpoint',async()=>{
 const original=globalThis.fetch
 const paths=[]
 globalThis.fetch=async(url,opts)=>{
  paths.push(String(url))
  if(String(url).endsWith('/oauth2/token'))return Response.json({dataBody:{access_token:'temp-mock-token',expires_in:3600}})
  if(String(url).endsWith('/api/v1/ssqm1802')){
   assert.equal(JSON.parse(opts.body).dataBody.is_no,'005930')
   return Response.json(response('281959'))
  }
  throw Error('Unexpected endpoint: '+url)
 }
 try{
  assert.deepEqual(await readKbBuyingPower({KB_APP_KEY:'risk-key-test-001',KB_APP_SECRET:'example'},'005930'),
    {orderableCash:281959,buyingPower:250000})
  assert.equal(paths.filter(p=>p.includes('ssam')).length,0)
  assert.equal(paths.filter(p=>p.endsWith('/api/v1/ssqm1802')).length,1)
 }finally{globalThis.fetch=original}
})
