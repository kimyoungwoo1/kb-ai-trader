import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const worker = readFileSync('worker/src/index.ts', 'utf8')
const batch = readFileSync('worker/src/kbAccountBatch.ts', 'utf8')
const app = readFileSync('src/App.tsx', 'utf8')

test('batched live account API stays authenticated and read only', () => {
  const auth = worker.indexOf('url.pathname === "/api/kb/account-batch" ||')
  const route = worker.indexOf('if (url.pathname === "/api/kb/account-batch" && request.method === "POST")')
  assert.ok(auth >= 0 && auth < route)
  const handler = worker.slice(route, worker.indexOf('if (url.pathname === "/api/live/trial"', route))
  assert.match(handler, /runAccountBatch\(key,async \(route,signal\)/)
  assert.match(batch, /\/api\/kb\/holdings/)
  assert.match(batch, /\/api\/kb\/valuation/)
  assert.match(batch, /\/api\/kb\/deposit/)
  assert.doesNotMatch(handler, /\/api\/live\/|ssam1801|ssam1802/)
})

test('frontend uses one batched account request and preserves independent error reporting', () => {
  const refresh = app.slice(app.indexOf('async function refreshAccountOnce()'), app.indexOf('async function runAiAnalysis()'))
  assert.match(refresh, /fetch\(API \+ '\/api\/kb\/account-batch'/)
  assert.match(refresh, /batch\.results\?\.\[endpoint\]/)
  assert.match(refresh, /await requestAccount\('holdings'/)
  assert.match(refresh, /await requestAccount\('valuation'/)
  assert.match(refresh, /await requestAccount\('deposit'/)
  assert.doesNotMatch(refresh, /fetch\(API \+ '\/api\/kb\/' \+ endpoint/)
})
