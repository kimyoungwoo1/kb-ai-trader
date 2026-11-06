import test from 'node:test'
import assert from 'node:assert/strict'
import { build } from 'esbuild'

// Exercise the actual engine with an isolated in-memory paper ledger.
const output = await build({ entryPoints: ['src/autoPaper.ts'], bundle: true, platform: 'node', format: 'esm', write: false })
const url = 'data:text/javascript;base64,' + Buffer.from(output.outputFiles[0].contents).toString('base64')
const { newAutoAccount, runAutoCycle } = await import(url)

const candidate = {
  code: '999999', name: 'TEST-ENTRY', status: '관찰 후보', score: 5, price: 9900,
  volumeRatio: null, volumePaceEstimate: null, foreignToday: null,
  foreignPositiveDays: 0, flowReliable: false, entryTrigger: 10000,
  stopReference: 9700, maxQuantity: 20, reasons: ['가격 조건 충족', '시세 추가 확인'],
}
const excluded = { ...candidate, code: '999998', name: 'TEST-EXCLUDED', status: '조건 미충족',
  score: 2, price: 5100, entryTrigger: null, stopReference: null, maxQuantity: 0,
  reasons: ['시가 대비 상승 미확인'],
}
const first = new Date('2026-11-06T01:00:00.000Z')
const second = new Date('2026-11-06T01:01:00.000Z')
const makeStore = () => {
  let ledger = { cash: 1_000_000, positions: [], trades: [] }
  return { read: () => ledger, write: value => { ledger = value } }
}

test('scan record explains which symbols were inspected and why', () => {
  const store = makeStore()
  const account = { ...newAutoAccount(), enabled: true }
  const run = runAutoCycle(account, [candidate, excluded],
    [{ code: candidate.code, name: candidate.name, price: 9900 },
     { code: excluded.code, name: excluded.name, price: 5100 }],
    first.toISOString(), first, store)
  const report = run.runs[0]
  assert.equal(report.scanned, 2)
  assert.equal(report.candidates, 1)
  assert.equal(report.filled, 0)
  assert.deepEqual(report.decisions.map(item => item.code), ['999999','999998'])
  assert.equal(report.decisions[0].price, 9900)
  assert.equal(report.decisions[0].score, 5)
  assert.equal(report.decisions[0].entryTrigger, 10000)
  assert.equal(report.decisions[0].outcome, '진입 감시 중')
  assert.equal(report.decisions[1].outcome, '조건 미충족')
  assert.ok(report.decisions[1].reason.includes('시가 대비 상승 미확인'))
})

test('subsequent valid trigger is reflected in historical scan outcome', () => {
  const store = makeStore()
  const account = { ...newAutoAccount(), enabled: true }
  const queued = runAutoCycle(account, [candidate], [{ code: candidate.code, name: candidate.name, price: 9900 }],
    first.toISOString(), first, store)
  const purchased = runAutoCycle(queued, [candidate], [{ code: candidate.code, name: candidate.name, price: 10050 }],
    second.toISOString(), second, store)
  assert.equal(purchased.runs.length, 2)
  assert.equal(purchased.runs[0].filled, 1)
  assert.equal(purchased.runs[0].decisions[0].outcome, '가상 매수 체결')
  assert.equal(purchased.runs[1].decisions[0].outcome, '진입 감시 중')
  assert.equal(store.read().trades.length, 1)
})

test('older run decision shapes without price, score or outcome remain valid', () => {
  const legacy = { code: '005930', name: '삼성전자', status: '조건 미충족', reason: '가격 조건 미달' }
  const account = { ...newAutoAccount(), runs: [{
    checkedAt: first.toISOString(), processedAt: first.toISOString(), status: '검사 완료',
    scanned: 1, candidates: 0, filled: 0, message: '정상', decisions: [legacy],
  }] }
  assert.equal(account.runs[0].decisions[0].price, undefined)
  assert.equal(account.runs[0].decisions[0].score, undefined)
  assert.equal(account.runs[0].decisions[0].status, '조건 미충족')
})
