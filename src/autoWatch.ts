import type { AutoAccount } from './autoPaper'

export const FAST_QUOTE_INTERVAL_MS = 60_000
export const FAST_QUOTE_MAX_CODES = 5
export type WatchStock = { code: string; name: string; priority: '보유' | '진입 감시' }

/** Price-only checks never scan the full universe or request investor-flow data. */
export function selectAutoWatchStocks(account: Pick<AutoAccount, 'positions' | 'pending'>): WatchStock[] {
  const result: WatchStock[] = []
  const seen = new Set<string>()
  for (const item of account.positions) {
    if (!/^\d{6}$/.test(item.code) || seen.has(item.code)) continue
    result.push({ code: item.code, name: item.name, priority: '보유' })
    seen.add(item.code)
  }
  for (const item of account.pending) {
    if (!/^\d{6}$/.test(item.code) || seen.has(item.code)) continue
    result.push({ code: item.code, name: item.name, priority: '진입 감시' })
    seen.add(item.code)
  }
  return result.slice(0, FAST_QUOTE_MAX_CODES)
}
