import { useEffect, useState, type FormEvent } from 'react'
import './styles.css'

type Holding = { name: string; code: string; quantity: number; orderable: number; averagePrice?: number; currentPrice?: number; valuation?: number; profitLoss?: number; yieldRate?: number }
type AccountSummary = { purchaseAmount: number; valuationAmount: number; profitLoss: number; yieldRate: number }
type NewsArticle = { title: string; link: string; source: string; published_at: string | null; query: string; category?: string }
type Disclosure = { company: string; stock_code: string; title: string; date: string; receipt_no: string; reporter: string; remark: string; link: string; listed: boolean }
const API = 'https://kb-ai-trader.ksmsy1.workers.dev'

export default function App() {
  const [password, setPassword] = useState('')
  const [token, setToken] = useState(() => sessionStorage.getItem('kb-trader-session') || '')
  const [error, setError] = useState('')
  const [holdings, setHoldings] = useState<Holding[]>([])
  const [accountSummary, setAccountSummary] = useState<AccountSummary | null>(null)
  const [deposit, setDeposit] = useState<Record<string, unknown> | null>(null)
  const [depositMessage, setDepositMessage] = useState('예수금 조회 전')
  const [message, setMessage] = useState('로그인 후 계좌 새로고침을 눌러주세요.')
  const [loading, setLoading] = useState(false)
  const [cloudflareAnalysis, setCloudflareAnalysis] = useState('')
  const [geminiAnalysis, setGeminiAnalysis] = useState('')
  const [aiLoading, setAiLoading] = useState(false)
  const [aiMessage, setAiMessage] = useState('계좌 데이터를 바탕으로 AI 포트폴리오 진단을 실행할 수 있습니다.')
  const [news, setNews] = useState<NewsArticle[]>([])
  const [newsLoading, setNewsLoading] = useState(false)
  const [newsMessage, setNewsMessage] = useState('뉴스를 불러오려면 뉴스 새로고침을 눌러주세요.')
  const [newsDiagnostics, setNewsDiagnostics] = useState<string[]>([])
  const [marketAnalysis, setMarketAnalysis] = useState('')
  const [disclosures, setDisclosures] = useState<Disclosure[]>([])
  const [disclosureLoading, setDisclosureLoading] = useState(false)
  const [disclosureMessage, setDisclosureMessage] = useState('공시 조회 전 · OpenDART 무료 인증키 필요')
  const [activePage, setActivePage] = useState<'dashboard' | 'news'>('dashboard')

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
        const valuationBody = valuationResult.data?.dataBody || {}
        const valuationHeader = valuationResult.data?.dataHeader || {}
        const summarySource = { ...valuationHeader, ...valuationBody }
        const numericField = (value: unknown) => Number(String(value ?? '0').replace(/,/g, '')) || 0
        setAccountSummary({
          purchaseAmount: numericField(summarySource.byng_amt_sum),
          valuationAmount: numericField(summarySource.val_amt_sum),
          profitLoss: numericField(summarySource.val_pl_sum),
          yieldRate: numericField(summarySource.val_yld_sum),
        })
        const valuationRows = valuationBody.Record1 || []
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
      } else {
        setAccountSummary(null)
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

  async function runAiAnalysis() {
    setAiLoading(true); setAiMessage('Cloudflare AI와 Gemini가 동일한 계좌 데이터를 동시에 분석하고 있습니다.'); setCloudflareAnalysis(''); setGeminiAnalysis('')
    try {
      const response = await fetch(API + '/api/ai/compare', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token },
        body: JSON.stringify({ holdings, accountSummary }),
      })
      const result = await response.json()
      if (response.status === 401) { logout(); setError('세션이 만료되었습니다. 다시 로그인해 주세요.'); return }
      if (!response.ok || !result.success) { setAiMessage(result.message || 'AI 분석에 실패했습니다.'); return }
      const cloud = result.results?.cloudflare
      const gemini = result.results?.gemini
      setCloudflareAnalysis(cloud?.analysis || 'Cloudflare AI 결과가 없습니다.')
      setGeminiAnalysis(gemini?.analysis || 'Gemini 결과가 없습니다.')
      setAiMessage('비교 분석 완료 · ' + new Date(result.checked_at).toLocaleString('ko-KR') + ' · 두 모델에 동일한 보유 종목 데이터 전달')
    } catch { setAiMessage('AI 분석 서버에 연결하지 못했습니다.') }
    finally { setAiLoading(false) }
  }


  async function loadNews() {
    setNewsLoading(true)
    setNewsMessage('오늘 국내외 시장 뉴스를 수집하고 AI가 분석하고 있습니다.')
    setMarketAnalysis('')
    try {
      const response = await fetch(API + '/api/market/research', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token },
        body: JSON.stringify({}),
      })
      const result = await response.json()
      if (response.status === 401) { logout(); setError('세션이 만료되었습니다. 다시 로그인해 주세요.'); return }
      if (!response.ok || !result.success) { setNewsMessage(result.message || '시장 뉴스 조회에 실패했습니다.'); return }
      setNews(result.articles || [])
      setMarketAnalysis(result.market_analysis || '')
      setNewsDiagnostics(Array.isArray(result.diagnostics) ? result.diagnostics.map((item: any) => item.source + ' · ' + item.query + ': HTTP ' + item.status + ', 원본 ' + (item.raw_count ?? '-') + '건, 유효 ' + (item.valid_count ?? '-') + '건, 오늘 ' + item.count + '건' + (item.newest_published ? ', 최신 ' + new Date(item.newest_published).toLocaleString('ko-KR') : '') + (item.error ? ' · ' + item.error : '')) : [])
      setNewsMessage((result.message || '시장 뉴스 조회 완료') + ' · 기준일 ' + result.market_date_kst + ' (KST) · ' + new Date(result.checked_at).toLocaleString('ko-KR'))
    } catch { setNewsMessage('뉴스 서버에 연결하지 못했습니다.') }
    finally { setNewsLoading(false) }
  }
  async function loadDisclosures() {
    setDisclosureLoading(true)
    setDisclosureMessage('최근 3일간의 전자공시를 조회하고 있습니다.')
    try {
      const response = await fetch(API + '/api/market/disclosures', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token },
        body: JSON.stringify({}),
      })
      const result = await response.json()
      if (response.status === 401) { logout(); setError('세션이 만료되었습니다. 다시 로그인해 주세요.'); return }
      if (!response.ok || !result.success) {
        setDisclosureMessage(result.message || '공시 조회에 실패했습니다.')
        return
      }
      setDisclosures(result.disclosures || [])
      setDisclosureMessage((result.message || '공시 조회 완료') + ' · ' + result.date_range + ' · 전체 ' + (result.total_count || 0) + '건 · ' + new Date(result.checked_at).toLocaleString('ko-KR'))
    } catch { setDisclosureMessage('OpenDART 서버에 연결하지 못했습니다.') }
    finally { setDisclosureLoading(false) }
  }

  useEffect(() => { if (token) refresh() }, [token])

  function logout() { sessionStorage.removeItem('kb-trader-session'); setToken(''); setHoldings([]); setDeposit(null); setAccountSummary(null) }

  if (!token) return <main className="login-page"><form className="login-card" onSubmit={login}><div className="brand-mark">KB</div><h1>KB AI TRADER</h1><p>대시보드 비밀번호로 로그인하세요.</p><input type="password" value={password} onChange={event => setPassword(event.target.value)} placeholder="대시보드 비밀번호" required /><button type="submit">로그인</button>{error && <p className="error">{error}</p>}</form></main>

  return <div className="app-shell"><aside className="sidebar"><div className="brand"><div className="brand-mark">KB</div><div><strong>KB AI TRADER</strong><span>SWING TERMINAL</span></div></div><nav className="nav-list"><button className={'nav-item ' + (activePage === 'dashboard' ? 'active' : '')} onClick={() => setActivePage('dashboard')}>계좌 대시보드</button><button className={'nav-item ' + (activePage === 'news' ? 'active' : '')} onClick={() => setActivePage('news')}>시장 뉴스</button><div className="nav-item">보유 종목</div><div className="nav-item">가상 트레이딩</div></nav><div className="sidebar-bottom"><div className="security-card">안전 모드 · 실주문 비활성화</div><button className="nav-item" onClick={logout}>로그아웃</button></div></aside>
    <main className="main"><header className="topbar"><div className="breadcrumbs">WORKSPACE / <b>{activePage === 'dashboard' ? '계좌 현황' : '시장 뉴스'}</b></div><div className="connection">KB증권 계좌 연동</div></header><div className="content">{activePage === 'dashboard' && <section className="page-heading"><div><div className="eyebrow">PERSONAL TRADING SPACE</div><h1>계좌 현황</h1><p>KB증권 실계좌 보유 종목 조회</p></div><button className="outline-button" onClick={refresh} disabled={loading}>{loading ? '조회 중...' : '계좌 새로고침'}</button></section>}
      {activePage === 'dashboard' ? <>
      <section className="section-title"><div><h2>보유 종목</h2><span>LIVE POSITIONS</span></div><span>{message}</span></section><div className="stats-grid">
        <article className="stat-card"><div className="stat-top">총 매입금액</div><div className="stat-value">{accountSummary ? accountSummary.purchaseAmount.toLocaleString('ko-KR') + '원' : '-'}</div><div className="stat-foot">보유 종목 매입금액 합계</div></article>
        <article className="stat-card primary-stat"><div className="stat-top">총 평가금액</div><div className="stat-value">{accountSummary ? accountSummary.valuationAmount.toLocaleString('ko-KR') + '원' : '-'}</div><div className="stat-foot">현재 보유 자산 평가금액</div></article>
        <article className="stat-card"><div className="stat-top">총 평가손익</div><div className={'stat-value ' + (accountSummary && accountSummary.profitLoss < 0 ? 'negative-value' : 'positive-value')}>{accountSummary ? (accountSummary.profitLoss > 0 ? '+' : '') + accountSummary.profitLoss.toLocaleString('ko-KR') + '원' : '-'}</div><div className="stat-foot">평가금액 - 매입금액 기준</div></article>
        <article className="stat-card"><div className="stat-top">전체 수익률</div><div className={'stat-value ' + (accountSummary && accountSummary.yieldRate < 0 ? 'negative-value' : 'positive-value')}>{accountSummary ? (accountSummary.yieldRate > 0 ? '+' : '') + accountSummary.yieldRate.toFixed(2) + '%' : '-'}</div><div className="stat-foot">KB증권 계좌자산평가 응답 기준</div></article>
      </div>
      
      <section className="panel ai-panel"><div className="panel-heading"><div><h3>AI 분석 비교</h3><span>PARALLEL MODEL REVIEW · SAME ACCOUNT DATA</span></div><button className="outline-button" onClick={runAiAnalysis} disabled={aiLoading || !holdings.length}>{aiLoading ? '두 AI 분석 중...' : '두 AI 동시 분석'}</button></div><p className="ai-message">{aiMessage}</p><div className="ai-compare-grid"><article className="ai-result-card"><h4>Cloudflare AI <small>Llama 3.1 8B</small></h4>{cloudflareAnalysis ? <div className="ai-analysis">{cloudflareAnalysis}</div> : <div className="ai-empty">분석 결과 대기 중</div>}</article><article className="ai-result-card"><h4>Google Gemini <small>Gemini 3.8 Flash</small></h4>{geminiAnalysis ? <div className="ai-analysis">{geminiAnalysis}</div> : <div className="ai-empty">분석 결과 대기 중</div>}</article></div><div className="ai-consensus-note">공통 의견은 두 분석에서 동일 종목코드와 판단이 겹치는지 확인해 판단합니다. 현재는 보유 종목만 비교하며, 신규 종목 발굴은 시장 데이터 연결 후 추가합니다.</div></section>

      <section className="panel holdings-panel"><div className="panel-heading"><div><h3>주문 가능 현금</h3><span>ORDERABLE CASH · SSQM0004</span></div><span>{depositMessage}</span></div>{deposit ? <div className="cash-summary"><div className="cash-label">현금 기준 주문 가능 금액</div><div className="cash-value">{deposit.ordr_psbl_csh !== undefined ? Number(String(deposit.ordr_psbl_csh).replace(/^0+(?=\\d)/, '')).toLocaleString('ko-KR') + '원' : '응답 필드 확인 필요'}</div><div className="cash-foot">KB증권 예수금내역의 주문가능현금 필드 기준</div><details className="raw-details"><summary>원본 응답 확인</summary><div className="table-wrap"><table><thead><tr><th>응답 필드</th><th>값</th></tr></thead><tbody>{Object.entries(deposit).filter(([, value]) => value === null || ['string','number','boolean'].includes(typeof value)).map(([key, value]) => <tr key={key}><td>{key}</td><td>{String(value ?? '-')}</td></tr>)}</tbody></table></div></details></div> : <div className="empty-row">{depositMessage}</div>}</section>
      <section className="panel holdings-panel"><div className="panel-heading"><div><h3>보유 종목</h3><span>POSITIONS</span></div></div><div className="table-wrap"><table><thead><tr><th>종목명</th><th>종목코드</th><th>보유 수량</th><th>주문 가능 수량</th><th>평균 매입가</th><th>현재가</th><th>평가금액</th><th>평가손익</th><th>수익률</th></tr></thead><tbody>{holdings.length ? holdings.map(item => <tr key={item.code}><td>{item.name}</td><td>{item.code}</td><td>{item.quantity.toLocaleString()}주</td><td>{item.orderable.toLocaleString()}주</td><td>{item.averagePrice ? item.averagePrice.toLocaleString() + '원' : '-'}</td><td>{item.currentPrice ? item.currentPrice.toLocaleString() + '원' : '-'}</td><td>{item.valuation ? item.valuation.toLocaleString() + '원' : '-'}</td><td>{item.profitLoss !== undefined ? item.profitLoss.toLocaleString() + '원' : '-'}</td><td>{item.yieldRate !== undefined ? item.yieldRate.toFixed(2) + '%' : '-'}</td></tr>) : <tr><td colSpan={9} className="empty-row"><div><b>{message}</b><span>조회 결과가 여기에 표시됩니다.</span></div></td></tr>}</tbody></table></div></section></> : <section className="news-page"><div className="page-heading"><div><div className="eyebrow">MARKET INTELLIGENCE</div><h1>시장 뉴스</h1><p>오늘 발행된 국내 증시·산업·글로벌 경제 뉴스를 분석합니다.</p></div><button className="outline-button" onClick={loadNews} disabled={newsLoading}>{newsLoading ? '뉴스 조회 중...' : '뉴스 새로고침'}</button></div><section className="panel news-panel"><div className="panel-heading"><div><h3>전체 시장 뉴스</h3><span>MARKET-WIDE NEWS · PUBLISHER RSS · TODAY KST</span></div></div><section className="panel disclosure-panel"><div className="panel-heading"><div><h3>전자공시 · DART</h3><span>OFFICIAL DISCLOSURES · OPENDART API</span></div><button className="outline-button" onClick={loadDisclosures} disabled={disclosureLoading}>{disclosureLoading ? '공시 조회 중...' : '공시 새로고침'}</button></div><p className="news-message">{disclosureMessage}</p>{disclosures.length ? <div className="disclosure-list">{disclosures.map((item, index) => <article className="disclosure-item" key={item.receipt_no || index}><div className="news-item-top"><span>{item.company}{item.stock_code ? ' · ' + item.stock_code : ' · 비상장/기타'}</span><span>{item.date ? item.date.slice(4, 6) + '-' + item.date.slice(6, 8) : ''}</span></div><a href={item.link} target="_blank" rel="noreferrer">{item.title}</a><div className="news-query">{item.reporter}{item.remark ? ' · ' + item.remark : ''}</div></article>)}</div> : <div className="ai-empty">공시 새로고침을 눌러 최근 3일간의 DART 공시를 확인하세요. 최초 사용 전 Cloudflare에 DART_API_KEY Secret 등록이 필요합니다.</div>}</section><p className="news-message">{newsMessage}</p>{marketAnalysis && <div className="market-analysis"><div className="market-analysis-title">AI 오늘의 시장 브리핑</div><div>{marketAnalysis}</div></div>}{newsDiagnostics.length > 0 && <div className="news-diagnostics">{newsDiagnostics.map((item, index) => <div key={index}>{item}</div>)}</div>}{news.length ? <div className="news-list">{news.map((item, index) => <article className="news-item" key={item.link + index}><div className="news-item-top"><span>{item.source}</span><span>{item.published_at ? new Date(item.published_at).toLocaleString('ko-KR', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }) : '시간 정보 없음'}</span></div><a href={item.link} target="_blank" rel="noreferrer">{item.title}</a><div className="news-query">검색: {item.query}</div></article>)}</div> : <div className="ai-empty">뉴스 새로고침을 누르면 오늘 발행된 국내외 시장·산업 뉴스를 수집하고 AI가 요약합니다.</div>}</section></section>}
      <footer><span>KB AI TRADER · 계좌 조회 전용</span><span>REAL ORDER DISABLED</span></footer></div></main></div>
}