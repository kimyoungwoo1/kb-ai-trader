import { AUTO_EVENT, AUTO_STORAGE_KEY, type AutoAccount } from './autoPaper'
import { PAPER_EVENT, PAPER_KEY, readPaperLedger, type PaperLedger } from './paperLedger'
import { readAutoAccount } from './autoPaper'
import { SCREENING_HISTORY_KEY, type ScreeningSnapshot } from './screeningHistory'

export const SERVER_PAPER_EVENT = 'kb-server-paper-updated'
const API = 'https://kb-ai-trader.ksmsy1.workers.dev/api/paper/server'
let active = false
let lastRevision = -1
let latest: ServerPaperStatus | null = null
let lastConnectionError = ''
export type ServerCronRun = {
  slot: number; started_at: string; finished_at: string; result: string;
  message: string; scanned: number; filled: number;
}
export type ServerCronMonitor = {
  last_tick: ServerCronRun | null;
  recent: ServerCronRun[];
  last_success: ServerCronRun | null;
  today: { total: number; completed: number; errors: number; skipped: number };
}
export type ServerPaperStatus = {
  success: boolean; migrated: boolean; mode: string; revision?: number;
  updated_at?: string; last_error?: string | null; message?: string;
  cron_monitor_available?: boolean; cron?: ServerCronMonitor;
  unchanged?: boolean; heartbeat?: boolean;
  snapshot?: { account: AutoAccount; ledger: PaperLedger; savedAt: string; screening?: ScreeningSnapshot }
}
export function isServerPaperMode() { return active }
export function getServerPaperStatus() { return latest }
export function getServerPaperError() { return lastConnectionError }
export function setServerPaperError(message: string) {
  lastConnectionError = message
  window.dispatchEvent(new CustomEvent(SERVER_PAPER_EVENT))
}
export function setServerPaperMode(enabled: boolean) {
  active = enabled
  if (!enabled) lastRevision = -1
  window.dispatchEvent(new CustomEvent(SERVER_PAPER_EVENT))
}
export async function serverPaperAction(token: string, action: string): Promise<ServerPaperStatus> {
  // Avoid parsing the browser's full trade ledger during frequent status polls.
  let signature = ''
  if (action === 'migrate') {
    const ledger = readPaperLedger(), account = readAutoAccount()
    signature = [ledger.trades.length,ledger.trades.slice(0,4).map(x=>x.id).join('|'),account.fills.length,account.fills.slice(0,4).map(x=>x.id).join('|')].join(':')
  }
  const revision = action === 'status' && latest?.migrated && Number.isSafeInteger(latest.revision)
    ? latest.revision : undefined
  const res = await fetch(API, {
    method: 'POST',cache:'no-store',
    headers:{'Content-Type':'application/json',Authorization:'Bearer '+token},
    body:JSON.stringify({action,signature,revision}),signal:AbortSignal.timeout(35_000),
  })
  const received = await res.json() as ServerPaperStatus
  if (!res.ok || !received.success) throw Error(received.message || '서버 가상매매 요청 실패')
  // Metadata heartbeats never advance the local snapshot revision: doing so
  // would incorrectly mark an older cached journal as current on next sync.
  if (action === 'heartbeat' && (!latest?.migrated || !latest.snapshot))
    throw Error('서버 원장 최초 동기화 필요')
  if (received.unchanged && (!latest?.snapshot || received.revision !== latest.revision))
    throw Error('서버 원장 버전 불일치 · 전체 조회 후 다시 확인 필요')
  const data = action === 'heartbeat'
    ? { ...latest!, ...received, revision:latest!.revision, snapshot:latest!.snapshot }
    : received.unchanged
      ? { ...latest!, ...received, snapshot:latest!.snapshot }
      : received
  latest = data
  lastConnectionError = ''
  if (data.migrated && data.snapshot) {
    active = true
    if (lastRevision !== data.revision) {
      lastRevision = data.revision ?? -1
      // Read-only local mirrors for existing charts. The server D1 row is authoritative.
      localStorage.setItem(AUTO_STORAGE_KEY, JSON.stringify(data.snapshot.account))
      localStorage.setItem(PAPER_KEY, JSON.stringify(data.snapshot.ledger))
      if (data.snapshot.screening?.signals?.length) localStorage.setItem(SCREENING_HISTORY_KEY,JSON.stringify(data.snapshot.screening))
      window.dispatchEvent(new CustomEvent(AUTO_EVENT))
      window.dispatchEvent(new CustomEvent(PAPER_EVENT))
    }
  }
  window.dispatchEvent(new CustomEvent(SERVER_PAPER_EVENT))
  return data
}
