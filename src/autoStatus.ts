import type { AutoAccount } from './autoPaper'

export type AutoHealth = {
  tone: 'ok' | 'working' | 'idle' | 'warning' | 'off'
  label: string
  detail: string
  inSession: boolean
}

const kst = (date: Date) => new Date(date.getTime() + 9 * 60 * 60 * 1000)
export const kstDay = (date: Date) => kst(date).toISOString().slice(0, 10)

export function getAutoHealth(account: Pick<AutoAccount, 'enabled' | 'runs'>, now: Date, loading: boolean, scanMessage: string): AutoHealth {
  const local = kst(now)
  const weekday = local.getUTCDay()
  const minute = local.getUTCHours() * 60 + local.getUTCMinutes()
  const inSession = weekday >= 1 && weekday <= 5 && minute >= 540 && minute < 930
  if (!account.enabled) return { tone: 'off', label: '자동매매 중지', detail: '자동 검사가 중지되어 있습니다.', inSession }
  if (!inSession) {
    const label = weekday === 0 || weekday === 6 ? '주말 대기' : minute < 540 ? '개장 전 대기' : '장 마감'
    return { tone: 'idle', label, detail: '정규장 시간에만 가상 체결을 평가합니다. (공휴일 여부는 별도 확인하지 않음)', inSession }
  }
  if (loading) return { tone: 'working', label: '시세 수집 중', detail: '시장 후보와 KB 시세를 조회하고 있습니다.', inSession }
  if (/실패|오류/.test(scanMessage)) return { tone: 'warning', label: '시장 조회 오류', detail: scanMessage, inSession }

  const last = (account.runs || [])[0]
  if (!last) return { tone: 'working', label: '첫 검사 대기', detail: '검사 시작 후 결과가 기록되면 상태가 바뀝니다.', inSession }

  const lastAt = Date.parse(last.processedAt)
  const elapsed = now.getTime() - lastAt
  if (!Number.isFinite(lastAt) || elapsed < -60_000 || elapsed > 12 * 60_000) {
    return { tone: 'warning', label: '검사 지연', detail: '최근 검사 이후 12분 이상 새 결과가 없습니다. 브라우저와 API 연결을 확인하세요.', inSession }
  }
  if (last.status === '실행 보류') return { tone: 'warning', label: '매매 판단 보류', detail: last.message, inSession }
  return { tone: 'ok', label: '정상 검사 중', detail: '최근 전략 평가가 정상 완료됐습니다. 가상 체결은 진입 조건 충족 시에만 발생합니다.', inSession }
}

export function todayActivity(account: Pick<AutoAccount, 'runs' | 'fills' | 'dailyStats'>, now: Date) {
  const day = kstDay(now)
  if (account.dailyStats?.date === day) {
    return {
      checked: account.dailyStats.checked,
      completed: account.dailyStats.completed,
      deferred: account.dailyStats.deferred,
      filled: account.dailyStats.filled,
      partialHistory: false,
    }
  }
  const records = (account.runs || []).filter(item => Number.isFinite(Date.parse(item.processedAt))
    && kstDay(new Date(item.processedAt)) === day)
  return {
    checked: records.length,
    completed: records.filter(item => item.status === '검사 완료').length,
    deferred: records.filter(item => item.status === '실행 보류').length,
    filled: records.reduce((sum, item) => sum + item.filled, 0),
    partialHistory: true, // Older accounts only retain the most recent 30 runs.
  }
}
