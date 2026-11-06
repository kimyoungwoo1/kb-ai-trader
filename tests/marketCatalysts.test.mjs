import test from 'node:test'
import assert from 'node:assert/strict'
import { build } from 'esbuild'

const buildOutput = await build({
  entryPoints: ['src/marketCatalysts.ts'], bundle: true, platform: 'node',
  format: 'esm', write: false,
})
const url = 'data:text/javascript;base64,' + Buffer.from(buildOutput.outputFiles[0].contents).toString('base64')
const { applyCatalystGate, catalystReady, catalystAllowsPending } = await import(url)
const now = new Date('2026-11-06T03:00:00.000Z')
const candidate = {
  code: '035720', name: '카카오', status: '관찰 후보', score: 5, price: 32000,
  volumeRatio: null, volumePaceEstimate: null, foreignToday: null,
  foreignPositiveDays: 0, flowReliable: false,
  entryTrigger: 32500, stopReference: 31525, maxQuantity: 6, reasons: ['가격 상승'],
}
const original = () => ({
  checkedAt: now.toISOString(), newsOk: true, dartOk: true,
  dartComplete: true, newsSources: 3, dartReported: 0,
  articles: [], disclosures: [], message: '정상',
})
const article = (title, published_at = now.toISOString()) => ({
  title, published_at, source: '테스트 언론사', link: 'https://example.com/article',
})
const filing = (code, title) => ({
  stock_code: code, company: '카카오', title, date: '20261106',
  receipt_no: '12345678901234', link: 'https://dart.fss.or.kr/dsaf001/main.do?rcpNo=12345678901234',
})

test('news or DART outage blocks NEW entries without creating false reassurance', () => {
  for (const snapshot of [null, { ...original(), newsOk: false }, { ...original(), dartOk: false },
    { ...original(), dartComplete: false }, { ...original(), checkedAt: '2026-11-05T03:00:00Z' }]) {
    const result = applyCatalystGate([candidate], snapshot, now)
    assert.equal(result.blocked, 1)
    assert.equal(result.allowed, 0)
    assert.equal(result.signals[0].status, '위험 주의')
    assert.equal(result.signals[0].entryTrigger, null)
    assert.equal(result.signals[0].maxQuantity, 0)
    assert.equal(catalystAllowsPending(candidate.code, candidate.name, snapshot, now), false)
  }
})

test('an exact stock-code DART adverse filing is sufficient to stop entry', () => {
  const snapshot = { ...original(), disclosures: [filing('035720', '유상증자 결정')] }
  const result = applyCatalystGate([candidate], snapshot, now)
  assert.equal(result.blocked, 1)
  assert.match(result.signals[0].reasons.join(' '), /DART.*유상증자/)
  assert.equal(catalystAllowsPending(candidate.code, candidate.name, snapshot, now), false)
})

test('a freshly published matching adverse news headline blocks entry', () => {
  const snapshot = { ...original(), articles: [article('카카오 배임 의혹 수사')] }
  const result = applyCatalystGate([candidate], snapshot, now)
  assert.equal(result.blocked, 1)
  assert.equal(catalystAllowsPending(candidate.code, candidate.name, snapshot, now), false)
})

test('unrelated disclosures and vague company mentions do NOT block the candidate', () => {
  const snapshot = { ...original(), articles: [article('SK 관련 상장폐지 기사')],
    disclosures: [filing('005930', '유상증자 결정')] }
  const result = applyCatalystGate([candidate], snapshot, now)
  assert.equal(result.allowed, 1)
  assert.equal(result.blocked, 0)
  assert.equal(result.signals[0].status, '관찰 후보')
  assert.equal(catalystAllowsPending(candidate.code, candidate.name, snapshot, now), true)
})

test('a favorable headline is research-only, not a mechanical score or buy signal', () => {
  const snapshot = { ...original(), articles: [article('카카오 신규 공급계약 체결')] }
  const result = applyCatalystGate([candidate], snapshot, now)
  assert.equal(result.allowed, 1)
  assert.equal(result.signals[0].score, candidate.score)
  assert.equal(result.signals[0].entryTrigger, candidate.entryTrigger)
  assert.match(result.signals[0].reasons.join(' '), /원문 확인 필요/)
})

test('old headlines, partial DART pages and future timestamps fail safely', () => {
  const snapshot = { ...original(), articles: [article('카카오 상장폐지 소문', '2026-11-01T01:00:00Z')] }
  assert.equal(catalystReady(snapshot, now), true)
  assert.equal(applyCatalystGate([candidate], snapshot, now).allowed, 1)
  const future = { ...snapshot, checkedAt: '2026-11-07T03:00:00Z' }
  assert.equal(catalystReady(future, now), false)
  assert.equal(catalystReady({ ...snapshot, dartComplete: false }, now), false)
})

test('the gate does not turn a poor technical setup into a buy', () => {
  const bad = { ...candidate, status: '조건 미충족', entryTrigger: null, maxQuantity: 0 }
  const result = applyCatalystGate([bad], original(), now)
  assert.equal(result.signals[0].status, '조건 미충족')
  assert.equal(result.allowed, 0)
})
