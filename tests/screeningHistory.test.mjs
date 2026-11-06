import test from 'node:test'
import assert from 'node:assert/strict'
import { build } from 'esbuild'
const result = await build({ entryPoints: ['src/screeningHistory.ts'], bundle: true,
  platform: 'node', format: 'esm', write: false })
const { readScreeningSnapshot, writeScreeningSnapshot, selectScreeningView } = await import(
  'data:text/javascript;base64,' + Buffer.from(result.outputFiles[0].contents).toString('base64'))
const at = '2026-11-06T05:00:00Z'
const signal = { code: '005930', name: '삼성전자', score: 5, status: '관찰 후보',
  entryTrigger: 10000, stopReference: 9700, maxQuantity: 4,
  reasons: ['기술적 신호'], flowReliable: true, volumeRatio: null, volumePaceEstimate: null }
const storedRun = {
  checkedAt: '2026-11-06T04:30:00Z', processedAt: '2026-11-06T04:30:03Z',
  scanned: 50, candidates: 4, filled: 0, status: '검사 완료', message: '시장 검사 완료',
  decisions: [{ code: '005930', name: '삼성전자', status: '관찰 후보', score: 5, reason: '신호' }],
}
test('reload restores last full signal snapshot without claiming fresh live data', () => {
  const memory = new Map()
  globalThis.localStorage = { getItem: key => memory.get(key) || null,
    setItem: (key, value) => { memory.set(key, value) } }
  try {
    writeScreeningSnapshot({ checkedAt: at, signals: [signal] })
    const restored = readScreeningSnapshot()
    assert.equal(restored.signals.length, 1)
    const view = selectScreeningView([], restored, [storedRun], '')
    assert.equal(view.source, 'snapshot')
    assert.equal(view.report.inspected, 1)
    assert.equal(view.breakdownAvailable, true)
    assert.match(view.note, /저장된/)
  } finally { delete globalThis.localStorage }
})
test('older saved market scan restores real totals instead of 0/50', () => {
  const view = selectScreeningView([], null, [storedRun], '')
  assert.equal(view.source, 'run')
  assert.equal(view.report.inspected, 50)
  assert.equal(view.report.candidates, 4)
  assert.equal(view.breakdownAvailable, false)
  assert.equal(view.report.breakdown.length, 0)
})
test('when no signals, snapshot or run exist, display missing data rather than zeros', () => {
  const view = selectScreeningView([], null, [], '')
  assert.equal(view.source, 'none')
  assert.equal(view.report, null)
})
test('live recent signals override saved records, without allowing saved data into trade engine', () => {
  const view = selectScreeningView([signal], null, [storedRun], at)
  assert.equal(view.source, 'live')
  assert.equal(view.report.candidates, 1)
})
