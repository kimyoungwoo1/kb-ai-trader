import type { TradeSignal } from './tradeSignals'
import { readPaperLedger, writePaperLedger, type PaperTrade } from './paperLedger'

export const AUTO_STORAGE_KEY = 'kb-ai-trader-autopaper-v1'
export const AUTO_INITIAL = 1_000_000
const MAX_POSITION = 200_000
const MAX_POSITIONS = 3
const MAX_DAILY_LOSS = 10_000
const MAX_CONSECUTIVE_LOSSES = 3
const MIN_DATA_FRESHNESS_MS = 5 * 60_000
const BUY_SLIPPAGE = 0.001
const SELL_SLIPPAGE = 0.001
const BUY_FEE = 0.00015
const SELL_COST = 0.0020 // illustrative fee + transaction tax, not an official broker quote

export type AutoPosition = {
  code: string; name: string; quantity: number; entry: number; last: number
  stop: number; target: number; openedAt: string; buyCost: number
}
export type AutoPending = { code: string; name: string; trigger: number; stop: number; createdAt: string }
export type AutoFill = {
  id: string; at: string; code: string; name: string; side: 'BUY' | 'SELL'
  quantity: number; price: number; costs: number; pnl: number | null; reason: string
}
export type AutoRun = {
  checkedAt: string; processedAt: string; status: '검사 완료' | '실행 보류'
  scanned: number; candidates: number; filled: number; message: string
  decisions: { code: string; name: string; status: string; reason: string }[]
}
export type AutoAccount = {
  enabled: boolean; cash: number; positions: AutoPosition[]; pending: AutoPending[]
  fills: AutoFill[]; equityHistory: { at: string; value: number }[]
  lastCycle: string; lastMessage: string; runs: AutoRun[]
}
export const newAutoAccount = (): AutoAccount => ({
  enabled: false, cash: AUTO_INITIAL, positions: [], pending: [], fills: [],
  equityHistory: [], lastCycle: '', lastMessage: '자동 가상매매는 기본적으로 꺼져 있습니다.', runs: [],
})
export const kstDate = (date: Date): string => new Date(date.getTime() + 9 * 3600000).toISOString().slice(0, 10)
const inSession = (date: Date) => {
  const kst = new Date(date.getTime() + 9 * 3600000)
  const day = kst.getUTCDay()
  const minutes = kst.getUTCHours() * 60 + kst.getUTCMinutes()
  return day >= 1 && day <= 5 && minutes >= 9 * 60 && minutes < 15 * 60 + 30
}
const won = (n: number) => Math.round(n)
const positive = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value > 0

export function autoEquity(account: AutoAccount): number {
  return account.cash + account.positions.reduce((sum, p) => sum + p.last * p.quantity, 0)
}
export function autoStats(account: AutoAccount) {
  const sells = account.fills.filter(f => f.side === 'SELL' && f.pnl !== null)
  const realized = sells.reduce((sum, f) => sum + (f.pnl || 0), 0)
  const winners = sells.filter(f => (f.pnl || 0) > 0).length
  const equity = autoEquity(account)
  let peak = AUTO_INITIAL
  let maxDrawdown = 0
  for (const point of [...account.equityHistory, { at: account.lastCycle, value: equity }]) {
    peak = Math.max(peak, point.value)
    if (peak > 0) maxDrawdown = Math.max(maxDrawdown, (peak - point.value) / peak * 100)
  }
  return { equity, realized, closed: sells.length, winRate: sells.length ? winners / sells.length * 100 : null,
    returnRate: (equity / AUTO_INITIAL - 1) * 100, maxDrawdown }
}
export function runAutoCycle(account: AutoAccount, signals: TradeSignal[], quotes: {
  code: string; name: string; price: number | null; quoteError?: string
}[], checkedAt: string, now = new Date()): AutoAccount {
  if (!account.enabled || account.lastCycle === checkedAt) return account
  const checked = new Date(checkedAt)
  const decisions = signals.map(signal => ({
    code: signal.code,
    name: signal.name,
    status: signal.status,
    reason: signal.status === '관찰 후보'
      ? signal.maxQuantity < 1 ? '종목당 20만원 한도로 1주 매수 불가' : '진입 감시 대상 · 다음 신규 시세에서 가격 돌파 확인 필요'
      : signal.reasons.join(' / ') || '진입 조건 미충족',
  }))
  const candidates = signals.filter(signal => signal.status === '관찰 후보' && signal.flowReliable && signal.maxQuantity > 0).length
  const completeRun = (status: AutoRun['status'], message: string, filled = 0): AutoAccount => {
    const run: AutoRun = {
      checkedAt, processedAt: now.toISOString(), status, scanned: signals.length,
      candidates, filled, message, decisions,
    }
    return { ...account, lastCycle: checkedAt, lastMessage: message,
      runs: [run, ...(account.runs || [])].slice(0, 30) }
  }
  if (!Number.isFinite(checked.getTime()) || Math.abs(now.getTime() - checked.getTime()) > MIN_DATA_FRESHNESS_MS) {
    return completeRun('실행 보류', '시세 수집 후 5분 초과 또는 수집시각 오류 · 가상 체결 보류')
  }
  if (!inSession(now)) return completeRun('실행 보류', '정규장 외 시간 · 신호만 확인, 가상 체결 보류')
  const ledger = readPaperLedger()
  const ledgerPositions = ledger.positions.map(p => ({ ...p }))
  const quoteMap = new Map<string, number>(quotes.filter(q => positive(q.price) && !q.quoteError).map(q => [q.code, q.price as number] as [string, number]))
  let cash = ledger.cash
  // A manual sale/reset may have removed an automated position. Never sell phantom shares.
  let positions = account.positions.filter(p => {
    const shared = ledgerPositions.find(item => item.code === p.code)
    return shared && shared.quantity >= p.quantity
  }).map(p => ({ ...p }))
  let pending = account.pending.map(p => ({ ...p }))
  const fills = [...account.fills]
  const currentDate = kstDate(now)
  const alreadyTradedToday = new Set(fills.filter(f => kstDate(new Date(f.at)) === currentDate).map(f => f.code))
  let executed = 0
  const dayRealized = fills.filter(f => f.side === 'SELL' && kstDate(new Date(f.at)) === currentDate)
    .reduce((sum, f) => sum + (f.pnl || 0), 0)
  let sessionPnl = dayRealized
  // A streak is evaluated from most recent completed automated exits, never manual trades.
  const priorSells = fills.filter(f => f.side === 'SELL' && f.pnl !== null)
  let consecutiveLosses = 0
  for (const fill of priorSells) { if ((fill.pnl ?? 0) < 0) consecutiveLosses++; else break }
  const dailyLossLocked = () => sessionPnl <= -MAX_DAILY_LOSS
  let pauseNewEntries = consecutiveLosses >= MAX_CONSECUTIVE_LOSSES
  // Existing position exits have precedence, and only verified fresh quotes may trigger them.
  positions = positions.filter(p => {
    const mark = quoteMap.get(p.code)
    if (mark === undefined) return true
    p.last = mark
    const holdingDays = (now.getTime() - new Date(p.openedAt).getTime()) / 86400000
    const reason = mark <= p.stop ? '손절 참고값 도달' : mark >= p.target ? '익절 참고값 도달' : holdingDays >= 15 ? '보유기간 15일 경과' : ''
    if (!reason) return true
    const sellPrice = won(mark * (1 - SELL_SLIPPAGE))
    const proceeds = sellPrice * p.quantity
    const costs = won(proceeds * SELL_COST)
    const pnl = proceeds - costs - p.entry * p.quantity - p.buyCost
    cash += proceeds - costs
    const idx = ledgerPositions.findIndex(item => item.code === p.code)
    if (idx >= 0) {
      const existing = ledgerPositions[idx]
      if (existing.quantity <= p.quantity) ledgerPositions.splice(idx, 1)
      else ledgerPositions[idx] = { ...existing, quantity: existing.quantity - p.quantity, lastPrice: mark }
    }
    sessionPnl += pnl
    consecutiveLosses = pnl < 0 ? consecutiveLosses + 1 : 0
    if (consecutiveLosses >= MAX_CONSECUTIVE_LOSSES) pauseNewEntries = true
    fills.unshift({ id: now.toISOString() + '-sell-' + p.code, at: now.toISOString(), code: p.code, name: p.name, side: 'SELL',
      quantity: p.quantity, price: sellPrice, costs, pnl, reason })
    alreadyTradedToday.add(p.code)
    executed++
    return false
  })
  // Discard pending signals whose conditions disappeared, then update watch targets.
  const valid = new Map<string, TradeSignal>(signals.filter(s => s.status === '관찰 후보' && s.maxQuantity > 0 && positive(s.entryTrigger) && positive(s.stopReference)).map(s => [s.code, s] as [string, TradeSignal]))
  // A rotating batch can omit a watched symbol, but queued triggers expire after one day.
  // Re-quoted watched symbols must still meet the current research criteria.
  pending = pending.filter(p => {
    const ageMs = now.getTime() - new Date(p.createdAt).getTime()
    if (!Number.isFinite(ageMs) || ageMs < 0 || ageMs > 24 * 3600000) return false
    if (ledgerPositions.some(position => position.code === p.code)) return false
    return !signals.some(signal => signal.code === p.code) || valid.has(p.code)
  })
  for (const signal of signals) {
    if (!valid.has(signal.code) || ledgerPositions.some(p => p.code === signal.code) || pending.some(p => p.code === signal.code) || alreadyTradedToday.has(signal.code)) continue
    pending.push({ code: signal.code, name: signal.name, trigger: signal.entryTrigger!, stop: signal.stopReference!, createdAt: now.toISOString() })
  }
  // Require a *later* quote to cross the watch trigger. Never fill using the creating snapshot.
  for (const item of [...pending]) {
    if (ledgerPositions.length >= MAX_POSITIONS || dailyLossLocked() || pauseNewEntries) break
    if (new Date(item.createdAt).getTime() >= checked.getTime()) continue
    if (alreadyTradedToday.has(item.code)) continue
    const mark = quoteMap.get(item.code)
    if (mark === undefined || mark < item.trigger || mark > item.trigger * 1.02) continue
    const fillPrice = won(mark * (1 + BUY_SLIPPAGE))
    const quantity = Math.min(Math.floor(MAX_POSITION / fillPrice), Math.floor(cash / (fillPrice * (1 + BUY_FEE))))
    if (quantity < 1) continue
    const cost = fillPrice * quantity
    const fee = won(cost * BUY_FEE)
    if (cost + fee > cash) continue
    cash -= cost + fee
    ledgerPositions.push({ code: item.code, name: item.name, quantity, averagePrice: fillPrice, lastPrice: mark })
    positions.push({ code: item.code, name: item.name, quantity, entry: fillPrice, last: mark,
      stop: Math.min(item.stop, won(fillPrice * 0.97)), target: won(fillPrice * 1.06), openedAt: now.toISOString(), buyCost: fee })
    fills.unshift({ id: now.toISOString() + '-buy-' + item.code, at: now.toISOString(), code: item.code, name: item.name,
      side: 'BUY', quantity, price: fillPrice, costs: fee, pnl: null, reason: '다음 시세에서 진입 참고값 돌파' })
    pending = pending.filter(p => p.code !== item.code)
    alreadyTradedToday.add(item.code)
    executed++
  }
  const autoOrders = fills.slice(0, Math.max(0, fills.length - account.fills.length)).map(f => ({
    id: f.id, time: f.at, side: f.side, code: f.code, name: f.name,
    quantity: f.quantity, price: f.price, amount: f.quantity * f.price,
    realizedPnl: f.pnl === null ? undefined : f.pnl, source: 'auto' as const, costs: f.costs, reason: f.reason,
  } satisfies PaperTrade))
  for (const position of ledgerPositions) {
    const updatedQuote = quoteMap.get(position.code)
    if (updatedQuote !== undefined) position.lastPrice = updatedQuote
  }
  writePaperLedger({ ...ledger, cash, positions: ledgerPositions, trades: [...autoOrders, ...ledger.trades] })
  const equity = cash + ledgerPositions.reduce((sum, p) => sum + p.lastPrice * p.quantity, 0)
  const lockReason = pauseNewEntries ? ' · 연속 손실 ' + MAX_CONSECUTIVE_LOSSES + '회 신규매수 중단' : dailyLossLocked() ? ' · 당일 실현손실 한도 도달: 신규매수 중단' : ''
  const summary = (executed ? '가상 체결 ' + executed + '건 · 검사 완료'
    : candidates ? '관찰 후보 ' + candidates + '건 · 현재가/진입 조건 미충족으로 가상 체결 0건'
      : '매수 후보 없음 · 가상 체결 0건 · 정상 검사 완료') + lockReason
  const run: AutoRun = { checkedAt, processedAt: now.toISOString(), status: '검사 완료',
    scanned: signals.length, candidates, filled: executed, message: summary, decisions }
  return { ...account, cash, positions, pending, fills: fills.slice(0, 1000),
    equityHistory: [...account.equityHistory, { at: checkedAt, value: equity }].slice(-1000),
    lastCycle: checkedAt, lastMessage: summary, runs: [run, ...(account.runs || [])].slice(0, 30) }
}
export function readAutoAccount(): AutoAccount {
  try {
    const saved = JSON.parse(localStorage.getItem(AUTO_STORAGE_KEY) || 'null') as AutoAccount | null
    if (saved && Number.isFinite(saved.cash) && saved.cash >= 0 && Array.isArray(saved.positions) && Array.isArray(saved.pending) && Array.isArray(saved.fills) && Array.isArray(saved.equityHistory)) return { ...newAutoAccount(), ...saved, runs: Array.isArray(saved.runs) ? saved.runs.slice(0, 30) : [] }
  } catch { /* ignore invalid local data */ }
  return newAutoAccount()
}
