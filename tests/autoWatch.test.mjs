import test from 'node:test'
import assert from 'node:assert/strict'
import { build } from 'esbuild'

async function load(entry) {
  const result = await build({ entryPoints: [entry], bundle: true, platform: 'node',
    format: 'esm', write: false })
  return import('data:text/javascript;base64,' + Buffer.from(result.outputFiles[0].contents).toString('base64'))
}
const { selectAutoWatchStocks, FAST_QUOTE_INTERVAL_MS } = await load('src/autoWatch.ts')
const { newAutoAccount, runAutoWatchCycle, recordAutoWatchError } = await load('src/autoPaper.ts')
const { getAutoHealth } = await load('src/autoStatus.ts')
const time = new Date('2026-11-06T01:01:00.000Z') // Friday 10:01 KST
const yesterday = new Date('2026-11-05T05:00:00.000Z').toISOString()
const make = () => {
  let ledger = { cash: 800_000,
    positions: [{ code: '123456', name: 'HELD', quantity: 20, averagePrice: 10000, lastPrice: 10000 }],
    trades: [],
  }
  const store = { read: () => ledger, write: next => { ledger = next } }
  const account = { ...newAutoAccount(), enabled: true,
    cash: 800_000,
    positions: [{ code: '123456', name: 'HELD', quantity: 20,
      entry: 10000, last: 10000, stop: 9700, target: 10500,
      openedAt: yesterday, buyCost: 30 }],
    dailyStats: { date: '2026-11-06', checked: 6, completed: 6, deferred: 0, filled: 1 },
    runs: [{ checkedAt: yesterday, processedAt: yesterday, status: '검사 완료',
      scanned: 30, candidates: 2, filled: 1, decisions: [], message: '정규장 검사' }],
  }
  return { account, store, getLedger: () => ledger }
}

test('held positions are prioritized, pending symbols deduplicated and capped at six', () => {
  const base = make().account
  const selected = selectAutoWatchStocks({ ...base, pending: [
    { code: '123456', name: 'dup', createdAt: yesterday, trigger: 10000, stop: 9700 },
    { code: '654321', name: 'WATCH', createdAt: yesterday, trigger: 20000, stop: 19000 },
    { code: 'bad', name: 'invalid', createdAt: yesterday, trigger: 1, stop: 1 },
  ] })
  assert.deepEqual(selected.map(p => p.code), ['123456','654321'])
  assert.deepEqual(selected.map(p => p.priority), ['보유','진입 감시'])
  assert.equal(FAST_QUOTE_INTERVAL_MS, 10_000)
})

test('price-only monitoring triggers auto sell using the existing 5% target', () => {
  const { account, store, getLedger } = make()
  const next = runAutoWatchCycle(account,
    [{ code: '123456', name: 'HELD', price: 10550 }],
    time.toISOString(), time, store)
  assert.equal(next.positions.length, 0)
  assert.equal(getLedger().positions.length, 0)
  assert.equal(getLedger().trades[0].side, 'SELL')
  assert.equal(getLedger().trades[0].source, 'auto')
  assert.equal(next.watchStatus.status, '정상')
  assert.equal(next.watchStatus.filled, 1)
  assert.equal(next.dailyStats.checked, 6)
  assert.equal(next.dailyStats.filled, 2)
  assert.equal(next.watchDaily.checked, 1)
  assert.equal(next.watchDaily.filled, 1)
  assert.deepEqual(next.runs, account.runs)
})

test('price-only monitoring can trigger a previously queued entry', () => {
  const ctx = make()
  ctx.account.positions = []
  ctx.account.pending = [{ code: '654321', name: 'QUEUED', trigger: 10000,
    stop: 9700, createdAt: new Date(time.getTime() - 61_000).toISOString() }]
  ctx.store.write({ cash: 1_000_000, positions: [], trades: [] })
  const next = runAutoWatchCycle(ctx.account,
    [{ code: '654321', name: 'QUEUED', price: 10050 }],
    time.toISOString(), time, ctx.store)
  assert.equal(next.positions.length, 1)
  assert.equal(next.pending.length, 0)
  assert.equal(ctx.getLedger().trades[0].side, 'BUY')
  assert.equal(ctx.getLedger().trades[0].source, 'auto')
  assert.equal(next.dailyStats.checked, 6)
  assert.equal(next.watchStatus.filled, 1)
})

test('stale price checks and errors leave money, positions and history unchanged', () => {
  const ctx = make()
  const bad = runAutoWatchCycle(ctx.account,
    [{ code: '123456', name: 'HELD', price: 10550 }],
    new Date(time.getTime() - 3 * 60000).toISOString(), time, ctx.store)
  assert.strictEqual(bad, ctx.account)
  assert.equal(ctx.getLedger().trades.length, 0)
  const errored = recordAutoWatchError(ctx.account, '시세 응답 오류', 1, time)
  assert.equal(errored.watchStatus.status, '오류')
  assert.equal(errored.positions.length, 1)
  assert.equal(errored.dailyStats.checked, 6)
})

test('held position quote errors and delays override a misleading all-green status', () => {
  const ctx = make()
  const error = recordAutoWatchError(ctx.account, '시세 없음', 1, time)
  assert.equal(getAutoHealth(error, time, false, '').tone, 'warning')
  const healthy = runAutoWatchCycle(ctx.account, [{ code: '123456', name: 'HELD', price: 10200 }],
    time.toISOString(), time, ctx.store)
  assert.equal(healthy.watchStatus.filled, 0)
  assert.equal(getAutoHealth(healthy, time, false, '').tone, 'warning') // market screening itself is stale
  const later = new Date(time.getTime() + 4 * 60000)
  assert.equal(getAutoHealth(healthy, later, false, '').label, '빠른 시세 감시 지연')
})
