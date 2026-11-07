import test from 'node:test'
import assert from 'node:assert/strict'
import {readFileSync} from 'node:fs'
import {build} from 'esbuild'

const output=await build({entryPoints:['worker/src/index.ts'],bundle:true,platform:'node',format:'esm',write:false})
const worker=(await import('data:text/javascript;base64,'+Buffer.from(output.outputFiles[0].contents).toString('base64'))).default
const base={
 DASHBOARD_API_KEY:'deploy-login-test-only',KB_APP_SECRET:'deploy-secret-test-only',
 DEPLOY_PROBE_TOKEN:'probe-test-secret-only',
 KB_BASE_URL:'https://developer.kbsec.com:32484'
}
const probe=(secret=base.DEPLOY_PROBE_TOKEN)=>new Request('https://test.workers.dev/api/deploy/verify',{
 method:'POST',headers:{'X-Deploy-Probe':secret}
})
test('authenticated deployment probe distinguishes network token failure without leaking raw broker or secret values',async()=>{
 const original=globalThis.fetch
 let calls=0
 globalThis.fetch=async(url)=>{
  if(!String(url).endsWith('/oauth2/token'))throw Error('Unexpected broker route')
  calls++
  throw new TypeError('private provider connection details')
 }
 try{
  const response=await worker.fetch(probe(),{...base,KB_APP_KEY:'deploy-transport-token-test'})
  assert.equal(response.status,503)
  const result=await response.json()
  assert.equal(result.success,false)
  assert.equal(result.checks.holdings.auth_issue,'auth_transport')
  assert.equal(result.checks.valuation.auth_issue,'auth_transport')
  assert.equal(result.checks.holdings.stage,'authentication')
  assert.ok(calls>0)
  const publicBody=JSON.stringify(result)
  assert.ok(!publicBody.includes('private provider connection details'))
  assert.ok(!publicBody.includes(base.KB_APP_SECRET))
  assert.ok(!publicBody.includes(base.DASHBOARD_API_KEY))
 }finally{globalThis.fetch=original}
})
test('KB HTTP 401 auth rejection is classified, not repeatedly retried, and never promotes deployment',async()=>{
 const original=globalThis.fetch
 let calls=0
 globalThis.fetch=async(url)=>{
  assert.ok(String(url).endsWith('/oauth2/token'))
  calls++
  return Response.json({message:'broker private credentials rejected'},{status:401})
 }
 try{
  const response=await worker.fetch(probe(),{...base,KB_APP_KEY:'deploy-401-test'})
  assert.equal(response.status,503)
  const result=await response.json()
  assert.equal(result.checks.holdings.auth_issue,'auth_rejected')
  assert.equal(result.checks.valuation.auth_issue,'auth_rejected')
  assert.equal(calls,2,'Each independent read fails once; no token retry on 401')
  assert.ok(!JSON.stringify(result).includes('broker private credentials rejected'))
 }finally{globalThis.fetch=original}
})
test('KB HTTP 429 auth throttle is distinguished from rejected credentials',async()=>{
 const original=globalThis.fetch
 globalThis.fetch=async()=>Response.json({message:'rate limited'},{status:429})
 try{
  const response=await worker.fetch(probe(),{...base,KB_APP_KEY:'deploy-429-test'})
  const value=await response.json()
  assert.equal(response.status,503)
  assert.equal(value.checks.holdings.auth_issue,'auth_rate_limited')
  assert.equal(value.checks.valuation.auth_issue,'auth_rate_limited')
 }finally{globalThis.fetch=original}
})
test('unauthorized probes are never allowed to reveal OAuth diagnostics or query broker',async()=>{
 const previous=globalThis.fetch
 globalThis.fetch=async()=>{throw Error('Network not allowed')}
 try{
  const response=await worker.fetch(probe('wrong'),{...base,KB_APP_KEY:'deploy-no-access'})
  assert.equal(response.status,404)
  assert.deepEqual(await response.json(),{success:false,message:'Not Found'})
 }finally{globalThis.fetch=previous}
})
test('deployment retains mandatory real KB account pass before switching live traffic',()=>{
 const s=readFileSync('scripts/deploy-verified-production.mjs','utf8')
 assert.ok(s.indexOf("await probeVersion(previewOrigin,probeKey,'신규 버전 사전 검사')")<s.indexOf('switched=true'))
 assert.match(s,/body\?\.checks\?\.holdings\?\.success===true\s*&&\s*body\?\.checks\?\.valuation\?\.success===true/)
 assert.match(s,/error\?\.authIssue==='auth_rejected'/)
 assert.match(s,/auth_rate_limited'\?30_000\*attempt/)
 assert.match(s,/startsWith\('auth_'\)\?12_000\*attempt/)
 assert.match(s,/await probeVersion\(domain,probeKey,'운영 전환 후 구조 재검사',\{checkAccount:false\}\)/)
})
