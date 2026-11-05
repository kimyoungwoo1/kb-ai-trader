// Single browser-side ledger shared by manual and automatic paper trading.
// Real brokerage order endpoints are never called.
export const PAPER_KEY = 'kb-ai-trader-paper-v1'
export const PAPER_EVENT = 'kb-paper-ledger-changed'
export type PaperPosition = { code: string; name: string; quantity: number; averagePrice: number; lastPrice: number; quoteUpdatedAt?: string }
export type PaperTrade = { id: string; time: string; side: 'BUY' | 'SELL'; code: string; name: string; quantity: number; price: number; amount: number; realizedPnl?: number; source?: 'manual' | 'auto'; costs?: number; reason?: string }
export type PaperLedger = { cash: number; positions: PaperPosition[]; trades: PaperTrade[] }
export const freshLedger = (): PaperLedger => ({ cash: 1000000, positions: [], trades: [] })
export function readPaperLedger(): PaperLedger {
  try {
    const value = JSON.parse(localStorage.getItem(PAPER_KEY) || 'null') as PaperLedger
    if (value && Number.isFinite(value.cash) && value.cash >= 0 && Array.isArray(value.positions) && Array.isArray(value.trades)) return value
  } catch { /* fallback */ }
  return freshLedger()
}
export function writePaperLedger(value: PaperLedger) {
  localStorage.setItem(PAPER_KEY, JSON.stringify(value))
  window.dispatchEvent(new CustomEvent(PAPER_EVENT))
}
export function ledgerEquity(value: PaperLedger): number {
  return value.cash + value.positions.reduce((sum, p) => sum + p.quantity * p.lastPrice, 0)
}
