import type { TradeSignal } from './tradeSignals'

/** News headlines are research signals only; they are NOT validated earnings or orders. */
export type MarketArticle = {
  title: string
  source: string
  link: string
  published_at: string | null
}
export type MarketDisclosure = {
  company: string
  stock_code: string
  title: string
  date: string
  receipt_no: string
  link: string
}
export type CatalystSnapshot = {
  checkedAt: string
  newsOk: boolean
  dartOk: boolean
  dartComplete: boolean
  articles: MarketArticle[]
  disclosures: MarketDisclosure[]
  newsSources: number
  dartReported: number
  message: string
}
export const CATALYST_STORAGE_KEY = 'kb-trader-market-catalysts-v1'
const MAX_AGE_MS = 15 * 60_000
const NEWS_AGE_MS = 8 * 60 * 60_000
const FILING_AGE_MS = 3 * 24 * 60 * 60_000
const severe = /(횡령|배임|상장폐지|거래정지|매매정지|부도|회생절차|법정관리|감사의견.{0,7}(거절|부적정)|자본잠식|영업정지|불성실공시|분식회계|유상증자|전환사채|신주인수권부사채|CB발행|BW발행|대규모.{0,3}손실)/i
const material = /(공급계약|수주|잠정.{0,3}실적|영업실적|합병|인수|자기주식|자사주|신규시설|배당|소각|경영권|최대주주|투자판단)/i

function validTime(value: string | null | undefined, now: Date, maxAge: number): boolean {
  if (!value) return false
  const at = Date.parse(value)
  return Number.isFinite(at) && at <= now.getTime() + 60_000 && now.getTime() - at <= maxAge
}
function recentFiling(value: string, now: Date): boolean {
  if (!/^\d{8}$/.test(value)) return false
  const at = Date.parse(value.slice(0,4) + '-' + value.slice(4,6) + '-' + value.slice(6,8) + 'T00:00:00+09:00')
  return Number.isFinite(at) && at <= now.getTime() && now.getTime() - at <= FILING_AGE_MS
}
function articleMatchesCompany(title: string, name: string): boolean {
  // Never match generic 1–2 character tickers or substring of an unrelated code.
  const normalizedName = name.toLowerCase().replace(/\s+/g, '').trim()
  const normalizedTitle = title.toLowerCase().replace(/\s+/g, '')
  return normalizedName.length >= 3 && normalizedTitle.includes(normalizedName)
}
export function catalystReady(snapshot: CatalystSnapshot | null, now = new Date()): boolean {
  return !!snapshot && snapshot.newsOk && snapshot.dartOk && snapshot.dartComplete
    && validTime(snapshot.checkedAt, now, MAX_AGE_MS)
}
/** Used by the faster price-only watch: no new entry if fresh context is missing. */
export function catalystAllowsPending(
  code: string, name: string, snapshot: CatalystSnapshot | null, now = new Date(),
): boolean {
  if (!catalystReady(snapshot, now)) return false
  const badNews = snapshot!.articles.some(article =>
    validTime(article.published_at, now, NEWS_AGE_MS)
    && articleMatchesCompany(article.title, name) && severe.test(article.title))
  const badFilings = snapshot!.disclosures.some(item =>
    item.stock_code === code && recentFiling(item.date, now) && severe.test(item.title))
  return !badNews && !badFilings
}
export function applyCatalystGate(signals: TradeSignal[], snapshot: CatalystSnapshot | null, now = new Date()): {
  signals: TradeSignal[]
  allowed: number
  blocked: number
  matched: number
  ready: boolean
} {
  const ready = catalystReady(snapshot, now)
  let blocked = 0
  let matched = 0
  let allowed = 0
  const processed = signals.map(signal => {
    const matchingNews = (snapshot?.articles || []).filter(item =>
      validTime(item.published_at, now, NEWS_AGE_MS) && articleMatchesCompany(item.title, signal.name))
    const matchingFilings = (snapshot?.disclosures || []).filter(item =>
      item.stock_code === signal.code && recentFiling(item.date, now))
    if (matchingNews.length || matchingFilings.length) matched++
    const headline = matchingNews.find(item => severe.test(item.title))
    const negativeFiling = matchingFilings.find(item => severe.test(item.title))
    const materialNews = matchingNews.find(item => material.test(item.title))
    const neutralFiling = matchingFilings.find(item => material.test(item.title))
    const extraReasons = [
      ...matchingFilings.slice(0, 3).map(item => 'DART ' + item.date + ' ' + item.title.slice(0, 90)),
      ...matchingNews.slice(0, 3).map(item => '언론 ' + item.source + ' ' + item.title.slice(0, 90)),
    ]
    if (signal.status !== '관찰 후보') return { ...signal, reasons: [...signal.reasons, ...extraReasons] }
    if (!ready || headline || negativeFiling) {
      blocked++
      return {
        ...signal, status: '위험 주의' as const, entryTrigger: null, stopReference: null,
        maxQuantity: 0,
        reasons: [...signal.reasons,
          !ready ? '뉴스·공시 검증 불가/미완료 · 신규 가상매수 보류'
            : '해당 종목에 중대 위험 키워드가 확인되어 신규 진입 보류 (기사·공시 원문 확인 필요)',
          ...extraReasons],
      }
    }
    allowed++
    return { ...signal, reasons: [...signal.reasons,
      materialNews || neutralFiling ? '최근 주요 뉴스·공시 제목 확인 · 상세 원문 확인 필요' : '최근 확인 가능한 뉴스·공시에서 특정 종목의 중대 위험 신호 미발견 (무위험 의미 아님)',
      ...extraReasons] }
  })
  return { signals: processed, allowed, blocked, matched, ready }
}
export function readCatalystSnapshot(): CatalystSnapshot | null {
  try {
    const value = JSON.parse(localStorage.getItem(CATALYST_STORAGE_KEY) || 'null') as CatalystSnapshot | null
    if (value && typeof value.checkedAt === 'string' && Array.isArray(value.articles)
      && Array.isArray(value.disclosures) && typeof value.newsOk === 'boolean') return value
  } catch { /* empty or older local storage */ }
  return null
}
export function writeCatalystSnapshot(value: CatalystSnapshot): void {
  localStorage.setItem(CATALYST_STORAGE_KEY, JSON.stringify(value))
}
