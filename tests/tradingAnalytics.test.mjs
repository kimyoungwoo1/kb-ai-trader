import test from 'node:test'
import assert from 'node:assert/strict'
import { build } from 'esbuild'

const result = await build({ entryPoints: ['src/tradingAnalytics.ts'], bundle: true,
  platform: 'node', format: 'esm', write: false })
const { journalTrades, summarizeAutoTrades, summarizeTradingAnalytics, equityCurve } = await import(
  'data:text/javascript;base64,' + Buffer.from(result.outputFiles[0].contents).toString('base64')
)
const now = new Date('2026-11-06T05:00:00Z')
const t = offset => new Date(now.getTime() - offset * 3600000).toISOString()
const account = {
  enabled: true, cash: 999000, positions: [], pending: [], lastCycle: t(0),
  lastMessage: '', runs: [
    { checkedAt: t(1), processedAt: t(1), status: '검사 완료',
      scanned: 50, candidates: 2, filled: 1, message: '검사 완료', decisions: [] },
  ],
  dailyStats: { date: '2026-11-06', checked: 1, completed: 1, deferred: 0, filled: 1 },
  equityHistory: [{ at: t(2), value: 1010000 }, { at: t(1), value: 1005000 }],
  fills: [
    { id: 'sell-win', at: t(1), code: '005930', name: '삼성전자', side: 'SELL',
      quantity: 2, price: 10200, costs: 20, pnl: 400, reason: '익절', test: false },
    { id: 'sell-loss', at: t(0.5), code: '035720', name: '카카오', side: 'SELL',
      quantity: 1, price: 9500, costs: 10, pnl: -500, reason: '손절' },
    { id: 'sell-trial', at: t(0.3), code: '030200', name: 'KT', side: 'SELL',
      quantity: 2, price: 11000, costs: 20, pnl: 1000, reason: '시험 청산', test: true },
    { id: 'buy-win', at: t(4), code: '005930', name: '삼성전자', side: 'BUY',
      quantity: 2, price: 10000, costs: 2, pnl: null, reason: '돌파' },
    { id: 'buy-loss', at: t(2), code: '035720', name: '카카오', side: 'BUY',
      quantity: 1, price: 10000, costs: 2, pnl: null, reason: '돌파' },
  ],
}
const ledger = {
  cash: 999000,
  positions: [{ code: '000660', name: 'SK하이닉스', quantity: 1, averagePrice: 10000, lastPrice: 12000 }],
  trades: [
    { id: 'auto-win', time: t(1), code: '005930', name: '삼성전자',
      side: 'SELL', quantity: 2, price: 10200, amount: 20400, realizedPnl: 400, source: 'auto' },
    { id: 'manual-buy', time: t(3), code: '000660', name: 'SK하이닉스',
      side: 'BUY', quantity: 1, price: 10000, amount: 10000, source: 'manual' },
    { id: 'trial', time: t(0.3), code: '030200', name: 'KT',
      side: 'SELL', quantity: 2, price: 11000, amount: 22000, realizedPnl: 1000, source: 'test' },
    { id: 'old', time: t(9 * 24), code: '035720', name: '카카오',
      side: 'SELL', quantity: 1, price: 9500, amount: 9500, realizedPnl: -500, source: 'auto' },
  ],
}

test('automatic success metrics exclude trial/manual sales and count matched holding time', () => {
  const report = summarizeAutoTrades(account, '7', now)
  assert.equal(report.count, 2)
  assert.equal(report.winners, 1)
  assert.equal(report.losers, 1)
  assert.equal(report.netPnl, -100)
  assert.equal(report.winRate, 50)
  assert.equal(report.profitFactor, 0.8)
  assert.equal(report.holdingSamples, 2)
  assert.ok(report.averageHoldingHours > 1)
})

test('ledger journal types and date filters are separate from strategy win rate', () => {
  assert.equal(journalTrades(ledger, '7', 'all', now).length, 3)
  assert.equal(journalTrades(ledger, '7', 'auto', now).length, 1)
  assert.equal(journalTrades(ledger, '7', 'manual', now).length, 1)
  assert.equal(journalTrades(ledger, '7', 'test', now).length, 1)
  assert.equal(journalTrades(ledger, 'all', 'auto', now).length, 2)
})

test('unified equity and observed curve do not impersonate strategy profit', () => {
  const report = summarizeTradingAnalytics(account, ledger, '30', now)
  assert.equal(report.performance.totalEquity, 1011000)
  assert.ok(Math.abs(report.performance.returnPct - 1.1) < 1e-9)
  assert.equal(report.strategy.netPnl, -100)
  assert.equal(report.curve.length, 3)
  assert.equal(report.curve.at(-1).value, 1011000)
  assert.equal(report.autoOrders, 1)
  assert.equal(report.manualOrders, 1)
  assert.equal(report.testOrders, 1)
  assert.equal(report.recentRuns.length, 1)
})

test('missing historical buy fill does not invent average holding time', () => {
  const withoutBuy = { ...account, fills: account.fills.filter(item => item.id !== 'buy-win') }
  const report = summarizeAutoTrades(withoutBuy, 'all', now)
  assert.equal(report.count, 2)
  assert.equal(report.holdingSamples, 1)
  assert.equal(report.closed.find(item => item.id === 'sell-win').holdingHours, null)
})

test('missing chart observations produce an empty graph, not a fabricated baseline', () => {
  assert.deepEqual(equityCurve({ ...account, equityHistory: [] }, ledger, '7', now), [])
})
