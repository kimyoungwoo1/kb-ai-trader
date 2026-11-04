import { useState } from 'react'
import './styles.css'

type Holding = { name: string; code: string; quantity: number; orderable: number }
const API = 'https://kb-ai-trader.ksmsy1.workers.dev'

export default function App() {
  const [password, setPassword] = useState('')
  const [token, setToken] = useState(() => sessionStorage.getItem('kb-trader-session') || '')
  const [error, setError] = useState('')
  const [holdings, setHoldings] = useState<Holding[]>([])
  const [message, setMessage] = useState('로그인 후 계좌 새로고침을 눌러주세요.')
  const [loading, setLoading] = useState(false)

  async function login(event: React.FormEvent<HTMLFormElement>) {
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
      setMessage('마지막 조회: ' + new Date().toLocaleString('ko-KR'))
    } catch { setMessage('계좌 조회 중 네트워크 오류가 발생했습니다.') }
    finally { setLoading(false) }
  }

  function logout() { sessionStorage.removeItem('kb-trader-session'); setToken(''); setHoldings([]) }

  if (!token) return <main className="login-page"><form className="login-card" onSubmit={login}><div className="brand-mark">KB</div><h1>KB AI TRADER</h1><p>대시보드 비밀번호로 로그인하세요.</p><input type="password" value={password} onChange={event => setPassword(event.target.value)} placeholder="대시보드 비밀번호" required /><button type="submit">로그인</button>{error && <p className="error">{error}</p>}</form></main>

  return <div className="app-shell"><aside className="sidebar"><div className="brand"><div className="brand-mark">KB</div><div><strong>KB AI TRADER</strong><span>SWING TERMINAL</span></div></div><nav className="nav-list"><div className="nav-item active">계좌 대시보드</div><div className="nav-item">보유 종목</div><div className="nav-item">가상 트레이딩</div></nav><div className="sidebar-bottom"><div className="security-card">안전 모드 · 실주문 비활성화</div><button className="nav-item" onClick={logout}>로그아웃</button></div></aside>
    <main className="main"><header className="topbar"><div className="breadcrumbs">WORKSPACE / <b>계좌 현황</b></div><div className="connection">KB증권 계좌 연동</div></header><div className="content"><section className="page-heading"><div><div className="eyebrow">PERSONAL TRADING SPACE</div><h1>계좌 현황</h1><p>KB증권 실계좌 보유 종목 조회</p></div><button className="outline-button" onClick={refresh} disabled={loading}>{loading ? '조회 중...' : '계좌 새로고침'}</button></section>
      <section className="section-title"><div><h2>보유 종목</h2><span>LIVE POSITIONS</span></div><span>{message}</span></section><div className="stats-grid"><article className="stat-card primary-stat"><div className="stat-top">보유 종목 수</div><div className="stat-value">{holdings.length} 종목</div><div className="stat-foot">KB증권 실계좌 기준</div></article></div>
      <section className="panel holdings-panel"><div className="panel-heading"><div><h3>보유 종목</h3><span>POSITIONS</span></div></div><div className="table-wrap"><table><thead><tr><th>종목명</th><th>종목코드</th><th>보유 수량</th><th>주문 가능 수량</th><th>평균 매입가</th><th>현재가</th></tr></thead><tbody>{holdings.length ? holdings.map(item => <tr key={item.code}><td>{item.name}</td><td>{item.code}</td><td>{item.quantity.toLocaleString()}주</td><td>{item.orderable.toLocaleString()}주</td><td>추가 API 필요</td><td>추가 API 필요</td></tr>) : <tr><td colSpan={6} className="empty-row"><div><b>{message}</b><span>조회 결과가 여기에 표시됩니다.</span></div></td></tr>}</tbody></table></div></section><footer><span>KB AI TRADER · 계좌 조회 전용</span><span>REAL ORDER DISABLED</span></footer></div></main></div>
}