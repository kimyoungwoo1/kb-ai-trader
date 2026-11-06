import test from 'node:test'
import assert from 'node:assert/strict'
import { build } from 'esbuild'

const bundle = async entry => {
  const built = await build({ entryPoints: [entry], bundle: true, platform: 'node',
    format: 'esm', write: false })
  return import('data:text/javascript;base64,' + Buffer.from(built.outputFiles[0].contents).toString('base64'))
}
const { AUTO_TAKE_PROFIT_PCT, newAutoAccount, runAutoCycle, runAutoTrialSell, autoStats, readAutoAccount } =
  await bundle('src/autoPaper.ts')
const { analyzePerformance } = await bundle('src/strategyDiagnostics.ts')

const start = new Date('2026-11-06T01:00:00.000Z') // 10:00 KST
const make = () => {
  let ledger = {
    cash: 990000, positions: [{ code: '123456', name: 'TEST', quantity: 1,
      averagePrice: 10000, lastPrice: 10000 }], trades: [],
  }
  const paperStore = { read: () => ledger, write: next => { ledger = next } }
  const account = { ...newAutoAccount(), enabled: true,
    cash: 990000, positions: [{ code: '123456', name: 'TEST', quantity: 1,
      entry: 10000, last: 10000, stop: 9700, target: 10600,
      openedAt: start.toISOString(), buyCost: 2 }] }
  return { account, paperStore, getLedger: () => ledger }
}

test('take-profit is 5%, and existing 6%-target positions migrate at next cycle', () => {
  assert.equal(AUTO_TAKE_PROFIT_PCT, 5)
  const ctx = make()
  const after = runAutoCycle(ctx.account, [],
    [{ code: '123456', name: 'TEST', price: 10500 }],
    start.toISOString(), start, ctx.paperStore)
  assert.equal(after.positions.length, 0)
  assert.equal(after.fills[0].reason, '익절 참고값 도달')
  assert.equal(ctx.getLedger().positions.length, 0)
  assert.equal(ctx.getLedger().trades[0].source, 'auto')
})

test('existing 6%-target positions also display 5% target after localStorage read', () => {
  const memory = new Map()
  globalThis.localStorage = { getItem: key => memory.get(key) || null,
    setItem: (key, value) => memory.set(key, value) }
  const ctx = make()
  memory.set('kb-ai-trader-autopaper-v1', JSON.stringify(ctx.account))
  const read = readAutoAccount()
  assert.equal(read.positions[0].target, 10500)
  delete globalThis.localStorage
})

test('confirmed trial sale uses fresh quote, settles shared cash and flags test metrics', () => {
  const ctx = make()
  const quote = { price: 10020, checkedAt: start.toISOString() }
  const after = runAutoTrialSell(ctx.account, '123456', quote, start, ctx.paperStore)
  const ledger = ctx.getLedger()
  assert.equal(after.positions.length, 0)
  assert.equal(ledger.positions.length, 0)
  assert.equal(ledger.trades.length, 1)
  assert.equal(ledger.trades[0].source, 'test')
  assert.equal(after.fills[0].test, true)
  assert.equal(after.fills[0].side, 'SELL')
  assert.equal(ledger.cash, 990000 + ledger.trades[0].amount - ledger.trades[0].costs)
  assert.equal(after.cash, ledger.cash)
  assert.equal(autoStats(after).closed, 0)
  assert.equal(analyzePerformance(after, ledger).closed, 0)
  assert.equal(after.runs.length, 0)
})

test('stale quotes, missing positions and closed sessions cannot alter shared cash', () => {
  const ctx = make()
  const stale = new Date(start.getTime() - 121000).toISOString()
  assert.throws(() => runAutoTrialSell(ctx.account, '123456', { price: 10000, checkedAt: stale }, start, ctx.paperStore), /2분/)
  assert.throws(() => runAutoTrialSell(ctx.account, '999999', { price: 10000, checkedAt: start.toISOString() }, start, ctx.paperStore), /자동 전략/)
  assert.throws(() => runAutoTrialSell(ctx.account, '123456', { price: 10000, checkedAt: start.toISOString() },
    new Date('2026-11-06T08:00:00.000Z'), ctx.paperStore), /정규장/)
  assert.equal(ctx.getLedger().cash, 990000)
  assert.equal(ctx.getLedger().trades.length, 0)
})
