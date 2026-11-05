import test from 'node:test'
import assert from 'node:assert/strict'
import { generateTradeSignals } from '../src/tradeSignals.ts'

// Run using Node 22+: node --experimental-strip-types --test tests/tradeSignals.test.mjs
const at = new Date('2026-11-05T05:30:00Z') // 14:30 KST, regular session
const quote = {
  code: '123456', name: 'TEST', price: 11000, changeRate: 2.0,
  volume: 1000000, previousVolume: 900000, openPrice: 10800,
  highPrice: 11100, lowPrice: 10500, averagePrice: 10850,
  tradeValue: 10_000_000_000, investorAccumulated: false, investorUnit: 'shares',
  investor: { out: [
    { dt: '20261105', fgnr: '100' }, { dt: '20261104', fgnr: '80' },
    { dt: '20261103', fgnr: '60' }, { dt: '20261102', fgnr: '-20' },
    { dt: '20261030', fgnr: '70' },
  ] },
}

test('independent price checks can produce a research candidate', () => {
  const [signal] = generateTradeSignals([quote], 200000, at)
  assert.equal(signal.status, '관찰 후보')
  assert.equal(signal.flowReliable, true)
  assert.equal(signal.volumeRatio, null) // no intraday/full-day direct comparison
  assert.ok(signal.volumePaceEstimate !== null)
  assert.ok(signal.maxQuantity > 0)
})

test('broken cumulative investor records cannot add score but must not freeze the price strategy', () => {
  const badFlow = {
    ...quote, investorAccumulated: true,
    investor: { out: [{ dt: '20261105', fgnr: '100' }, { dt: '20261104', fgnr: '100' }, { dt: '20261103', fgnr: '100' }] },
  }
  const [signal] = generateTradeSignals([badFlow], 200000, at)
  assert.equal(signal.flowReliable, false)
  assert.equal(signal.status, '관찰 후보')
  assert.equal(signal.score, 5)
})

test('sharp declines do not produce candidates', () => {
  const [signal] = generateTradeSignals([{ ...quote, changeRate: -4 }], 200000, at)
  assert.equal(signal.status, '위험 주의')
})

test('required quote fields missing means no candidate', () => {
  const [signal] = generateTradeSignals([{ ...quote, averagePrice: null }], 200000, at)
  assert.equal(signal.status, '데이터 부족')
})

test('position allocation never exceeds 200000 won at signal trigger', () => {
  const [signal] = generateTradeSignals([quote], 200000, at)
  assert.ok(signal.entryTrigger !== null)
  assert.ok(signal.maxQuantity * signal.entryTrigger <= 200000)
})


test('research signal generator retains all 30 scanned symbols', () => {
  const stocks = Array.from({ length: 30 }, (_, i) => ({
    ...quote, code: String(100000 + i), name: 'TEST-' + i,
  }))
  const signals = generateTradeSignals(stocks, 200000, at)
  assert.equal(signals.length, 30)
  assert.equal(new Set(signals.map(signal => signal.code)).size, 30)
})
