import {isKrxRegularSession as isKrxSession} from './marketSession'
import { useEffect, useRef, useState, type FormEvent } from 'react'
import './styles.css'
import PaperTrading from './PaperTrading'
import { generateTradeSignals } from './tradeSignals'
import AutoPaperLab from './AutoPaperLab'
import TradingAnalytics from './TradingAnalytics'
import NotificationCenter from './NotificationCenter'
import LiveTrial from './LiveTrial'
import ManualLimitOrder from './ManualLimitOrder'
import { AUTO_EVENT, readAutoAccount, recordAutoWatchError, runAutoCycle, runAutoWatchCycle, writeAutoAccount } from './autoPaper'
import { FAST_QUOTE_INTERVAL_MS, selectAutoWatchStocks } from './autoWatch'
import { canExecutePaperTrade, CLOUD_SYNC_EVENT, getCloudSyncState, startCloudAutoSync, verifyTradingLease } from './cloudAutoSync'
import { getAutoHealth } from './autoStatus'
import { applyCatalystGate, catalystAllowsPending, catalystReady, readCatalystSnapshot, writeCatalystSnapshot, type CatalystSnapshot, type MarketArticle, type MarketDisclosure } from './marketCatalysts'
import { writeScreeningSnapshot } from './screeningHistory'
import { isServerPaperMode, serverPaperAction, setServerPaperMode, setServerPaperError } from './serverPaperClient'

type Holding = { name: string; code: string; quantity: number; orderable: number; averagePrice?: number; currentPrice?: number; valuation?: number; profitLoss?: number; yieldRate?: number }
type AccountSummary = { purchaseAmount: number; valuationAmount: number; profitLoss: number; yieldRate: number }
type NewsArticle = { title: string; link: string; source: string; published_at: string | null; query: string; category?: string }
type MarketStock = { code: string; name: string; price: number | null; change: string | number | null; changeRate: string | number | null; volume: string | number | null; tradeValue: string | number | null; previousVolume?: number | null; openPrice?: number | null; highPrice?: number | null; lowPrice?: number | null; averagePrice?: number | null; investorUnit?: string; investorAccumulated?: boolean; quote: Record<string, unknown> | null; investor: Record<string, unknown> | null; quoteError: string; investorError: string }
type InvestorDay = { dt: string; indv: number; fgnr: number; scrt: number }
function getInvestorDays(stock: MarketStock): InvestorDay[] {
  const rows = (stock.investor as { out?: unknown } | null)?.out
  if (!Array.isArray(rows)) return []
  return rows.filter((row: any) => /^\d{8}$/.test(String(row?.dt || ''))).slice(0, 5).map((row: any) => ({
    dt: String(row.dt),
    indv: Number(row.indv) || 0,
    fgnr: Number(row.fgnr) || 0,
    scrt: Number(row.scrt) || 0,
  }))
}
type Disclosure = { company: string; stock_code: string; title: string; date: string; receipt_no: string; reporter: string; remark: string; link: string; listed: boolean; priority?: string; matched?: boolean }
const SIGNAL_MAX_POSITION_WON = 200000
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
  // Single account snapshot for every menu. Repeated UI requests share one
  // in-flight promise; brief cooldowns prevent rapid retries after KB 522.
  // Live order preflight never reads these UI values as authoritative.
  const accountPendingRef = useRef<Promise<void> | null>(null)
  const accountNextRefreshRef = useRef(0)
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
  const [marketCheckedAt, setMarketCheckedAt] = useState('')
  const [autoSignals, setAutoSignals] = useState<ReturnType<typeof generateTradeSignals>>([])
  const [catalysts, setCatalysts] = useState<CatalystSnapshot | null>(readCatalystSnapshot)
  const [catalystSummary, setCatalystSummary] = useState('자동매매용 뉴스·공시 교차 확인 대기')
  const [marketDiscoveryInfo, setMarketDiscoveryInfo] = useState('수급 후보 탐색 전 · 코스피·코스닥 공개 데이터에 포함된 종목을 대상으로 선별합니다(전체 상장종목 전수 아님).')
  const marketScanRef = useRef(false)
  const marketScanRunner = useRef<() => Promise<void>>(async () => {})
  const fastWatchBusyRef = useRef(false)
  const fastWatchRunner = useRef<() => Promise<void>>(async () => {})
  const fastWatchBackoffRef = useRef(0)
  const [signalSnapshot, setSignalSnapshot] = useState<ReturnType<typeof generateTradeSignals>>([])
  const [signalCheckedAt, setSignalCheckedAt] = useState('')
  const [marketDataLoading, setMarketDataLoading] = useState(false)
  const [marketDataMessage, setMarketDataMessage] = useState('보유 종목과 관심 종목의 현재가·투자자 동향을 수집할 수 있습니다.')
  const [disclosures, setDisclosures] = useState<Disclosure[]>([])
  const [disclosureLoading, setDisclosureLoading] = useState(false)
  const [disclosureMessage, setDisclosureMessage] = useState('공시 조회 전 · OpenDART 무료 인증키 필요')
  const [watchlistText, setWatchlistText] = useState(() => localStorage.getItem('kb-trader-watchlist') || '')
  const [activePage, setActivePage] = useState<'dashboard' | 'auto' | 'analytics' | 'news' | 'paper' | 'notifications' | 'live' | 'manual'>(() => new URLSearchParams(window.location.search).get('page') === 'notifications' ? 'notifications' : 'dashboard')
  const [autoHeartbeat, setAutoHeartbeat] = useState(() => Date.now())
  const [serverMode, setServerMode] = useState(true)
  useEffect(() => {
    const refreshStatus = () => setAutoHeartbeat(Date.now())
    window.addEventListener(AUTO_EVENT, refreshStatus)
    window.addEventListener(CLOUD_SYNC_EVENT, refreshStatus)
    window.addEventListener('storage', refreshStatus)
    const timer = window.setInterval(refreshStatus, 30_000)
    return () => {
      window.removeEventListener(AUTO_EVENT, refreshStatus)
      window.removeEventListener(CLOUD_SYNC_EVENT, refreshStatus)
      window.removeEventListener('storage', refreshStatus)
      window.clearInterval(timer)
    }
  }, [])

  async function login(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setError('')
    try {
      const response = await fetch(API + '/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password }) })
      const result = await response.json()
      if (!response.ok || !result.success) { setError(result.message || '로그인 실패'); return }
      sessionStorage.setItem('kb-trader-session', result.token); setToken(result.token); setPassword('')
    } catch { setError('서버에 연결하지 못했습니다.') }
  }

  function refresh(): Promise<void> {
    if (accountPendingRef.current) return accountPendingRef.current
    if (Date.now() < accountNextRefreshRef.current) {
      setMessage(previous => previous.includes('실패')
        ? previous + (previous.includes('재조회 보류') ? '' : ' · KB 재조회 보류 중')
        : previous)
      return Promise.resolve()
    }
    const current = refreshAccountOnce()
    accountPendingRef.current = current
    return current.finally(() => {
      if (accountPendingRef.current === current) accountPendingRef.current = null
    })
  }

  async function refreshAccountOnce() {
    setLoading(true)
    setMessage('KB증권 계좌 조회 중...')
    setDepositMessage('예수금 조회 중...')
    // Do not expose API tokens, account identifiers, or raw response bodies.
    const failures: string[] = []
    let sessionExpired = false
    let batchFailure = ''
    // One shared refresh for every menu. The Worker returns each KB read independently.
    // No live-order execution uses these browser values.
    const accountBatch = fetch(API + '/api/kb/account-batch', {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + token },
      signal: AbortSignal.timeout(50_000),
    }).then(async response => {
      if (response.status === 401) return { expired: true }
      const payload = await response.json()
      if (!response.ok || payload?.success !== true || !payload.results)
        throw Error(String(payload?.message || '계좌 일괄 조회 실패'))
      return payload
    })
    const requestAccount = async (endpoint: 'holdings' | 'valuation' | 'deposit', label: string): Promise<any | null> => {
      try {
        const batch = await accountBatch
        if (batch.expired) {
          sessionExpired = true
          failures.push(label + ': 로그인 세션 만료 (HTTP 401)')
          return null
        }
        const result = batch.results?.[endpoint]
        if (!result || result.success !== true) {
          const reason = String(result?.message || 'API 조회 실패').slice(0, 180)
          const status = Number(result?.status) || 502
          failures.push(label + ': ' + reason + ' (HTTP ' + status +
            (result?.stage ? ', 단계 ' + String(result.stage).slice(0, 50) : '') + ')')
          return null
        }
        return result
      } catch (error) {
        batchFailure = error instanceof Error && error.name === 'TimeoutError'
          ? '계좌 조회 서버 응답 시간 초과'
          : '계좌 조회 요청 실패'
        return null
      }
    }
    try {
      const holdingsResult = await requestAccount('holdings', '보유 종목')
      if (holdingsResult) {
        const rows = holdingsResult.data?.dataBody?.Record1
        if (Array.isArray(rows)) {
          setHoldings(rows.map((row: any) => ({
            name: row.is_nm || '종목명 없음', code: row.is_no || '',
            quantity: Number(row.gnrl_q || 0), orderable: Number(row.ordr_psbl_q || 0),
          })))
        } else {
          failures.push('보유 종목: 응답 Record1 형식 확인 필요')
        }
      }

      if (!sessionExpired) {
        const valuationResult = await requestAccount('valuation', '계좌 평가')
        if (valuationResult) {
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
          const valuationRows = valuationBody.Record1
          if (Array.isArray(valuationRows) && valuationRows.length) {
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
      }

      if (!sessionExpired) {
        const depositResult = await requestAccount('deposit', '예수금')
        if (depositResult) {
          setDeposit(depositResult.data?.dataBody || {})
          setDepositMessage('예수금 조회 성공 · ' + new Date().toLocaleString('ko-KR'))
        } else {
          setDeposit(null)
          setDepositMessage(batchFailure || failures.find(item => item.startsWith('예수금:')) || '예수금 조회 실패')
        }
      }
      if (sessionExpired) {
        logout()
        setError('세션이 만료되었습니다. 다시 로그인해 주세요.')
        return
      }
      setMessage(batchFailure || (failures.length ? '일부 계좌 조회 실패 · ' + failures.join(' / ') : '마지막 조회: ' + new Date().toLocaleString('ko-KR')))
    } finally {
      // A manual refresh within this window reuses the shared menu state,
      // rather than creating new provider sessions during an outage.
      if (!sessionExpired) accountNextRefreshRef.current =
        Date.now() + (batchFailure || failures.length ? 15_000 : 10_000)
      setLoading(false)
    }
  }

  async function runAiAnalysis() {
    setAiLoading(true); setAiMessage('Cloudflare AI와 Gemini가 동일한 계좌 데이터를 동시에 분석하고 있습니다.'); setCloudflareAnalysis(''); setGeminiAnalysis('')
    try {
      const response = await fetch(API + '/api/ai/compare', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token },
        body: JSON.stringify({ holdings, accountSummary, marketData: marketStocks.map(stock => ({ code: stock.code, name: stock.name, price: stock.price, changeRate: stock.changeRate, volume: stock.volume, investorDays: getInvestorDays(stock) })) }),
      })
      const result = await response.json()
      if (response.status === 401) { logout(); setError('세션이 만료되었습니다. 다시 로그인해 주세요.'); return }
      if (!response.ok || !result.success) { setAiMessage(result.message || 'AI 분석에 실패했습니다.'); return }
      const cloud = result.results?.cloudflare
      const gemini = result.results?.gemini
      setCloudflareAnalysis(cloud?.analysis || 'Cloudflare AI 결과가 없습니다.')
      setGeminiAnalysis(gemini?.analysis || 'Gemini 결과가 없습니다.')
      setAiMessage('비교 분석 완료 · ' + new Date(result.checked_at).toLocaleString('ko-KR') + ' · 두 모델에 동일한 계좌 데이터 전달' + (marketStocks.length ? ' · 최근 수집한 시장·수급 데이터 포함' : ' · 시장 데이터 미수집'))
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
      setMarketCheckedAt(result.checked_at || '')
      setSignalSnapshot([])
      setSignalCheckedAt('')
      setMarketDataMessage((result.message || 'KB증권 시장 데이터 수집 완료') + ' · ' + result.requested + '종목 · IVU10140 현재가 / IVU10430 투자자 동향 · ' + new Date(result.checked_at).toLocaleString('ko-KR'))
    } catch {
      setMarketDataMessage('시장 데이터 서버 연결 또는 응답 처리에 실패했습니다.')
    } finally {
      setMarketDataLoading(false)
    }
  }

  async function collectMarketCatalysts(): Promise<CatalystSnapshot> {
    const headers = { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token }
    // Briefing AI is intentionally skipped. This refreshes only published RSS headlines
    // and official DART filings; neither AI-written text nor headline rumors make orders.
    const [newsResult, dartResult] = await Promise.allSettled([
      fetch(API + '/api/market/research', {
        method: 'POST', headers,
        body: JSON.stringify({ holdings: [], watchlist: [], disclosures: [], skip_ai: true }),
        signal: AbortSignal.timeout(22_000),
      }).then(async response => ({ ok: response.ok, data: await response.json() })),
      fetch(API + '/api/market/disclosures', {
        method: 'POST', headers, body: JSON.stringify({ complete: true }),
        signal: AbortSignal.timeout(80_000),
      }).then(async response => ({ ok: response.ok, data: await response.json() })),
    ])
    const rss = newsResult.status === 'fulfilled' ? newsResult.value : null
    const dart = dartResult.status === 'fulfilled' ? dartResult.value : null
    const rssData = rss?.data as Record<string, any> | undefined
    const dartData = dart?.data as Record<string, any> | undefined
    const newsSources = Array.isArray(rssData?.diagnostics)
      ? rssData.diagnostics.filter((item: any) => item.status === 200 && Number(item.valid_count || 0) > 0).length : 0
    const newsOk = !!rss?.ok && rssData?.success === true && newsSources > 0
    const dartOk = !!dart?.ok && dartData?.success === true
    const dartComplete = dartOk && dartData?.complete === true
    const articles: MarketArticle[] = newsOk && Array.isArray(rssData?.articles)
      ? rssData.articles.filter((item: any) => item && typeof item.title === 'string')
        .slice(0, 200).map((item: any) => ({
          title: item.title.slice(0, 230), source: String(item.source || '').slice(0, 70),
          link: String(item.link || '').slice(0, 500), published_at: item.published_at || null,
        })) : []
    const disclosures: MarketDisclosure[] = dartOk && Array.isArray(dartData?.disclosures)
      ? dartData.disclosures.filter((item: any) => item && /^\d{6}$/.test(String(item.stock_code)))
        .slice(0, 2500).map((item: any) => ({
          company: String(item.company || '').slice(0, 100),
          stock_code: String(item.stock_code), title: String(item.title || '').slice(0, 230),
          date: String(item.date || ''), receipt_no: String(item.receipt_no || ''),
          link: String(item.link || '').slice(0, 500),
        })) : []
    const message = '언론 RSS ' + (newsOk ? articles.length + '건' : '수집 실패')
      + ' · DART ' + (dartOk ? disclosures.length + '/' + Number(dartData?.total_count || 0) + '건' : '수집 실패')
      + (dartComplete ? ' · 공시 페이지 확인' : ' · 공시 불완전')
      + (!newsOk || !dartComplete ? ' · 신규 매수 보류(보유종목 매도 감시는 유지)' : '')
    const value: CatalystSnapshot = {
      checkedAt: new Date().toISOString(), newsOk, dartOk, dartComplete,
      newsSources, dartReported: Number(dartData?.total_count || 0),
      articles, disclosures, message,
    }
    writeCatalystSnapshot(value)
    setCatalysts(value)
    setCatalystSummary(message)
    return value
  }

  async function loadBroadMarketData() {
    if (marketScanRef.current) return
    marketScanRef.current = true
    setMarketDataLoading(true)
    setMarketDataMessage('코스피·코스닥 공개 수급 데이터에서 후보를 선정하고 KB증권 시세로 검증 중...')
    try {
      const discoveryResponse = await fetch(API + '/api/market/discover', {
        method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token },
        body: JSON.stringify({}),
      })
      const discovery = await discoveryResponse.json()
      if (!discoveryResponse.ok || !discovery.success || !Array.isArray(discovery.candidates)) {
        setMarketDiscoveryInfo('전체시장 수급 수집 실패 · ' + (discovery.message || '데이터를 받지 못했습니다.') + ' · ' + (discovery.diagnostics || []).join(' / '))
        setMarketDataMessage('전체시장 수급 탐색 실패 · 기존 시세 데이터 유지')
        return
      }
      const candidates = discovery.candidates.filter((item: any) => /^\d{6}$/.test(String(item.code)) && !/ETF|ETN|레버리지|인버스/.test(String(item.name)))
      if (!candidates.length) { setMarketDiscoveryInfo('사용 가능한 일반주 후보가 없습니다.'); return }
      const auto = readAutoAccount()
      // Always re-quote watched entries and auto positions; otherwise rotating 10-stock batches
      // never revisit a signal on the next cycle and cannot simulate its trigger/stop.
      const pinned = [...auto.positions, ...auto.pending]
        .filter(item => /^\d{6}$/.test(item.code))
        .filter((item, index, all) => all.findIndex(other => other.code === item.code) === index)
        .slice(0, 30)
        .map(item => ({ code: item.code, name: item.name }))
      const selected = [...pinned]
      // Rank is computed from the public coverage set, not 50 randomly rotating symbols.
      for (const item of candidates) {
        if (selected.length >= 50) break
        if (!selected.some(stock => stock.code === item.code)) selected.push({
          code: item.code, name: item.name,
        })
      }
      const catalystTask = collectMarketCatalysts()
      // Worker accepts at most 10 stocks per request. Do not change that API limit.
      // Use the first successful batch timestamp for conservative paper-trade freshness.
      const collected: MarketStock[] = []
      let firstCheckedAt = ''
      const batchErrors: string[] = []
      // At most two investor-flow requests in parallel; each Worker call handles
      // ten symbols and shares one KB token. Avoid serially blocking fast exits.
      const batches = Array.from({ length: Math.ceil(selected.length / 10) },
        (_, index) => ({ index, stocks: selected.slice(index * 10, index * 10 + 10) }))
      for (let i = 0; i < batches.length; i += 2) {
        const replies = await Promise.all(batches.slice(i, i + 2).map(async batch => {
          try {
            const response = await fetch(API + '/api/market/investor-flow', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token },
              body: JSON.stringify({ stocks: batch.stocks }),
              signal: AbortSignal.timeout(80_000),
            })
            const result = await response.json()
            if (!response.ok || !result.success || !Array.isArray(result.results)) {
              return { index: batch.index, results: [] as MarketStock[], checkedAt: '',
                error: String(result.message || 'KB 조회 실패') }
            }
            return { index: batch.index, results: result.results as MarketStock[],
              checkedAt: String(result.checked_at || ''), error: '' }
          } catch (error) {
            return { index: batch.index, results: [] as MarketStock[], checkedAt: '',
              error: error instanceof Error ? error.message : '네트워크 오류' }
          }
        }))
        for (const reply of replies) {
          if (reply.error) batchErrors.push((reply.index + 1) + '차: ' + reply.error)
          else {
            collected.push(...reply.results)
            if (!firstCheckedAt) firstCheckedAt = reply.checkedAt
          }
        }
      }
      if (!collected.length) {
        setMarketDiscoveryInfo('KB 정밀 조회 실패 · ' + batchErrors.join(' / '))
        setMarketDataMessage('시장 후보 조회 실패 · 이전 시세 데이터 유지')
        return
      }
      const snapshot = await catalystTask
      const checkedAt = firstCheckedAt || new Date(0).toISOString()
      const evaluated = applyCatalystGate(generateTradeSignals(collected, SIGNAL_MAX_POSITION_WON), snapshot)
      setMarketStocks(collected)
      setMarketCheckedAt(checkedAt)
      setAutoSignals(evaluated.signals)
      writeScreeningSnapshot({ checkedAt, signals: evaluated.signals })
      setSignalSnapshot([])
      setSignalCheckedAt('')
      // Evaluate atomically after BOTH quote analysis and news/DART validation.
      // A stale or inaccessible information source stops new entries, never exits.
      // A remote market scan can outlive a previous lease. Revalidate the D1
      // single-trader permission immediately before committing any paper fills.
      if (!isServerPaperMode() && canExecutePaperTrade() && await verifyTradingLease()) {
        const latest = readAutoAccount()
        if (latest.enabled && latest.lastCycle !== checkedAt && canExecutePaperTrade()) {
          writeAutoAccount(runAutoCycle(latest, evaluated.signals, collected, checkedAt))
        }
      }
      setMarketDiscoveryInfo(discovery.coverage + ' · 데이터 기준일 ' + (discovery.market_as_of || '미확인') + ' · 데이터 포함 ' + (discovery.universe_count || 0) + '종목 · 후보 ' + candidates.length + '종목 · 이번 정밀 검사 ' + collected.length + '/' + selected.length + '종목(보유·감시 ' + pinned.length + '종목 포함) · 수급 상위 후보 순위 기준 · ' + [...(discovery.diagnostics || []), ...batchErrors].join(' / '))
      setMarketDataMessage('공개 시장 수급 후보 정밀 검사 ' + collected.length + '/50종목 · '
        + (evaluated.ready ? '뉴스·공시 확인' : '뉴스·공시 확인 불가 · 신규 매수 보류')
        + ' · 관찰 ' + evaluated.allowed + '종목, 매수 보류 ' + evaluated.blocked + '종목')
    } catch (error) {
      setMarketDiscoveryInfo('전체시장 수급 또는 KB API 연결 오류: ' + (error instanceof Error ? error.message : '요청 실패'))
      setMarketDataMessage('전체시장 수급 후보 탐색 실패 · 기존 데이터 유지')
    } finally { marketScanRef.current = false; setMarketDataLoading(false) }
  }
  async function refreshTrackedPrices() {
    if (!token || fastWatchBusyRef.current || !canExecutePaperTrade() || !isKrxSession()
      || Date.now() < fastWatchBackoffRef.current) return
    const account = readAutoAccount()
    if (!account.enabled) return
    const tracked = selectAutoWatchStocks(account)
    if (!tracked.length) return
    fastWatchBusyRef.current = true
    const valid: { code: string; name: string; price: number }[] = []
    const failures: string[] = []
    let rateLimited = false
    try {
      // One request per 30-second watch cycle. The Worker caches OAuth once
      // and fetches all five KB prices concurrently, avoiding 5 × sequential latency.
      // 40s client budget > 12s OAuth + 20s upstream KB quote timeout.
      try {
        const response = await fetch(API + '/api/kb/quotes', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token },
          body: JSON.stringify({ stocks: tracked }),
          signal: AbortSignal.timeout(40_000),
          cache: 'no-store',
        })
        if (response.status === 401) {
          logout()
          setError('시세 감시 중 로그인 세션이 만료됐습니다. 다시 로그인해 주세요.')
          return
        }
        const result = await response.json()
        rateLimited = response.status === 429 || result.rate_limited === true
        if (!response.ok || !result.success || !Array.isArray(result.results)) {
          failures.push(rateLimited ? 'KB 호출 제한' :
            'KB 시세 응답 오류: ' + String(result.message || '일괄 조회 실패').slice(0, 130))
        } else {
          const remaining = new Map(tracked.map(item => [item.code, item]))
          for (const item of result.results as Array<{
            code: string; name: string; price: number | null; checked_at: string;
            error: string; rate_limited: boolean; token_expired: boolean
          }>) {
            const stock = remaining.get(item.code)
            if (!stock) continue
            remaining.delete(item.code)
            if (item.rate_limited) rateLimited = true
            const price = item.price == null ? NaN : Number(item.price)
            const checked = Date.parse(item.checked_at || '')
            if (item.error || !Number.isFinite(price) || price <= 0 ||
              !Number.isFinite(checked) || checked > Date.now() + 15_000 ||
              Date.now() - checked > 120_000) {
              failures.push(stock.name + ': ' + (item.error || 'KB 현재가 유효성 오류'))
              continue
            }
            valid.push({ code: item.code, name: stock.name, price })
          }
          if (remaining.size) failures.push('응답 누락 ' + remaining.size + '종목')
          if (result.token_expired) failures.push('KB 인증 만료 · 다음 검사에서 토큰 재발급')
        }
      } catch (error) {
        const timedOut = error instanceof Error &&
          /abort|timeout/i.test(error.name + ' ' + error.message)
        failures.push(timedOut ? '시세 일괄조회 40초 초과 · KB 응답 지연'
          : '시세 일괄조회 연결 오류 · ' + (error instanceof Error ? error.message.slice(0, 100) : '요청 실패'))
      }
      if (rateLimited) fastWatchBackoffRef.current = Date.now() + 180_000
      // A manual sale, stop request or broad scan can occur during the network reads.
      // Re-read account after awaits and never write stale positions back over user actions.
      // Check the server lease after all asynchronous KB quote reads, then
      // re-read local state to avoid using a stale pre-network portfolio.
      if (isServerPaperMode() || !canExecutePaperTrade() || !(await verifyTradingLease())) return
      const latest = readAutoAccount()
      if (!latest.enabled || !isKrxSession() || !canExecutePaperTrade()) return
      if (!valid.length) {
        writeAutoAccount(recordAutoWatchError(latest,
          rateLimited ? 'KB API 호출 제한 · 3분 후 재시도' : failures.join(' / ') || '조회된 가격 없음',
          tracked.length))
        return
      }
      const now = new Date()
      const freshContext = readCatalystSnapshot()
      const deferredEntries = latest.pending.filter(item =>
        rateLimited || !catalystAllowsPending(item.code, item.name, freshContext, now))
      const allowedEntries = latest.pending.filter(item =>
        !rateLimited && catalystAllowsPending(item.code, item.name, freshContext, now))
      // Filter pending entries only for this evaluation, then retain blocked
      // watch records for a future fresh-context scan. Held positions may EXIT regardless.
      const input = deferredEntries.length ? { ...latest, pending: allowedEntries } : latest
      const evaluated = runAutoWatchCycle(input, valid, now.toISOString(), now, undefined, tracked.length)
      if (evaluated !== input) {
        const next = deferredEntries.length ? { ...evaluated,
          pending: [...evaluated.pending, ...deferredEntries].filter(item =>
            !evaluated.positions.some(position => position.code === item.code)),
        } : evaluated
        if (failures.length && next.watchStatus) {
          next.watchStatus = {
            ...next.watchStatus,
            status: '일부 오류',
            message: next.watchStatus.message + ' · ' + failures.join(' / '),
          }
        }
        if (deferredEntries.length && next.watchStatus) {
          next.watchStatus.message += ' · '
            + (rateLimited ? 'KB 호출 제한' : '뉴스·공시 확인 전 대기 진입') + ' '
            + deferredEntries.length + '종목 신규 진입 보류 (익절·손절은 가능한 시세로 감시)'
        }
        writeAutoAccount(next)
      }
    } finally {
      fastWatchBusyRef.current = false
    }
  }
  fastWatchRunner.current = refreshTrackedPrices

  marketScanRunner.current = loadBroadMarketData
  useEffect(() => {
    if (!token) return
    let cancelled = false
    let cleanupLegacy: (()=>void) | undefined
    let interval: number | undefined
    void (async () => {
      try {
        const status = await serverPaperAction(token,'status')
        if (cancelled) return
        if (status.migrated) {
          setMarketCheckedAt(status.snapshot?.account.lastCycle || '')
          setServerMode(true)
          // The previous 15-second poll repeatedly requested the 665KiB+
          // canonical D1 ledger whenever Cron advanced its revision.
          // Keep the Cron monitor responsive with lightweight heartbeats,
          // and refresh the full immutable snapshot once every two minutes.
          let polls = 0
          let polling = false
          interval = window.setInterval(() => {
            if (cancelled || polling) return
            polling = true
            const action = ++polls % 4 === 0 ? 'status' : 'heartbeat'
            void serverPaperAction(token,action)
              .then(data => { if (!cancelled && action === 'status') setMarketCheckedAt(data.snapshot?.account.lastCycle || '') })
              .catch(error => { if (!cancelled) setServerPaperError(error instanceof Error ? error.message : '서버 상태 조회 실패') })
              .finally(() => { polling = false })
          }, 30_000)
        } else {
          setServerPaperMode(false)
          setServerMode(false)
          cleanupLegacy = startCloudAutoSync(token)
        }
      } catch (error) {
        // Fail closed: never start the legacy browser engine when the server
        // account status is unknown. Show an explicit retry instead of hiding it.
        if (cancelled) return
        setServerPaperMode(true)
        setServerMode(true)
        setServerPaperError(error instanceof Error ? error.message : '서버 상태 조회 실패')
      }
    })()
    return () => {
      cancelled = true
      cleanupLegacy?.()
      if (interval !== undefined) window.clearInterval(interval)
    }
  }, [token])

  useEffect(() => {
    if (!token) return
    const poll = () => {
      if (isServerPaperMode() || !isKrxSession() || !readAutoAccount().enabled || !canExecutePaperTrade() || marketScanRef.current) return
      void marketScanRunner.current()
    }
    // Market scans no longer depend on the visible page. Browser must remain open.
    poll()
    // New tabs wait for D1 lease verification; start scanning immediately once
    // the first exclusive lease arrives rather than delaying for five minutes.
    let wasReady = canExecutePaperTrade()
    const onCloudReady = () => {
      const ready = canExecutePaperTrade()
      if (ready && !wasReady) poll()
      wasReady = ready
    }
    window.addEventListener(CLOUD_SYNC_EVENT, onCloudReady)
    const timer = window.setInterval(poll, 5 * 60 * 1000)
    return () => {
      window.clearInterval(timer)
      window.removeEventListener(CLOUD_SYNC_EVENT, onCloudReady)
    }
  }, [token])

  useEffect(() => {
    if (!token) return
    // Thirty-second monitoring for held/queued securities, independent of page navigation.
    // Browser tabs can throttle timers; this is not a server-side stop order.
    const poll = () => { if (!isServerPaperMode() && readAutoAccount().enabled && canExecutePaperTrade()) void fastWatchRunner.current() }
    poll()
    let wasReady = canExecutePaperTrade()
    const onCloudReady = () => {
      const ready = canExecutePaperTrade()
      if (ready && !wasReady) poll()
      wasReady = ready
    }
    window.addEventListener(CLOUD_SYNC_EVENT, onCloudReady)
    const timer = window.setInterval(poll, FAST_QUOTE_INTERVAL_MS)
    // Tab timers may pause in the background. Resume promptly when it becomes visible.
    const resume = () => { if (document.visibilityState === 'visible') poll() }
    document.addEventListener('visibilitychange', resume)
    return () => {
      window.clearInterval(timer)
      window.removeEventListener(CLOUD_SYNC_EVENT, onCloudReady)
      document.removeEventListener('visibilitychange', resume)
    }
  }, [token])

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

  function logout() {
    sessionStorage.removeItem('kb-trader-session')
    accountPendingRef.current = null
    accountNextRefreshRef.current = 0
    setToken('')
    setHoldings([])
    setDeposit(null)
    setAccountSummary(null)
  }

  const baseHealth = getAutoHealth(readAutoAccount(), new Date(autoHeartbeat), marketDataLoading, marketDataMessage)
  const cloudHealth = getCloudSyncState()
  const autoHealth = readAutoAccount().enabled && ['blocked', 'error'].includes(cloudHealth.phase)
    ? { ...baseHealth, tone: 'warning' as const, label: 'D1 실행권 오류 · 가상체결 차단',
      detail: cloudHealth.message }
    : readAutoAccount().enabled && isKrxSession(new Date(autoHeartbeat))
      && baseHealth.tone !== 'warning' && !catalystReady(catalysts, new Date(autoHeartbeat))
      ? { ...baseHealth, tone: 'warning' as const, label: '뉴스·공시 신규 매수 보류',
        detail: '뉴스·공시 수집이 미완료입니다. 기존 보유 종목의 가상매도 감시는 지속합니다.' }
      : baseHealth

  if (!token) return <main className="login-page"><form className="login-card" onSubmit={login}><div className="brand-mark">KB</div><h1>KB AI TRADER</h1><p>대시보드 비밀번호로 로그인하세요.</p><input type="password" value={password} onChange={event => setPassword(event.target.value)} placeholder="대시보드 비밀번호" required /><button type="submit">로그인</button>{error && <p className="error">{error}</p>}</form></main>

  return <div className="app-shell"><aside className="sidebar"><div className="brand"><div className="brand-mark">KB</div><div><strong>KB AI TRADER</strong><span>SWING TERMINAL</span></div></div><nav className="nav-list"><button className={'nav-item ' + (activePage === 'dashboard' ? 'active' : '')} onClick={() => setActivePage('dashboard')}>계좌 대시보드</button><button className={'nav-item ' + (activePage === 'auto' ? 'active' : '')} onClick={() => setActivePage('auto')}>자동 가상매매</button><button className={'nav-item ' + (activePage === 'analytics' ? 'active' : '')} onClick={() => setActivePage('analytics')}>매매 분석</button><button className={'nav-item ' + (activePage === 'live' ? 'active' : '')} onClick={() => setActivePage('live')}>실계좌 자동매매</button><button className={'nav-item ' + (activePage === 'manual' ? 'active' : '')} onClick={() => setActivePage('manual')}>지정가 주문</button><button className={'nav-item ' + (activePage === 'news' ? 'active' : '')} onClick={() => setActivePage('news')}>시장 뉴스</button><button className={'nav-item ' + (activePage === 'notifications' ? 'active' : '')} onClick={() => setActivePage('notifications')}>알림 센터</button><div className="nav-item">보유 종목</div><button className={'nav-item ' + (activePage === 'paper' ? 'active' : '')} onClick={() => setActivePage('paper')}>가상 트레이딩</button></nav><div className="sidebar-bottom"><div className="security-card">실주문 상태 · 자동매매 메뉴에서 확인</div><button className="nav-item" onClick={logout}>로그아웃</button></div></aside>
    <main className="main"><header className="topbar"><div className="breadcrumbs">WORKSPACE / <b>{activePage === 'dashboard' ? '계좌 현황' : activePage === 'news' ? '시장 뉴스' : activePage === 'auto' ? '자동 가상매매' : activePage === 'analytics' ? '매매 분석' : activePage === 'notifications' ? '알림 센터' : activePage === 'live' ? '실계좌 자동매매' : activePage === 'manual' ? '지정가 주문' : '가상 트레이딩'}</b></div><div className="top-actions">
      <button type="button" className={'auto-global-status auto-global-status-' + autoHealth.tone}
        onClick={() => setActivePage('auto')} title={autoHealth.detail}>
        <span className="auto-state-dot" /> 자동 가상매매 · {autoHealth.label}
      </button>
      <div className="connection">KB증권 계좌 연동</div>
    </div></header><div className="content">{activePage === 'dashboard' && <section className="page-heading"><div><div className="eyebrow">PERSONAL TRADING SPACE</div><h1>계좌 현황</h1><p>KB증권 실계좌 보유 종목 조회</p></div><button className="outline-button" onClick={refresh} disabled={loading}>{loading ? '조회 중...' : '계좌 새로고침'}</button></section>}
      {activePage === 'manual' ? <ManualLimitOrder token={token} /> : activePage === 'live' ? <LiveTrial token={token} holdings={holdings} accountSummary={accountSummary} deposit={deposit} depositMessage={depositMessage} accountMessage={message} accountLoading={loading} onRefreshAccount={refresh} /> : activePage === 'notifications' ? <NotificationCenter token={token} /> : activePage === 'paper' ? (serverMode ? <section className="panel auto-main-panel"><h2>서버 가상매매 원장</h2><p>서버 실행 모드입니다. 기존 브라우저 수동 매매는 데이터 충돌 방지를 위해 비활성화했습니다. 자동 가상매매 및 매매 분석 메뉴에서 서버 보유종목과 거래 기록을 확인하세요.</p></section> : <PaperTrading token={token} />) : activePage === 'analytics'
        ? <TradingAnalytics
            signals={autoSignals.length ? autoSignals : generateTradeSignals(marketStocks, SIGNAL_MAX_POSITION_WON)}
            catalysts={catalysts}
            marketCoverage={marketDiscoveryInfo}
            liveCheckedAt={marketCheckedAt}
            token={token}
            onGoAuto={() => setActivePage('auto')}
          /> : activePage === 'auto'
        ? <AutoPaperLab
            catalysts={catalysts}
            catalystSummary={catalystSummary}
            checkedAt={marketCheckedAt}
            token={token}
            scanLoading={marketDataLoading}
            scanMessage={marketDataMessage}
            onStart={() => { if (!isServerPaperMode() && isKrxSession() && !marketScanRef.current) void marketScanRunner.current() }}
            onOpenAnalytics={() => setActivePage('analytics')}
          />
        : activePage === 'dashboard' ? <>
      <section className="section-title"><div><h2>보유 종목</h2><span>LIVE POSITIONS</span></div><span>{message}</span></section><div className="stats-grid">
        <article className="stat-card"><div className="stat-top">총 매입금액</div><div className="stat-value">{accountSummary ? accountSummary.purchaseAmount.toLocaleString('ko-KR') + '원' : '-'}</div><div className="stat-foot">보유 종목 매입금액 합계</div></article>
        <article className="stat-card primary-stat"><div className="stat-top">총 평가금액</div><div className="stat-value">{accountSummary ? accountSummary.valuationAmount.toLocaleString('ko-KR') + '원' : '-'}</div><div className="stat-foot">현재 보유 자산 평가금액</div></article>
        <article className="stat-card"><div className="stat-top">총 평가손익</div><div className={'stat-value ' + (accountSummary && accountSummary.profitLoss < 0 ? 'negative-value' : 'positive-value')}>{accountSummary ? (accountSummary.profitLoss > 0 ? '+' : '') + accountSummary.profitLoss.toLocaleString('ko-KR') + '원' : '-'}</div><div className="stat-foot">평가금액 - 매입금액 기준</div></article>
        <article className="stat-card"><div className="stat-top">전체 수익률</div><div className={'stat-value ' + (accountSummary && accountSummary.yieldRate < 0 ? 'negative-value' : 'positive-value')}>{accountSummary ? (accountSummary.yieldRate > 0 ? '+' : '') + accountSummary.yieldRate.toFixed(2) + '%' : '-'}</div><div className="stat-foot">KB증권 계좌자산평가 응답 기준</div></article>
      </div>
      
      <section className="panel ai-panel"><div className="panel-heading"><div><h3>AI 분석 비교</h3><span>PARALLEL MODEL REVIEW · SAME ACCOUNT DATA</span></div><button className="outline-button" onClick={runAiAnalysis} disabled={aiLoading || !holdings.length}>{aiLoading ? '두 AI 분석 중...' : '두 AI 동시 분석'}</button></div><p className="ai-message">{aiMessage}</p><div className="ai-compare-grid"><article className="ai-result-card"><h4>Cloudflare AI <small>Llama 3.1 8B</small></h4>{cloudflareAnalysis ? <div className="ai-analysis">{cloudflareAnalysis}</div> : <div className="ai-empty">분석 결과 대기 중</div>}</article><article className="ai-result-card"><h4>Google Gemini <small>Gemini 3.8 Flash</small></h4>{geminiAnalysis ? <div className="ai-analysis">{geminiAnalysis}</div> : <div className="ai-empty">분석 결과 대기 중</div>}</article></div><div className="ai-consensus-note">공통 의견은 두 분석에서 동일 종목코드와 판단이 겹치는지 확인해 판단합니다. 현재는 보유 종목만 비교하며, 신규 종목 발굴은 시장 데이터 연결 후 추가합니다.</div></section>

      <section className="panel holdings-panel"><div className="panel-heading"><div><h3>주문 가능 현금</h3><span>ORDERABLE CASH · SSQM0004</span></div><span>{depositMessage}</span></div>{deposit ? <div className="cash-summary"><div className="cash-label">현금 기준 주문 가능 금액</div><div className="cash-value">{deposit.ordr_psbl_csh !== undefined ? Number(String(deposit.ordr_psbl_csh).replace(/^0+(?=\\d)/, '')).toLocaleString('ko-KR') + '원' : '응답 필드 확인 필요'}</div><div className="cash-foot">KB증권 예수금내역의 주문가능현금 필드 기준</div><details className="raw-details"><summary>원본 응답 확인</summary><div className="table-wrap"><table><thead><tr><th>응답 필드</th><th>값</th></tr></thead><tbody>{Object.entries(deposit).filter(([, value]) => value === null || ['string','number','boolean'].includes(typeof value)).map(([key, value]) => <tr key={key}><td>{key}</td><td>{String(value ?? '-')}</td></tr>)}</tbody></table></div></details></div> : <div className="empty-row">{depositMessage}</div>}</section>
      <section className="panel holdings-panel"><div className="panel-heading"><div><h3>보유 종목</h3><span>POSITIONS</span></div></div><div className="table-wrap"><table><thead><tr><th>종목명</th><th>종목코드</th><th>보유 수량</th><th>주문 가능 수량</th><th>평균 매입가</th><th>현재가</th><th>평가금액</th><th>평가손익</th><th>수익률</th></tr></thead><tbody>{holdings.length ? holdings.map(item => <tr key={item.code}><td>{item.name}</td><td>{item.code}</td><td>{item.quantity.toLocaleString()}주</td><td>{item.orderable.toLocaleString()}주</td><td>{item.averagePrice ? item.averagePrice.toLocaleString() + '원' : '-'}</td><td>{item.currentPrice ? item.currentPrice.toLocaleString() + '원' : '-'}</td><td>{item.valuation ? item.valuation.toLocaleString() + '원' : '-'}</td><td>{item.profitLoss !== undefined ? item.profitLoss.toLocaleString() + '원' : '-'}</td><td>{item.yieldRate !== undefined ? item.yieldRate.toFixed(2) + '%' : '-'}</td></tr>) : <tr><td colSpan={9} className="empty-row"><div><b>{message}</b><span>조회 결과가 여기에 표시됩니다.</span></div></td></tr>}</tbody></table></div></section></> : <section className="news-page"><div className="page-heading"><div><div className="eyebrow">MARKET INTELLIGENCE</div><h1>시장 뉴스</h1><p>오늘 발행된 국내 증시·산업·글로벌 경제 뉴스를 분석합니다.</p></div><button className="outline-button" onClick={loadNews} disabled={newsLoading}>{newsLoading ? '뉴스 조회 중...' : '뉴스 새로고침'}</button></div><section className="panel news-panel"><div className="panel-heading"><div><h3>전체 시장 뉴스</h3><span>MARKET-WIDE NEWS · PUBLISHER RSS · TODAY KST</span></div></div><section className="panel disclosure-panel"><div className="panel-heading"><div><h3>관심 종목</h3><span>WATCHLIST · 종목명 또는 종목코드</span></div></div><textarea className="watchlist-input" value={watchlistText} onChange={event => { setWatchlistText(event.target.value); localStorage.setItem('kb-trader-watchlist', event.target.value) }} placeholder="예: 삼성전자, SK하이닉스&#10;또는 005930, 000660" rows={2} /><p className="news-query">쉼표 또는 줄바꿈으로 구분해 입력하세요. 시장 뉴스 새로고침 시 보유 종목과 함께 공시·뉴스 분석에 반영됩니다.</p></section><details className="news-advanced"><summary>매매 신호 상세 진단</summary><section className="panel disclosure-panel"><div className="panel-heading"><div><h3>자동 매매 신호 실험실</h3><span>RULE-BASED SIGNALS · RESEARCH ONLY · 실주문 금지</span></div><button className="outline-button" disabled={!marketStocks.length || marketDataLoading} onClick={() => { setSignalSnapshot(generateTradeSignals(marketStocks, SIGNAL_MAX_POSITION_WON)); setSignalCheckedAt(new Date().toLocaleString('ko-KR')) }}>신호 분석</button></div><p className="news-message">현재 수집한 최대 30종목을 시가·고가·저가·평균 체결가·거래대금으로 평가해. 장중 거래량 속도는 추정값으로 표시하고 점수에는 넣지 않아. 외국인 수급은 비누적 일별 응답 검증을 통과할 때만 보조 점수로 반영해. 종목당 참고 한도 200,000원, 손절 참고 -3%. 신호 분석 버튼은 주문을 실행하지 않아. {signalCheckedAt ? ' · 마지막 분석 ' + signalCheckedAt : ''}</p>{signalSnapshot.length ? <div className="signal-grid">{signalSnapshot.map(signal => <article className="signal-card" key={signal.code}><div className="signal-top"><strong>{signal.name} <small>{signal.code}</small></strong><span>{signal.status}</span></div><div className="signal-stats"><span>조건 점수 <b>{signal.score}</b></span><span>거래량 <b>{signal.volumeRatio !== null ? signal.volumeRatio.toFixed(2) + '배(마감)' : signal.volumePaceEstimate !== null ? signal.volumePaceEstimate.toFixed(2) + '배(추정)' : '비교 불가'}</b></span><span>외국인 관측 순매매 <b>{signal.foreignToday === null ? '-' : signal.foreignToday.toLocaleString('ko-KR')}</b></span></div><p>진입 관찰값 {signal.entryTrigger === null ? '-' : signal.entryTrigger.toLocaleString('ko-KR') + '원'} · 손절 참고 {signal.stopReference === null ? '-' : signal.stopReference.toLocaleString('ko-KR') + '원'} · 최대 {signal.maxQuantity}주</p><ul>{signal.reasons.map((reason, index) => <li key={index}>{reason}</li>)}</ul></article>)}</div> : <div className="ai-empty">시장 데이터를 수집한 후 '신호 분석'을 눌러 관찰 후보와 위험 신호를 확인해. 결과는 투자 권유나 주문 지시가 아니야.</div>}</section></details><details className="news-advanced"><summary>종목별 시세·수급 데이터 상세 조회</summary><section className="panel disclosure-panel"><div className="panel-heading"><div><h3>국내 주식 시장 데이터</h3><span>KB QUOTE · INVESTOR FLOW · 전체시장 수급 기반 후보 순환 검사</span></div><div className="market-actions"><button className="outline-button" onClick={() => void loadMarketData()} disabled={marketDataLoading}>{marketDataLoading ? '수집 중...' : '내 종목 수집'}</button><button className="outline-button" onClick={() => void loadBroadMarketData()} disabled={marketDataLoading}>{marketDataLoading ? '시장 탐색 중...' : '시장 전체 후보 탐색'}</button></div></div><p className="news-message">{marketDataMessage}</p><p className="news-query">{marketDiscoveryInfo} · 자동 가상매매 활성화 시 로그인 브라우저가 열려 있는 동안 장중 5분마다 순위 후보 자동 탐색</p>{marketStocks.length ? <div className="table-wrap market-data-table"><table><thead><tr><th>종목</th><th>현재가</th><th>전일 대비</th><th>등락률</th><th>누적 거래량</th><th>거래대금(추정)</th><th>투자자 순매매 (주, 일별)</th></tr></thead><tbody>{marketStocks.map(stock => <tr key={stock.code}><td>{stock.name}<small>{stock.code}</small></td><td>{stock.price ? stock.price.toLocaleString('ko-KR') + '원' : stock.quoteError || '-'}</td><td>{typeof stock.change === 'number' ? (stock.change > 0 ? '+' : '') + stock.change.toLocaleString('ko-KR') : stock.change ?? '-'}</td><td>{stock.changeRate != null ? (Number(stock.changeRate) > 0 ? '+' : '') + Number(stock.changeRate).toFixed(2) + '%' : '-'}</td><td>{typeof stock.volume === 'number' ? stock.volume.toLocaleString('ko-KR') : stock.volume ?? '-'}</td><td>{typeof stock.tradeValue === 'number' ? stock.tradeValue.toLocaleString('ko-KR') + '원' : '-'}</td><td>{stock.investorError ? <span className="market-investor-error">{stock.investorError}</span> : (stock.investor as any)?.out?.[0] ? <div className="market-investor-summary"><small>{(stock.investor as any).out[0].dt || ''}</small><span>개인 <b>{Number((stock.investor as any).out[0].indv || 0).toLocaleString('ko-KR')}</b></span><span>외국인 <b>{Number((stock.investor as any).out[0].fgnr || 0).toLocaleString('ko-KR')}</b></span><span>증권 <b>{Number((stock.investor as any).out[0].scrt || 0).toLocaleString('ko-KR')}</b></span><details className="market-flow-history"><summary>최근 5거래일 수급</summary>{getInvestorDays(stock).map(day => <div className="market-flow-day" key={day.dt}><small>{day.dt.slice(4, 6) + '/' + day.dt.slice(6, 8)}</small><span>개인 {day.indv.toLocaleString('ko-KR')}</span><span>외국인 {day.fgnr.toLocaleString('ko-KR')}</span><span>증권 {day.scrt.toLocaleString('ko-KR')}</span></div>)}</details></div> : '-'}</td></tr>)}</tbody></table></div> : <div className="ai-empty">시장 데이터 수집을 누르면 계좌 보유 종목과 관심 종목 최대 10개를 대상으로 현재가 및 투자자별 매매동향을 조회합니다.</div>}</section></details><section className="panel disclosure-panel"><div className="panel-heading"><div><h3>전자공시 · DART</h3><span>OFFICIAL DISCLOSURES · OPENDART API</span></div><button className="outline-button" onClick={loadDisclosures} disabled={disclosureLoading}>{disclosureLoading ? '공시 조회 중...' : '공시 새로고침'}</button></div><p className="news-message">{disclosureMessage}</p>{disclosures.length ? <div className="disclosure-list">{disclosures.slice(0, 30).map((item, index) => <article className="disclosure-item" key={item.receipt_no || index}><div className="news-item-top"><span>{item.company}{item.stock_code ? ' · ' + item.stock_code : ' · 비상장/기타'}{item.matched ? ' · 내 종목' : ''}{item.priority ? ' · ' + item.priority : ''}</span><span>{item.date ? item.date.slice(4, 6) + '-' + item.date.slice(6, 8) : ''}</span></div><a href={item.link} target="_blank" rel="noreferrer">{item.title}</a><div className="news-query">{item.reporter}{item.remark ? ' · ' + item.remark : ''}</div></article>)}</div> : <div className="ai-empty">공시 새로고침을 눌러 최근 3일간의 DART 공시를 확인하세요. 최초 사용 전 Cloudflare에 DART_API_KEY Secret 등록이 필요합니다.</div>}</section><p className="news-message">{newsMessage}</p>{marketAnalysis && <div className="market-analysis"><div className="market-analysis-title">AI 오늘의 시장 브리핑</div><div>{marketAnalysis}</div></div>}{newsDiagnostics.length > 0 && <div className="news-diagnostics">{newsDiagnostics.map((item, index) => <div key={index}>{item}</div>)}</div>}{news.length ? <div className="news-list">{news.map((item, index) => <article className="news-item" key={item.link + index}><div className="news-item-top"><span>{item.source}</span><span>{item.published_at ? new Date(item.published_at).toLocaleString('ko-KR', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }) : '시간 정보 없음'}</span></div><a href={item.link} target="_blank" rel="noreferrer">{item.title}</a><div className="news-query">검색: {item.query}</div></article>)}</div> : <div className="ai-empty">뉴스 새로고침을 누르면 오늘 발행된 국내외 시장·산업 뉴스를 수집하고 AI가 요약합니다.</div>}</section></section>}
      <footer><span>KB AI TRADER · 실계좌 주문 상태는 자동매매 메뉴에서 확인</span><span>LIVE ORDER STATUS</span></footer></div></main></div>
}