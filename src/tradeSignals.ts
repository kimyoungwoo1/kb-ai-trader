export type SignalInput = {
  code: string
  name: string
  price: number | null
  changeRate: number | string | null
  volume: number | string | null
  investor: Record<string, unknown> | null
  quoteError?: string
  investorError?: string
}

export type TradeSignal = {
  code: string
  name: string
  status: '관찰 후보' | '위험 주의' | '데이터 부족'
  score: number
  price: number | null
  volumeRatio: number | null
  foreignToday: number | null
  foreignPositiveDays: number
  entryTrigger: number | null
  stopReference: number | null
  maxQuantity: number
  reasons: string[]
}

const numeric = (value: unknown): number | null => {
  if (value === null || value === undefined || String(value).trim() === '') return null
  const result = Number(String(value).replace(/,/g, '').trim())
  return Number.isFinite(result) ? result : null
}

// This is a research signal, not a trading order. Investor data can be delayed or duplicated.
export function generateTradeSignals(stocks: SignalInput[], maxPositionWon = 200000): TradeSignal[] {
  return stocks.map(stock => {
    const price = numeric(stock.price)
    const rate = numeric(stock.changeRate)
    const volume = numeric(stock.volume)
    const raw = (stock.investor as { out?: unknown } | null)?.out
    const rows: Record<string, unknown>[] = Array.isArray(raw)
      ? raw.filter((item): item is Record<string, unknown> => item !== null && typeof item === 'object')
          .filter(item => /^\d{8}$/.test(String(item.dt || '')))
          .slice(0, 5)
      : []
    const previousVolume = rows.length > 1 ? numeric(rows[1].vlm) : null
    const volumeRatio = volume !== null && previousVolume !== null && previousVolume > 0
      ? volume / previousVolume : null
    const flows = rows.map(row => numeric(row.fgnr))
    const foreignToday = flows[0] ?? null
    const foreignPositiveDays = flows.filter(value => value !== null && value > 0).length
    const repeatedFlow = rows.length > 1 && flows[0] !== null && flows[0] === flows[1]
    const reasons: string[] = []
    let score = 0
    const complete = price !== null && price > 0 && rate !== null && volume !== null && rows.length >= 2 && foreignToday !== null
    if (!complete || stock.quoteError || stock.investorError) {
      reasons.push('시세·전일 거래량·투자자 데이터 일부 누락: 매매 판단 보류')
    } else {
      if (rate > 0 && rate <= 4) { score += 2; reasons.push('상승세 유지(당일 0~4% 구간)') }
      else if (rate <= -3) { score -= 2; reasons.push('당일 낙폭 3% 이상: 반등 확인 필요') }
      else if (rate > 7) { score -= 2; reasons.push('당일 급등: 추격 진입 위험') }
      else reasons.push('가격 방향성 추가 확인 필요')
      if (volumeRatio !== null) {
        if (volumeRatio >= 1.3 && volumeRatio <= 3) { score += 1; reasons.push('거래량 전일 대비 증가') }
        else if (volumeRatio > 3) reasons.push('거래량 급증: 이상 거래 여부 확인')
        else reasons.push('거래량 증가 확인되지 않음')
      }
      if (repeatedFlow) {
        reasons.push('투자자 수급 값이 서로 다른 날짜에 동일: API 검증 전 점수 미반영')
      } else {
        if (foreignToday > 0 && foreignPositiveDays >= 3) { score += 2; reasons.push('최근 관측일 중 외국인 순매수 우세') }
        if (foreignToday < 0 && foreignPositiveDays === 0) { score -= 1; reasons.push('외국인 수급 약세') }
      }
    }
    const status: TradeSignal['status'] = !complete || stock.quoteError || stock.investorError
      ? '데이터 부족' : score <= -1 ? '위험 주의' : '관찰 후보'
    const entryTrigger = status === '관찰 후보' && price !== null ? Math.ceil(price * 1.01) : null
    const stopReference = entryTrigger !== null ? Math.floor(entryTrigger * 0.97) : null
    const maxQuantity = entryTrigger !== null ? Math.floor(maxPositionWon / entryTrigger) : 0
    if (entryTrigger !== null) reasons.push('기준가 +1% 재확인 전에는 진입하지 않음; 손절 참고 -3% (호가단위 미반영)')
    if (entryTrigger !== null && maxQuantity === 0) reasons.push('종목당 20만원 한도에서 1주 매수 불가')
    return {
      code: stock.code, name: stock.name, status, score, price, volumeRatio,
      foreignToday, foreignPositiveDays, entryTrigger, stopReference, maxQuantity, reasons,
    }
  }).sort((a, b) => b.score - a.score).slice(0, 10)
}
