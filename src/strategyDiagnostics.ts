import type { TradeSignal } from './tradeSignals'
import type { AutoAccount } from './autoPaper'
import type { PaperLedger } from './paperLedger'

export type ScreeningDiagnostic = {
  key: string; label: string; count: number; description: string
}
export type ScreeningReport = {
  inspected: number; candidates: number; insufficient: number; risky: number
  nearMisses: number; meanScore: number | null; breakdown: ScreeningDiagnostic[]
  sampleSize: number
}

// Counts may overlap: one stock can fail several independent safety checks.
export function analyzeSignals(signals: TradeSignal[]): ScreeningReport {
  const inspected = signals.length
  const criteria = [
    { key: 'data', label: '필수 시세·수급 데이터 부족', description: '현시세, 수급 기록 또는 거래량 등 필수 정보가 없음', test: (s: TradeSignal) => s.status === '데이터 부족' },
    { key: 'flow', label: '외국인 수급 검증 실패', description: '중복·반복 관측치 등으로 수급 점수 적용 불가', test: (s: TradeSignal) => !s.flowReliable },
    { key: 'volume', label: '거래량 비교 불가', description: '장중 누적 거래량과 전일 종일 거래량을 비교하지 않음', test: (s: TradeSignal) => s.volumeRatio === null },
    { key: 'fall', label: '당일 3% 이상 하락', description: '급락 시 반등 여부 확인 필요', test: (s: TradeSignal) => s.reasons.some(r => r.includes('당일 낙폭 3% 이상')) },
    { key: 'rise', label: '당일 급등', description: '추격 진입 위험', test: (s: TradeSignal) => s.reasons.some(r => r.includes('당일 급등')) },
    { key: 'score', label: '매수 점수 3점 미만', description: '현재 점수 기준에 미달', test: (s: TradeSignal) => s.score < 3 },
    { key: 'size', label: '종목당 20만원 한도 미달', description: '진입 후보여도 1주 매수 금액이 부족함', test: (s: TradeSignal) => s.entryTrigger !== null && s.maxQuantity < 1 },
  ]
  return {
    inspected,
    candidates: signals.filter(s => s.status === '관찰 후보' && s.maxQuantity > 0).length,
    insufficient: signals.filter(s => s.status === '데이터 부족').length,
    risky: signals.filter(s => s.status === '위험 주의').length,
    nearMisses: signals.filter(s => s.score >= 2 && s.status !== '관찰 후보').length,
    meanScore: inspected ? signals.reduce((sum, s) => sum + s.score, 0) / inspected : null,
    breakdown: criteria.map(rule => ({ key: rule.key, label: rule.label,
      count: signals.filter(rule.test).length, description: rule.description })),
    sampleSize: inspected,
  }
}

export type PerformanceReport = {
  closed: number; profitable: number; losing: number; winRate: number | null
  netPnl: number; averagePnl: number | null; profitFactor: number | null
  expectancyPct: number | null; maxDrawdown: number | null
  totalEquity: number; returnPct: number; observations: number
}
export function analyzePerformance(account: AutoAccount, ledger: PaperLedger): PerformanceReport {
  const completed = (account.fills || []).filter(f => f.side === 'SELL' && f.pnl !== null && Number.isFinite(f.pnl))
  const profit = completed.filter(f => (f.pnl || 0) > 0).reduce((sum, f) => sum + (f.pnl || 0), 0)
  const loss = completed.filter(f => (f.pnl || 0) < 0).reduce((sum, f) => sum + Math.abs(f.pnl || 0), 0)
  const netPnl = completed.reduce((sum, f) => sum + (f.pnl || 0), 0)
  const totalEquity = ledger.cash + ledger.positions.reduce((sum, p) => sum + p.lastPrice * p.quantity, 0)
  const points = (account.equityHistory || []).filter(p => Number.isFinite(p.value) && p.value >= 0)
  let peak = 1_000_000
  let maxDrawdown = 0
  for (const point of points) {
    peak = Math.max(peak, point.value)
    maxDrawdown = Math.max(maxDrawdown, peak > 0 ? (peak - point.value) / peak * 100 : 0)
  }
  return {
    closed: completed.length, profitable: completed.filter(f => (f.pnl || 0) > 0).length,
    losing: completed.filter(f => (f.pnl || 0) <= 0).length,
    winRate: completed.length ? completed.filter(f => (f.pnl || 0) > 0).length / completed.length * 100 : null,
    netPnl, averagePnl: completed.length ? netPnl / completed.length : null,
    profitFactor: completed.length && loss > 0 ? profit / loss : null,
    expectancyPct: null, // Requires entry trade matching and capital-weighted returns.
    maxDrawdown: points.length ? maxDrawdown : null,
    totalEquity, returnPct: (totalEquity / 1_000_000 - 1) * 100,
    observations: points.length,
  }
}
