import { AUTO_EVENT, readAutoAccount } from './autoPaper'
import { PAPER_EVENT, readPaperLedger } from './paperLedger'
import { readScreeningSnapshot } from './screeningHistory'

export const CLOUD_SYNC_EVENT = 'kb-cloud-sync-changed'
export const CLOUD_BACKUP_INTERVAL_MS = 120_000
export const CLOUD_LEASE_RENEW_MS = 30_000
const CLOUD_API = '/api/paper/backup'
const TRADE_BACKUP_DEBOUNCE_MS = 650

export type CloudSyncState = {
  phase: 'inactive' | 'starting' | 'ready' | 'blocked' | 'error'
  ownsLease: boolean
  revision: number | null
  lastBackupAt: string | null
  lastError: string
  message: string
}
const freshState = (): CloudSyncState => ({
  phase: 'inactive', ownsLease: false, revision: null, lastBackupAt: null,
  lastError: '', message: '연결 전',
})
let state: CloudSyncState = freshState()
let token = ''
let owner = ''
let generation = 0
let active = false
let initializing: Promise<void> | null = null
let inflightBackup: Promise<boolean> | null = null
let inflightLease: Promise<boolean> | null = null
let lastTradeSignature = ''
let lastSaveAt = 0
let debounce: number | null = null
let ticker: number | null = null
let renewTimer: number | null = null

const publish = (patch: Partial<CloudSyncState>) => {
  state = { ...state, ...patch }
  if (typeof window !== 'undefined') window.dispatchEvent(new CustomEvent(CLOUD_SYNC_EVENT))
}
export const getCloudSyncState = (): CloudSyncState => ({ ...state })
export const canExecutePaperTrade = (): boolean => active && state.phase === 'ready'
  && state.ownsLease && Number.isInteger(state.revision)
const signature = () => {
  const trades = readPaperLedger().trades
  return trades.length + ':' + trades.slice(0, 4).map(item => item.id).join('|')
}
const snapshot = () => ({
  format: 1,
  savedAt: new Date().toISOString(),
  ledger: readPaperLedger(),
  account: readAutoAccount(),
  screening: readScreeningSnapshot(),
})
type BackupResult = {
  success: boolean; revision?: number; updated_at?: string | null
  conflict?: boolean; message?: string; snapshot?: ReturnType<typeof snapshot>;
  has_backup?: boolean
}
async function request(action: string, extra: Record<string, unknown> = {}): Promise<BackupResult> {
  if (!token) throw Error('클라우드 자동 백업에 로그인이 필요합니다.')
  const response = await fetch(CLOUD_API, {
    method: 'POST', cache: 'no-store',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token },
    body: JSON.stringify({ action, ...extra }),
    signal: AbortSignal.timeout(22_000),
  })
  const result = await response.json() as BackupResult
  if (!response.ok || !result.success) {
    const message = result.message || 'D1 연결 오류 (HTTP ' + response.status + ')'
    const error = new Error(message) as Error & { conflict?: boolean }
    error.conflict = response.status === 409 || result.conflict === true
    throw error
  }
  return result
}
function compatibleServerSnapshot(remote: ReturnType<typeof snapshot>): boolean {
  const ledger = readPaperLedger()
  const account = readAutoAccount()
  if (!remote?.ledger || !remote?.account
    || !Array.isArray(remote.ledger.trades) || !Array.isArray(remote.account.fills)) return false
  const existingTrades = new Set(ledger.trades.map(item => item.id))
  const existingFills = new Set(account.fills.map(item => item.id))
  return remote.ledger.trades.every(item => existingTrades.has(item.id))
    && remote.account.fills.every(item => existingFills.has(item.id))
}
function block(message: string) {
  publish({ phase: 'blocked', ownsLease: false, lastError: message, message })
}
function fail(message: string) {
  publish({ phase: 'error', ownsLease: false, lastError: message, message })
}
async function initialize(): Promise<void> {
  if (!active || !token) return
  const when = generation
  publish({ phase: 'starting', lastError: '', message: 'D1 서버 백업과 실행권 확인 중' })
  try {
    const response = await request('status')
    if (!active || when !== generation) return
    if (!Number.isInteger(response.revision)) throw Error('D1 백업 버전을 확인할 수 없습니다.')
    const revision = response.revision!
    if (response.has_backup) {
      const loaded = await request('load')
      if (!active || when !== generation) return
      if (!loaded.snapshot || loaded.revision !== revision
        || !compatibleServerSnapshot(loaded.snapshot)) {
        block('서버 백업과 현재 브라우저 거래 기록이 다릅니다. 다른 기기에서 거래했을 수 있으니 자동매매를 멈추고 백업·복원을 확인하세요.')
        return
      }
    }
    publish({ phase: 'ready', revision, lastBackupAt: response.updated_at || null,
      message: 'D1 버전 ' + revision + ' 확인 · 자동 백업 준비', lastError: '' })
    lastTradeSignature = signature()
    if (readAutoAccount().enabled) await acquireTradingLease()
  } catch (error) {
    if (!active || when !== generation) return
    fail('D1 자동 백업 연결 실패 · ' + (error instanceof Error ? error.message : '서버 오류'))
  }
}
export async function acquireTradingLease(): Promise<boolean> {
  if (!active || !token) return false
  if (initializing && state.phase === 'starting') {
    await initializing
    if (getCloudSyncState().phase !== 'ready') return false
  }
  if (state.phase !== 'ready' || state.revision === null) return false
  return verifyTradingLease()
}
export async function verifyTradingLease(): Promise<boolean> {
  if (!active || !token || state.phase !== 'ready' || state.revision === null) return false
  if (inflightLease) return inflightLease
  const when = generation
  const task = (async () => {
    try {
      const result = await request(state.ownsLease ? 'renew' : 'claim',
        { owner, expectedRevision: state.revision })
      if (!active || when !== generation) return false
      if (!result.success) return false
      publish({ ownsLease: true, lastError: '', message: '실행권 확보 · D1 자동 백업 정상' })
      return true
    } catch (error) {
      if (active && when === generation) {
        const message = '다른 브라우저 실행 중 또는 D1 실행권 확인 실패 · '
          + (error instanceof Error ? error.message : '통신 오류')
        block(message)
      }
      return false
    }
  })()
  inflightLease = task
  try { return await task } finally { if (inflightLease === task) inflightLease = null }
}
async function saveInternal(): Promise<boolean> {
  if (!active || !token || state.phase !== 'ready' || state.revision === null) return false
  if (inflightBackup) return inflightBackup
  const when = generation
  const operation = (async (): Promise<boolean> => {
    if (readAutoAccount().enabled && !(await verifyTradingLease())) return false
    if (!active || when !== generation || state.phase !== 'ready') return false
    const expected = state.revision
    const payload = snapshot()
    const snapshotSignature = signature()
    try {
      const result = await request('save', {
        expectedRevision: expected, snapshot: payload,
        checkpointOnly: snapshotSignature === lastTradeSignature,
        ...(state.ownsLease ? { owner } : {}),
      })
      if (!active || when !== generation) return false
      if (!Number.isInteger(result.revision)) throw Error('새 백업 버전 확인 실패')
      lastSaveAt = Date.now()
      // Another trade may occur while D1 is saving; never mark that later fill
      // as backed up just because the older snapshot completed successfully.
      lastTradeSignature = snapshotSignature
      publish({ phase: 'ready', revision: result.revision!, lastBackupAt: result.updated_at || null,
        lastError: '', message: '자동 백업 완료 · v' + result.revision })
      return true
    } catch (error) {
      if (active && when === generation) {
        const message = '클라우드 백업 실패 · ' + (error instanceof Error ? error.message : '서버 오류')
        if ((error as { conflict?: boolean }).conflict) block(message)
        else fail(message)
      }
      return false
    }
  })()
  inflightBackup = operation
  try {
    return await operation
  } finally {
    if (inflightBackup === operation) inflightBackup = null
    if (active && when === generation && state.phase === 'ready'
      && signature() !== lastTradeSignature) scheduleBackup()
  }
}
export async function saveCloudBackupNow(): Promise<boolean> {
  if (!active || !token) return false
  if (state.phase !== 'ready') return false
  return saveInternal()
}
function scheduleBackup() {
  if (!active || state.phase !== 'ready' || debounce !== null) return
  debounce = window.setTimeout(() => {
    debounce = null
    if (signature() !== lastTradeSignature) void saveInternal()
  }, TRADE_BACKUP_DEBOUNCE_MS)
}
function onTradeChange() {
  if (signature() !== lastTradeSignature) scheduleBackup()
}
function onAccountChange() {
  if (!active || state.phase !== 'ready') return
  if (readAutoAccount().enabled && !state.ownsLease) {
    void acquireTradingLease()
  } else if (!readAutoAccount().enabled && state.ownsLease) {
    void saveInternal().finally(() => { void releaseTradingLease() })
  }
  onTradeChange()
}
async function releaseTradingLease() {
  if (!state.ownsLease) return
  try { await request('release', { owner }) } catch { /* lease expires on server anyway */ }
  if (active) publish({ ownsLease: false, message: '자동매매 실행권 반납 · 백업 대기' })
}
export async function suspendCloudSync(): Promise<void> {
  if (readAutoAccount().enabled) throw Error('자동매매를 먼저 중지해야 합니다.')
  if (inflightBackup) await inflightBackup
  await releaseTradingLease()
}
function onVisibilityChange() {
  if (document.visibilityState === 'visible' && active && state.phase === 'ready') {
    if (readAutoAccount().enabled) void verifyTradingLease()
    else if (signature() !== lastTradeSignature) void saveInternal()
  }
}
export function startCloudAutoSync(sessionToken: string): () => void {
  if (!sessionToken) return () => {}
  // Every page load creates a new in-memory owner; a cloned tab cannot inherit it.
  const when = ++generation
  token = sessionToken
  owner = 'paper-' + crypto.randomUUID()
  active = true
  lastSaveAt = 0
  state = freshState()
  lastTradeSignature = signature()
  publish({ phase: 'starting', message: 'D1 연결 확인 중' })
  initializing = initialize()
  const periodic = () => {
    if (!active || when !== generation || state.phase !== 'ready') return
    if (readAutoAccount().enabled && !state.ownsLease) {
      void acquireTradingLease()
      return
    }
    if (signature() !== lastTradeSignature || Date.now() - lastSaveAt >= CLOUD_BACKUP_INTERVAL_MS)
      void saveInternal()
  }
  const heartbeat = () => {
    if (active && when === generation && readAutoAccount().enabled && state.ownsLease) {
      void verifyTradingLease()
    }
  }
  window.addEventListener(PAPER_EVENT, onTradeChange)
  window.addEventListener(AUTO_EVENT, onAccountChange)
  window.addEventListener('storage', onTradeChange)
  document.addEventListener('visibilitychange', onVisibilityChange)
  ticker = window.setInterval(periodic, CLOUD_BACKUP_INTERVAL_MS)
  renewTimer = window.setInterval(heartbeat, CLOUD_LEASE_RENEW_MS)
  return () => {
    if (when !== generation) return
    if (debounce !== null) window.clearTimeout(debounce)
    if (ticker !== null) window.clearInterval(ticker)
    if (renewTimer !== null) window.clearInterval(renewTimer)
    window.removeEventListener(PAPER_EVENT, onTradeChange)
    window.removeEventListener(AUTO_EVENT, onAccountChange)
    window.removeEventListener('storage', onTradeChange)
    document.removeEventListener('visibilitychange', onVisibilityChange)
    const oldToken = token
    const oldOwner = owner
    const hadLease = state.ownsLease
    generation++
    active = false
    token = ''
    owner = ''
    initializing = null
    publish({ phase: 'inactive', ownsLease: false, message: '로그아웃 · 자동 동기화 중지' })
    if (hadLease) {
      void fetch(CLOUD_API, { method: 'POST', headers: {
        'Content-Type': 'application/json', Authorization: 'Bearer ' + oldToken,
      }, body: JSON.stringify({ action: 'release', owner: oldOwner }), keepalive: true })
        .catch(() => {})
    }
  }
}
