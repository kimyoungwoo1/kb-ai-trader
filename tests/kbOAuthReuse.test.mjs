import test from 'node:test'
import assert from 'node:assert/strict'
import { build } from 'esbuild'

const bundle = await build({
  entryPoints: ['worker/src/index.ts'], bundle: true,
  platform: 'node', format: 'esm', write: false,
})
const { default: worker } = await import('data:text/javascript;base64,'
  + Buffer.from(bundle.outputFiles[0].contents).toString('base64'))
const endpoint = 'https://kb-ai-trader.ksmsy1.workers.dev/api/kb/quote'
const env = {
  KB_APP_KEY: 'test-key', KB_APP_SECRET: 'test-secret',
  DASHBOARD_API_KEY: 'dashboard-test-token',
  KB_BASE_URL: 'https://developer.kbsec.com:32484',
}
const quote = (code = '005930', key = env.DASHBOARD_API_KEY) => new Request(endpoint, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + key },
  body: JSON.stringify({ code, exchange: '1' }),
})

test('multiple existing KB price calls share the token for up to eight hours', async () => {
  const fetchOriginal = globalThis.fetch
  const nowOriginal = Date.now
  const start = Date.parse('2026-11-06T01:00:00Z')
  let clock = start, authCalls = 0, priceCalls = 0
  Date.now = () => clock
  globalThis.fetch = async (input) => {
    const url = String(input)
    if (url.endsWith('/oauth2/token')) {
      authCalls++
      return Response.json({ dataBody: { access_token: 'private-test-token',
        expires_in: 86400 } })
    }
    assert.ok(url.endsWith('/api/v1/ivu10140'))
    priceCalls++
    return Response.json({ dataHeader: { resultCode: '0' },
      dataBody: { now_prc: '80000', is_nm: 'TEST' } })
  }
  try {
    let response = await worker.fetch(quote(), env)
    assert.equal(response.status, 200)
    const value = await response.json()
    assert.equal(value.price, 80000)
    assert.equal(JSON.stringify(value).includes('private-test-token'), false)
    clock += 30_000
    await worker.fetch(quote('035720'), env)
    clock += 7 * 60 * 60 * 1000
    await worker.fetch(quote('030200'), env)
    assert.equal(authCalls, 1)
    assert.equal(priceCalls, 3)
    clock = start + 8 * 60 * 60 * 1000
    await worker.fetch(quote('005930'), env)
    assert.equal(authCalls, 2, 'eight-hour cap forces a fresh token')
    assert.equal(priceCalls, 4)
  } finally {
    globalThis.fetch = fetchOriginal
    Date.now = nowOriginal
  }
})

test('a shorter KB expiry overrides the eight-hour reuse maximum', async () => {
  const fetchOriginal = globalThis.fetch
  const nowOriginal = Date.now
  let now = Date.parse('2026-11-06T01:00:00Z'), authCalls = 0
  Date.now = () => now
  globalThis.fetch = async (input) => {
    if (String(input).endsWith('/oauth2/token')) {
      authCalls++
      return Response.json({ dataBody: { access_token: 'short-expiry',
        expires_in: 120 } })
    }
    return Response.json({ dataHeader: { resultCode: '0' },
      dataBody: { now_prc: '10000' } })
  }
  try {
    const shortEnv = { ...env, KB_APP_KEY: 'short-expiry-test' }
    await worker.fetch(quote(), shortEnv)
    now += 30_000
    await worker.fetch(quote(), shortEnv)
    assert.equal(authCalls, 1)
    now += 70_000
    await worker.fetch(quote(), shortEnv)
    assert.equal(authCalls, 2)
  } finally {
    globalThis.fetch = fetchOriginal
    Date.now = nowOriginal
  }
})

test('the quote endpoint refuses unauthenticated requests before hitting KB API', async () => {
  const fetchOriginal = globalThis.fetch
  globalThis.fetch = async () => { throw Error('do not request KB') }
  try {
    const result = await worker.fetch(quote('005930', 'invalid'), env)
    assert.equal(result.status, 401)
  } finally { globalThis.fetch = fetchOriginal }
})

test('a transient KB authentication transport failure retries once without exposing credentials',async()=>{
 const previous=globalThis.fetch
 let authCalls=0
 globalThis.fetch=async(input)=>{
   if(String(input).endsWith('/oauth2/token')){
     authCalls++
     if(authCalls===1)throw new TypeError('temporary network failure')
     return Response.json({dataBody:{access_token:'retry-token',expires_in:3600}})
   }
   return Response.json({dataHeader:{resultCode:'0'},dataBody:{now_prc:'80000',is_nm:'TEST'}})
 }
 try{
   const isolatedEnv={...env,KB_APP_KEY:'retry-key'}
   const res=await worker.fetch(quote(),isolatedEnv)
   assert.equal(res.status,200)
   assert.equal(authCalls,2)
 }finally{globalThis.fetch=previous}
})

test('a KB-issued authentication rejection is not retried',async()=>{
 const previous=globalThis.fetch
 let authCalls=0
 globalThis.fetch=async(input)=>{
   if(String(input).endsWith('/oauth2/token')){
     authCalls++
     return Response.json({message:'bad credentials'},{status:401})
   }
   throw Error('should not request a quote without an auth token')
 }
 try{
   const rejectedEnv={...env,KB_APP_KEY:'rejected-token-key'}
   const res=await worker.fetch(quote(),rejectedEnv)
   assert.equal(res.status,502)
   assert.equal(authCalls,1)
 }finally{globalThis.fetch=previous}
})
