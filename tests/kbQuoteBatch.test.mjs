import test from 'node:test'
import assert from 'node:assert/strict'
import { build } from 'esbuild'

const output = await build({
  entryPoints: ['worker/src/index.ts'], bundle: true, platform: 'node',
  format: 'esm', write: false,
})
const url = 'data:text/javascript;base64,' + Buffer.from(output.outputFiles[0].contents).toString('base64')
const { default: worker } = await import(url)
const env = {
  DASHBOARD_API_KEY: 'paper-dashboard-pass',
  KB_APP_KEY: 'mock-client-key', KB_APP_SECRET: 'mock-client-secret',
  KB_BASE_URL: 'https://developer.kbsec.com:32484',
}
const endpoint = 'https://kb-ai-trader.ksmsy1.workers.dev/api/kb/quotes'
const stocks = Array.from({ length: 5 }, (_, i) => ({
  code: String(100001 + i), name: 'STOCK' + (i + 1),
}))
const request = (codes = stocks, auth = true) => new Request(endpoint, {
  method: 'POST', headers: { 'Content-Type': 'application/json',
    Authorization: 'Bearer ' + (auth ? env.DASHBOARD_API_KEY : 'invalid') },
  body: JSON.stringify({ stocks: codes }),
})

test('one OAuth token serves five batched KB quotes and is reused on the next poll', async () => {
  let tokens = 0, quotes = 0
  const originalFetch = globalThis.fetch
  globalThis.fetch = async (input, init) => {
    const uri = String(input)
    if (uri.endsWith('/oauth2/token')) {
      tokens++
      assert.match(String(init?.body), /mock-client-key/)
      return Response.json({ dataBody: { access_token: 'not-for-browser-token', expires_in: 86400 } })
    }
    assert.match(uri, /\/api\/v1\/ivu10140$/)
    quotes++
    return Response.json({ dataHeader: { resultCode: '0' },
      dataBody: { now_prc: '10100', is_nm: 'TEST' } })
  }
  try {
    const first = await worker.fetch(request(), env)
    assert.equal(first.status, 200)
    const firstJson = await first.json()
    assert.equal(firstJson.requested, 5)
    assert.equal(firstJson.received, 5)
    assert.equal(firstJson.results.filter(row => row.price === 10100).length, 5)
    assert.ok(firstJson.results.every(row => Number.isFinite(Date.parse(row.checked_at))))
    assert.equal(firstJson.rate_limited, false)
    assert.equal(first.headers.get('cache-control'), 'no-store')
    assert.ok(!JSON.stringify(firstJson).includes('not-for-browser-token'))
    const second = await worker.fetch(request(), env)
    assert.equal(second.status, 200)
    assert.equal((await second.json()).received, 5)
    assert.equal(tokens, 1)
    assert.equal(quotes, 10)
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('requests without a valid dashboard token never call the KB service', async () => {
  const originalFetch = globalThis.fetch
  globalThis.fetch = async () => { throw Error('should not call KB') }
  try {
    const response = await worker.fetch(request(stocks, false), env)
    assert.equal(response.status, 401)
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('429 from KB stops subsequent batches and exposes a rate-limit hint without leaking secrets', async () => {
  let calls = 0
  const originalFetch = globalThis.fetch
  globalThis.fetch = async (input) => {
    if (String(input).endsWith('/oauth2/token'))
      return Response.json({ dataBody: { access_token: 'not-for-browser-token', expires_in: 86400 } })
    calls++
    return Response.json({
      dataHeader: { resultCode: '429', processMessage: '호출 제한 초과' },
    }, { status: 429 })
  }
  try {
    const response = await worker.fetch(request(), env)
    const data = await response.json()
    assert.equal(data.success, true)
    assert.equal(data.rate_limited, true)
    assert.equal(data.received, 2)
    assert.equal(calls, 2)
    assert.ok(data.results.every(row => row.rate_limited))
    assert.ok(!JSON.stringify(data).includes('mock-client-secret'))
  } finally { globalThis.fetch = originalFetch }
})
