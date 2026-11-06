import { freshLedger, type PaperLedger } from './paperLedger'
import { newAutoAccount, runAutoCycle, type AutoAccount } from './autoPaper'
import type { TradeSignal } from './tradeSignals'

export type EngineScenario = {
  name: string
  passed: boolean
  steps: string[]
  buyPrice: number | null
  exitPrice: number | null
  quantity: number
  realizedPnl: number | null
  message: string
}
export type EngineCheckReport = {
  passed: boolean
  scenarios: EngineScenario[]
  checkedAt: string
  isolated: true
}

const code = '999999' // Synthetic identifier, never submitted to a brokerage API.
const name = '체결 테스트 전용 종목'
const signal: TradeSignal = {
  code, name, status: '관찰 후보', score: 5, price: 9900,
  volumeRatio: null, volumePaceEstimate: null,
  foreignToday: null, foreignPositiveDays: 0,
  flowReliable: false, // Foreign-flow score is optional for this price-qualified entry.
  entryTrigger: 10000, stopReference: 9700, maxQuantity: 20, reasons: [],
}

function checkScenario(name: string, exitQuote: number, expectedReason: string): EngineScenario {
  let ledger: PaperLedger = freshLedger()
  const original = JSON.stringify(ledger)
  const store = {
    read: () => ledger,
    write: (next: PaperLedger) => { ledger = next },
  }
  let account: AutoAccount = { ...newAutoAccount(), enabled: true }
  const base = Date.parse('2026-11-06T01:00:00.000Z') // Friday 10:00 KST
  const execute = (minute: number, quote: number) => {
    const now = new Date(base + minute * 60000)
    account = runAutoCycle(account, [signal], [{ code, name, price: quote }], now.toISOString(), now, store)
  }

  try {
    execute(0, 9900) // First quote establishes a pending entry; not a fill.
    const queued = account.pending.length === 1 && ledger.trades.length === 0
    execute(1, 10050) // A later, fresh quote crosses the 10,000-won entry.
    const buy = ledger.trades.find(item => item.side === 'BUY' && item.source === 'auto')
    const bought = !!buy && buy.quantity > 0 && ledger.positions.length === 1
      && account.positions.length === 1 && ledger.cash < 1_000_000
    execute(2, exitQuote) // Third quote triggers take-profit or stop-loss.
    const sell = ledger.trades.find(item => item.side === 'SELL' && item.source === 'auto')
    const exited = !!sell && sell.reason === expectedReason
      && ledger.positions.length === 0 && account.positions.length === 0
      && ledger.trades.length === 2 && account.fills.length === 2
      && ledger.cash > 0
    const passed = queued && bought && exited && original === JSON.stringify(freshLedger())
    return {
      name, passed, steps: [
        queued ? '감시 대상 등록 성공' : '감시 등록 실패',
        bought ? '실제 엔진의 가상매수·현금 차감 성공' : '매수 또는 현금 차감 실패',
        exited ? '가상매도·잔액 정산 성공' : '매도 또는 정산 실패',
      ],
      buyPrice: buy?.price ?? null, exitPrice: sell?.price ?? null,
      quantity: buy?.quantity ?? 0, realizedPnl: sell?.realizedPnl ?? null,
      message: passed ? '별도 메모리 원장에서 실제 전략 함수의 매수·매도가 검증되었습니다.' : '체결 경로 검증 실패',
    }
  } catch (error) {
    return {
      name, passed: false, steps: [], buyPrice: null, exitPrice: null,
      quantity: 0, realizedPnl: null,
      message: error instanceof Error ? error.message : '예상하지 못한 오류',
    }
  }
}

export function runPaperEngineCheck(): EngineCheckReport {
  const scenarios = [
    checkScenario('가상매수 → 익절 매도', 10800, '익절 참고값 도달'),
    checkScenario('가상매수 → 손절 매도', 9500, '손절 참고값 도달'),
  ]
  return { passed: scenarios.every(item => item.passed), scenarios, checkedAt: new Date().toISOString(), isolated: true }
}
