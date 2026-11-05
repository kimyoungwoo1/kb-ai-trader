import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { PAPER_EVENT, freshLedger, readPaperLedger, writePaperLedger, type PaperLedger } from './paperLedger'
import { readAutoAccount, AUTO_STORAGE_KEY, newAutoAccount } from './autoPaper'

type Position = PaperLedger['positions'][number]
type Trade = PaperLedger['trades'][number]
type PaperState = PaperLedger
const emptyState: PaperState = freshLedger()
const won = (value: number) => Math.round(value).toLocaleString('ko-KR') + '원'
const readState = readPaperLedger

export default function PaperTrading({ token }: { token: string }) {
  const [account, setAccount] = useState<PaperState>(readState)
  const [name, setName] = useState('')
  const [code, setCode] = useState('')
  const [price, setPrice] = useState('')
  const [quantity, setQuantity] = useState('1')
  const [side, setSide] = useState<'BUY' | 'SELL'>('BUY')
  const [notice, setNotice] = useState('가상 계좌가 준비되었습니다. 보유 종목 시세는 KB 현재가로 자동 갱신됩니다.')
  const [confirmReset, setConfirmReset] = useState(false)
  const [quoteLoading, setQuoteLoading] = useState(false)
  const [quoteInfo, setQuoteInfo] = useState('종목명을 입력해 검색하세요.')
  const [stockResults, setStockResults] = useState<{ name: string; code: string; market: string }[]>([])
  const [stockSearchLoading, setStockSearchLoading] = useState(false)
  const [selectedStock, setSelectedStock] = useState(false)
  const stockSearchRequest = useRef(0)
  const quoteRefreshLock = useRef(false)
  const positionsRef = useRef(account.positions)
  positionsRef.current = account.positions
  const [refreshingPositions, setRefreshingPositions] = useState(false)
  const [positionQuoteInfo, setPositionQuoteInfo] = useState('보유 종목 시세는 60초마다 자동 갱신됩니다.')
  const [lastPositionRefresh, setLastPositionRefresh] = useState('')

  const valuation = useMemo(() => account.positions.reduce((sum, p) => sum + p.quantity * p.lastPrice, 0), [account.positions])
  const invested = useMemo(() => account.positions.reduce((sum, p) => sum + p.quantity * p.averagePrice, 0), [account.positions])
  const total = account.cash + valuation
  const pnl = valuation - invested
  const realizedPnl = useMemo(() => account.trades.reduce((sum, trade) => sum + (trade.realizedPnl || 0), 0), [account.trades])
  const totalPnl = pnl + realizedPnl
  const persist = (next: PaperState) => { setAccount(next); writePaperLedger(next) }
  useEffect(() => {
    const update = () => setAccount(readPaperLedger())
    window.addEventListener(PAPER_EVENT, update)
    window.addEventListener('storage', update)
    return () => { window.removeEventListener(PAPER_EVENT, update); window.removeEventListener('storage', update) }
  }, [])

  const refreshPositionQuotes = useCallback(async (silent = false) => {
    const snapshot = positionsRef.current
    if (!snapshot.length || quoteRefreshLock.current) return
    quoteRefreshLock.current = true
    setRefreshingPositions(true)
    if (!silent) setPositionQuoteInfo('보유 종목 현재가를 조회하고 있습니다...')
    let updated = 0
    const failures: string[] = []
    const prices = new Map<string, { price: number; checkedAt: string }>()
    try {
      for (const position of snapshot) {
        try {
          const response = await fetch('https://kb-ai-trader.ksmsy1.workers.dev/api/kb/quote', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token },
            body: JSON.stringify({ code: position.code, exchange: '1' }),
          })
          const result = await response.json()
          if (!response.ok || !result.success || !Number.isFinite(Number(result.price)) || Number(result.price) <= 0) {
            failures.push(position.name + ': ' + (result.message || '현재가 조회 실패'))
            continue
          }
          prices.set(position.code, { price: Number(result.price), checkedAt: result.checked_at || new Date().toISOString() })
          updated++
        } catch (error) {
          failures.push(position.name + ': ' + (error instanceof Error ? error.message : '연결 실패'))
        }
      }
      if (prices.size) {
        const current = readPaperLedger()
        const next: PaperState = {
          ...current,
          positions: current.positions.map(position => {
            const quote = prices.get(position.code)
            return quote ? { ...position, lastPrice: quote.price, quoteUpdatedAt: quote.checkedAt } : position
          }),
        }
        persist(next)
      }
      const completedAt = new Date().toLocaleString('ko-KR')
      setLastPositionRefresh(completedAt)
      if (failures.length) setPositionQuoteInfo(updated + '개 종목 갱신, ' + failures.length + '개 실패 · 실패 종목은 기존 가격 유지')
      else setPositionQuoteInfo(updated + '개 종목 현재가 갱신 완료')
    } finally {
      quoteRefreshLock.current = false
      setRefreshingPositions(false)
    }
  }, [token])

  useEffect(() => {
    if (!account.positions.length) return
    void refreshPositionQuotes(true)
    const timer = window.setInterval(() => { void refreshPositionQuotes(true) }, 60000)
    return () => window.clearInterval(timer)
  }, [account.positions.length, refreshPositionQuotes])



  useEffect(() => {
    const query = name.trim()
    const requestId = ++stockSearchRequest.current
    if (selectedStock || query.length < 2) {
      setStockResults([])
      setStockSearchLoading(false)
      return
    }
    const controller = new AbortController()
    const timer = window.setTimeout(async () => {
      setStockSearchLoading(true)
      try {
        const response = await fetch('https://kb-ai-trader.ksmsy1.workers.dev/api/kb/search-stocks', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token },
          body: JSON.stringify({ query }),
          signal: controller.signal,
        })
        const result = await response.json()
        if (requestId !== stockSearchRequest.current) return
        const matches = response.ok && result.success ? result.stocks || [] : []
        setStockResults(matches)
        if (!response.ok || !result.success) setQuoteInfo(result.message || '종목 검색에 실패했습니다.')
        else setQuoteInfo(matches.length ? '검색 결과 ' + matches.length + '건 · 목록에서 종목을 선택하세요.' : (result.message || '검색 결과가 없습니다. KB 종목 마스터 응답을 확인해야 합니다.'))
      } catch (error) {
        if (error instanceof DOMException && error.name === 'AbortError') return
        if (requestId === stockSearchRequest.current) setQuoteInfo('종목 검색 서버에 연결하지 못했습니다.')
      } finally {
        if (requestId === stockSearchRequest.current) setStockSearchLoading(false)
      }
    }, 350)
    return () => {
      window.clearTimeout(timer)
      controller.abort()
    }
  }, [name, token, selectedStock])

  function chooseStock(stock: { name: string; code: string; market: string }) {
    setName(stock.name)
    setCode(stock.code)
    setSelectedStock(true)
    setStockResults([])
    setPrice('')
    setQuoteInfo(stock.name + ' · 종목코드 ' + stock.code + ' 선택 완료')
  }

  async function fetchQuote() {
    if (!/^\d{6}$/.test(code.trim())) { setNotice('종목명을 검색한 뒤 목록에서 선택해 주세요.'); return }
    setQuoteLoading(true)
    setQuoteInfo('KB증권 현재가 조회 중...')
    try {
      const response = await fetch('https://kb-ai-trader.ksmsy1.workers.dev/api/kb/quote', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token },
        body: JSON.stringify({ code: code.trim(), exchange: '1' }),
      })
      const result = await response.json()
      if (!response.ok || !result.success) { setQuoteInfo(result.message || '현재가 조회 실패'); return }
      if (!result.price) { setQuoteInfo(result.message || '현재가 필드를 확인할 수 없습니다. KB 원본 응답을 확인해야 합니다.'); return }
      setPrice(String(result.price))
      if (result.name) setName(result.name)
      setQuoteInfo('KB증권 KRX 현재가 · ' + new Date(result.checked_at).toLocaleString('ko-KR') + (result.changeRate != null ? ' · 등락률 ' + result.changeRate + '%' : ''))
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error)
      setQuoteInfo('현재가 조회 요청 실패: ' + detail.slice(0, 180))
    } finally { setQuoteLoading(false) }
  }

  function executeTrade(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const cleanCode = code.trim()
    const cleanName = name.trim()
    const tradePrice = Number(price)
    const tradeQty = Number(quantity)
    if (!/^\d{6}$/.test(cleanCode) || !cleanName || !Number.isFinite(tradePrice) || tradePrice <= 0 || !Number.isInteger(tradeQty) || tradeQty <= 0) {
      setNotice('종목명을 검색해 목록에서 선택하고, 가격과 수량을 확인해 주세요.')
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
      const realized = (tradePrice - existing.averagePrice) * tradeQty
      const trade: Trade = { id: crypto.randomUUID(), time: new Date().toISOString(), side, code: cleanCode, name: cleanName, quantity: tradeQty, price: tradePrice, amount, realizedPnl: realized }
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
    const auto = readAutoAccount()
    if (auto.enabled || auto.positions.length) {
      setConfirmReset(false)
      setNotice('자동 가상매매가 실행 중이거나 자동 보유 포지션이 있습니다. 자동 가상매매를 중지하고 포지션을 먼저 정리해야 공유 계좌를 초기화할 수 있습니다.')
      return
    }
    localStorage.setItem(AUTO_STORAGE_KEY, JSON.stringify(newAutoAccount()))
    persist(freshLedger())
    setConfirmReset(false)
    setNotice('공유 가상 계좌와 수동·자동 체결 기록을 초기화했습니다. 초기 자금은 100만 원입니다.')
  }

  return <section className="paper-page">
    <div className="page-heading"><div><div className="eyebrow">PAPER TRADING · NO REAL ORDERS</div><h1>가상 트레이딩</h1><p>초기 자금 100만 원 · 보유 종목 시세 60초 자동 갱신 · 브라우저 로컬 저장 · 실계좌와 완전 분리</p></div><button className="outline-button" onClick={() => setConfirmReset(true)}>계좌 초기화</button></div>
    <div className="paper-warning"><b>가상 거래 전용</b><span>매수·매도는 실제 주문이 아닌 가상 체결입니다. KB 현재가 조회 또는 직접 입력한 가격을 기준으로 계산하며, 보유 종목 평가 가격은 KB 현재가를 60초마다 자동 갱신하며, 조회 실패 시 기존 가격을 유지합니다.</span></div>
    <div className="stats-grid">
      <article className="stat-card"><div className="stat-top">가상 총자산</div><div className="stat-value">{won(total)}</div><div className="stat-foot">가상 예수금 + 보유 평가금액</div></article>
      <article className="stat-card"><div className="stat-top">가상 예수금</div><div className="stat-value">{won(account.cash)}</div><div className="stat-foot">가상 주문에 사용할 수 있는 금액</div></article>
      <article className="stat-card"><div className="stat-top">보유 평가금액</div><div className="stat-value">{won(valuation)}</div><div className="stat-foot">KB 현재가 자동 갱신</div></article>
      <article className="stat-card"><div className="stat-top">평가손익</div><div className={'stat-value ' + (pnl < 0 ? 'negative-value' : 'positive-value')}>{pnl > 0 ? '+' : ''}{won(pnl)}</div><div className="stat-foot">매입 평균가 대비 평가손익 · 비용 미반영</div></article>
      <article className="stat-card"><div className="stat-top">실현손익</div><div className={'stat-value ' + (realizedPnl < 0 ? 'negative-value' : 'positive-value')}>{realizedPnl > 0 ? '+' : ''}{won(realizedPnl)}</div><div className="stat-foot">매도 체결로 확정된 손익</div></article>
      <article className="stat-card"><div className="stat-top">누적손익</div><div className={'stat-value ' + (totalPnl < 0 ? 'negative-value' : 'positive-value')}>{totalPnl > 0 ? '+' : ''}{won(totalPnl)}</div><div className="stat-foot">평가손익 + 실현손익 · 비용 미반영</div></article>
    </div>
    <div className="paper-grid">
      <section className="panel"><div className="panel-heading"><div><h3>가상 주문</h3><span>MANUAL PAPER ORDER</span></div></div>
        <form className="paper-form" onSubmit={executeTrade}>
          <div className="paper-side"><button type="button" className={side === 'BUY' ? 'selected-buy' : ''} onClick={() => setSide('BUY')}>가상 매수</button><button type="button" className={side === 'SELL' ? 'selected-sell' : ''} onClick={() => setSide('SELL')}>가상 매도</button></div>
          <div className="paper-stock-search">
            <label>종목명<input value={name} onChange={e => { setName(e.target.value); setCode(''); setSelectedStock(false); setPrice(''); setQuoteInfo('종목을 선택해 주세요.') }} placeholder="종목명 입력 · 예: 삼성전자" autoComplete="off" /></label>
            {stockSearchLoading && <p className="paper-search-status">KB증권 종목 목록 검색 중...</p>}
            {stockResults.length > 0 && <div className="paper-stock-results">{stockResults.map(stock => <button type="button" key={stock.code} onClick={() => chooseStock(stock)}><b>{stock.name}</b><span>{stock.code}</span></button>)}</div>}
            {selectedStock && <p className="paper-selected-stock">선택 종목: {name} ({code}) <button type="button" onClick={() => { setSelectedStock(false); setCode(''); setPrice(''); setName('') }}>변경</button></p>}
          </div>
          <label>기준 가격 (원)<div className="paper-price-row"><input value={price} onChange={e => setPrice(e.target.value)} type="number" min="1" step="1" placeholder="현재가 조회 또는 직접 입력" /><button type="button" className="outline-button" onClick={fetchQuote} disabled={quoteLoading}>{quoteLoading ? "조회 중..." : "KB 현재가 조회"}</button></div></label><p className="paper-quote-info">{quoteInfo}</p>
          <label>수량 (주)<input value={quantity} onChange={e => setQuantity(e.target.value)} type="number" min="1" step="1" /></label>
          <div className="paper-order-total">주문 금액 <b>{won((Number(price) || 0) * (Number(quantity) || 0))}</b></div>
          <button className="paper-submit" type="submit">{side === 'BUY' ? '가상 매수 체결' : '가상 매도 체결'}</button>
          <p className="paper-notice">{notice}</p>
        </form>
      </section>
      <section className="panel"><div className="panel-heading"><div><h3>보유 종목</h3><span>VIRTUAL POSITIONS</span><p className="paper-quote-info">{positionQuoteInfo}{lastPositionRefresh ? ' · 마지막 갱신 ' + lastPositionRefresh : ''}</p></div><button type="button" className="outline-button" onClick={() => void refreshPositionQuotes(false)} disabled={refreshingPositions || !account.positions.length}>{refreshingPositions ? '갱신 중...' : '현재가 일괄 갱신'}</button></div>
        {account.positions.length ? <div className="table-wrap"><table className="paper-table"><thead><tr><th>종목</th><th>수량</th><th>평균 매수가</th><th>평가 기준가 · 수동 수정 가능</th><th>평가금액</th><th>평가손익</th><th>수익률</th></tr></thead><tbody>{account.positions.map(p => { const positionPnl = (p.lastPrice - p.averagePrice) * p.quantity; const cost = p.averagePrice * p.quantity; const rate = cost ? positionPnl / cost * 100 : 0; return <tr key={p.code}><td>{p.name}<small>{p.code}</small></td><td>{p.quantity.toLocaleString()}주</td><td>{Math.round(p.averagePrice).toLocaleString()}원</td><td><input aria-label={p.name + ' 평가 기준 가격'} type="number" min="1" defaultValue={p.lastPrice} onBlur={e => updateMark(p, e.target.value)} /></td><td>{won(p.lastPrice * p.quantity)}</td><td className={positionPnl >= 0 ? 'positive-value' : 'negative-value'}>{positionPnl > 0 ? '+' : ''}{won(positionPnl)}</td><td className={rate >= 0 ? 'positive-value' : 'negative-value'}>{rate > 0 ? '+' : ''}{rate.toFixed(2)}%</td></tr> })}</tbody></table></div> : <div className="ai-empty">아직 보유한 가상 종목이 없습니다. 왼쪽에서 가상 매수 주문을 입력하세요.</div>}
      </section>
    </div>
    <section className="panel"><div className="panel-heading"><div><h3>가상 체결 내역</h3><span>SIMULATED EXECUTIONS · {account.trades.length}건</span></div></div>
      {account.trades.length ? <div className="table-wrap"><table className="paper-table"><thead><tr><th>시간</th><th>구분</th><th>종목</th><th>수량</th><th>체결가</th><th>거래금액</th><th>실현손익</th></tr></thead><tbody>{account.trades.map(t => <tr key={t.id}><td>{new Date(t.time).toLocaleString('ko-KR')}</td><td className={t.side === 'BUY' ? 'negative-value' : 'positive-value'}>{t.side === 'BUY' ? '매수' : '매도'}</td><td>{t.name}<small>{t.code}</small></td><td>{t.quantity}주</td><td>{t.price.toLocaleString()}원</td><td>{won(t.amount)}</td><td className={(t.realizedPnl || 0) >= 0 ? 'positive-value' : 'negative-value'}>{t.side === 'SELL' ? ((t.realizedPnl || 0) > 0 ? '+' : '') + won(t.realizedPnl || 0) : '—'}</td></tr>)}</tbody></table></div> : <div className="ai-empty">가상 체결 내역이 여기에 누적됩니다.</div>}
    </section>
    {confirmReset && <div className="paper-reset"><span>가상 계좌와 모든 체결 내역을 초기화할까요?</span><button onClick={reset}>초기화 확인</button><button onClick={() => setConfirmReset(false)}>취소</button></div>}
  </section>
}
