import { AUTO_EVENT, AUTO_STORAGE_KEY, type AutoAccount } from './autoPaper'
import { PAPER_EVENT, PAPER_KEY, type PaperLedger } from './paperLedger'

export const SERVER_PAPER_EVENT = 'kb-server-paper-updated'
const API = 'https://kb-ai-trader.ksmsy1.workers.dev/api/paper/server'
let active = false
let lastRevision = -1
export type ServerPaperStatus = {
  success: boolean; migrated: boolean; mode: string; revision?: number;
  updated_at?: string; last_error?: string | null; message?: string;
  snapshot?: { account: AutoAccount; ledger: PaperLedger; savedAt: string }
}
export function isServerPaperMode() { return active }
export function setServerPaperMode(enabled: boolean) {
  active = enabled
  if (!enabled) lastRevision = -1
  window.dispatchEvent(new CustomEvent(SERVER_PAPER_EVENT))
}
export async function serverPaperAction(token: string, action: string): Promise<ServerPaperStatus> {
  const res = await fetch(API, {
    method: 'POST',cache:'no-store',
    headers:{'Content-Type':'application/json',Authorization:'Bearer '+token},
    body:JSON.stringify({action}),signal:AbortSignal.timeout(35_000),
  })
  const data = await res.json() as ServerPaperStatus
  if (!res.ok || !data.success) throw Error(data.message || '서버 가상매매 요청 실패')
  if (data.migrated && data.snapshot) {
    active = true
    if (lastRevision !== data.revision) {
      lastRevision = data.revision ?? -1
      // Read-only local mirrors for existing charts. The server D1 row is authoritative.
      localStorage.setItem(AUTO_STORAGE_KEY, JSON.stringify(data.snapshot.account))
      localStorage.setItem(PAPER_KEY, JSON.stringify(data.snapshot.ledger))
      window.dispatchEvent(new CustomEvent(AUTO_EVENT))
      window.dispatchEvent(new CustomEvent(PAPER_EVENT))
    }
  }
  window.dispatchEvent(new CustomEvent(SERVER_PAPER_EVENT))
  return data
}
