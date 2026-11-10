import test from 'node:test'
import assert from 'node:assert/strict'
import {build} from 'esbuild'
const output=await build({entryPoints:['worker/src/kbAccountBatch.ts'],bundle:true,platform:'node',format:'esm',write:false})
const {runAccountBatch}=await import('data:text/javascript;base64,'+Buffer.from(output.outputFiles[0].contents).toString('base64'))

test('account UI starts each read independently',async()=>{
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

test('repeated concurrent refreshes share one batch of 3 upstream reads',async()=>{
 let calls=0
 const request=()=>runAccountBatch('dedupe-test',async()=>{
  calls++
  await new Promise(resolve=>setTimeout(resolve,5))
  return {success:true,status:200}
 })
 const [a,b]=await Promise.all([request(),request()])
 assert.equal(calls,3)
 assert.equal(a.checked_at,b.checked_at)
 const cached=await request()
 assert.equal(calls,3)
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

test('valuation and cash can recover after a holdings 522',async()=>{
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
