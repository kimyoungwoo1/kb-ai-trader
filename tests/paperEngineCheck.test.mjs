import test from 'node:test'
import assert from 'node:assert/strict'
import { build } from 'esbuild'

// Bundle the same TypeScript implementation used by the React app so extensionless
// browser imports resolve under Node 22 without any test-only copy of the engine.
const output = await build({
  entryPoints: ['src/paperEngineCheck.ts'], bundle: true, platform: 'node',
  format: 'esm', write: false,
})
const moduleUrl = 'data:text/javascript;base64,' + Buffer.from(output.outputFiles[0].contents).toString('base64')
const { runPaperEngineCheck } = await import(moduleUrl)

test('real auto engine buys on a later quote and closes at take-profit', () => {
  const report = runPaperEngineCheck()
  const profit = report.scenarios.find(item => item.name.includes('익절'))
  assert.ok(report.isolated)
  assert.ok(profit?.passed, JSON.stringify(profit))
  assert.ok(profit.quantity > 0)
  assert.ok(profit.buyPrice > 0)
  assert.ok(profit.exitPrice > profit.buyPrice)
  assert.ok(profit.realizedPnl > 0)
  assert.deepEqual(profit.steps, [
    '감시 대상 등록 성공',
    '실제 엔진의 가상매수·현금 차감 성공',
    '가상매도·잔액 정산 성공',
  ])
})

test('real auto engine buys on a later quote and closes at stop-loss', () => {
  const report = runPaperEngineCheck()
  const stop = report.scenarios.find(item => item.name.includes('손절'))
  assert.ok(stop?.passed, JSON.stringify(stop))
  assert.ok(stop.quantity > 0)
  assert.ok(stop.buyPrice > stop.exitPrice)
  assert.ok(stop.realizedPnl < 0)
  assert.equal(report.passed, true)
})

test('engine checks cannot touch browser paper balances', () => {
  // Any accidental call to a browser-backed storage path would fail in Node.
  const report = runPaperEngineCheck()
  assert.equal(report.passed, true)
  assert.equal(report.scenarios.length, 2)
})
