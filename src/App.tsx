import { useEffect, useState, type FormEvent } from 'react'
import './styles.css'
import PaperTrading from './PaperTrading'

type Holding = { name: string; code: string; quantity: number; orderable: number; averagePrice?: number; currentPrice?: number; valuation?: number; profitLoss?: number; yieldRate?: number }
type AccountSummary = { purchaseAmount: number; valuationAmount: number; profitLoss: number; yieldRate: number }
type NewsArticle = { title: string; link: string; source: string; published_at: string | null; query: string; category?: string }
type MarketStock = { code: string; name: string; price: number | null; change: string | number | null; changeRate: string | number | null; volume: string | number | null; tradeValue: string | number | null; quote: Record<string, unknown> | null; investor: Record<string, unknown> | null; quoteError: string; investorError: string }
type Disclosure = { company: string; stock_code: string; title: string; date: string; receipt_no: string; reporter: string; remark: string; link: string; listed: boolean; priority?: string; matched?: boolean }
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
  const [marketStocks, setMarketStocks] = useState<MarketStock[]>([])
  const [marketDataLoading, setMarketDataLoading] = useState(false)
  const [marketDataMessage, setMarketDataMessage] = useState('보유 종목과 관심 종목의 현재가·투자자 동향을 수집할 수 있습니다.')
  const [disclosures, setDisclosures] = useState<Disclosure[]>([])
  const [disclosureLoading, setDisclosureLoading] = useState(false)
  const [disclosureMessage, setDisclosureMessage] = useState('공시 조회 전 · OpenDART 무료 인증키 필요')
  const [watchlistText, setWatchlistText] = useState(() => localStorage.getItem('kb-trader-watchlist') || '')
  const [activePage, setActivePage] = useState<'dashboard' | 'news' | 'paper'>('dashboard')

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
      let disclosureRows: Disclosure[] = []
      try {
        const disclosureResponse = await fetch(API + '/api/market/disclosures', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token },
          body: JSON.stringify({}),
        })
        const disclosureResult = await disclosureResponse.json()
        if (disclosureResponse.status === 401) { logout(); setError('세션이 만료되었습니다. 다시 로그인해 주세요.'); return }
        if (disclosureResponse.ok && disclosureResult.success) {
          disclosureRows = disclosureResult.disclosures || []
          setDisclosures(disclosureRows)
          setDisclosureMessage((disclosureResult.message || '공시 조회 완료') + ' · ' + disclosureResult.date_range + ' · 전체 ' + (disclosureResult.total_count || 0) + '건 · ' + new Date(disclosureResult.checked_at).toLocaleString('ko-KR'))
        } else {
          setDisclosureMessage(disclosureResult.message || '시장 브리핑용 공시 조회에 실패했습니다.')
        }
      } catch {
        setDisclosureMessage('시장 브리핑용 DART 공시 조회에 실패했습니다.')
      }
      const watchlist = watchlistText.split(/[，,\n;]/).map(item => item.trim()).filter(Boolean).slice(0, 30)
      const response = await fetch(API + '/api/market/research', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token },
        body: JSON.stringify({ holdings, watchlist, disclosures: disclosureRows }),
      })
      const result = await response.json()
      if (response.status === 401) { logout(); setError('세션이 만료되었습니다. 다시 로그인해 주세요.'); return }
      if (!response.ok || !result.success) { setNewsMessage(result.message || '시장 뉴스 조회에 실패했습니다.'); return }
      setNews(result.articles || [])
      setMarketAnalysis(result.market_analysis || '')
      if (Array.isArray(result.priority_disclosures)) setDisclosures(result.priority_disclosures)
      setNewsDiagnostics(Array.isArray(result.diagnostics) ? result.diagnostics.map((item: any) => item.source + ' · ' + item.query + ': HTTP ' + item.status + ', 원본 ' + (item.raw_count ?? '-') + '건, 유효 ' + (item.valid_count ?? '-') + '건, 오늘 ' + item.count + '건' + (item.newest_published ? ', 최신 ' + new Date(item.newest_published).toLocaleString('ko-KR') : '') + (item.sample_title ? ' · 제목 샘플: ' + item.sample_title : '') + (item.sample_link ? ' · 링크 샘플: ' + item.sample_link : '') + (item.error ? ' · ' + item.error : '')) : [])
      setNewsMessage((result.message || '시장 뉴스 조회 완료') + ' · 보유 ' + (result.research_context?.holdings_count ?? holdings.length) + '종목 · 관심 ' + (result.research_context?.watchlist_count ?? 0) + '종목 · 관련 공시 ' + (result.research_context?.matched_disclosure_count ?? 0) + '건 · 기준일 ' + result.market_date_kst + ' (KST) · ' + new Date(result.checked_at).toLocaleString('ko-KR'))
    } catch { setNewsMessage('뉴스 서버에 연결하지 못했습니다.') }
    finally { setNewsLoading(false) }
  }
  async function loadMarketData() {
    setMarketDataLoading(true)
    setMarketDataMessage('보유 종목과 관심 종목 코드를 확인하고 KB증권 시세·투자자 동향을 조회하고 있습니다.')
    try {
      const candidates = [
        ...holdings.map(item => ({ code: item.code, name: item.name })),
        ...watchlistText.split(/[，,\n;]/).map(value => value.trim()).filter(Boolean).map(value => /^\d{6}$/.test(value) ? ({ code: value, name: value }) : ({ code: '', name: value })),
      ]
      const stocks: { code: string; name: string }[] = []
      for (const item of candidates) {
        if (stocks.length >= 10) break
        if (item.code && /^\d{6}$/.test(item.code)) {
          if (!stocks.some(stock => stock.code === item.code)) stocks.push(item)
          continue
        }
        if (!item.name || item.name.length < 2) continue
        const searchResponse = await fetch(API + '/api/kb/search-stocks', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token },
          body: JSON.stringify({ query: item.name }),
        })
        const searchResult = await searchResponse.json()
        const match = searchResult?.stocks?.[0]
        if (searchResponse.ok && searchResult.success && match?.code && !stocks.some(stock => stock.code === match.code)) {
          stocks.push({ code: match.code, name: match.name || item.name })
        }
      }
      if (!stocks.length) {
        setMarketStocks([])
        setMarketDataMessage('조회할 종목이 없습니다. 관심 종목에 종목명 또는 6자리 코드를 입력하거나 계좌 보유 종목을 불러와 주세요.')
        return
      }
      const response = await fetch(API + '/api/market/investor-flow', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token },
        body: JSON.stringify({ stocks }),
      })
      const result = await response.json()
      if (response.status === 401) { logout(); setError('세션이 만료되었습니다. 다시 로그인해 주세요.'); return }
      if (!response.ok || !result.success) {
        setMarketDataMessage(result.message || '시장 데이터 수집에 실패했습니다.')
        return
      }
      setMarketStocks(result.results || [])
      setMarketDataMessage((result.message || 'KB증권 시장 데이터 수집 완료') + ' · ' + result.requested + '종목 · IVU10140 현재가 / IVU10430 투자자 동향 · ' + new Date(result.checked_at).toLocaleString('ko-KR'))
    } catch {
      setMarketDataMessage('시장 데이터 서버 연결 또는 응답 처리에 실패했습니다.')
    } finally {
      setMarketDataLoading(false)
    }
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
        setDisclosureMessage((result.message || '공시 조회에 실패했습니다.') + (result.error_type ? ' · 오류 유형: ' + result.error_type : '') + (result.cause_type ? ' · 원인: ' + result.cause_type : '') + (result.cause_code ? ' · 코드: ' + result.cause_code : '') + (result.stage ? ' · 단계: ' + result.stage : '') + (result.error_detail ? ' · 오류 상세: ' + result.error_detail : '') + (result.redirect_status ? ' · 리다이렉트 HTTP: ' + result.redirect_status : '') + (result.redirect_host ? ' · 이동 호스트: ' + result.redirect_host : '') + (result.redirect_path ? ' · 이동 경로: ' + result.redirect_path : '') + (result.redirect_count !== undefined ? ' · 이동 횟수: ' + result.redirect_count : '') + (result.public_host_ok !== undefined ? ' · 일반 외부 연결: ' + (result.public_host_ok ? '정상' : '실패') : '') + (result.public_host_status ? ' · 외부 응답: ' + result.public_host_status : ''))
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

  return <div className="app-shell"><aside className="sidebar"><div className="brand"><div className="brand-mark">KB</div><div><strong>KB AI TRADER</strong><span>SWING TERMINAL</span></div></div><nav className="nav-list"><button className={'nav-item ' + (activePage === 'dashboard' ? 'active' : '')} onClick={() => setActivePage('dashboard')}>계좌 대시보드</button><button className={'nav-item ' + (activePage === 'news' ? 'active' : '')} onClick={() => setActivePage('news')}>시장 뉴스</button><div className="nav-item">보유 종목</div><button className={'nav-item ' + (activePage === 'paper' ? 'active' : '')} onClick={() => setActivePage('paper')}>가상 트레이딩</button></nav><div className="sidebar-bottom"><div className="security-card">안전 모드 · 실주문 비활성화</div><button className="nav-item" onClick={logout}>로그아웃</button></div></aside>
    <main className="main"><header className="topbar"><div className="breadcrumbs">WORKSPACE / <b>{activePage === 'dashboard' ? '계좌 현황' : activePage === 'news' ? '시장 뉴스' : '가상 트레이딩'}</b></div><div className="connection">KB증권 계좌 연동</div></header><div className="content">{activePage === 'dashboard' && <section className="page-heading"><div><div className="eyebrow">PERSONAL TRADING SPACE</div><h1>계좌 현황</h1><p>KB증권 실계좌 보유 종목 조회</p></div><button className="outline-button" onClick={refresh} disabled={loading}>{loading ? '조회 중...' : '계좌 새로고침'}</button></section>}
      {activePage === 'paper' ? <PaperTrading token={token} /> : activePage === 'dashboard' ? <>
      <section className="section-title"><div><h2>보유 종목</h2><span>LIVE POSITIONS</span></div><span>{message}</span></section><div className="stats-grid">
        <article className="stat-card"><div className="stat-top">총 매입금액</div><div className="stat-value">{accountSummary ? accountSummary.purchaseAmount.toLocaleString('ko-KR') + '원' : '-'}</div><div className="stat-foot">보유 종목 매입금액 합계</div></article>
        <article className="stat-card primary-stat"><div className="stat-top">총 평가금액</div><div className="stat-value">{accountSummary ? accountSummary.valuationAmount.toLocaleString('ko-KR') + '원' : '-'}</div><div className="stat-foot">현재 보유 자산 평가금액</div></article>
        <article className="stat-card"><div className="stat-top">총 평가손익</div><div className={'stat-value ' + (accountSummary && accountSummary.profitLoss < 0 ? 'negative-value' : 'positive-value')}>{accountSummary ? (accountSummary.profitLoss > 0 ? '+' : '') + accountSummary.profitLoss.toLocaleString('ko-KR') + '원' : '-'}</div><div className="stat-foot">평가금액 - 매입금액 기준</div></article>
        <article className="stat-card"><div className="stat-top">전체 수익률</div><div className={'stat-value ' + (accountSummary && accountSummary.yieldRate < 0 ? 'negative-value' : 'positive-value')}>{accountSummary ? (accountSummary.yieldRate > 0 ? '+' : '') + accountSummary.yieldRate.toFixed(2) + '%' : '-'}</div><div className="stat-foot">KB증권 계좌자산평가 응답 기준</div></article>
      </div>
      
      <section className="panel ai-panel"><div className="panel-heading"><div><h3>AI 분석 비교</h3><span>PARALLEL MODEL REVIEW · SAME ACCOUNT DATA</span></div><button className="outline-button" onClick={runAiAnalysis} disabled={aiLoading || !holdings.length}>{aiLoading ? '두 AI 분석 중...' : '두 AI 동시 분석'}</button></div><p className="ai-message">{aiMessage}</p><div className="ai-compare-grid"><article className="ai-result-card"><h4>Cloudflare AI <small>Llama 3.1 8B</small></h4>{cloudflareAnalysis ? <div className="ai-analysis">{cloudflareAnalysis}</div> : <div className="ai-empty">분석 결과 대기 중</div>}</article><article className="ai-result-card"><h4>Google Gemini <small>Gemini 3.8 Flash</small></h4>{geminiAnalysis ? <div className="ai-analysis">{geminiAnalysis}</div> : <div className="ai-empty">분석 결과 대기 중</div>}</article></div><div className="ai-consensus-note">공통 의견은 두 분석에서 동일 종목코드와 판단이 겹치는지 확인해 판단합니다. 현재는 보유 종목만 비교하며, 신규 종목 발굴은 시장 데이터 연결 후 추가합니다.</div></section>

      <section className="panel holdings-panel"><div className="panel-heading"><div><h3>주문 가능 현금</h3><span>ORDERABLE CASH · SSQM0004</span></div><span>{depositMessage}</span></div>{deposit ? <div className="cash-summary"><div className="cash-label">현금 기준 주문 가능 금액</div><div className="cash-value">{deposit.ordr_psbl_csh !== undefined ? Number(String(deposit.ordr_psbl_csh).replace(/^0+(?=\\d)/, '')).toLocaleString('ko-KR') + '원' : '응답 필드 확인 필요'}</div><div className="cash-foot">KB증권 예수금내역의 주문가능현금 필드 기준</div><details className="raw-details"><summary>원본 응답 확인</summary><div className="table-wrap"><table><thead><tr><th>응답 필드</th><th>값</th></tr></thead><tbody>{Object.entries(deposit).filter(([, value]) => value === null || ['string','number','boolean'].includes(typeof value)).map(([key, value]) => <tr key={key}><td>{key}</td><td>{String(value ?? '-')}</td></tr>)}</tbody></table></div></details></div> : <div className="empty-row">{depositMessage}</div>}</section>
      <section className="panel holdings-panel"><div className="panel-heading"><div><h3>보유 종목</h3><span>POSITIONS</span></div></div><div className="table-wrap"><table><thead><tr><th>종목명</th><th>종목코드</th><th>보유 수량</th><th>주문 가능 수량</th><th>평균 매입가</th><th>현재가</th><th>평가금액</th><th>평가손익</th><th>수익률</th></tr></thead><tbody>{holdings.length ? holdings.map(item => <tr key={item.code}><td>{item.name}</td><td>{item.code}</td><td>{item.quantity.toLocaleString()}주</td><td>{item.orderable.toLocaleString()}주</td><td>{item.averagePrice ? item.averagePrice.toLocaleString() + '원' : '-'}</td><td>{item.currentPrice ? item.currentPrice.toLocaleString() + '원' : '-'}</td><td>{item.valuation ? item.valuation.toLocaleString() + '원' : '-'}</td><td>{item.profitLoss !== undefined ? item.profitLoss.toLocaleString() + '원' : '-'}</td><td>{item.yieldRate !== undefined ? item.yieldRate.toFixed(2) + '%' : '-'}</td></tr>) : <tr><td colSpan={9} className="empty-row"><div><b>{message}</b><span>조회 결과가 여기에 표시됩니다.</span></div></td></tr>}</tbody></table></div></section></> : <section className="news-page"><div className="page-heading"><div><div className="eyebrow">MARKET INTELLIGENCE</div><h1>시장 뉴스</h1><p>오늘 발행된 국내 증시·산업·글로벌 경제 뉴스를 분석합니다.</p></div><button className="outline-button" onClick={loadNews} disabled={newsLoading}>{newsLoading ? '뉴스 조회 중...' : '뉴스 새로고침'}</button></div><section className="panel news-panel"><div className="panel-heading"><div><h3>전체 시장 뉴스</h3><span>MARKET-WIDE NEWS · PUBLISHER RSS · TODAY KST</span></div></div><section className="panel disclosure-panel"><div className="panel-heading"><div><h3>관심 종목</h3><span>WATCHLIST · 종목명 또는 종목코드</span></div></div><textarea className="watchlist-input" value={watchlistText} onChange={event => { setWatchlistText(event.target.value); localStorage.setItem('kb-trader-watchlist', event.target.value) }} placeholder="예: 삼성전자, SK하이닉스&#10;또는 005930, 000660" rows={2} /><p className="news-query">쉼표 또는 줄바꿈으로 구분해 입력하세요. 시장 뉴스 새로고침 시 보유 종목과 함께 공시·뉴스 분석에 반영됩니다.</p></section><section className="panel disclosure-panel"><div className="panel-heading"><div><h3>국내 주식 시장 데이터</h3><span>KB QUOTE · INVESTOR FLOW · 최대 10종목</span></div><button className="outline-button" onClick={loadMarketData} disabled={marketDataLoading}>{marketDataLoading ? '수집 중...' : '시장 데이터 수집'}</button></div><p className="news-message">{marketDataMessage}</p>{marketStocks.length ? <div className="table-wrap market-data-table"><table><thead><tr><th>종목</th><th>현재가</th><th>전일 대비</th><th>등락률</th><th>누적 거래량</th><th>거래대금(추정)</th><th>당일 투자자 순매매</th></tr></thead><tbody>{marketStocks.map(stock => <tr key={stock.code}><td>{stock.name}<small>{stock.code}</small></td><td>{stock.price ? stock.price.toLocaleString('ko-KR') + '원' : stock.quoteError || '-'}</td><td>{typeof stock.change === 'number' ? (stock.change > 0 ? '+' : '') + stock.change.toLocaleString('ko-KR') : stock.change ?? '-'}</td><td>{stock.changeRate != null ? (Number(stock.changeRate) > 0 ? '+' : '') + Number(stock.changeRate).toFixed(2) + '%' : '-'}</td><td>{typeof stock.volume === 'number' ? stock.volume.toLocaleString('ko-KR') : stock.volume ?? '-'}</td><td>{typeof stock.tradeValue === 'number' ? stock.tradeValue.toLocaleString('ko-KR') + '원' : '-'}</td><td>{stock.investorError ? <span className="market-investor-error">{stock.investorError}</span> : (stock.investor as any)?.out?.[0] ? <div className="market-investor-summary"><small>{(stock.investor as any).out[0].dt || ''}</small><span>개인 <b>{Number((stock.investor as any).out[0].indv || 0).toLocaleString('ko-KR')}</b></span><span>외국인 <b>{Number((stock.investor as any).out[0].fgnr || 0).toLocaleString('ko-KR')}</b></span><span>증권 <b>{Number((stock.investor as any).out[0].scrt || 0).toLocaleString('ko-KR')}</b></span></div> : '-'}</td></tr>)}</tbody></table></div> : <div className="ai-empty">시장 데이터 수집을 누르면 계좌 보유 종목과 관심 종목 최대 10개를 대상으로 현재가 및 투자자별 매매동향을 조회합니다.</div>}</section><section className="panel disclosure-panel"><div className="panel-heading"><div><h3>전자공시 · DART</h3><span>OFFICIAL DISCLOSURES · OPENDART API</span></div><button className="outline-button" onClick={loadDisclosures} disabled={disclosureLoading}>{disclosureLoading ? '공시 조회 중...' : '공시 새로고침'}</button></div><p className="news-message">{disclosureMessage}</p>{disclosures.length ? <div className="disclosure-list">{disclosures.slice(0, 30).map((item, index) => <article className="disclosure-item" key={item.receipt_no || index}><div className="news-item-top"><span>{item.company}{item.stock_code ? ' · ' + item.stock_code : ' · 비상장/기타'}{item.matched ? ' · 내 종목' : ''}{item.priority ? ' · ' + item.priority : ''}</span><span>{item.date ? item.date.slice(4, 6) + '-' + item.date.slice(6, 8) : ''}</span></div><a href={item.link} target="_blank" rel="noreferrer">{item.title}</a><div className="news-query">{item.reporter}{item.remark ? ' · ' + item.remark : ''}</div></article>)}</div> : <div className="ai-empty">공시 새로고침을 눌러 최근 3일간의 DART 공시를 확인하세요. 최초 사용 전 Cloudflare에 DART_API_KEY Secret 등록이 필요합니다.</div>}</section><p className="news-message">{newsMessage}</p>{marketAnalysis && <div className="market-analysis"><div className="market-analysis-title">AI 오늘의 시장 브리핑</div><div>{marketAnalysis}</div></div>}{newsDiagnostics.length > 0 && <div className="news-diagnostics">{newsDiagnostics.map((item, index) => <div key={index}>{item}</div>)}</div>}{news.length ? <div className="news-list">{news.map((item, index) => <article className="news-item" key={item.link + index}><div className="news-item-top"><span>{item.source}</span><span>{item.published_at ? new Date(item.published_at).toLocaleString('ko-KR', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }) : '시간 정보 없음'}</span></div><a href={item.link} target="_blank" rel="noreferrer">{item.title}</a><div className="news-query">검색: {item.query}</div></article>)}</div> : <div className="ai-empty">뉴스 새로고침을 누르면 오늘 발행된 국내외 시장·산업 뉴스를 수집하고 AI가 요약합니다.</div>}</section></section>}
      <footer><span>KB AI TRADER · 실계좌 주문 비활성화</span><span>REAL ORDER DISABLED</span></footer></div></main></div>
}