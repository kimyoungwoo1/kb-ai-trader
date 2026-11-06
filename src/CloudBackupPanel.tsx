import { useCallback, useEffect, useState } from 'react'
import { AUTO_STORAGE_KEY, readAutoAccount } from './autoPaper'
import { PAPER_KEY } from './paperLedger'
import { SCREENING_HISTORY_KEY } from './screeningHistory'
import { CLOUD_SYNC_EVENT, getCloudSyncState, saveCloudBackupNow, suspendCloudSync } from './cloudAutoSync'
import { isServerPaperMode } from './serverPaperClient'

type ServerStatus = { revision: number; updated_at: string | null; configured: boolean; has_backup: boolean }
const LOCAL_SAFETY_KEY = 'kb-ai-trader-pre-cloud-restore-v1'
const api = '/api/paper/backup'
const date = (raw: string | null) => raw ? new Date(raw).toLocaleString('ko-KR') : '없음'

async function requestBackup(token: string, action: string, extra: Record<string, unknown> = {}) {
  const response = await fetch(api, {
    method: 'POST', cache: 'no-store',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token },
    body: JSON.stringify({ action, ...extra }), signal: AbortSignal.timeout(20000),
  })
  const result = await response.json()
  if (!response.ok || !result.success)
    throw Error(result.message || '서버 백업 요청 실패')
  return result
}
export default function CloudBackupPanel({ token }: { token: string }) {
  const [status, setStatus] = useState<ServerStatus | null>(null)
  const [message, setMessage] = useState('클라우드 백업 연결 상태 확인 전')
  const [busy, setBusy] = useState(false)
  const [offline, setOffline] = useState(false)
  const [autoState, setAutoState] = useState(getCloudSyncState)
  useEffect(() => {
    const update = () => {
      const current = getCloudSyncState()
      setAutoState(current)
      if (current.revision !== null) {
        setStatus(previous => previous ? {
          ...previous, revision: current.revision!,
          has_backup: current.revision! > 0,
          updated_at: current.lastBackupAt || previous.updated_at,
        } : previous)
      }
    }
    window.addEventListener(CLOUD_SYNC_EVENT, update)
    return () => window.removeEventListener(CLOUD_SYNC_EVENT, update)
  }, [])
  const refresh = useCallback(async () => {
    if (!token) return
    try {
      const info = await requestBackup(token, 'status')
      setStatus({ revision: Number(info.revision) || 0, updated_at: info.updated_at || null,
        configured: info.configured === true, has_backup: info.has_backup === true })
      setOffline(false)
      setMessage('D1 서버 연결 확인됨 · 수동 백업 및 복원 가능')
    } catch (error) {
      setOffline(true)
      setMessage(error instanceof Error ? error.message : 'D1 서버 연결 실패')
    }
  }, [token])
  useEffect(() => { void refresh() }, [refresh])
  async function save() {
    if (!token || busy) return
    if (!window.confirm('현재 브라우저 가상매매 기록을 지금 D1 서버에 백업할까요? 자동 백업과 동일한 버전 잠금을 사용합니다.')) return
    setBusy(true)
    try {
      const success = await saveCloudBackupNow()
      if (!success) throw Error(getCloudSyncState().message)
      await refresh()
      setMessage('수동 백업 완료 · 최신 자동 백업 상태와 동기화했습니다.')
    } catch (error) {
      setMessage('백업 실패 · ' + (error instanceof Error ? error.message : '응답 오류')
        + ' · 기존 로컬 데이터는 보존됩니다.')
    } finally { setBusy(false) }
  }
  async function restore() {
    if (!token || !status?.has_backup || busy) return
    if (readAutoAccount().enabled) {
      setMessage('복원 전에 자동 가상매매를 먼저 중지해 주세요. 여러 기기에서 동시에 자동매매하면 중복 거래가 발생할 수 있습니다.')
      return
    }
    if (!window.confirm('D1 서버의 백업으로 이 브라우저의 가상계좌·자동 전략·종목 분석 기록을 교체할까요?\n\n로컬 기존 기록은 되돌리기 사본으로 남기며, 복원 후 자동매매는 중지 상태로 시작합니다.')) return
    setBusy(true)
    try {
      await suspendCloudSync()
      const result = await requestBackup(token, 'load')
      const snapshot = result.snapshot
      if (snapshot?.format !== 1 || !snapshot.ledger || !snapshot.account
        || !Number.isFinite(snapshot.ledger.cash)
        || !Array.isArray(snapshot.ledger.trades)
        || !Array.isArray(snapshot.account.positions))
        throw Error('서버 백업 구조가 올바르지 않습니다.')
      // Do not alter the live account until a usable local safety copy exists.
      const prior = JSON.stringify({
        paper: localStorage.getItem(PAPER_KEY),
        auto: localStorage.getItem(AUTO_STORAGE_KEY),
        screening: localStorage.getItem(SCREENING_HISTORY_KEY),
      })
      localStorage.setItem(LOCAL_SAFETY_KEY, prior)
      try {
        localStorage.setItem(PAPER_KEY, JSON.stringify(snapshot.ledger))
        // Never automatically activate a potentially stale strategy on restore.
        localStorage.setItem(AUTO_STORAGE_KEY, JSON.stringify({ ...snapshot.account, enabled: false }))
        if (snapshot.screening) localStorage.setItem(SCREENING_HISTORY_KEY, JSON.stringify(snapshot.screening))
        else localStorage.removeItem(SCREENING_HISTORY_KEY)
      } catch (restoreError) {
        // Storage quota or browser privacy failures must not strand a half-restored ledger.
        const previous = JSON.parse(prior)
        for (const [key, raw] of [[PAPER_KEY, previous.paper],
          [AUTO_STORAGE_KEY, previous.auto], [SCREENING_HISTORY_KEY, previous.screening]] as const) {
          if (typeof raw === 'string') localStorage.setItem(key, raw)
          else localStorage.removeItem(key)
        }
        throw restoreError
      }
      window.location.reload()
    } catch (error) {
      setMessage('복원 실패 · ' + (error instanceof Error ? error.message : '응답 오류'))
      setBusy(false)
    }
  }
  function undoRestore() {
    if (busy || readAutoAccount().enabled) {
      setMessage('되돌리기 전에 자동 가상매매를 중지해야 합니다.')
      return
    }
    const before = localStorage.getItem(LOCAL_SAFETY_KEY)
    if (!before) return
    if (!window.confirm('클라우드 복원 직전에 저장한 브라우저 기록으로 되돌릴까요? 현재 브라우저의 최신 변경은 사라집니다.')) return
    try {
      const previous = JSON.parse(before)
      for (const [key, raw] of [[PAPER_KEY, previous.paper],
        [AUTO_STORAGE_KEY, previous.auto], [SCREENING_HISTORY_KEY, previous.screening]] as const) {
        if (typeof raw === 'string') localStorage.setItem(key, raw)
        else localStorage.removeItem(key)
      }
      // Restoration must not trigger automatic trading when the page reloads.
      const account = readAutoAccount()
      localStorage.setItem(AUTO_STORAGE_KEY, JSON.stringify({ ...account, enabled: false }))
      localStorage.removeItem(LOCAL_SAFETY_KEY)
      window.location.reload()
    } catch (error) {
      setMessage('되돌리기 실패 · ' + (error instanceof Error ? error.message : '로컬 데이터 오류'))
    }
  }
  if (isServerPaperMode()) return <section className="panel analysis-section cloud-backup-panel"><h3>D1 서버 가상매매 원장</h3><p>서버가 거래·잔액·보유종목의 원본을 관리합니다. 이전 브라우저 백업과 복원 기능은 데이터 충돌 방지를 위해 비활성화했습니다.</p></section>
  return <section className="panel analysis-section cloud-backup-panel">
    <div className="panel-heading"><div><h3>가상매매 기록 클라우드 백업</h3>
      <span>D1 BACKUP · EXPLICIT SYNC ONLY · REAL ORDERS DISABLED</span></div>
      <span className={'analysis-source-state ' + (!offline && status?.configured ? 'ready' : 'blocked')}>
        {offline ? '연결 확인 필요' : status ? 'D1 연결됨' : '조회 중'}
      </span>
    </div>
    <div className="analysis-mini-stats">
      <div><span>서버 백업 버전</span><b>{status?.has_backup ? 'v' + status.revision : '백업 없음'}</b></div>
      <div><span>마지막 서버 저장</span><b>{date(status?.updated_at || null)}</b></div>
      <div><span>자동 백업 상태</span><b>{autoState.phase === 'ready' ? '정상 동작'
        : autoState.phase === 'blocked' || autoState.phase === 'error' ? '확인 필요' : '준비 중'}</b></div>
      <div><span>자동매매 단일 실행권</span><b>{autoState.ownsLease ? '이 브라우저' : '미보유 / 미사용'}</b></div>
    </div>
    <p className="analysis-footnote">가상 체결이 발생하면 변경을 감지해 서버에 자동 백업하고, 장중 사용 중에는 약 2분마다 보조 백업합니다. 수동 백업·복원도 사용할 수 있어요. 자동매매 실행권은 D1에서 브라우저별로 관리합니다.</p>
    <p className="analysis-footnote">마지막 자동 저장: {date(autoState.lastBackupAt)} · {autoState.message}</p>
    <p className="analysis-footnote">D1 실행권으로 여러 탭·기기의 자동 가상체결을 막지만, 서버에서 직접 주문하는 방식은 아니야. 다른 PC에서는 자동매매를 중지하고 최신 서버 백업을 복원해 사용하세요. 브라우저가 갑자기 종료되면 마지막 체결의 백업이 완료되기 전에 종료될 가능성도 있습니다.</p>
    <div className="cloud-backup-actions">
      <button type="button" className="outline-button" disabled={busy || offline || !status || autoState.phase !== 'ready'}
        onClick={() => void save()}>{busy ? '처리 중...' : '현재 기록 서버에 백업'}</button>
      <button type="button" className="outline-button" disabled={busy || offline || !status?.has_backup}
        onClick={() => void restore()}>서버 기록 이 브라우저에 복원</button>
      <button type="button" className="outline-button" disabled={busy} onClick={() => void refresh()}>연결 상태 다시 확인</button>
      {localStorage.getItem(LOCAL_SAFETY_KEY) && <button type="button" className="outline-button"
        disabled={busy} onClick={undoRestore}>복원 이전 로컬 기록 되돌리기</button>}
    </div>
    <p role="status" className="cloud-backup-message">{message}</p>
  </section>
}
