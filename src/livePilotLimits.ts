export const LIVE_BUY_LIMIT_WON = 50_000
export const LIVE_BUY_CONFIRMATION = '5만원 실주문 시작'
export const liveBuyRequiredCash = (price: number) => price + Math.ceil(price / 100)
