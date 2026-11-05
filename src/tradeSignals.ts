export type SignalInput = {
  code: string
  name: string
  price: number | null
  changeRate: number | string | null
  volume: number | string | null
  previousVolume?: number | null
  openPrice?: number | null
  highPrice?: number | null
  lowPrice?: number | null
  averagePrice?: number | null
  tradeValue?: number | string | null
  investorAccumulated?: boolean
  investorUnit?: string
  investor: Record<string, unknown> | null
  quoteError?: string
  investorError?: string
}

export type TradeSignal = {
  code: string
  name: string
  status: '관찰 후보' | '조건 미충족' | '위험 주의' | '데이터 부족'
  score: number
  price: number | null
  volumeRatio: number | null
  volumePaceEstimate: number | null
  foreignToday: number | null
  foreignPositiveDays: number
  flowReliable: boolean
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

export function generateTradeSignals(stocks: SignalInput[], maxPositionWon = 200000, now = new Date()): TradeSignal[] {
  const kst = new Date(now.getTime() + 9 * 60 * 60 * 1000)
  const minutes = kst.getUTCHours() * 60 + kst.getUTCMinutes()
  const dateKst = kst.toISOString().slice(0, 10).replace(/-/g, '')
  const isRegularSession = kst.getUTCDay() >= 1 && kst.getUTCDay() <= 5 && minutes >= 540 && minutes < 930
  const isAfterClose = minutes >= 930
  return stocks.map(stock => {
    const price = numeric(stock.price)
    const rate = numeric(stock.changeRate)
    const volume = numeric(stock.volume)
    const open = numeric(stock.openPrice)
    const high = numeric(stock.highPrice)
    const low = numeric(stock.lowPrice)
    const vwap = numeric(stock.averagePrice)
    const previousVolume = numeric(stock.previousVolume)
    const tradeValue = numeric(stock.tradeValue)
    const volumeRatio = isAfterClose && previousVolume !== null && previousVolume > 0 && volume !== null
      ? volume / previousVolume : null
    // Estimated daily run rate, for display only; volume is not linear throughout a trading day.
    const volumePaceEstimate = isRegularSession && minutes >= 570 && previousVolume !== null
      && previousVolume > 0 && volume !== null
      ? volume / previousVolume * 390 / Math.max(minutes - 540, 30) : null
    const raw = (stock.investor as { out?: unknown } | null)?.out
    const rows: Record<string, unknown>[] = Array.isArray(raw)
      ? raw.filter((item): item is Record<string, unknown> => item !== null && typeof item === 'object')
        .filter(item => /^\d{8}$/.test(String(item.dt || '')))
        .slice(0, 5)
      : []
    const dates = rows.map(row => String(row.dt))
    const flows = rows.map(row => numeric(row.fgnr))
    const foreignToday = flows[0] ?? null
    const foreignPositiveDays = flows.filter(value => value !== null && value > 0).length
    // IVU10430 must be requested with acml_clsf=0 (daily) and amt_q_clsf=2 (shares).
    const uniqueDays = new Set(dates).size === dates.length
    const descending = dates.every((date, index) => index === 0 || dates[index - 1] > date)
    const suspiciousRepeat = flows.some((value, index) => index > 0 && value !== null && value === flows[index - 1])
    const flowReliable = stock.investorAccumulated === false && stock.investorUnit === 'shares'
      && !stock.investorError && rows.length >= 3 && uniqueDays && descending
      && dates[0] <= dateKst && flows.every(value => value !== null) && !suspiciousRepeat

    const reasons: string[] = []
    let score = 0
    const complete = price !== null && price > 0 && rate !== null && volume !== null
      && open !== null && open > 0 && high !== null && low !== null
      && high >= low && high >= price && low <= price
      && vwap !== null && vwap > 0 && tradeValue !== null && tradeValue > 0
    if (!complete || stock.quoteError) {
      reasons.push('가격·장중 범위·평균체결가·거래대금 일부 누락: 매매 판단 보류')
    } else {
      if (rate <= -3) { score -= 3; reasons.push('당일 낙폭 3% 이상: 반등 확인 필요') }
      else if (rate >= 7) { score -= 3; reasons.push('당일 급등: 추격 진입 위험') }
      else if (rate >= 0.7 && rate <= 4.5) { score += 1; reasons.push('전일 종가 대비 완만한 상승(+0.7~4.5%)') }
      else reasons.push('당일 등락률 상승 조건 미달')

      if (price >= open * 1.003) { score += 1; reasons.push('현재가가 시가 대비 0.3% 이상 높음') }
      else reasons.push('시가 대비 상승 확인되지 않음')
      if (price >= vwap * 1.002) { score += 1; reasons.push('현재가가 당일 평균 체결가를 0.2% 이상 상회') }
      else reasons.push('평균 체결가 대비 우위 미확인')
      if (high > low && (price - low) / (high - low) >= 0.70) {
        score += 1; reasons.push('현재가가 당일 가격 범위의 상위 30%에 위치')
      } else reasons.push('당일 가격 범위 상단 유지 미확인')
      if (tradeValue >= 3_000_000_000 && volume >= 20_000) {
        score += 1; reasons.push('거래대금 추정 30억원 이상 · 누적 거래량 2만주 이상')
      } else reasons.push('거래 유동성 조건 미달')

      if (volumePaceEstimate !== null) reasons.push('장중 거래량 속도 추정 ' + volumePaceEstimate.toFixed(2) + '배 (참고값, 점수 미반영)')
      else if (volumeRatio !== null) reasons.push('전일 대비 거래량 ' + volumeRatio.toFixed(2) + '배 (점수 미반영)')
      else reasons.push('같은 시간대 과거 거래량 부재: 거래량 비교 점수 미반영')
      if (!flowReliable) reasons.push('투자자 수급: 일별·비누적 응답 검증 미완료, 수급 점수 제외')
      else if (foreignToday !== null && foreignToday > 0 && foreignPositiveDays >= 3) {
        score += 1; reasons.push('일별 외국인 순매수 5일 중 3일 이상')
      } else if (foreignToday !== null && foreignToday < 0) reasons.push('외국인 순매도: 추가 관찰 필요')
    }

    // 4 independent price/liquidity checks are required. Flow is optional and never
    // compensates for missing quote fields or an excessive one-day price move.
    const unsafeMove = rate !== null && (rate <= -3 || rate >= 7)
    const priceChecks = complete && rate! >= 0.7 && rate! <= 4.5
      && price! >= open! * 1.003 && price! >= vwap! * 1.002
      && high! > low! && (price! - low!) / (high! - low!) >= 0.70
      && tradeValue! >= 3_000_000_000 && volume! >= 20_000
    const status: TradeSignal['status'] = !complete || stock.quoteError ? '데이터 부족'
      : unsafeMove ? '위험 주의' : priceChecks && score >= 5 ? '관찰 후보' : '조건 미충족'
    const entryTrigger = status === '관찰 후보' && price !== null ? Math.ceil(price * 1.005) : null
    const stopReference = entryTrigger !== null ? Math.floor(entryTrigger * 0.97) : null
    const maxQuantity = entryTrigger !== null ? Math.floor(maxPositionWon / entryTrigger) : 0
    if (entryTrigger !== null) reasons.push('진입 +0.5% / 손절 -3%는 가상 참고값 (호가단위·체결불확실성 주의)')
    if (entryTrigger !== null && maxQuantity === 0) reasons.push('종목당 20만원 한도에서 1주 매수 불가')
    return { code: stock.code, name: stock.name, status, score, price, volumeRatio, volumePaceEstimate,
      foreignToday, foreignPositiveDays, flowReliable, entryTrigger, stopReference, maxQuantity, reasons }
  }).sort((a, b) => b.score - a.score).slice(0, 10)
}
