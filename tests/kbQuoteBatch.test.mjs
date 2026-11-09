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

test('market scan stops before further KB reads on gateway, rate limit or transport failures', async () => {
  const oldFetch = globalThis.fetch
  const env = mkEnv('scan-failure')
  for (const failure of [522, 429, 'TimeoutError']) {
    for (const failOn of ['/ivu10140', '/ivu10430']) {
      const calls = []
      globalThis.fetch = async (url) => {
        if (String(url).endsWith('/oauth2/token'))
          return Response.json({ dataBody: { access_token: 'mock', expires_in: 3600 } })
        const path = new URL(url).pathname
        calls.push(path)
        if (path.endsWith(failOn)) {
          if (typeof failure === 'string') throw new DOMException('mock timeout', failure)
          return new Response('gateway unavailable', { status: failure })
        }
        return Response.json({ dataBody: { now_prc: '1000' } })
      }
      try {
        const response = await worker.fetch(new Request(new URL('/api/market/investor-flow', base), {
          method: 'POST', headers: { Authorization: 'Bearer ' + env.DASHBOARD_API_KEY },
          body: JSON.stringify({ stocks }),
        }), env)
        assert.equal(response.status, failure === 429 ? 429 : 503)
        assert.equal((await response.json()).stage, 'market_scan_upstream')
        assert.deepEqual(calls, failOn === '/ivu10140'
          ? ['/api/v1/ivu10140'] : ['/api/v1/ivu10140', '/api/v1/ivu10430'])
      } finally { globalThis.fetch = oldFetch }
    }
  }
})
