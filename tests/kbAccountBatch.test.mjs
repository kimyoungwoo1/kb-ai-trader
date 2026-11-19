import test from 'node:test'
import assert from 'node:assert/strict'
import {build} from 'esbuild'
const output=await build({entryPoints:['worker/src/kbAccountBatch.ts'],bundle:true,platform:'node',format:'esm',write:false})
const {runAccountBatch}=await import('data:text/javascript;base64,'+Buffer.from(output.outputFiles[0].contents).toString('base64'))

test('account UI starts all three independent reads before waiting for results',async()=>{
 let active=0,maxActive=0
 const routes=[]
 const result=await runAccountBatch('serial-test',async route=>{
  active++;maxActive=Math.max(maxActive,active);routes.push(route)
  await Promise.resolve()
  active--
  return {success:true,status:200,data:{dataBody:{Record1:[]}}}
 })
 assert.equal(result.success,true)
 assert.equal(maxActive,3)
 assert.deepEqual(routes,['/api/kb/holdings','/api/kb/valuation','/api/kb/deposit'])
})

test('concurrent refreshes own their reads and reuse only a completed snapshot',async()=>{
 let calls=0
 const request=()=>runAccountBatch('dedupe-test',async()=>{
  calls++
  await new Promise(resolve=>setTimeout(resolve,5))
  return {success:true,status:200}
 })
 const [a,b]=await Promise.all([request(),request()])
 assert.equal(calls,6)
 assert.ok(a.success && b.success)
 const cached=await request()
 assert.equal(calls,6)
 assert.equal(typeof cached.cache_age_ms,'number')
})

test('a sustained 522 gets one extra probe and then the cached failure',async()=>{
 let calls=0
 const request=()=>runAccountBatch('522-gate-test',async()=>{
  calls++
  return {success:false,status:502,http_status:522,error_type:'NON_JSON'}
 })
 const first=await request()
 assert.equal(calls,4)
 assert.equal(first.results.holdings.http_status,522)
 assert.equal(first.results.valuation.http_status,522)
 assert.equal(first.results.deposit.http_status,522)
 const again=await request()
 assert.equal(calls,4)
 assert.equal(again.results.holdings.http_status,522)
})

test('normal per-route HTTP 4xx error does not conceal the remaining account reads',async()=>{
 let calls=0
 const results=await runAccountBatch('partial-4xx-test',async()=>{
  calls++
  return calls===1?{success:false,status:502,http_status:403,error_type:'HTTP_ERROR'}:
   {success:true,status:200}
 })
 assert.equal(calls,3)
 assert.equal(results.results.valuation.success,true)
 assert.equal(results.results.deposit.success,true)
})

test('batch deadline preserves cash and holdings when valuation hangs',async()=>{
 const calls=[]
 let slowSignal
 const result=await runAccountBatch('deadline-test',async(route,signal)=>{
  calls.push(route)
  if(!route.endsWith('/valuation'))return {success:true,status:200}
  slowSignal=signal
  return new Promise(resolve=>signal.addEventListener('abort',()=>resolve({success:false,status:502}),{once:true}))
 },Date.now(),15)
 assert.deepEqual(calls,['/api/kb/holdings','/api/kb/valuation','/api/kb/deposit'])
 assert.equal(slowSignal.aborted,true)
 assert.equal(result.results.holdings.success,true)
 assert.equal(result.results.valuation.stage,'account_batch_deadline')
 assert.equal(result.results.valuation.error_type,'TIMEOUT')
 assert.equal(result.results.deposit.success,true)
})

test('valuation and cash survive repeated holdings 522',async()=>{
 const calls=[]
 const batch=await runAccountBatch('valuation-fallback-522',async route=>{
  calls.push(route)
  return route.endsWith('/holdings')
   ? {success:false,status:502,http_status:522}
   : {success:true,status:200}
 })
 assert.equal(batch.results.holdings.http_status,522)
 assert.equal(batch.results.valuation.success,true)
 assert.equal(batch.results.deposit.success,true)
 assert.deepEqual(calls,['/api/kb/holdings','/api/kb/valuation','/api/kb/deposit','/api/kb/holdings'])
})


test('a recovered 522 probe allows retrying other failed reads without repeating successful reads',async()=>{
 const calls=new Map()
 const batch=await runAccountBatch('recovered-account-522',async route=>{
  const count=(calls.get(route)??0)+1
  calls.set(route,count)
  return count===1&&!route.endsWith('/deposit')
   ? {success:false,status:502,http_status:522}
   : {success:true,status:200}
 })
 assert.ok(Object.values(batch.results).every(result=>result.success))
 assert.deepEqual([...calls.values()],[2,2,1])
})

test('account batch recovers a holdings 502 and a valuation timeout without repeating cash',async()=>{
 const calls=new Map()
 const batch=await runAccountBatch('recovered-account-502-timeout',async route=>{
  const count=(calls.get(route)??0)+1
  calls.set(route,count)
  if(count===1&&route.endsWith('/holdings'))return {success:false,status:502,http_status:502}
  if(count===1&&route.endsWith('/valuation'))return {success:false,status:502,error_type:'TIMEOUT'}
  return {success:true,status:200}
 })
 assert.ok(Object.values(batch.results).every(result=>result.success))
 assert.deepEqual([...calls.values()],[2,2,1])
})

test('slow holdings failure does not delay successful valuation and cash reads',async()=>{
 let finishHoldings
 const calls=[]
 const request=runAccountBatch('slow-holdings-522',async route=>{
  calls.push(route)
  if(route.endsWith('/holdings'))return new Promise(resolve=>{finishHoldings=resolve})
  return {success:true,status:200}
 },Date.now(),100)
 assert.deepEqual(calls,['/api/kb/holdings','/api/kb/valuation','/api/kb/deposit'])
 finishHoldings({success:false,status:502,http_status:522})
 const batch=await request
 assert.equal(batch.results.holdings.http_status,522)
 assert.equal(batch.results.valuation.success,true)
 assert.equal(batch.results.deposit.success,true)
})

const snapshotBundle = await build({entryPoints:['worker/src/kbAccountSnapshots.ts'],bundle:true,platform:'node',format:'esm',write:false})
const {accountSnapshots} = await import('data:text/javascript;base64,'+Buffer.from(snapshotBundle.outputFiles[0].contents).toString('base64'))

test('display-only encrypted snapshots preserve last success per endpoint and isolate accounts',async()=>{
 const rows = new Map()
 const db = {prepare(sql){return {bind(scope,item,checked_at,nonce,payload){
  const key = scope+':'+item
  return {
   async run(){
    assert.match(sql,/WHERE excluded.checked_at > kb_account_display_snapshot.checked_at/)
    assert.ok(!payload.includes('sensitive-account-number'))
    if (!rows.has(key) || checked_at > rows.get(key).checked_at) rows.set(key,{checked_at,nonce,payload})
   },
   async first(){return rows.get(key)},
  }
 }}}}
 const env = {PAPER_DB:db,KB_APP_KEY:'test-key',KB_APP_SECRET:'test-secret'}
 const first = '2026-11-17T01:00:00.000Z'
 const later = '2026-11-17T02:00:00.000Z'
 const success = (checked_at,dataBody) => ({success:true,status:200,checked_at,data:{dataBody}})
 const failed = {success:false,status:502,error_type:'TIMEOUT'}
 const batch = (results) => ({success:true,checked_at:later,results})
 await accountSnapshots(env,batch({
  holdings:success(first,{Record1:[{is_no:'316140',gnrl_q:1,account:'sensitive-account-number'}]}),
  valuation:success(first,{val_amt_sum:33000}),
  deposit:success(first,{ordr_psbl_csh:55000}),
 }))
 const partial = batch({holdings:failed,valuation:success(later,{val_amt_sum:34000}),deposit:failed})
 const saved = await accountSnapshots(env,partial)
 assert.equal(partial.results.holdings.success,false)
 assert.deepEqual(saved,{
  holdings:{checked_at:first,data:{dataBody:{Record1:[{is_no:'316140',gnrl_q:1}]}}},
  deposit:{checked_at:first,data:{dataBody:{ordr_psbl_csh:55000}}},
 })
 await accountSnapshots(env,batch({valuation:success(first,{val_amt_sum:1}),holdings:success(later,{Record1:[]})}))
 assert.deepEqual(await accountSnapshots(env,batch({valuation:failed,holdings:failed})),{
  holdings:{checked_at:later,data:{dataBody:{Record1:[]}}},
  valuation:{checked_at:later,data:{dataBody:{val_amt_sum:34000}}},
 })
 assert.deepEqual(await accountSnapshots({...env,KB_APP_KEY:'other-key'},partial),{})
 assert.deepEqual(await accountSnapshots({...env,PAPER_DB:{prepare(){throw Error('unavailable')}}},partial),{})
})

test('a repeated holdings timeout does not stop valuation recovery when cash succeeded',async()=>{
 const attempts=new Map()
 const result=await runAccountBatch('successful-deposit-independent-valuation',async route=>{
  const count=(attempts.get(route)??0)+1
  attempts.set(route,count)
  if(route.endsWith('/holdings') || (route.endsWith('/valuation')&&count===1))
   return {success:false,status:502,error_type:'TIMEOUT'}
  return {success:true,status:200}
 })
 assert.equal(result.results.holdings.success,false)
 assert.equal(result.results.valuation.success,true)
 assert.deepEqual([...attempts.values()],[2,2,1])
})
