const kst = (date: Date) => new Date(date.getTime() + 9 * 3_600_000)

export const kstTradingDay = (date = new Date()) => kst(date).toISOString().slice(0, 10)

// Weekday regular session. This clock does not model exchange holidays.
export function isKrxRegularSession(date = new Date()): boolean {
  const local = kst(date)
  const weekday = local.getUTCDay()
  const minutes = local.getUTCHours() * 60 + local.getUTCMinutes()
  return weekday >= 1 && weekday <= 5 && minutes >= 540 && minutes < 930
}
