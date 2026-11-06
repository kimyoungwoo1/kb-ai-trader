import test from 'node:test'
import assert from 'node:assert/strict'
import { build } from 'esbuild'

async function load(entry) {
  const bundle = await build({ entryPoints: [entry], bundle: true, platform: 'node',
    format: 'esm', write: false })
  return import('data:text/javascript;base64,' + Buffer.from(bundle.outputFiles[0].contents).toString('base64'))
}
const { MAX_POSITIONS, newAutoAccount, runAutoCycle } = await load('src/autoPaper.ts')
const { FAST_QUOTE_MAX_CODES, selectAutoWatchStocks } = await load('src/autoWatch.ts')
const day = new Date('2026-11-06T01:00:00.000Z') // Friday 10:00 KST
const future = new Date(day.getTime() + 60000)
const candidates = Array.from({ length: 6 }, (_, i) => ({
  code: String(100001 + i), name: 'STOCK-' + (i + 1), status: '관찰 후보',
  score: 5, price: 9900, volumeRatio: null, volumePaceEstimate: null,
  foreignToday: null, foreignPositiveDays: 0, flowReliable: false,
  entryTrigger: 10000, stopReference: 9700, maxQuantity: 20, reasons: [],
}))
function store() {
  let ledger = { cash: 1_000_000, positions: [], trades: [] }
  return {
    read: () => ledger,
    write: next => { ledger = next },
  }
}

test('five different stocks can be bought while a sixth is rejected by allocation limit', () => {
  const paper = store()
  let account = { ...newAutoAccount(), enabled: true }
  const quotes = candidates.map(stock => ({ code: stock.code, name: stock.name, price: 9900 }))
  account = runAutoCycle(account, candidates, quotes, day.toISOString(), day, paper)
  assert.equal(account.positions.length, 0)
  assert.equal(account.pending.length, 6)
  const second = candidates.map(stock => ({ code: stock.code, name: stock.name, price: 10050 }))
  account = runAutoCycle(account, candidates, second, future.toISOString(), future, paper)
  assert.equal(MAX_POSITIONS, 5)
  assert.equal(account.positions.length, 5)
  assert.equal(new Set(account.positions.map(p => p.code)).size, 5)
  assert.equal(paper.read().positions.length, 5)
  assert.equal(paper.read().trades.filter(t => t.side === 'BUY').length, 5)
  assert.ok(paper.read().cash >= 0)
  assert.equal(account.pending.length, 1)
  assert.equal(account.positions.reduce((sum, p) => sum + p.entry * p.quantity, 0) <= 1_000_000, true)
})

test('one-minute priority watch always covers five held stocks and does not quote unnecessary pending symbols', () => {
  const stocklist = candidates.map(stock => ({ code: stock.code, name: stock.name }))
  const positions = stocklist.slice(0, 5).map(stock => ({ ...stock, quantity: 1, entry: 10000,
    last: 10000, stop: 9700, target: 10500, openedAt: day.toISOString(), buyCost: 2 }))
  const pending = stocklist.slice(5).map(stock => ({ ...stock, trigger: 10000,
    stop: 9700, createdAt: day.toISOString() }))
  const selected = selectAutoWatchStocks({ positions, pending })
  assert.equal(FAST_QUOTE_MAX_CODES, 5)
  assert.deepEqual(selected.map(stock => stock.code), stocklist.slice(0, 5).map(stock => stock.code))
  assert.ok(selected.every(stock => stock.priority === '보유'))
})

test('one free holding slot permits fast monitoring of one queued stock', () => {
  const stocklist = candidates.map(stock => ({ code: stock.code, name: stock.name }))
  const positions = stocklist.slice(0, 4).map(stock => ({ ...stock, quantity: 1, entry: 10000,
    last: 10000, stop: 9700, target: 10500, openedAt: day.toISOString(), buyCost: 2 }))
  const pending = stocklist.slice(4).map(stock => ({ ...stock, trigger: 10000,
    stop: 9700, createdAt: day.toISOString() }))
  const selected = selectAutoWatchStocks({ positions, pending })
  assert.equal(selected.length, 5)
  assert.deepEqual(selected.map(stock => stock.code), stocklist.slice(0, 5).map(stock => stock.code))
  assert.equal(selected[4].priority, '진입 감시')
})
