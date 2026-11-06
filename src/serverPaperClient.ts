import { AUTO_EVENT, AUTO_STORAGE_KEY, type AutoAccount } from './autoPaper'
import { PAPER_EVENT, PAPER_KEY, readPaperLedger, type PaperLedger } from './paperLedger'
import { readAutoAccount } from './autoPaper'
import { SCREENING_HISTORY_KEY, type ScreeningSnapshot } from './screeningHistory'

export const SERVER_PAPER_EVENT = 'kb-server-paper-updated'
const API = 'https://kb-ai-trader.ksmsy1.workers.dev/api/paper/server'
let active = false
let lastRevision = -1
let latest: ServerPaperStatus | null = null
export type ServerPaperStatus = {
  success: boolean; migrated: boolean; mode: string; revision?: number;
  updated_at?: string; last_error?: string | null; message?: string;
  snapshot?: { account: AutoAccount; ledger: PaperLedger; savedAt: string; screening?: ScreeningSnapshot }
}
export function isServerPaperMode() { return active }
export function getServerPaperStatus() { return latest }
export function setServerPaperMode(enabled: boolean) {
  active = enabled
  if (!enabled) lastRevision = -1
  window.dispatchEvent(new CustomEvent(SERVER_PAPER_EVENT))
}
export async function serverPaperAction(token: string, action: string): Promise<ServerPaperStatus> {
  const ledger = readPaperLedger(), account = readAutoAccount()
  const signature = action === 'migrate' ? [ledger.trades.length,ledger.trades.slice(0,4).map(x=>x.id).join('|'),account.fills.length,account.fills.slice(0,4).map(x=>x.id).join('|')].join(':') : ''
  const res = await fetch(API, {
    method: 'POST',cache:'no-store',
    headers:{'Content-Type':'application/json',Authorization:'Bearer '+token},
    body:JSON.stringify({action,signature}),signal:AbortSignal.timeout(35_000),
  })
  const data = await res.json() as ServerPaperStatus
  if (!res.ok || !data.success) throw Error(data.message || '서버 가상매매 요청 실패')
  latest = data
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
