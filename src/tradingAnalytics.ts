import type { AutoAccount, AutoFill } from './autoPaper'
import type { PaperLedger, PaperTrade } from './paperLedger'
import { analyzePerformance } from './strategyDiagnostics'

export type JournalGroup = 'all' | 'auto' | 'manual' | 'test'
export type AnalyticsPeriod = '7' | '30' | 'all'

export function journalGroup(trade: PaperTrade): Exclude<JournalGroup, 'all'> {
  return trade.source === 'test' ? 'test' : trade.source === 'auto' ? 'auto' : 'manual'
}
export function inPeriod(timestamp: string, period: AnalyticsPeriod, now: Date): boolean {
  const parsed = Date.parse(timestamp)
  if (!Number.isFinite(parsed) || parsed > now.getTime() + 60_000) return false
  return period === 'all' || now.getTime() - parsed <= Number(period) * 86400000
}
export function journalTrades(ledger: PaperLedger, period: AnalyticsPeriod, group: JournalGroup, now = new Date()): PaperTrade[] {
  return ledger.trades.filter(trade => inPeriod(trade.time, period, now)
    && (group === 'all' || journalGroup(trade) === group))
    .sort((a, b) => Date.parse(b.time) - Date.parse(a.time))
}
export type ClosedAutoTrade = {
  id: string; code: string; name: string; at: string; quantity: number;
  sellPrice: number; pnl: number; reason: string; holdingHours: number | null
}
function matchedHoldingHours(sells: AutoFill[], fills: AutoFill[]): ClosedAutoTrade[] {
  const buys = fills.filter(fill => fill.side === 'BUY' && !fill.test
    && Number.isFinite(Date.parse(fill.at))).sort((a,b) => Date.parse(a.at) - Date.parse(b.at))
    .map(fill => ({ ...fill, remaining: fill.quantity }))
  return sells.map(sell => {
    let missing = sell.quantity
    let weightedHours = 0
    let accounted = 0
    const at = Date.parse(sell.at)
    for (const buy of buys) {
      if (missing <= 0) break
      if (buy.code !== sell.code || Date.parse(buy.at) > at || buy.remaining <= 0) continue
      const used = Math.min(missing, buy.remaining)
      buy.remaining -= used
      missing -= used
      const hours = (at - Date.parse(buy.at)) / 3600000
      if (Number.isFinite(hours) && hours >= 0) {
        weightedHours += hours * used
        accounted += used
      }
    }
    return {
      id: sell.id, code: sell.code, name: sell.name, at: sell.at,
      quantity: sell.quantity, sellPrice: sell.price,
      pnl: sell.pnl ?? 0, reason: sell.reason,
      holdingHours: !missing && accounted === sell.quantity && accounted > 0
        ? weightedHours / accounted : null,
    }
  })
}
export function summarizeAutoTrades(account: AutoAccount, period: AnalyticsPeriod, now = new Date()) {
  const sells = account.fills.filter(fill =>
    fill.side === 'SELL' && !fill.test && fill.pnl !== null
    && Number.isFinite(fill.pnl) && inPeriod(fill.at, period, now)
  ).sort((a, b) => Date.parse(b.at) - Date.parse(a.at))
  const closed = matchedHoldingHours(sells, account.fills)
  const won = closed.filter(row => row.pnl > 0)
  const lost = closed.filter(row => row.pnl <= 0)
  const net = closed.reduce((sum, row) => sum + row.pnl, 0)
  const matched = closed.filter(row => row.holdingHours !== null)
  const grossProfit = won.reduce((sum, row) => sum + row.pnl, 0)
  const grossLoss = lost.reduce((sum, row) => sum + Math.abs(row.pnl), 0)
  return {
    closed, count: closed.length, winners: won.length, losers: lost.length,
    winRate: closed.length ? won.length / closed.length * 100 : null,
    netPnl: net, averagePnl: closed.length ? net / closed.length : null,
    profitFactor: grossLoss > 0 ? grossProfit / grossLoss : null,
    averageHoldingHours: matched.length
      ? matched.reduce((sum, row) => sum + (row.holdingHours || 0), 0) / matched.length : null,
    holdingSamples: matched.length,
  }
}
export function equityCurve(account: AutoAccount, ledger: PaperLedger, period: AnalyticsPeriod, now = new Date()) {
  const history = account.equityHistory
    .filter(point => Number.isFinite(point.value) && point.value >= 0
      && inPeriod(point.at, period, now))
    .sort((a, b) => Date.parse(a.at) - Date.parse(b.at))
  // Include the current, unified account equity only when there is stored history.
  // A sole live balance must not masquerade as a historical series.
  if (!history.length) return []
  const current = ledger.cash + ledger.positions.reduce((sum, p) =>
    sum + p.lastPrice * p.quantity, 0)
  return [...history, { at: now.toISOString(), value: current }]
}
export function summarizeTradingAnalytics(account: AutoAccount, ledger: PaperLedger,
  period: AnalyticsPeriod, now = new Date()) {
  const performance = analyzePerformance(account, ledger)
  const strategy = summarizeAutoTrades(account, period, now)
  const filteredTrades = journalTrades(ledger, period, 'all', now)
  const curve = equityCurve(account, ledger, period, now)
  const recentRuns = account.runs.filter(run => inPeriod(run.processedAt, period, now))
  return {
    performance, strategy, filteredTrades, curve, recentRuns,
    autoOrders: filteredTrades.filter(trade => journalGroup(trade) === 'auto').length,
    manualOrders: filteredTrades.filter(trade => journalGroup(trade) === 'manual').length,
    testOrders: filteredTrades.filter(trade => journalGroup(trade) === 'test').length,
  }
}
