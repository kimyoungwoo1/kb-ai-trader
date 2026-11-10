import { useEffect, useState } from 'react'
import { PAPER_EVENT, ledgerEquity, readPaperLedger } from './paperLedger'
import { AUTO_EVENT, AUTO_TAKE_PROFIT_PCT, newAutoAccount, readAutoAccount, runAutoTrialSell, writeAutoAccount, type AutoAccount } from './autoPaper'
import { getAutoHealth, todayActivity } from './autoStatus'
import { runPaperEngineCheck, type EngineCheckReport } from './paperEngineCheck'
import { catalystReady, type CatalystSnapshot } from './marketCatalysts'
import { acquireTradingLease, verifyTradingLease, canExecutePaperTrade, CLOUD_SYNC_EVENT, getCloudSyncState } from './cloudAutoSync'
import { getServerPaperStatus, getServerPaperError, isServerPaperMode, serverPaperAction, SERVER_PAPER_EVENT } from './serverPaperClient'

const money = (value: number) => Math.round(value).toLocaleString('ko-KR') + '원'
const percent = (value: number) => (value > 0 ? '+' : '') + value.toFixed(2) + '%'
const formatTime = (value?: string) => {
  if (!value || !Number.isFinite(new Date(value).getTime())) return '기록 없음'
  return new Date(value).toLocaleString('ko-KR')
}

export default function AutoPaperLab({
  checkedAt, token, catalysts, catalystSummary, onStart, onOpenAnalytics, scanLoading = false, scanMessage = '',
}: {
  checkedAt: string
  token: string
  catalysts: CatalystSnapshot | null
  catalystSummary: string
  onStart?: () => void
  onOpenAnalytics: () => void
  scanLoading?: boolean
  scanMessage?: string
}) {
  const [account, setAccount] = useState<AutoAccount>(readAutoAccount)
  const [ledger, setLedger] = useState(readPaperLedger)
  const [confirmReset, setConfirmReset] = useState(false)
  const [engineCheck, setEngineCheck] = useState<EngineCheckReport | null>(null)
  const [trialCode, setTrialCode] = useState('')
  const [trialBusy, setTrialBusy] = useState(false)
  const [trialNotice, setTrialNotice] = useState('')
  const [cloud, setCloud] = useState(getCloudSyncState)
  const [startBusy, setStartBusy] = useState(false)
  const [serverTick, setServerTick] = useState(0)
  const [clock, setClock] = useState(() => Date.now())

  useEffect(() => {
    const timer = window.setInterval(() => setClock(Date.now()), 30_000)
    return () => window.clearInterval(timer)
  }, [])

  useEffect(() => {
    const sync = () => {
      setAccount(readAutoAccount())
      setLedger(readPaperLedger())
    }
    window.addEventListener(AUTO_EVENT, sync)
    window.addEventListener(PAPER_EVENT, sync)
    window.addEventListener('storage', sync)
    const syncCloud = () => setCloud(getCloudSyncState())
    window.addEventListener(CLOUD_SYNC_EVENT, syncCloud)
    const syncServer = () => setServerTick(x => x+1)
    window.addEventListener(SERVER_PAPER_EVENT, syncServer)
    return () => {
      window.removeEventListener(CLOUD_SYNC_EVENT, syncCloud)
      window.removeEventListener(SERVER_PAPER_EVENT, syncServer)
      window.removeEventListener(AUTO_EVENT, sync)
      window.removeEventListener(PAPER_EVENT, sync)
      window.removeEventListener('storage', sync)
    }
  }, [])

  const serverMode = isServerPaperMode()
  const serverInfo = getServerPaperStatus()
  const serverError = getServerPaperError()
  const cron = serverInfo?.cron
  const lastCronAt = cron?.last_tick?.finished_at || ''
  const cronAge = lastCronAt ? clock - Date.parse(lastCronAt) : Number.POSITIVE_INFINITY
  const cronRecent = cronAge >= 0 && cronAge <= 180_000
  const cronLabels: Record<string,string> = {
    market_closed:'장 마감 · 검사 대기', stopped:'자동매매 중지',
    duplicate:'중복 호출 무시', busy:'이전 검사 처리 중',
    scanned:'전체시장 검사 완료', watched:'보유·진입 종목 감시 완료',
    no_symbols:'감시 종목 없음', error:'서버 검사 오류',
  }
  void serverTick
  const currentEquity = ledgerEquity(ledger)
  const currentReturn = (currentEquity / 1_000_000 - 1) * 100
  const autoOwned = new Set(account.positions.map(item => item.code))
  const lastRun = (account.runs || [])[0]
  const baseHealth = getAutoHealth(account, new Date(clock), scanLoading, scanMessage)
  const health = serverMode
    ? { ...baseHealth, tone: serverInfo?.last_error ? 'warning' as const : account.enabled ? 'success' as const : 'neutral' as const,
        label: account.enabled ? '서버 자동 가상매매 실행 중' : '서버 자동 가상매매 중지',
        detail: serverInfo?.last_error || ('서버 D1 원장 · 최근 갱신 ' + formatTime(serverInfo?.updated_at)) }
    : account.enabled && (cloud.phase === 'blocked' || cloud.phase === 'error')
    ? { ...baseHealth, tone: 'warning' as const, label: 'D1 실행권 오류 · 자동체결 차단',
      detail: cloud.message }
    : account.enabled && baseHealth.inSession && baseHealth.tone !== 'warning' && !catalystReady(catalysts, new Date(clock))
      ? { ...baseHealth, tone: 'warning' as const, label: '뉴스·공시 신규 매수 보류',
        detail: '뉴스·공시 확인이 불완전해 신규 매수를 보류합니다. 보유 종목 감시는 계속합니다.' }
      : baseHealth
  const activity = todayActivity(account, new Date(clock))
  const lastCompleted = (account.runs || []).find(item => item.status === '검사 완료')

  async function confirmTrialSell() {
    if (serverMode) { setTrialNotice('서버 원장 모드에서는 브라우저 시험 청산이 비활성화됩니다.'); return }
    if (!trialCode || trialBusy || scanLoading) return
    setTrialBusy(true)
    setTrialNotice('')
    try {
      const current = readAutoAccount()
      if (!current.positions.some(p => p.code === trialCode)) throw Error('대상 종목이 이미 청산되었습니다.')
      const response = await fetch('https://kb-ai-trader.ksmsy1.workers.dev/api/kb/quote', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token },
        body: JSON.stringify({ code: trialCode, exchange: '1' }),
      })
      const result = await response.json()
      if (!response.ok || !result.success) throw Error(result.message || 'KB 현재가 조회에 실패했습니다.')
      const quote = { price: Number(result.price), checkedAt: String(result.checked_at || '') }
      if (!canExecutePaperTrade() || !(await verifyTradingLease()))
        throw Error('D1 자동매매 실행권이 없어 시험 청산을 중지했습니다.')
      const next = runAutoTrialSell(readAutoAccount(), trialCode, quote)
      writeAutoAccount(next)
      setTrialCode('')
      setTrialNotice('시험 청산 완료 · ' + next.lastMessage + ' 가상잔액과 체결 내역을 확인하세요.')
    } catch (error) {
      setTrialNotice('시험 청산 실패 · ' + (error instanceof Error ? error.message : '다시 시도해 주세요.'))
    } finally {
      setTrialBusy(false)
    }
  }

  async function toggle() {
    if (startBusy) return
    if (serverMode) {
      setStartBusy(true)
      try {
        const next = await serverPaperAction(token, account.enabled ? 'stop' : 'start')
        setTrialNotice(next.mode === 'running' ? '서버 가상매매 시작 · 브라우저를 닫아도 Cron이 작동합니다.' : '서버 가상매매 중지 · 보유종목 유지')
      } catch (error) { setTrialNotice('서버 제어 실패 · '+(error instanceof Error ? error.message : '다시 시도해 주세요.')) }
      finally { setStartBusy(false) }
      return
    }
    const enabled = !readAutoAccount().enabled
    if (enabled) {
      setStartBusy(true)
      try {
        const allowed = await acquireTradingLease()
        if (!allowed) {
          setTrialNotice('자동매매 시작 보류 · ' + getCloudSyncState().message
            + ' · 다른 탭이 실행 중이거나 D1 백업 상태를 확인해야 합니다.')
          return
        }
      } finally { setStartBusy(false) }
    }
    const current = readAutoAccount()
    const next: AutoAccount = {
      ...current,
      enabled,
      lastMessage: enabled
        ? 'D1 실행권 확보 · 자동 가상매매가 활성화되었습니다.'
        : '자동 가상매매가 중지되었습니다. 기존 가상 보유 종목은 유지됩니다.',
      lastCycle: enabled && checkedAt ? checkedAt : current.lastCycle,
    }
    writeAutoAccount(next)
    if (enabled) onStart?.()
  }

  async function migrate() {
    if (startBusy) return
    setStartBusy(true)
    try {
      await serverPaperAction(token,'migrate')
      // A reload releases the old legacy browser listeners; only server mode
      // will be initialized on the next page load.
      window.location.reload()
    } catch (error) {
      setTrialNotice('서버 이전 실패 · '+(error instanceof Error ? error.message : 'D1 상태 확인 필요'))
      setStartBusy(false)
    }
  }
  return <section className="auto-dashboard">
    <div className="auto-hero panel">
      <div className="auto-hero-heading">
        <div>
          <div className="eyebrow">PAPER TRADING · REAL ORDERS DISABLED</div>
          <h2>AI 자동 가상매매</h2>
          <p>현재 가상계좌의 자산과 거래 결과를 한눈에 확인하세요.</p>
        </div>
        <div className="auto-hero-actions">
          <span role="status" aria-live="polite" className={'auto-state auto-state-' + health.tone}>
            <span className="auto-state-dot" />
            {health.label}
          </span>
          {account.enabled && !serverMode && health.inSession && <button type="button" className="outline-button" onClick={onStart} disabled={scanLoading || !onStart}>
            {scanLoading ? '조회 중...' : '지금 검사'}
          </button>}
          <button type="button" className="outline-button" onClick={() => void toggle()} disabled={startBusy || (serverMode && !serverInfo?.migrated)}>
            {startBusy ? '상태 확인 중...' : account.enabled ? '자동매매 중지' : '자동매매 시작'}
          </button>
        </div>
      </div>
      <div className={'auto-health-panel auto-health-' + health.tone} role="status">
        <div className="auto-health-copy">
          <strong>{health.label}</strong>
          <span>{health.detail}</span>
        </div>
        <span className="auto-health-frequency">{serverMode ? '서버 전체시장 5분 · 보유종목 1분 (Cron)' : '전체시장 5분 · 보유종목 30초'}</span>
      </div>
      {serverMode && !serverInfo?.migrated && <div className="auto-cloud-sync-status cloud-phase-blocked" role="alert">
        <span><strong>서버 이전 상태 확인 필요</strong>
          <small>{serverError || '서버 상태를 확인하지 못했습니다. 중복 체결 방지를 위해 브라우저 자동매매는 차단되어 있습니다.'}</small></span>
        <button type="button" className="outline-button" disabled={startBusy} onClick={() => {
          if (startBusy) return
          setStartBusy(true)
          void serverPaperAction(token,'status').then(() => window.location.reload())
            .catch(error => setTrialNotice('서버 상태 재확인 실패 · '+(error instanceof Error ? error.message : '연결 오류')))
            .finally(() => setStartBusy(false))
        }}>서버 상태 다시 확인</button>
      </div>}
      {!serverMode && <div className="auto-cloud-sync-status cloud-phase-ready" role="status">
        <span><strong>서버 자동매매로 전환</strong>
          <small>현재 D1 백업을 서버 원장으로 안전하게 이전합니다. 다른 탭의 자동매매를 중지한 뒤 실행하세요. 전환 이후 브라우저 수동 거래·기존 백업 쓰기는 비활성화됩니다.</small></span>
        <button type="button" className="outline-button" disabled={startBusy} onClick={() => void migrate()}>
          {startBusy ? '서버 이전 확인 중...' : 'D1 기록 서버로 이전'}
        </button>
      </div>}
      <div className={'auto-cloud-sync-status cloud-phase-' + (serverMode ? 'ready' : cloud.phase)} role="status">
        <span><strong>{serverMode ? 'D1 서버 거래 원장 · 서버 실행' : 'D1 자동 백업·중복 체결 방지'}</strong>
          <small>{serverMode ? (serverInfo?.last_error || ('서버 '+(serverInfo?.mode || '상태 확인 중')+' · 최근 저장 '+formatTime(serverInfo?.updated_at))) : cloud.message}</small></span>
        <span>{serverMode ? ('서버 '+(serverInfo?.mode === 'running' ? '실행 중' : '중지')+' · v'+(serverInfo?.revision ?? '-')) : (cloud.ownsLease ? '실행권 확보' : cloud.phase === 'blocked' || cloud.phase === 'error'
          ? '자동 체결 차단' : '연결 확인/대기') + ' · v' + (cloud.revision ?? '-')}</span>
      </div>
      {serverMode && serverInfo?.migrated && <section className="panel" aria-label="서버 Cron 실행 모니터">
        <div className="panel-heading">
          <div><h3>서버 자동매매 실행 모니터</h3><span>SERVER CRON · D1 실행 이력 · 최근 12회</span></div>
          <span className={'analysis-source-state ' + (cronRecent && serverInfo.cron_monitor_available ? 'ready' : 'blocked')}>
            {!serverInfo.cron_monitor_available ? '모니터 연결 확인 필요' : !lastCronAt ? '첫 실행 기록 대기' : cronRecent ? '최근 실행 확인' : '최근 실행 지연'}
          </span>
        </div>
        <div className="auto-health-grid">
          <div><span>최근 서버 Cron 호출</span><strong>{formatTime(lastCronAt)}</strong><small>{cron?.last_tick ? (cronLabels[cron.last_tick.result] || cron.last_tick.result) : '서버 실행 이력 확인 전'}</small></div>
          <div><span>최근 정상 서버 검사</span><strong>{formatTime(cron?.last_success?.finished_at)}</strong><small>정규장 중 정상 완료된 검사</small></div>
          <div><span>오늘 서버 검사</span><strong>{cron?.today?.completed ?? '-'}회</strong><small>정규장 1분 감시·5분 시장 탐색 완료</small></div>
          <div><span>오늘 서버 오류</span><strong>{cron?.today?.errors ?? '-'}회</strong><small>장 마감·중지·중복 건은 오류 제외</small></div>
        </div>
        {cron?.last_tick?.result === 'error' && <p className="news-message" role="alert">최근 서버 오류: {cron.last_tick.message}</p>}
        <details className="auto-advanced">
          <summary>서버 Cron 최근 실행 이력 보기</summary>
          <div className="table-wrap">
            <table className="paper-table">
              <thead><tr><th>실행 시간</th><th>결과</th><th>검사 종목</th><th>모의 체결</th><th>상세</th></tr></thead>
              <tbody>{cron?.recent?.length ? cron.recent.map(item => <tr key={item.slot}>
                <td>{formatTime(item.finished_at)}</td>
                <td>{cronLabels[item.result] || item.result}</td>
                <td>{item.scanned}</td><td>{item.filled}</td><td>{item.message}</td>
              </tr>) : <tr><td colSpan={5}>아직 저장된 Cron 실행 기록이 없습니다.</td></tr>}</tbody>
            </table>
          </div>
        </details>
        <p className="auto-operation-note">Cron 호출은 장 마감에도 기록됩니다. 서버가 실행 중인지와 실제 장중 매매 검사가 수행됐는지는 별도로 확인해야 합니다. 이 이력은 D1에 최대 14일 보관됩니다.</p>
      </section>}
      <div className="auto-health-grid">
        <div><span>최근 정상 검사</span><strong>{formatTime(lastCompleted?.processedAt)}</strong><small>진단 결과를 실제로 평가한 시각</small></div>
        <div><span>오늘 검사 횟수</span><strong>{activity.checked.toLocaleString('ko-KR')}회</strong><small>완료 {activity.completed}회 · 보류 {activity.deferred}회{activity.partialHistory ? ' · 이전 기록 일부만 집계' : ''}</small></div>
        <div><span>오늘 자동 체결</span><strong>{activity.filled.toLocaleString('ko-KR')}건</strong><small>모의 매수·매도 합계</small></div>
        <div><span>최근 전략 판단</span><strong>{lastRun ? lastRun.status : '아직 없음'}</strong><small>{lastRun ? formatTime(lastRun.processedAt) : '첫 검사 후 기록됩니다'}</small></div>
      </div>
      <div className="auto-watch-panel">
        <div className="auto-watch-title"><strong>보유·진입 감시 종목 빠른 대응</strong><span>{serverMode ? '정규장 약 1분 간격 · 서버 KB 현재가 확인' : '정규장 약 30초 간격 · KB 현재가 확인'}</span></div>
        <div className="auto-watch-stats">
          <span>상태 <b>{account.positions.length + account.pending.length === 0 ? '감시 대상 없음'
            : account.watchStatus?.status || '시작 대기'}</b></span>
          <span>최근 확인 <b>{formatTime(account.watchStatus?.processedAt)}</b></span>
          <span>가격 확인 <b>{account.watchStatus ? account.watchStatus.received + '/' + account.watchStatus.watched + '종목' : '-'}</b></span>
          <span>빠른 감시 체결 <b>{account.watchDaily?.date === new Date(clock + 9 * 3600000).toISOString().slice(0,10)
            ? account.watchDaily.filled + '건' : '0건'}</b></span>
        </div>
        {account.watchStatus?.message && <p className="auto-watch-message">{account.watchStatus.message}</p>}
      </div>
      <div className="auto-overview-grid">
        <article className="auto-overview-card auto-overview-primary">
          <span>가상 총자산</span><strong>{money(currentEquity)}</strong>
          <small>수동·자동 가상매매 통합</small>
        </article>
        <article className="auto-overview-card">
          <span>누적 수익률</span>
          <strong className={currentReturn < 0 ? 'negative-value' : 'positive-value'}>{percent(currentReturn)}</strong>
          <small>초기 가상자금 100만원 기준</small>
        </article>
        <article className="auto-overview-card">
          <span>보유 종목</span><strong>{ledger.positions.length} / 5종목</strong>
          <small>진입 감시 {account.pending.length}종목</small>
        </article>
        <article className="auto-overview-card">
          <span>누적 가상 거래</span><strong>{ledger.trades.length}건</strong>
          <small>공유 가상 현금 {money(ledger.cash)}</small>
        </article>
      </div>
      <div className="auto-activity-line">
        <span>매수 후보가 있어도 후속 시세에서 진입 조건을 충족해야만 가상 체결됩니다.</span>
        <span>마지막 수집 {formatTime(checkedAt)}</span>
      </div>
      <p className="auto-operation-note">{serverMode ? '정규장 서버 시장 탐색 약 5분 · 보유·진입 감시 약 1분. 브라우저 종료 후에도 서버 Cron에서 실행합니다. KB 응답 오류·시장 휴장·스케줄 지연 시 검사는 보류됩니다.' : '정규장 시장 탐색 5분 · 보유·진입 감시 30초. 브라우저가 닫히거나 시세 요청이 지연되면 검사도 멈추거나 늦어질 수 있습니다.'} 실계좌 주문 상태는 실계좌 시험매매 메뉴에서 확인하세요.</p>
      <p className="auto-operation-note">뉴스·DART 확인: {catalystSummary}</p>
    </div>

    <section className="panel auto-analytics-shortcut">
      <div>
        <strong>성과 분석 · 매매 판단 이력</strong>
        <p>자산 그래프, 승률·손익, 뉴스·공시 검증과 시장 검사 내역은 별도 대시보드에서 확인하세요.</p>
      </div>
      <button type="button" className="outline-button" onClick={onOpenAnalytics}>매매 분석 대시보드 보기</button>
    </section>

    <section className="panel auto-main-panel">
      <div className="panel-heading"><div><h3>현재 가상 보유 종목</h3><span>MANUAL + AUTOMATIC PAPER POSITIONS</span></div></div>
      {ledger.positions.length ? <div className="table-wrap"><table className="paper-table">
        <thead><tr><th>종목</th><th>보유 수량</th><th>평균 매수가</th><th>최근 확인가</th><th>익절 목표 (+{AUTO_TAKE_PROFIT_PCT}%)</th><th>평가손익</th><th>시험 청산</th></tr></thead>
        <tbody>{ledger.positions.map(position => {
          const pnl = (position.lastPrice - position.averagePrice) * position.quantity
          const autoPosition = account.positions.find(item => item.code === position.code)
          const target = autoPosition ? Math.round(autoPosition.entry * (1 + AUTO_TAKE_PROFIT_PCT / 100)) : null
          const distance = target && position.lastPrice > 0 ? (target / position.lastPrice - 1) * 100 : null
          return <tr key={position.code}>
            <td><strong>{position.name}</strong><small>{position.code} · {autoOwned.has(position.code) ? '자동 전략 포함' : '수동 가상매매'}</small></td>
            <td>{position.quantity.toLocaleString('ko-KR')}주</td>
            <td>{money(position.averagePrice)}</td>
            <td>{money(position.lastPrice)}</td>
            <td>{target === null ? '수동 관리' : <>{money(target)}<small>{distance !== null ? (distance > 0 ? '목표까지 +' + distance.toFixed(2) + '%' : '목표가 이상') : '시세 확인 필요'}</small></>}</td>
            <td className={pnl < 0 ? 'negative-value' : 'positive-value'}>{pnl > 0 ? '+' : ''}{money(pnl)}</td>
            <td>{autoPosition ? <button type="button" className="outline-button auto-trial-button"
              onClick={() => { setTrialCode(position.code); setTrialNotice('') }}
              disabled={serverMode || trialBusy || scanLoading || !health.inSession || !account.enabled}>시험 청산</button> : '—'}</td>
          </tr>
        })}</tbody>
      </table></div> : <p className="ai-empty">현재 보유 중인 가상 종목이 없습니다. 매수 조건을 만족할 때 거래 내역에 자동 기록됩니다.</p>}
      <p className="auto-check-safety">일반 자동매도는 +{AUTO_TAKE_PROFIT_PCT}% 익절 / -3% 손절 또는 최대 15일 보유 시 실행됩니다. 아래 시험 청산은 수익 목표 달성을 기다리지 않고 해당 종목을 실제 가상계좌에서 매도하는 별도 사용자 테스트입니다.</p>
      {trialCode && <div className="auto-trial-confirm">
        <strong>가상 보유 종목 시험 청산</strong>
        <p>{account.positions.find(p => p.code === trialCode)?.name || trialCode} · 현재 KB 시세를 새로 조회하여 해당 자동 보유 수량을 전량 가상매도합니다.</p>
        <p><b>주의:</b> 가상잔액·보유 종목·전체 거래 내역과 계좌 수익률이 실제로 바뀝니다. 이 체결은 ‘시험 매도’로 구분되며 자동매매 전략 승률에서는 제외됩니다. 실계좌 주문은 없습니다.</p>
        <div className="auto-trial-actions">
          <button type="button" className="outline-button auto-trial-confirm-button" disabled={trialBusy || scanLoading} onClick={() => void confirmTrialSell()}>{trialBusy ? '현재가 확인 및 청산 중...' : '최신 시세로 시험 청산 확정'}</button>
          <button type="button" className="outline-button" disabled={trialBusy} onClick={() => setTrialCode('')}>취소</button>
        </div>
      </div>}
      {trialNotice && <p role="status" className="auto-trial-notice">{trialNotice}</p>}
    </section>

    <details className="panel auto-advanced auto-engine-check">
      <summary>매수·매도 기능 테스트 (실제 원장 미변경)</summary>
      <div className="auto-engine-check-heading">
        <div>
          <h3>매수·매도 기능 테스트</h3>
          <p>자동매매 엔진에 시험용 가격을 입력해 감시 등록 → 가상매수 → 익절/손절 매도까지 검증합니다.</p>
        </div>
        <button type="button" className="outline-button" onClick={() => setEngineCheck(runPaperEngineCheck())}>체결 테스트 실행</button>
      </div>
      <p className="auto-check-safety">테스트 종목과 가격은 가상 시나리오입니다. 실제 시세나 시장 주문을 사용하지 않으며, 현재 가상잔액·수익률·보유종목·거래 기록도 변경하지 않습니다.</p>
      {engineCheck && <div className={'auto-engine-check-result ' + (engineCheck.passed ? 'auto-engine-check-passed' : 'auto-engine-check-failed')} role="status" aria-live="polite">
        <strong>{engineCheck.passed ? '체결 엔진 테스트 통과' : '체결 엔진 테스트 실패'} · {formatTime(engineCheck.checkedAt)}</strong>
        <div className="auto-engine-check-list">{engineCheck.scenarios.map(result =>
          <div key={result.name} className="auto-engine-check-scenario">
            <b>{result.passed ? '✓' : '✕'} {result.name}</b>
            <small>{result.steps.join(' → ') || result.message}</small>
            {result.passed && <span>{result.quantity}주 · 매수가 {money(result.buyPrice || 0)} · 매도가 {money(result.exitPrice || 0)} · 모의 손익 {money(result.realizedPnl || 0)}</span>}
          </div>
        )}</div>
        <small>이 결과는 체결 프로그램의 기능 시험입니다. 실제 시장에서 매수 신호가 발생했다는 의미는 아닙니다.</small>
      </div>}
    </details>

    <details className="panel auto-advanced">
      <summary>전략 설정 및 초기화</summary>
      <div className="auto-advanced-inner">
        <p className="news-query">초기 자금 100만원 · 종목당 최대 20만원 · 최대 5종목 · 당일 실현손실 -1만원 이후 신규 진입 중단 · 익절 +5% / 손절 -3% · 최대 보유 15일. 수수료와 슬리피지는 모의 계산이며 실주문은 비활성화돼 있습니다.</p>
        <p className="news-message">{account.lastMessage}</p>
        <div className="auto-actions">{!confirmReset
          ? <button type="button" className="outline-button" disabled={serverMode} onClick={() => setConfirmReset(true)}>자동 전략 기록만 초기화</button>
          : <><span>공유 현금·보유 종목·전체 거래 원장은 유지되며 자동 전략 기록만 초기화됩니다.</span>
            <button type="button" className="outline-button" onClick={() => { writeAutoAccount(newAutoAccount()); setConfirmReset(false) }}>기록 초기화</button>
            <button type="button" className="outline-button" onClick={() => setConfirmReset(false)}>취소</button></>}
        </div>
      </div>
    </details>
  </section>
}
