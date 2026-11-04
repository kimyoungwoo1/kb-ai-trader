import { useEffect, useState, type FormEvent } from 'react'
import './styles.css'

type Holding = { name: string; code: string; quantity: number; orderable: number; averagePrice?: number; currentPrice?: number; valuation?: number; profitLoss?: number; yieldRate?: number }
const API = 'https://kb-ai-trader.ksmsy1.workers.dev'

export default function App() {
  const [password, setPassword] = useState('')
  const [token, setToken] = useState(() => sessionStorage.getItem('kb-trader-session') || '')
  const [error, setError] = useState('')
  const [holdings, setHoldings] = useState<Holding[]>([])
  const [deposit, setDeposit] = useState<Record<string, unknown> | null>(null)
  const [depositMessage, setDepositMessage] = useState('예수금 조회 전')
  const [message, setMessage] = useState('로그인 후 계좌 새로고침을 눌러주세요.')
  const [loading, setLoading] = useState(false)

  async function login(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setError('')
    try {
      const response = await fetch(API + '/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password }) })
      const result = await response.json()
      if (!response.ok || !result.success) { setError(result.message || '로그인 실패'); return }
      sessionStorage.setItem('kb-trader-session', result.token); setToken(result.token); setPassword('')
    } catch { setError('서버에 연결하지 못했습니다.') }
  }

  async function refresh() {
    setLoading(true); setMessage('KB증권 계좌 조회 중...')
    try {
      const response = await fetch(API + '/api/kb/holdings', { method: 'POST', headers: { Authorization: 'Bearer ' + token } })
      const result = await response.json()
      if (response.status === 401) { logout(); setError('세션이 만료되었습니다. 다시 로그인해 주세요.'); return }
      if (!response.ok || !result.success) { setMessage(result.message || '조회 실패'); return }
      const rows = result.data?.dataBody?.Record1 || []
      setHoldings(rows.map((row: any) => ({ name: row.is_nm || '종목명 없음', code: row.is_no || '', quantity: Number(row.gnrl_q || 0), orderable: Number(row.ordr_psbl_q || 0) })))
      const valuationResponse = await fetch(API + '/api/kb/valuation', { method: 'POST', headers: { Authorization: 'Bearer ' + token } })
      const valuationResult = await valuationResponse.json()
      if (valuationResponse.ok && valuationResult.success) {
        const valuationRows = valuationResult.data?.dataBody?.Record1 || []
        if (valuationRows.length) {
          setHoldings(valuationRows.map((row: any) => ({
            name: row.is_nm || '종목명 없음',
            code: row.is_cd || '',
            quantity: Number(row.hld_q || row.ec_q || 0),
            orderable: Number(row.ordr_psbl_q || 0),
            averagePrice: Number(row.byng_avr_prc || 0),
            currentPrice: Number(row.now_prc || 0),
            valuation: Number(row.val_amt || 0),
            profitLoss: Number(row.val_pl || 0),
            yieldRate: Number(row.val_yld || 0),
          })))
        }
      }
      const depositResponse = await fetch(API + '/api/kb/deposit', { method: 'POST', headers: { Authorization: 'Bearer ' + token } })
      const depositResult = await depositResponse.json()
      if (depositResponse.status === 401) { logout(); setError('세션이 만료되었습니다. 다시 로그인해 주세요.'); return }
      if (depositResponse.ok && depositResult.success) {
        setDeposit(depositResult.data?.dataBody || {})
        setDepositMessage('예수금 조회 성공 · ' + new Date().toLocaleString('ko-KR'))
      } else {
        setDeposit(null)
        setDepositMessage(depositResult.message || '예수금 조회 실패')
      }
      setMessage('마지막 조회: ' + new Date().toLocaleString('ko-KR'))
    } catch { setMessage('계좌 조회 중 네트워크 오류가 발생했습니다.') }
    finally { setLoading(false) }
  }

  useEffect(() => { if (token) refresh() }, [token])

  function logout() { sessionStorage.removeItem('kb-trader-session'); setToken(''); setHoldings([]); setDeposit(null) }

  if (!token) return <main className="login-page"><form className="login-card" onSubmit={login}><div className="brand-mark">KB</div><h1>KB AI TRADER</h1><p>대시보드 비밀번호로 로그인하세요.</p><input type="password" value={password} onChange={event => setPassword(event.target.value)} placeholder="대시보드 비밀번호" required /><button type="submit">로그인</button>{error && <p className="error">{error}</p>}</form></main>

  return <div className="app-shell"><aside className="sidebar"><div className="brand"><div className="brand-mark">KB</div><div><strong>KB AI TRADER</strong><span>SWING TERMINAL</span></div></div><nav className="nav-list"><div className="nav-item active">계좌 대시보드</div><div className="nav-item">보유 종목</div><div className="nav-item">가상 트레이딩</div></nav><div className="sidebar-bottom"><div className="security-card">안전 모드 · 실주문 비활성화</div><button className="nav-item" onClick={logout}>로그아웃</button></div></aside>
    <main className="main"><header className="topbar"><div className="breadcrumbs">WORKSPACE / <b>계좌 현황</b></div><div className="connection">KB증권 계좌 연동</div></header><div className="content"><section className="page-heading"><div><div className="eyebrow">PERSONAL TRADING SPACE</div><h1>계좌 현황</h1><p>KB증권 실계좌 보유 종목 조회</p></div><button className="outline-button" onClick={refresh} disabled={loading}>{loading ? '조회 중...' : '계좌 새로고침'}</button></section>
      <section className="section-title"><div><h2>보유 종목</h2><span>LIVE POSITIONS</span></div><span>{message}</span></section><div className="stats-grid"><article className="stat-card primary-stat"><div className="stat-top">보유 종목 수</div><div className="stat-value">{holdings.length} 종목</div><div className="stat-foot">KB증권 실계좌 기준</div></article></div>
      <section className="panel holdings-panel"><div className="panel-heading"><div><h3>주문 가능 현금</h3><span>ORDERABLE CASH · SSQM0004</span></div><span>{depositMessage}</span></div>{deposit ? <div className="cash-summary"><div className="cash-label">현금 기준 주문 가능 금액</div><div className="cash-value">{deposit.ordr_psbl_csh !== undefined ? Number(String(deposit.ordr_psbl_csh).replace(/^0+(?=\\d)/, '')).toLocaleString('ko-KR') + '원' : '응답 필드 확인 필요'}</div><div className="cash-foot">KB증권 예수금내역의 주문가능현금 필드 기준</div><details className="raw-details"><summary>원본 응답 확인</summary><div className="table-wrap"><table><thead><tr><th>응답 필드</th><th>값</th></tr></thead><tbody>{Object.entries(deposit).filter(([, value]) => value === null || ['string','number','boolean'].includes(typeof value)).map(([key, value]) => <tr key={key}><td>{key}</td><td>{String(value ?? '-')}</td></tr>)}</tbody></table></div></details></div> : <div className="empty-row">{depositMessage}</div>}</section>
      <section className="panel holdings-panel"><div className="panel-heading"><div><h3>보유 종목</h3><span>POSITIONS</span></div></div><div className="table-wrap"><table><thead><tr><th>종목명</th><th>종목코드</th><th>보유 수량</th><th>주문 가능 수량</th><th>평균 매입가</th><th>현재가</th><th>평가금액</th><th>평가손익</th><th>수익률</th></tr></thead><tbody>{holdings.length ? holdings.map(item => <tr key={item.code}><td>{item.name}</td><td>{item.code}</td><td>{item.quantity.toLocaleString()}주</td><td>{item.orderable.toLocaleString()}주</td><td>{item.averagePrice ? item.averagePrice.toLocaleString() + '원' : '-'}</td><td>{item.currentPrice ? item.currentPrice.toLocaleString() + '원' : '-'}</td><td>{item.valuation ? item.valuation.toLocaleString() + '원' : '-'}</td><td>{item.profitLoss !== undefined ? item.profitLoss.toLocaleString() + '원' : '-'}</td><td>{item.yieldRate !== undefined ? item.yieldRate.toFixed(2) + '%' : '-'}</td></tr>) : <tr><td colSpan={9} className="empty-row"><div><b>{message}</b><span>조회 결과가 여기에 표시됩니다.</span></div></td></tr>}</tbody></table></div></section><footer><span>KB AI TRADER · 계좌 조회 전용</span><span>REAL ORDER DISABLED</span></footer></div></main></div>
}