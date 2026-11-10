import { useCallback, useEffect, useState } from 'react'
import { orderStatusLabel, type LiveOrder } from './LiveTrial'
import { validateLiveBuyInput } from './liveBuyValidation'

type Status = { enabled: boolean; hardEnabled: boolean; orders?: LiveOrder[] }
type Stock = { code: string; name: string; market?: string }
type Preview = { permitted: boolean; reasons: string[]; requiredCash: number }
const results: Record<string, string> = {
  accepted_not_filled: 'KB 주문 접수 · 체결은 주문 기록에서 확인하세요.',
  manual_locked: '정규장에 자동매매를 잠근 상태에서만 지정가 주문을 보낼 수 있습니다.',
  invalid_signal: '종목코드, 수량 또는 지정가를 다시 확인하세요.',
  disarmed_after_claim: '전송 직전에 주문 허용 조건이 바뀌어 주문을 보류했습니다.',
  not_claimed: '주문 전송권을 확보하지 못했습니다. 주문 기록을 확인하세요.',
  budget_exceeded: '지정가와 수량이 시험 주문 한도를 초과했습니다.',
  history_unavailable: 'KB 주문·체결 조회를 완료하지 못해 전송을 보류했습니다.',
  account_not_verified: 'KB 보유수량 또는 주문가능금액을 확인하지 못했습니다.',
  already_held_in_real_account: '기존 보유종목은 시험 주문 대상에서 제외됩니다.',
  journal_unavailable: '주문 원장을 확인하지 못했습니다.',
  risk_blocked: '당일 주문 한도 또는 주문가능금액 조건을 충족하지 못했습니다.',
  duplicate_or_blocked: '당일 주문 기록, 미확정 주문 또는 자동매매 잠금 상태를 확인하세요.',
  unknown_order_result: '접수 여부 미확정 · 같은 주문을 다시 보내기 전에 주문 기록과 M-able을 확인하세요.',
  rejected: 'KB가 주문을 거부했습니다.',
}

export default function ManualLimitOrder({ token }: { token: string }) {
  const [status, setStatus] = useState<Status | null>(null)
  const [statusError, setStatusError] = useState(false)
  const [query, setQuery] = useState('')
  const [stock, setStock] = useState<Stock | null>(null)
  const [searchResult, setSearchResult] = useState<{ term: string; stocks: Stock[] } | null>(null)
  const [searchMessage, setSearchMessage] = useState('')
  const [quantity, setQuantity] = useState('1')
  const [price, setPrice] = useState('')
  const [preview, setPreview] = useState<Preview | null>(null)
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState('')
  const request = useCallback(async (body: object, timeout = 15_000) => {
    const response = await fetch('/api/live/trial', {
      method: 'POST', cache: 'no-store', signal: AbortSignal.timeout(timeout),
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token },
      body: JSON.stringify(body),
    })
    return response.json()
  }, [token])
  const refresh = useCallback(async () => {
    try {
      const data = await request({ action: 'status' })
      if (data.success !== true) throw Error()
      setStatus(data)
      setStatusError(false)
    } catch { setStatusError(true) }
  }, [request])
  useEffect(() => {
    void refresh()
    const timer = window.setInterval(() => void refresh(), 30_000)
    return () => window.clearInterval(timer)
  }, [refresh])

  useEffect(() => {
    const term = query.trim()
    if (stock || term.length < 2) return
    const controller = new AbortController()
    const timer = window.setTimeout(async () => {
      setSearchMessage('종목 검색 중…')
      try {
        const response = await fetch('/api/kb/search-stocks', {
          method: 'POST', cache: 'no-store',
          headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token },
          body: JSON.stringify({ query: term }),
          signal: AbortSignal.any([controller.signal, AbortSignal.timeout(26_000)]),
        })
        const data = await response.json()
        if (controller.signal.aborted) return
        if (!response.ok || !data.success || !Array.isArray(data.stocks)) throw Error()
        const stocks = data.stocks.filter((item: Stock) =>
          typeof item?.name === 'string' && item.name.trim() && typeof item.code === 'string' && /^\d{6}$/.test(item.code))
        setSearchResult({ term, stocks })
        setSearchMessage(stocks.length ? '목록에서 주문할 종목을 선택하세요.' : '검색 결과가 없습니다.')
      } catch {
        if (!controller.signal.aborted) setSearchMessage('종목 검색에 실패했습니다. 검색어를 다시 입력해 주세요.')
      }
    }, 350)
    return () => { window.clearTimeout(timer); controller.abort() }
  }, [query, stock, token])

  const allowed = !statusError && status?.hardEnabled && !status.enabled
  const fields = { code: stock?.code ?? '', quantity: Number(quantity), limitPrice: Number(price) }
  const edit = (set: (value: string) => void, value: string) => {
    set(value)
    setPreview(null)
    setMessage('')
  }
  function changeSearch(value: string) {
    edit(setQuery, value)
    setStock(null)
    setSearchResult(null)
    setSearchMessage('')
    setPrice('')
  }
  function selectStock(item: Stock) {
    edit(setQuery, item.name)
    setStock(item)
    setSearchResult(null)
    setSearchMessage('')
  }
  async function inspect() {
    if (!stock) return
    const issue = validateLiveBuyInput(stock.code, quantity, price)
    if (issue) { setMessage(issue); return }
    setBusy(true)
    setMessage('')
    setPreview(null)
    try {
      const data = await request({ action: 'preflight', ...fields }, 35_000)
      if (!data.success) throw Error(data.message || '주문 점검 실패')
      setPreview(data.preview)
    } catch (error) {
      setMessage(error instanceof Error ? error.message : '주문 점검 실패')
    } finally { setBusy(false) }
  }
  async function submit() {
    if (!allowed || !stock || !preview?.permitted || busy) return
    setBusy(true)
    setPreview(null)
    setMessage('')
    try {
      const data = await request({
        action: 'manualBuy', ...fields,
        requestId: crypto.randomUUID(), confirmation: '지정가 실매수 확인',
      }, 120_000)
      setMessage(results[data.decision] ?? data.message ?? '주문 결과를 확인할 수 없습니다. 주문 기록을 확인하세요.')
    } catch {
      setMessage('응답을 받지 못했습니다. 같은 주문을 다시 보내기 전에 주문 기록과 M-able을 확인하세요.')
    } finally {
      await refresh()
      setBusy(false)
    }
  }

  const matches = !stock && searchResult?.term === query.trim() ? searchResult.stocks : []
  const orders = status?.orders?.filter(order => order.id.startsWith('manual-buy-')) ?? []
  return <section className="notification-page">
    <div className="page-heading"><div><div className="eyebrow">MANUAL LIMIT ORDER</div><h1>지정가 주문</h1>
      <p>정규장 국내주식 지정가 매수 · 수수료 여유금 포함 1만 원 · 자동매매와 당일 매수 1회 한도 공유</p>
    </div><button className="outline-button" onClick={() => void refresh()}>새로고침</button></div>
    <div className="panel" style={{ padding: 20, display: 'grid', gap: 12 }}>
      <p className="notification-hint">{statusError || !status ? '서버 주문 상태 확인 필요' :
        status.enabled ? '실계좌 자동매매 메뉴에서 자동매매를 잠근 뒤 진행하세요.' :
        status.hardEnabled ? '종목과 금액을 점검한 뒤 확인 버튼으로 실제 주문을 보냅니다.' : '서버 시험매매 설정이 잠겨 있습니다.'}</p>
      <div className="paper-stock-search" style={{width:'min(100%, 380px)'}}>
        <label>종목명 <input className="live-trial-field" value={query} disabled={busy} autoComplete="off"
          placeholder="종목명 검색" maxLength={60} onChange={e => changeSearch(e.target.value)} /></label>
        {stock && <p className="paper-selected-stock">선택한 종목 <strong>{stock.name}</strong> ({stock.code})
          <button type="button" disabled={busy} onClick={() => changeSearch('')}>변경</button>
        </p>}
        {searchMessage && <p role="status" className="paper-search-status">{searchMessage}</p>}
        {matches.length > 0 && <div className="paper-stock-results" aria-label="종목 검색 결과">{matches.map(item =>
          <button type="button" key={item.code} disabled={busy} onClick={() => selectStock(item)}>
            <b>{item.name}</b><span>{item.code}{item.market ? ' · ' + item.market : ''}</span>
          </button>)}</div>}
      </div>
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
        <label>수량 <input className="live-trial-field" inputMode="numeric" value={quantity} disabled={busy} onChange={e => edit(setQuantity, e.target.value)} /></label>
        <label>지정가(원) <input className="live-trial-field" inputMode="numeric" value={price} disabled={busy} onChange={e => edit(setPrice, e.target.value)} /></label>
        <button className="outline-button" type="button" disabled={busy || !allowed || !stock} onClick={() => void inspect()}>주문 점검</button>
      </div>
      {preview && stock && <div>
        {preview.permitted ? <>
          <p>실계좌 매수 <strong>{stock.name}</strong> ({stock.code}) · {quantity}주 × {Number(price).toLocaleString('ko-KR')}원 · 예상 필요 현금 {preview.requiredCash.toLocaleString('ko-KR')}원</p>
          <button className="outline-button" type="button" disabled={busy || !allowed} onClick={() => void submit()}>확인하고 실제 지정가 매수</button>
        </> : <p role="alert">{preview.reasons.join(' · ')}</p>}
      </div>}
      {busy && <p role="status">KB증권과 서버 원장을 확인 중입니다.</p>}
      {message && <p role="status">{message}</p>}
    </div>
    <div className="panel" style={{ padding: 20 }}>
      <h3>수동 지정가 주문 기록</h3>
      <p className="notification-hint">미체결 주문 취소는 M-able에서 직접 확인하세요.</p>
      {orders.length ? <div className="notification-list">{orders.map(order =>
        <article key={order.id} className="notification-item">
          <strong>{order.code} · {orderStatusLabel(order)}</strong>
          <p>{order.quantity}주 × {order.limit_price.toLocaleString('ko-KR')}원 · 체결 {order.filled_quantity}주 · KB 주문번호 {order.broker_order_id ?? '미확인'}</p>
        </article>)}</div> : <p>{statusError || !status ? '주문 기록 확인 필요' : '수동 주문 기록 없음'}</p>}
    </div>
  </section>
}
