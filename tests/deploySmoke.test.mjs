import test from 'node:test'
import assert from 'node:assert/strict'
import { build } from 'esbuild'

const output=await build({entryPoints:['worker/src/index.ts'],bundle:true,platform:'node',format:'esm',write:false})
const worker= (await import('data:text/javascript;base64,'+Buffer.from(output.outputFiles[0].contents).toString('base64'))).default
const env={
  DASHBOARD_API_KEY:'private-session', KB_APP_KEY:'test-app-key', KB_APP_SECRET:'test-app-secret',
  DEPLOY_PROBE_TOKEN:'private-random-deploy-check',
  KB_BASE_URL:'https://developer.kbsec.com:32484'
}
const request=(secret)=>new Request('https://kb-ai-trader.ksmsy1.workers.dev/api/deploy/verify',{
  method:'POST',headers:{'X-Deploy-Probe':secret}
})

test('deploy health probe rejects missing or wrong secret without KB access',async()=>{
 const original=globalThis.fetch
 let calls=0
 globalThis.fetch=async()=>{calls++;throw Error('No KB access allowed')}
 try{
   const absent=await worker.fetch(request(''),env)
   assert.equal(absent.status,404)
   const wrong=await worker.fetch(request('wrong'),env)
   assert.equal(wrong.status,404)
   assert.equal(calls,0)
 }finally{globalThis.fetch=original}
})
test('authenticated deploy health checks KB OAuth once and both read-only account endpoints',async()=>{
 const original=globalThis.fetch
 let tokenCount=0,holdingsCount=0,valuationCount=0
 globalThis.fetch=async(input)=>{
   const url=String(input)
   if(url.endsWith('/oauth2/token')){tokenCount++;return Response.json({dataBody:{access_token:'secret-token',expires_in:3600}})}
   if(url.endsWith('/api/v1/ssqm1801')){holdingsCount++;return Response.json({dataBody:{Record1:[{name:'PRIVATE'}]}})}
   if(url.endsWith('/api/v1/ssqm2952')){valuationCount++;return Response.json({dataBody:{val_amt_sum:500000}})}
   throw Error('Unexpected KB path')
 }
 try{
   const response=await worker.fetch(request(env.DEPLOY_PROBE_TOKEN),env)
   assert.equal(response.status,200)
   const body=await response.json()
   assert.equal(body.success,true)
   assert.equal(body.checks.holdings.success,true)
   assert.equal(body.checks.valuation.success,true)
   assert.equal(tokenCount,1)
   assert.equal(holdingsCount,1)
   assert.equal(valuationCount,1)
   assert.ok(!JSON.stringify(body).includes('PRIVATE'))
   assert.ok(!JSON.stringify(body).includes('secret-token'))
 }finally{globalThis.fetch=original}
})
test('deploy probe fails closed when holdings or valuation read is rejected',async()=>{
 const original=globalThis.fetch
 const failingEnv={...env,KB_APP_KEY:'other-credentials'}
 globalThis.fetch=async(input)=>{
   const url=String(input)
   if(url.endsWith('/oauth2/token'))return Response.json({dataBody:{access_token:'test-token-2',expires_in:3600}})
   if(url.endsWith('/api/v1/ssqm1801'))return Response.json({dataBody:{Record1:[]}})
   if(url.endsWith('/api/v1/ssqm2952'))return Response.json({dataHeader:{resultCode:'FAIL'}},{status:500})
   throw Error('Unexpected request')
 }
 try{
   const response=await worker.fetch(request(env.DEPLOY_PROBE_TOKEN),failingEnv)
   assert.equal(response.status,503)
   const result=await response.json()
   assert.equal(result.success,false)
   assert.equal(result.checks.valuation.success,false)
   assert.equal(result.checks.holdings.success,true)
 }finally{globalThis.fetch=original}
})

test('deploy probe stops at first KB 522 and never claims successful valuation',async()=>{
 const previous=globalThis.fetch
 let holdings=0,valuation=0
 const isolated={...env,KB_APP_KEY:'probe-522-single-flight'}
 globalThis.fetch=async input=>{
  const url=String(input)
  if(url.endsWith('/oauth2/token'))
   return Response.json({dataBody:{access_token:'522-probe-token',expires_in:3600}})
  if(url.endsWith('/api/v1/ssqm1801')){
   holdings++
   return new Response('<html>upstream 522</html>',{status:522,headers:{'content-type':'text/html'}})
  }
  if(url.endsWith('/api/v1/ssqm2952')){valuation++;throw Error('Must not query valuation during 522')}
  throw Error('Unexpected KB request')
 }
 try{
  const response=await worker.fetch(request(env.DEPLOY_PROBE_TOKEN),isolated)
  const result=await response.json()
  assert.equal(response.status,503)
  assert.equal(result.success,false)
  assert.equal(result.checks.holdings.stage,'holdings_response')
  assert.equal(result.checks.holdings.upstream_status,522)
  assert.equal(result.checks.valuation.stage,'skipped_upstream_unavailable')
  assert.equal(result.checks.valuation.success,false)
  assert.equal(holdings,1)
  assert.equal(valuation,0)
 }finally{globalThis.fetch=previous}
})
