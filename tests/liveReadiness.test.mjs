import test from 'node:test'
import assert from 'node:assert/strict'
import {readFileSync} from 'node:fs'
import {build} from 'esbuild'
const output=await build({entryPoints:['worker/src/liveReadiness.ts'],bundle:true,platform:'node',format:'esm',write:false})
const {diagnoseLiveReadiness}=
 await import('data:text/javascript;base64,'+Buffer.from(output.outputFiles[0].contents).toString('base64'))
const sat=new Date('2026-11-07T12:00:00.000Z')
const result=()=>Response.json({dataHeader:{resultCode:'200',processFlag:'A'},
 dataBody:{Record1:[],nxt_key:''}})
const makeDb=(state={gate:0,orders:0,cancels:0})=>({
 reads:[],prepare(sql){
  this.reads.push(sql)
  const value=this
  return {async first(){
   if(sql.includes('FROM live_execution_gate'))return {enabled:state.gate,trading_day:null,updated_at:null}
   if(sql.includes('FROM live_order_journal'))return {total:state.orders}
   if(sql.includes('FROM live_cancel_journal'))return {total:state.cancels}
   throw Error('Unexpected SQL read '+sql)
  },async run(){throw Error('Readiness must never modify D1')}}
 }
})
const env=(suffix)=>({KB_APP_KEY:'kb-readiness-check-'+suffix,KB_APP_SECRET:'test-only'})
function mockNetwork({failKb=false}={}){
 const saved=globalThis.fetch,calls=[]
 globalThis.fetch=async(uri,opts)=>{
  const endpoint=String(uri)
  calls.push({endpoint,opts})
  if(endpoint.endsWith('/oauth2/token'))
   return Response.json({dataBody:{access_token:'dummy',expires_in:1800}})
  if(endpoint.endsWith('/api/v1/ssqm2341'))
   return failKb?new Response('broker unavailable',{status:502}):result()
  throw Error('Unexpected trading endpoint in READ ONLY readiness: '+endpoint)
 }
 return {calls,restore(){globalThis.fetch=saved}}
}
test('one-click checks genuine KB read-only SSQM2341, D1 gate, no order submission, and remains locked',async()=>{
 const broker=mockNetwork(),db=makeDb()
 try{
  const value=await diagnoseLiveReadiness(db,env('success'),sat)
  assert.equal(value.success,true)
  assert.equal(value.locked,true)
  assert.equal(value.mode,'READ_ONLY_READINESS')
  assert.equal(value.brokerWritesVerified,false)
  assert.equal(value.readOnlyChecksPassed,true)
  assert.equal(value.checks.find(x=>x.id==='kbQuery').status,'PASS')
  assert.equal(value.checks.find(x=>x.id==='brokerWrite').status,'UNVERIFIED')
  assert.equal(value.checks.find(x=>x.id==='hours').status,'UNVERIFIED')
  assert.ok(broker.calls.some(x=>x.endpoint.endsWith('/api/v1/ssqm2341')))
  assert.ok(!broker.calls.some(x=>x.endpoint.includes('/ssam')))
  assert.ok(db.reads.every(x=>x.startsWith('SELECT ')))
  const lookup=broker.calls.find(x=>x.endpoint.endsWith('/api/v1/ssqm2341'))
  assert.equal(JSON.parse(lookup.opts.body).dataBody.ordr_dt,'20261106')
 }finally{broker.restore()}
})
test('D1 gate ON must not be marked ready even if hard flag absent',async()=>{
 const broker=mockNetwork()
 try{
  const value=await diagnoseLiveReadiness(makeDb({gate:1}),env('gateon'),sat)
  assert.equal(value.readOnlyChecksPassed,false)
  assert.equal(value.checks.find(x=>x.id==='gate').status,'BLOCKED')
  assert.equal(value.brokerWritesVerified,false)
 }finally{broker.restore()}
})
test('unresolved order or cancel journal blocks readiness without writing or resubmitting',async()=>{
 const broker=mockNetwork()
 try{
  const value=await diagnoseLiveReadiness(makeDb({orders:1,cancels:2}),env('unknown'),sat)
  assert.equal(value.readOnlyChecksPassed,false)
  assert.equal(value.checks.find(x=>x.id==='journal').status,'BLOCKED')
  assert.ok(!broker.calls.some(x=>x.endpoint.includes('/ssam')))
 }finally{broker.restore()}
})
test('KB order inquiry 502 never masquerades as trade readiness',async()=>{
 const broker=mockNetwork({failKb:true})
 try{
  const value=await diagnoseLiveReadiness(makeDb(),env('brokerfail'),sat)
  assert.equal(value.readOnlyChecksPassed,false)
  assert.equal(value.checks.find(x=>x.id==='kbQuery').status,'BLOCKED')
  assert.match(value.checks.find(x=>x.id==='kbQuery').detail,/주문조회 서버 오류/)
 }finally{broker.restore()}
})
test('missing KB credentials produces blocked check without contacting provider',async()=>{
 const original=globalThis.fetch
 let called=0
 globalThis.fetch=async()=>{called++;throw Error('Do not contact provider')}
 try{
  const value=await diagnoseLiveReadiness(makeDb(),{},sat)
  assert.equal(value.readOnlyChecksPassed,false)
  assert.equal(value.checks.find(x=>x.id==='kbQuery').status,'BLOCKED')
  assert.equal(called,0)
 }finally{globalThis.fetch=original}
})
test('existing live trial UI offers explicit inspection and never claims broker write validation',()=>{
 const ui=readFileSync('src/LiveReadiness.tsx','utf8')
 const trial=readFileSync('src/LiveTrial.tsx','utf8')
 const api=readFileSync('worker/src/liveTrial.ts','utf8')
 assert.match(ui,/action:'readiness'/)
 assert.match(ui,/실거래 준비 점검 실행/)
 assert.match(ui,/실주문 전송은 미검증/)
 assert.match(trial,/<LiveReadiness token=\{token\}/)
 assert.match(api,/if\(action==='readiness'\)/)
 assert.match(api,/brokerOrdersVerified:false/)
})

test('readiness screen explains KB successful-header missing-order-list without declaring ready',async()=>{
 const original=globalThis.fetch
 globalThis.fetch=async(uri)=>{
  if(String(uri).endsWith('/oauth2/token'))
   return Response.json({dataBody:{access_token:'mock-order-token',expires_in:3600}})
  return Response.json({dataHeader:{resultCode:'200',processFlag:'A'},dataBody:{nxt_key:''}})
 }
 try{
  const result=await diagnoseLiveReadiness(makeDb(),env('record-missing'),sat)
  assert.equal(result.readOnlyChecksPassed,false)
  const check=result.checks.find(x=>x.id==='kbQuery')
  assert.equal(check.status,'BLOCKED')
  assert.match(check.detail,/Record1 배열이 없음/)
  assert.match(check.detail,/20261106/)
  assert.ok(!JSON.stringify(result).includes('mock-order-token'))
 }finally{globalThis.fetch=original}
})

test('KB business rejection presents only safe result/process codes while leaving orders locked',async()=>{
 const previous=globalThis.fetch
 globalThis.fetch=async(uri)=>{
  if(String(uri).endsWith('/oauth2/token'))
   return Response.json({dataBody:{access_token:'token-test-private',expires_in:3600}})
  return Response.json({dataHeader:{
   resultCode:'5007',processCode:'E0012',processFlag:'N',
   processMessage:'PRIVATE ACCOUNT RECORD'
  },dataBody:{accountNumber:'sensitive'}})
 }
 try{
  const inspected=await diagnoseLiveReadiness(makeDb(),env('code-detail'),sat)
  assert.equal(inspected.readOnlyChecksPassed,false)
  assert.equal(inspected.locked,true)
  const check=inspected.checks.find(x=>x.id==='kbQuery')
  assert.equal(check.status,'BLOCKED')
  assert.match(check.detail,/resultCode=5007/)
  assert.match(check.detail,/processCode=E0012/)
  assert.match(check.detail,/processFlag=N/)
  assert.ok(!JSON.stringify(inspected).includes('PRIVATE ACCOUNT RECORD'))
  assert.ok(!JSON.stringify(inspected).includes('sensitive'))
  assert.equal(inspected.brokerWritesVerified,false)
 }finally{globalThis.fetch=previous}
})
