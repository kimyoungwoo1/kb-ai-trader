export const LIVE_BUY_LIMIT_WON = 50_000
export const LIVE_BUY_CONFIRMATION = '5만원 실주문 시작'
export const liveBuyRequiredCash = (price: number) => price + Math.ceil(price / 100)

// Ordinary KRX equity grid. Use this conservative grid when product metadata is unavailable.
export function liveOrderTick(price: number): number {
  if (price < 2_000) return 1
  if (price < 5_000) return 5
  if (price < 20_000) return 10
  if (price < 50_000) return 50
  if (price < 200_000) return 100
  if (price < 500_000) return 500
  return 1_000
}

export const isLiveOrderTick = (price: number) => price % liveOrderTick(price) === 0
