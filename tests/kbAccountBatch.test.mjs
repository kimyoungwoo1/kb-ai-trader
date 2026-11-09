import test from 'node:test'
import assert from 'node:assert/strict'
import {build} from 'esbuild'
const output=await build({entryPoints:['worker/src/kbAccountBatch.ts'],bundle:true,platform:'node',format:'esm',write:false})
const {runAccountBatch}=await import('data:text/javascript;base64,'+Buffer.from(output.outputFiles[0].contents).toString('base64'))

test('account UI reads use one upstream request at a time, in predictable order',async()=>{
 let active=0,maxActive=0
 const routes=[]
 const result=await runAccountBatch('serial-test',async route=>{
  active++;maxActive=Math.max(maxActive,active);routes.push(route)
  await Promise.resolve()
  active--
  return {success:true,status:200,data:{dataBody:{Record1:[]}}}
 })
 assert.equal(result.success,true)
 assert.equal(maxActive,1)
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

test('a 522 blocks the remaining read-only account calls and short-term refresh storms',async()=>{
 let calls=0
 const request=()=>runAccountBatch('522-gate-test',async()=>{
  calls++
  return {success:false,status:502,http_status:522,error_type:'NON_JSON'}
 })
 const first=await request()
 assert.equal(calls,1)
 assert.equal(first.results.holdings.http_status,522)
 assert.equal(first.results.valuation.stage,'account_upstream_cooldown')
 assert.equal(first.results.deposit.stage,'account_upstream_cooldown')
 const again=await request()
 assert.equal(calls,1)
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
