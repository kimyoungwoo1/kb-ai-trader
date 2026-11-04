import { useMemo, useState } from 'react'

type Position = { code: string; name: string; quantity: number; averagePrice: number; lastPrice: number }
type Trade = { id: string; time: string; side: 'BUY' | 'SELL'; code: string; name: string; quantity: number; price: number; amount: number }
type PaperState = { cash: number; positions: Position[]; trades: Trade[] }
const INITIAL_CASH = 1_000_000
const STORAGE_KEY = 'kb-ai-trader-paper-v1'
const emptyState: PaperState = { cash: INITIAL_CASH, positions: [], trades: [] }
const won = (value: number) => Math.round(value).toLocaleString('ko-KR') + '원'

function readState(): PaperState {
  try {
    const parsed = JSON.parse(localStorage.getItem(STORAGE_KEY) || 'null') as PaperState | null
    if (parsed && Number.isFinite(parsed.cash) && Array.isArray(parsed.positions) && Array.isArray(parsed.trades)) return parsed
  } catch { /* use fresh account */ }
  return emptyState
}

export default function PaperTrading() {
  const [account, setAccount] = useState<PaperState>(readState)
  const [name, setName] = useState('')
  const [code, setCode] = useState('')
  const [price, setPrice] = useState('')
  const [quantity, setQuantity] = useState('1')
  const [side, setSide] = useState<'BUY' | 'SELL'>('BUY')
  const [notice, setNotice] = useState('가상 계좌가 준비되었습니다. 실제 시세 API 연결 전까지 기준 가격은 직접 입력해야 합니다.')
  const [confirmReset, setConfirmReset] = useState(false)

  const valuation = useMemo(() => account.positions.reduce((sum, p) => sum + p.quantity * p.lastPrice, 0), [account.positions])
  const invested = useMemo(() => account.positions.reduce((sum, p) => sum + p.quantity * p.averagePrice, 0), [account.positions])
  const total = account.cash + valuation
  const pnl = valuation - invested
  const persist = (next: PaperState) => { setAccount(next); localStorage.setItem(STORAGE_KEY, JSON.stringify(next)) }

  function executeTrade(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const cleanCode = code.trim()
    const cleanName = name.trim()
    const tradePrice = Number(price)
    const tradeQty = Math.floor(Number(quantity))
    if (!/^\\d{6}$/.test(cleanCode) || !cleanName || !Number.isFinite(tradePrice) || tradePrice <= 0 || !Number.isInteger(tradeQty) || tradeQty <= 0) {
      setNotice('종목명, 6자리 종목코드, 양수 가격과 수량을 정확히 입력해 주세요.')
      return
    }
    const existing = account.positions.find(p => p.code === cleanCode)
    if (side === 'BUY') {
      const amount = tradePrice * tradeQty
      if (amount > account.cash) { setNotice('가상 예수금이 부족합니다. 주문 금액을 줄여주세요.'); return }
      const oldQty = existing?.quantity || 0
      const nextQty = oldQty + tradeQty
      const averagePrice = ((existing?.averagePrice || 0) * oldQty + amount) / nextQty
      const nextPosition: Position = { code: cleanCode, name: cleanName, quantity: nextQty, averagePrice, lastPrice: tradePrice }
      const positions = existing ? account.positions.map(p => p.code === cleanCode ? nextPosition : p) : [...account.positions, nextPosition]
      const trade: Trade = { id: crypto.randomUUID(), time: new Date().toISOString(), side, code: cleanCode, name: cleanName, quantity: tradeQty, price: tradePrice, amount }
      persist({ cash: account.cash - amount, positions, trades: [trade, ...account.trades] })
      setNotice(cleanName + ' ' + tradeQty + '주 가상 매수 체결 처리했습니다.')
    } else {
      if (!existing || existing.quantity < tradeQty) { setNotice('보유 수량이 부족합니다.'); return }
      const amount = tradePrice * tradeQty
      const positions = account.positions.map(p => p.code === cleanCode ? { ...p, quantity: p.quantity - tradeQty, lastPrice: tradePrice } : p).filter(p => p.quantity > 0)
      const trade: Trade = { id: crypto.randomUUID(), time: new Date().toISOString(), side, code: cleanCode, name: cleanName, quantity: tradeQty, price: tradePrice, amount }
      persist({ cash: account.cash + amount, positions, trades: [trade, ...account.trades] })
      setNotice(cleanName + ' ' + tradeQty + '주 가상 매도 체결 처리했습니다.')
    }
  }

  function updateMark(p: Position, value: string) {
    const nextPrice = Number(value)
    if (!Number.isFinite(nextPrice) || nextPrice <= 0) return
    persist({ ...account, positions: account.positions.map(item => item.code === p.code ? { ...item, lastPrice: nextPrice } : item) })
  }

  function reset() {
    persist(emptyState)
    setConfirmReset(false)
    setNotice('가상 계좌를 초기화했습니다. 초기 자금은 100만 원입니다.')
  }

  return <section className="paper-page">
    <div className="page-heading"><div><div className="eyebrow">PAPER TRADING · NO REAL ORDERS</div><h1>가상 트레이딩</h1><p>초기 자금 100만 원 · 브라우저 로컬 저장 · 실계좌와 완전 분리</p></div><button className="outline-button" onClick={() => setConfirmReset(true)}>계좌 초기화</button></div>
    <div className="paper-warning"><b>시세 연결 전 단계</b><span>현재 주문 체결가는 직접 입력한 기준 가격입니다. 실시간 시세·호가 기반 체결이나 AI 자동 주문은 아직 활성화되지 않았습니다. 수동 입력 가격을 실제 시장 가격으로 오인하지 않도록 구분합니다.</span></div>
    <div className="stats-grid">
      <article className="stat-card"><div className="stat-top">가상 총자산</div><div className="stat-value">{won(total)}</div><div className="stat-foot">가상 예수금 + 보유 평가금액</div></article>
      <article className="stat-card"><div className="stat-top">가상 예수금</div><div className="stat-value">{won(account.cash)}</div><div className="stat-foot">가상 주문에 사용할 수 있는 금액</div></article>
      <article className="stat-card"><div className="stat-top">보유 평가금액</div><div className="stat-value">{won(valuation)}</div><div className="stat-foot">마지막 입력 기준 가격</div></article>
      <article className="stat-card"><div className="stat-top">평가손익</div><div className={'stat-value ' + (pnl < 0 ? 'negative-value' : 'positive-value')}>{pnl > 0 ? '+' : ''}{won(pnl)}</div><div className="stat-foot">매입 평균가 대비 평가손익 · 비용 미반영</div></article>
    </div>
    <div className="paper-grid">
      <section className="panel"><div className="panel-heading"><div><h3>가상 주문</h3><span>MANUAL PAPER ORDER</span></div></div>
        <form className="paper-form" onSubmit={executeTrade}>
          <div className="paper-side"><button type="button" className={side === 'BUY' ? 'selected-buy' : ''} onClick={() => setSide('BUY')}>가상 매수</button><button type="button" className={side === 'SELL' ? 'selected-sell' : ''} onClick={() => setSide('SELL')}>가상 매도</button></div>
          <label>종목명<input value={name} onChange={e => setName(e.target.value)} placeholder="예: 삼성전자" /></label>
          <label>종목코드<input value={code} onChange={e => setCode(e.target.value)} inputMode="numeric" maxLength={6} placeholder="005930" /></label>
          <label>기준 가격 (원)<input value={price} onChange={e => setPrice(e.target.value)} type="number" min="1" step="1" placeholder="직접 입력" /></label>
          <label>수량 (주)<input value={quantity} onChange={e => setQuantity(e.target.value)} type="number" min="1" step="1" /></label>
          <div className="paper-order-total">주문 금액 <b>{won((Number(price) || 0) * (Number(quantity) || 0))}</b></div>
          <button className="paper-submit" type="submit">{side === 'BUY' ? '가상 매수 체결' : '가상 매도 체결'}</button>
          <p className="paper-notice">{notice}</p>
        </form>
      </section>
      <section className="panel"><div className="panel-heading"><div><h3>보유 종목</h3><span>VIRTUAL POSITIONS</span></div></div>
        {account.positions.length ? <div className="table-wrap"><table className="paper-table"><thead><tr><th>종목</th><th>수량</th><th>평균가</th><th>기준가 수정</th><th>평가손익</th></tr></thead><tbody>{account.positions.map(p => <tr key={p.code}><td>{p.name}<small>{p.code}</small></td><td>{p.quantity.toLocaleString()}주</td><td>{Math.round(p.averagePrice).toLocaleString()}원</td><td><input aria-label={p.name + ' 기준 가격'} type="number" min="1" defaultValue={p.lastPrice} onBlur={e => updateMark(p, e.target.value)} /></td><td className={p.lastPrice >= p.averagePrice ? 'positive-value' : 'negative-value'}>{((p.lastPrice - p.averagePrice) * p.quantity).toLocaleString('ko-KR')}원</td></tr>)}</tbody></table></div> : <div className="ai-empty">아직 보유한 가상 종목이 없습니다. 왼쪽에서 가상 매수 주문을 입력하세요.</div>}
      </section>
    </div>
    <section className="panel"><div className="panel-heading"><div><h3>가상 체결 내역</h3><span>SIMULATED EXECUTIONS · {account.trades.length}건</span></div></div>
      {account.trades.length ? <div className="table-wrap"><table className="paper-table"><thead><tr><th>시간</th><th>구분</th><th>종목</th><th>수량</th><th>체결가</th><th>거래금액</th></tr></thead><tbody>{account.trades.map(t => <tr key={t.id}><td>{new Date(t.time).toLocaleString('ko-KR')}</td><td className={t.side === 'BUY' ? 'negative-value' : 'positive-value'}>{t.side === 'BUY' ? '매수' : '매도'}</td><td>{t.name}<small>{t.code}</small></td><td>{t.quantity}주</td><td>{t.price.toLocaleString()}원</td><td>{won(t.amount)}</td></tr>)}</tbody></table></div> : <div className="ai-empty">가상 체결 내역이 여기에 누적됩니다.</div>}
    </section>
    {confirmReset && <div className="paper-reset"><span>가상 계좌와 모든 체결 내역을 초기화할까요?</span><button onClick={reset}>초기화 확인</button><button onClick={() => setConfirmReset(false)}>취소</button></div>}
  </section>
}
