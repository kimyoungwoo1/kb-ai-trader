import type { TradeSignal } from './tradeSignals'

export const AUTO_STORAGE_KEY = 'kb-ai-trader-autopaper-v1'
export const AUTO_INITIAL = 1_000_000
const MAX_POSITION = 200_000
const MAX_POSITIONS = 3
const MAX_DAILY_LOSS = 10_000
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
export type AutoAccount = {
  enabled: boolean; cash: number; positions: AutoPosition[]; pending: AutoPending[]
  fills: AutoFill[]; equityHistory: { at: string; value: number }[]
  lastCycle: string; lastMessage: string
}
export const newAutoAccount = (): AutoAccount => ({
  enabled: false, cash: AUTO_INITIAL, positions: [], pending: [], fills: [],
  equityHistory: [], lastCycle: '', lastMessage: '자동 가상매매는 기본적으로 꺼져 있습니다.',
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
  if (!account.enabled) return account
  const checked = new Date(checkedAt)
  if (!Number.isFinite(checked.getTime()) || Math.abs(now.getTime() - checked.getTime()) > 5 * 60000) {
    return { ...account, lastMessage: '5분 이내 수집한 시세만 가상 체결에 사용합니다. 시장 데이터를 다시 수집해 주세요.' }
  }
  if (!inSession(now)) return { ...account, lastMessage: '국내 주식 정규장 시간(평일 09:00~15:30 KST)에만 가상 체결합니다.' }
  if (account.lastCycle === checkedAt) return account
  const quoteMap = new Map(quotes.filter(q => positive(q.price) && !q.quoteError).map(q => [q.code, q.price as number]))
  let cash = account.cash
  let positions = account.positions.map(p => ({ ...p }))
  let pending = account.pending.map(p => ({ ...p }))
  const fills = [...account.fills]
  const currentDate = kstDate(now)
  const alreadyTradedToday = new Set(fills.filter(f => kstDate(new Date(f.at)) === currentDate).map(f => f.code))
  let executed = 0
  const dayRealized = fills.filter(f => f.side === 'SELL' && kstDate(new Date(f.at)) === currentDate)
    .reduce((sum, f) => sum + (f.pnl || 0), 0)
  let sessionPnl = dayRealized
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
    sessionPnl += pnl
    fills.unshift({ id: now.toISOString() + '-sell-' + p.code, at: now.toISOString(), code: p.code, name: p.name, side: 'SELL',
      quantity: p.quantity, price: sellPrice, costs, pnl, reason })
    alreadyTradedToday.add(p.code)
    executed++
    return false
  })
  // Discard pending signals whose conditions disappeared, then update watch targets.
  const valid = new Map(signals.filter(s => s.status === '관찰 후보' && s.flowReliable && positive(s.entryTrigger) && positive(s.stopReference)).map(s => [s.code, s]))
  pending = pending.filter(p => valid.has(p.code) && !positions.some(position => position.code === p.code))
  for (const signal of signals) {
    if (!valid.has(signal.code) || positions.some(p => p.code === signal.code) || pending.some(p => p.code === signal.code) || alreadyTradedToday.has(signal.code)) continue
    pending.push({ code: signal.code, name: signal.name, trigger: signal.entryTrigger!, stop: signal.stopReference!, createdAt: now.toISOString() })
  }
  // Require a *later* quote to cross the watch trigger. Never fill using the creating snapshot.
  for (const item of [...pending]) {
    if (positions.length >= MAX_POSITIONS || sessionPnl <= -MAX_DAILY_LOSS) break
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
    positions.push({ code: item.code, name: item.name, quantity, entry: fillPrice, last: mark,
      stop: Math.min(item.stop, won(fillPrice * 0.97)), target: won(fillPrice * 1.06), openedAt: now.toISOString(), buyCost: fee })
    fills.unshift({ id: now.toISOString() + '-buy-' + item.code, at: now.toISOString(), code: item.code, name: item.name,
      side: 'BUY', quantity, price: fillPrice, costs: fee, pnl: null, reason: '다음 시세에서 진입 참고값 돌파' })
    pending = pending.filter(p => p.code !== item.code)
    alreadyTradedToday.add(item.code)
    executed++
  }
  const equity = cash + positions.reduce((sum, p) => sum + p.last * p.quantity, 0)
  return { ...account, cash, positions, pending, fills: fills.slice(0, 1000),
    equityHistory: [...account.equityHistory, { at: checkedAt, value: equity }].slice(-1000), lastCycle: checkedAt,
    lastMessage: executed ? '이번 수집 시세로 가상 체결 ' + executed + '건 처리' : '가상 체결 0건 · 신호/시세/리스크 조건 확인 완료' }
}
export function readAutoAccount(): AutoAccount {
  try {
    const saved = JSON.parse(localStorage.getItem(AUTO_STORAGE_KEY) || 'null') as AutoAccount | null
    if (saved && Number.isFinite(saved.cash) && saved.cash >= 0 && Array.isArray(saved.positions) && Array.isArray(saved.pending) && Array.isArray(saved.fills) && Array.isArray(saved.equityHistory)) return { ...newAutoAccount(), ...saved }
  } catch { /* ignore invalid local data */ }
  return newAutoAccount()
}
