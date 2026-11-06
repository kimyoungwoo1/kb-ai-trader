import type { TradeSignal } from './tradeSignals'
import type { AutoRun, AutoRunDecision } from './autoPaper'
import { analyzeSignals, type ScreeningReport } from './strategyDiagnostics'

export const SCREENING_HISTORY_KEY = 'kb-ai-trader-latest-screening-v1'
export type ScreeningSnapshot = {
  checkedAt: string
  signals: TradeSignal[]
}

export function writeScreeningSnapshot(value: ScreeningSnapshot): void {
  // Historical inspection only. Never use this persisted data to enter trades.
  try {
    localStorage.setItem(SCREENING_HISTORY_KEY, JSON.stringify({
      checkedAt: value.checkedAt, signals: value.signals.slice(0, 50),
    }))
  } catch { /* storage quotas or browser privacy restrictions */ }
}

export function readScreeningSnapshot(): ScreeningSnapshot | null {
  try {
    const raw = localStorage.getItem(SCREENING_HISTORY_KEY)
    if (!raw) return null
    const saved = JSON.parse(raw) as ScreeningSnapshot
    if (!saved || !Number.isFinite(Date.parse(saved.checkedAt))
      || !Array.isArray(saved.signals) || saved.signals.length === 0
      || saved.signals.length > 50) return null
    const acceptable = saved.signals.every(signal => signal
      && /^\d{6}$/.test(signal.code) && typeof signal.name === 'string'
      && typeof signal.status === 'string' && typeof signal.score === 'number'
      && Array.isArray(signal.reasons))
    return acceptable ? saved : null
  } catch {
    return null
  }
}

export type ScreeningView = {
  report: ScreeningReport | null
  source: 'live' | 'snapshot' | 'run' | 'none'
  checkedAt: string | null
  note: string
  breakdownAvailable: boolean
}

/**
 * Reconstruct only the metrics provably present in older stored run decisions.
 * We cannot recover original investor-flow / volume fields from reasons alone,
 * so per-rule breakdown is deliberately unavailable for legacy runs.
 */
export function summarizeRunDecisions(run: AutoRun): ScreeningReport {
  const items: AutoRunDecision[] = Array.isArray(run.decisions) ? run.decisions : []
  return {
    inspected: run.scanned,
    candidates: run.candidates,
    insufficient: items.filter(item => item.status === '데이터 부족').length,
    risky: items.filter(item => item.status === '위험 주의').length,
    nearMisses: items.filter(item => typeof item.score === 'number'
      && item.score >= 4 && item.status !== '관찰 후보').length,
    meanScore: items.length > 0 && items.every(item => typeof item.score === 'number')
      ? items.reduce((sum, item) => sum + (item.score ?? 0), 0) / items.length : null,
    breakdown: [],
    sampleSize: items.length,
  }
}
export function selectScreeningView(
  liveSignals: TradeSignal[],
  stored: ScreeningSnapshot | null,
  runs: AutoRun[],
  liveCheckedAt: string | null = null,
): ScreeningView {
  if (liveSignals.length && liveCheckedAt && Number.isFinite(Date.parse(liveCheckedAt))) {
    return { report: analyzeSignals(liveSignals), source: 'live', checkedAt: liveCheckedAt,
      note: '현재 열린 화면에서 수집한 최신 정밀 분석 결과입니다.', breakdownAvailable: true }
  }
  const saved = stored && stored.signals.length ? stored : null
  const run = (runs || []).find(item => item.scanned > 0 && Number.isFinite(Date.parse(item.processedAt)))
  // Choose the newest available research evidence. Explicitly label stale data.
  if (saved && (!run || Date.parse(saved.checkedAt) >= Date.parse(run.checkedAt))) {
    return { report: analyzeSignals(saved.signals), source: 'snapshot',
      checkedAt: saved.checkedAt,
      note: '브라우저에 저장된 마지막 종목 분석입니다. 현재 실시간 조회 결과가 아닙니다.',
      breakdownAvailable: true }
  }
  if (run) {
    return { report: summarizeRunDecisions(run), source: 'run',
      checkedAt: run.processedAt,
      note: '이전 자동매매 검사 기록에서 복원했습니다. 과거 기록에는 일부 세부 지표가 없어 제외 원인별 막대그래프는 제공하지 않습니다.',
      breakdownAvailable: false }
  }
  if (saved) {
    return { report: analyzeSignals(saved.signals), source: 'snapshot',
      checkedAt: saved.checkedAt,
      note: '브라우저에 저장된 마지막 종목 분석입니다. 현재 실시간 조회 결과가 아닙니다.',
      breakdownAvailable: true }
  }
  return { report: null, source: 'none', checkedAt: null,
    note: '사용 가능한 종목 정밀 분석 기록이 없습니다. 장중 시장 검사가 완료된 뒤 표시됩니다.',
    breakdownAvailable: false }
}
