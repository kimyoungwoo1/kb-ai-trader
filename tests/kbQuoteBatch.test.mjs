import test from 'node:test'
import assert from 'node:assert/strict'
import { build } from 'esbuild'
const bundle = await build({ entryPoints: ['worker/src/index.ts'], bundle: true,
  platform: 'node', format: 'esm', write: false })
const worker = (await import('data:text/javascript;base64,'
  + Buffer.from(bundle.outputFiles[0].contents).toString('base64'))).default
const base = 'https://kb-ai-trader.ksmsy1.workers.dev/api/kb/quotes'
const mkEnv = (key) => ({
  KB_APP_KEY: key, KB_APP_SECRET: 'never-expose-secret',
  DASHBOARD_API_KEY: 'dashboard-pass', KB_BASE_URL: 'https://developer.kbsec.com:32484',
})
const stocks = Array.from({ length: 5 }, (_, index) => ({
  code: String(100001 + index), name: 'STOCK' + (index + 1),
}))
const req = (list = stocks, password = 'dashboard-pass') => new Request(base, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + password },
  body: JSON.stringify({ stocks: list }),
})
test('one OAuth grant and five concurrent KB quotes, then reused on the second thirty-second poll', async () => {
  const oldFetch = globalThis.fetch
  let auths = 0, quoted = 0, active = 0, simultaneous = 0
  globalThis.fetch = async (target, options) => {
    if (String(target).endsWith('/oauth2/token')) {
      auths++
      return Response.json({ dataBody: { access_token: 'private-kb-token', expires_in: 86400 } })
    }
    quoted++
    active++
    simultaneous = Math.max(simultaneous, active)
    assert.equal(options.headers.Authorization, 'bearer private-kb-token')
    await Promise.resolve()
    active--
    return Response.json({ dataHeader: { resultCode: '0' },
      dataBody: { now_prc: '12345' } })
  }
  try {
    const env = mkEnv('quote-batch-1')
    const first = await worker.fetch(req(), env)
    assert.equal(first.status, 200)
    assert.equal(first.headers.get('Cache-Control'), 'no-store')
    const result = await first.json()
    assert.equal(result.requested, 5)
    assert.equal(result.received, 5)
    assert.equal(result.results.length, 5)
    assert.ok(result.results.every(item => item.price === 12345 && Number.isFinite(Date.parse(item.checked_at))))
    assert.ok(simultaneous >= 2, 'stocks should be checked concurrently rather than serially')
    assert.ok(!JSON.stringify(result).includes('private-kb-token'))
    const second = await worker.fetch(req(), env)
    assert.equal((await second.json()).received, 5)
    assert.equal(auths, 1)
    assert.equal(quoted, 10)
  } finally { globalThis.fetch = oldFetch }
})
test('one failing quote does not obscure other valid prices', async () => {
  const oldFetch = globalThis.fetch
  let calls = 0
  globalThis.fetch = async (target, options) => {
    if (String(target).endsWith('/oauth2/token'))
      return Response.json({ dataBody: { access_token: 'token', expires_in: 86400 } })
    const code = JSON.parse(options.body).dataBody.shrt_cd
    calls++
    if (code === stocks[1].code) return Response.json({
      dataHeader: { resultCode: '429', processMessage: '호출 제한 초과' },
    }, { status: 429 })
    if (code === stocks[2].code) throw new Error('network disconnected')
    return Response.json({ dataHeader: { resultCode: '0' },
      dataBody: { now_prc: 12300 } })
  }
  try {
    const result = await (await worker.fetch(req(), mkEnv('quote-batch-2'))).json()
    assert.equal(calls, 5)
    assert.equal(result.success, true)
    assert.equal(result.received, 3)
    assert.equal(result.rate_limited, true)
    assert.equal(result.results[1].rate_limited, true)
    assert.match(result.results[2].error, /연결 실패/)
    assert.equal(result.results[0].price, 12300)
    assert.equal(result.results[3].price, 12300)
  } finally { globalThis.fetch = oldFetch }
})
test('authentication is required, and invalid/too many codes are rejected before calling KB', async () => {
  const oldFetch = globalThis.fetch
  let count = 0
  globalThis.fetch = async () => { count++; throw Error('unexpected KB request') }
  try {
    const env = mkEnv('quote-batch-3')
    const invalidAuth = await worker.fetch(req(stocks, 'wrong'), env)
    assert.equal(invalidAuth.status, 401)
    const dup = await worker.fetch(req([stocks[0], stocks[0]]), env)
    assert.equal(dup.status, 400)
    const tooMany = await worker.fetch(req([...stocks, { code: '100010', name: 'extra' }]), env)
    assert.equal(tooMany.status, 400)
    assert.equal(count, 0)
  } finally { globalThis.fetch = oldFetch }
})
test('persistent HTML 522 allows one scan retry and stops before the next symbol or investor-flow read', async () => {
  const oldFetch = globalThis.fetch
  const requestedCodes = []
  globalThis.fetch = async (target, options) => {
    if (String(target).endsWith('/oauth2/token'))
      return Response.json({ dataBody: { access_token: 'mock-token', expires_in: 86400 } })
    assert.ok(String(target).endsWith('/ivu10140'))
    requestedCodes.push(JSON.parse(options.body).dataBody.shrt_cd)
    return new Response('<html>Gateway timeout</html>', { status: 522 })
  }
  try {
    const env = mkEnv('quote-batch-522')
    const batch = await (await worker.fetch(req([stocks[0]]), env)).json()
    assert.equal(batch.results[0].upstream_status, 522)
    assert.match(batch.results[0].error, /HTTP 522/)
    assert.deepEqual(requestedCodes.splice(0), [stocks[0].code, stocks[0].code])
    const scan = await worker.fetch(new Request(base.replace('/kb/quotes', '/market/investor-flow'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer dashboard-pass' },
      body: JSON.stringify({ stocks, stopOnUpstream: true }),
    }), env)
    assert.equal(scan.status, 502)
    const failure = await scan.json()
    assert.equal(failure.stage, 'kb_upstream')
    assert.match(failure.message, /HTTP 522/)
    assert.deepEqual(requestedCodes, [stocks[0].code, stocks[0].code])
  } finally { globalThis.fetch = oldFetch }
})

test('intermittent 522 retries only failed symbols and a sustained outage gets one probe',async()=>{
 const saved=globalThis.fetch
 let recover=true
 const calls=new Map()
 globalThis.fetch=async(url,options)=>{
  if(String(url).endsWith('/oauth2/token'))return Response.json({dataBody:{access_token:'token',expires_in:86400}})
  const code=JSON.parse(options.body).dataBody.shrt_cd
  const count=(calls.get(code)||0)+1
  calls.set(code,count)
  if(recover&&(code===stocks[2].code||count===2))
   return Response.json({dataHeader:{resultCode:'0'},dataBody:{now_prc:'12300'}})
  return new Response('gateway timeout',{status:522})
 }
 try{
  const sample=stocks.slice(0,3)
  const first=await (await worker.fetch(req(sample),mkEnv('quote-recover'))).json()
  assert.equal(first.received,3)
  assert.deepEqual(sample.map(({code})=>calls.get(code)),[2,2,1])
  recover=false
  calls.clear()
  const second=await (await worker.fetch(req(sample),mkEnv('quote-sustained-522'))).json()
  assert.equal(second.received,0)
  assert.deepEqual(sample.map(({code})=>calls.get(code)),[2,1,1])
  assert.ok(second.results.every(item=>item.upstream_status===522))
 }finally{globalThis.fetch=saved}
})
