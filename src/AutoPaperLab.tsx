import { useEffect, useMemo, useState } from 'react'
import { PAPER_EVENT, ledgerEquity, readPaperLedger } from './paperLedger'
import { AUTO_EVENT, AUTO_TAKE_PROFIT_PCT, newAutoAccount, readAutoAccount, runAutoTrialSell, writeAutoAccount, type AutoAccount } from './autoPaper'
import type { TradeSignal } from './tradeSignals'
import { analyzeSignals, analyzePerformance } from './strategyDiagnostics'
import { getAutoHealth, todayActivity } from './autoStatus'
import { runPaperEngineCheck, type EngineCheckReport } from './paperEngineCheck'
import { catalystReady, type CatalystSnapshot } from './marketCatalysts'

const money = (value: number) => Math.round(value).toLocaleString('ko-KR') + '원'
const percent = (value: number) => (value > 0 ? '+' : '') + value.toFixed(2) + '%'
const formatTime = (value?: string) => {
  if (!value || !Number.isFinite(new Date(value).getTime())) return '기록 없음'
  return new Date(value).toLocaleString('ko-KR')
}

export default function AutoPaperLab({
  signals, checkedAt, token, catalysts, catalystSummary, onStart, scanLoading = false, scanMessage = '',
}: {
  signals: TradeSignal[]
  checkedAt: string
  token: string
  catalysts: CatalystSnapshot | null
  catalystSummary: string
  onStart?: () => void
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
  const [selectedRunIndex, setSelectedRunIndex] = useState(0)
  const [showAllReviewed, setShowAllReviewed] = useState(false)
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
    return () => {
      window.removeEventListener(AUTO_EVENT, sync)
      window.removeEventListener(PAPER_EVENT, sync)
      window.removeEventListener('storage', sync)
    }
  }, [])

  const realizedPnl = useMemo(() => ledger.trades.reduce((sum, trade) => sum + (trade.realizedPnl || 0), 0), [ledger.trades])
  const screening = useMemo(() => analyzeSignals(signals), [signals])
  const performance = useMemo(() => analyzePerformance(account, ledger), [account, ledger])
  const currentEquity = ledgerEquity(ledger)
  const currentReturn = (currentEquity / 1_000_000 - 1) * 100
  const lastRun = (account.runs || [])[0]
  const autoOwned = new Set(account.positions.map(item => item.code))
  const runCount = (account.runs || []).filter(item => item.status === '검사 완료').length
  const baseHealth = getAutoHealth(account, new Date(clock), scanLoading, scanMessage)
  const health = account.enabled && baseHealth.inSession && !catalystReady(catalysts, new Date(clock))
    ? { ...baseHealth, tone: 'warning' as const, label: '뉴스·공시 신규 매수 보류',
      detail: '시세 검사는 작동하지만 뉴스·공시 확인이 불완전해 신규 매수만 보류합니다.' }
    : baseHealth
  const activity = todayActivity(account, new Date(clock))
  const lastCompleted = (account.runs || []).find(item => item.status === '검사 완료')
  const visibleRuns = (account.runs || []).slice(0, 6)
  const selectedRun = visibleRuns[selectedRunIndex] || visibleRuns[0]
  const reviewedStocks = [...(selectedRun?.decisions || [])].sort((a, b) => {
    const priority = (item: typeof a) => {
      if (item.outcome?.includes('체결')) return 0
      if (item.outcome === '진입 감시 중') return 1
      if (item.status === '관찰 후보') return 2
      if (item.status === '위험 주의') return 3
      if (item.status === '조건 미충족') return 4
      return 5
    }
    return priority(a) - priority(b)
  })
  const shownStocks = showAllReviewed ? reviewedStocks : reviewedStocks.slice(0, 8)

  useEffect(() => {
    setSelectedRunIndex(0)
    setShowAllReviewed(false)
  }, [account.runs?.[0]?.checkedAt])

  async function confirmTrialSell() {
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

  function toggle() {
    const enabled = !account.enabled
    const next: AutoAccount = {
      ...account,
      enabled,
      lastMessage: enabled
        ? '자동 가상매매가 활성화되었습니다. 장중에 새 시세를 확인합니다.'
        : '자동 가상매매가 중지되었습니다. 기존 가상 보유 종목은 유지됩니다.',
      // Only a later quote may create a paper fill.
      lastCycle: enabled && checkedAt ? checkedAt : account.lastCycle,
    }
    writeAutoAccount(next)
    if (enabled) onStart?.()
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
          {account.enabled && health.inSession && <button type="button" className="outline-button" onClick={onStart} disabled={scanLoading || !onStart}>
            {scanLoading ? '조회 중...' : '지금 검사'}
          </button>}
          <button type="button" className="outline-button" onClick={toggle}>
            {account.enabled ? '자동매매 중지' : '자동매매 시작'}
          </button>
        </div>
      </div>
      <div className={'auto-health-panel auto-health-' + health.tone} role="status">
        <div className="auto-health-copy">
          <strong>{health.label}</strong>
          <span>{health.detail}</span>
        </div>
        <span className="auto-health-frequency">전체시장 5분 · 보유종목 1분</span>
      </div>
      <div className="auto-health-grid">
        <div><span>최근 정상 검사</span><strong>{formatTime(lastCompleted?.processedAt)}</strong><small>진단 결과를 실제로 평가한 시각</small></div>
        <div><span>오늘 검사 횟수</span><strong>{activity.checked.toLocaleString('ko-KR')}회</strong><small>완료 {activity.completed}회 · 보류 {activity.deferred}회{activity.partialHistory ? ' · 이전 기록 일부만 집계' : ''}</small></div>
        <div><span>오늘 자동 체결</span><strong>{activity.filled.toLocaleString('ko-KR')}건</strong><small>모의 매수·매도 합계</small></div>
        <div><span>최근 전략 판단</span><strong>{lastRun ? lastRun.status : '아직 없음'}</strong><small>{lastRun ? formatTime(lastRun.processedAt) : '첫 검사 후 기록됩니다'}</small></div>
      </div>
      <div className="auto-watch-panel">
        <div className="auto-watch-title"><strong>보유·진입 감시 종목 빠른 대응</strong><span>정규장 약 1분 간격 · KB 현재가 확인</span></div>
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
      <p className="auto-operation-note">정규장에는 시장 후보를 약 5분마다 탐색하고, 보유·진입 감시 중인 종목만 약 1분마다 KB 시세로 확인합니다. 브라우저의 백그라운드 제한 또는 API 지연으로 실제 간격은 길어질 수 있습니다. 서버 자동매매나 실계좌 주문은 실행하지 않습니다.</p>
    </div>

    <section className="panel auto-main-panel auto-news-risk-panel">
      <div className="auto-review-heading">
        <div>
          <h3>자동매매 뉴스·공시 교차 검증</h3>
          <p>최근 언론사 RSS 제목과 금융감독원 DART 공시를 매수 후보에 연결해 위험 신호를 확인합니다.</p>
        </div>
        <span className={'auto-review-decision ' + (catalystReady(catalysts, new Date(clock))
          ? 'auto-review-decision-filled' : 'auto-review-decision-risk')}>
          {catalystReady(catalysts, new Date(clock)) ? '정보 수집 정상' : '신규 매수 보류'}
        </span>
      </div>
      <div className="auto-review-summary">
        <div><span>이번 정밀 분석</span><strong>{signals.length} / 50종목</strong></div>
        <div><span>언론 뉴스</span><strong>{catalysts?.newsOk ? catalysts.articles.length + '건' : '확인 불가'}</strong></div>
        <div><span>DART 공시</span><strong>{catalysts?.dartOk
          ? catalysts.disclosures.length + '/' + catalysts.dartReported + '건'
          : '확인 불가'}</strong></div>
        <div><span>마지막 교차 확인</span><strong>{formatTime(catalysts?.checkedAt)}</strong></div>
      </div>
      <p className="auto-review-result">{catalystSummary}</p>
      <p className="auto-review-note">뉴스 제목만으로 호재·악재를 확정하지 않으며, 실제 종목코드가 일치하는 공시를 우선 반영합니다. 부정적인 중대 이슈가 감지되면 신규 가상매수를 보류합니다. 뉴스·공시 확인에 실패해도 보유 종목의 익절·손절 감시는 계속합니다.</p>
      {catalysts && (catalysts.articles.length || catalysts.disclosures.length) > 0 &&
        <details className="auto-news-risk-details">
          <summary>최근 수집 자료 원문 확인</summary>
          <div className="auto-news-risk-list">
            {catalysts.disclosures.slice(0, 6).map(item =>
              <a key={'dart'+item.receipt_no} href={item.link} target="_blank" rel="noopener noreferrer">
                <b>DART · {item.company}</b><span>{item.title}</span>
              </a>)}
            {catalysts.articles.slice(0, 6).map(item =>
              <a key={'rss'+item.link} href={item.link} target="_blank" rel="noopener noreferrer">
                <b>{item.source}</b><span>{item.title}</span>
              </a>)}
          </div>
        </details>}
    </section>

    <section className="panel auto-main-panel auto-scan-review">
      <div className="auto-review-heading">
        <div>
          <h3>최근 시장 검사 내역</h3>
          <p>자동매매가 실제로 분석한 종목과 판단 이유를 표시합니다. 최근 검사 기록은 새로고침 후에도 유지됩니다.</p>
        </div>
        {scanLoading && <span className="auto-review-collecting">새로운 종목 수집 중</span>}
      </div>
      {selectedRun ? <>
        <div className="auto-review-summary">
          <div><span>검사 종목</span><strong>{selectedRun.scanned}종목</strong></div>
          <div><span>매수 관찰 후보</span><strong>{selectedRun.candidates}종목</strong></div>
          <div><span>가상 체결</span><strong>{selectedRun.filled}건</strong></div>
          <div><span>검사 시각</span><strong>{formatTime(selectedRun.processedAt)}</strong></div>
        </div>
        <div className="auto-review-history">
          <span>최근 검사 선택</span>
          <div className="auto-review-run-picker">
            {visibleRuns.map((run, index) => <button type="button" key={run.checkedAt + index}
              className={'auto-review-run ' + (index === selectedRunIndex ? 'selected' : '')}
              aria-pressed={index === selectedRunIndex}
              onClick={() => { setSelectedRunIndex(index); setShowAllReviewed(false) }}>
              {index === 0 ? '최신 · ' : ''}{formatTime(run.processedAt)} <small>{run.status} · {run.scanned}종목</small>
            </button>)}
          </div>
        </div>
        <p className="auto-review-result">{selectedRun.status === '실행 보류' ? '검사 보류 · ' : '검사 결과 · '}{selectedRun.message}</p>
        {reviewedStocks.length ? <>
          <div className="auto-review-stock-list">{shownStocks.map(decision => {
            const outcome = decision.outcome || (decision.status === '관찰 후보' ? '관찰 후보' : decision.status)
            const tone = outcome.includes('체결') ? 'filled'
              : outcome.includes('감시') || decision.status === '관찰 후보' ? 'watch'
              : decision.status === '위험 주의' ? 'risk' : 'rejected'
            const reasonSummary = decision.reason.split(' / ').slice(0, 2).join(' · ')
            return <article className="auto-review-stock" key={decision.code}>
              <div className="auto-review-stock-info">
                <strong>{decision.name} <small>{decision.code}</small></strong>
                <span className={'auto-review-decision auto-review-decision-' + tone}>{outcome}</span>
              </div>
              <div className="auto-review-stock-metrics">
                <span>검사 당시 가격 <b>{decision.price != null ? money(decision.price) : '이전 검사 기록'}</b></span>
                <span>신호 점수 <b>{decision.score !== undefined ? decision.score + '점' : '기록 없음'}</b></span>
                {decision.entryTrigger != null && <span>진입 감시가 <b>{money(decision.entryTrigger)}</b></span>}
              </div>
              <p>{reasonSummary || '조건별 판단 사유가 기록되지 않았습니다.'}</p>
              {decision.reason.includes(' / ') && <details className="auto-review-stock-details">
                <summary>전체 판단 근거</summary><p>{decision.reason.split(' / ').join(' · ')}</p>
              </details>}
            </article>
          })}</div>
          {reviewedStocks.length > 8 && <button type="button" className="outline-button auto-review-more"
            onClick={() => setShowAllReviewed(value => !value)}>
            {showAllReviewed ? '상위 8종목만 보기' : '검사한 ' + reviewedStocks.length + '종목 전체 보기'}
          </button>}
        </> : <p className="ai-empty">이 회차에 저장된 종목별 기록이 없습니다. 다음 시장 수집 결과가 여기에 표시됩니다.</p>}
        <p className="auto-review-note">매수 후보 선정은 체결이 아닙니다. 조건을 충족한 후 다음 시세에서 진입가를 확인해 가상 체결합니다. 가격·점수는 이번 업데이트 이후 저장되는 검사 기록부터 표시됩니다.</p>
      </> : <p className="ai-empty">아직 자동 검사한 종목이 없습니다. 장중 자동 검사 또는 ‘지금 검사’가 완료되면 검사 종목과 매매 판단이 이곳에 표시됩니다.</p>}
    </section>

    <section className="panel auto-main-panel auto-engine-check">
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
              disabled={trialBusy || scanLoading || !health.inSession || !account.enabled}>시험 청산</button> : '—'}</td>
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

    <section className="panel auto-main-panel">
      <div className="panel-heading"><div><h3>최근 가상 거래</h3><span>RECENT PAPER TRANSACTIONS</span></div></div>
      {ledger.trades.length ? <div className="table-wrap"><table className="paper-table">
        <thead><tr><th>체결 시각</th><th>종목</th><th>구분</th><th>수량</th><th>가상 체결가</th><th>실현손익</th></tr></thead>
        <tbody>{ledger.trades.slice(0, 8).map(trade => <tr key={trade.id}>
          <td>{formatTime(trade.time)}</td><td>{trade.name}<small>{trade.code}</small></td>
          <td>{trade.source === 'test' ? '시험 매도' : (trade.source === 'auto' ? '자동 ' : '수동 ') + (trade.side === 'BUY' ? '매수' : '매도')}</td>
          <td>{trade.quantity.toLocaleString('ko-KR')}주</td><td>{money(trade.price)}</td>
          <td>{trade.realizedPnl === undefined ? '-' : money(trade.realizedPnl)}</td>
        </tr>)}</tbody>
      </table></div> : <p className="ai-empty">아직 거래 내역이 없습니다. 가상매매를 시작하면 이곳에 자동으로 기록됩니다.</p>}
    </section>

    <details className="panel auto-advanced">
      <summary><strong>고급 진단 및 전략 설정</strong><span>검사 종목·탈락 사유·실행 기록·성과 통계</span></summary>
      <div className="auto-advanced-inner">
        <p className="news-query">초기 자금 100만원 · 종목당 최대 20만원 · 최대 5종목 · 당일 실현손실 -1만원 이후 신규 진입 중단 · 익절 +5% / 손절 -3% · 최대 보유 15일. 수수료와 슬리피지는 모의 계산이며 실주문은 비활성화되어 있습니다.</p>
        <div className="auto-monitor">
          <div><span>엔진 상태</span><strong>{account.enabled ? '활성화' : '중지'}</strong></div>
          <div><span>최근 검사 결과</span><strong>{lastRun?.status || '미실행'}</strong></div>
          <div><span>최근 검사 종목 / 후보 / 체결</span><strong>{lastRun ? lastRun.scanned + ' / ' + lastRun.candidates + ' / ' + lastRun.filled : '-'}</strong></div>
          <div><span>정상 검사 누적</span><strong>{runCount}회</strong></div>
        </div>
        <p className="news-message">{account.lastMessage}</p>
        <section className="auto-diagnostics">
          <div className="auto-diagnostics-heading"><h4>매수 조건 진단</h4><span>최근 수집 {screening.inspected}종목 · 관찰 후보 {screening.candidates}종목</span></div>
          {screening.inspected ? <div className="auto-diagnostic-list">{screening.breakdown.map(item =>
            <div key={item.key} className="auto-diagnostic-row"><div><strong>{item.label}</strong><small>{item.description}</small></div><div className="auto-diagnostic-progress"><span style={{ width: (100 * item.count / screening.inspected) + '%' }} /></div><b>{item.count} / {screening.inspected}</b></div>
          )}</div> : <p className="ai-empty">수집된 시장 데이터가 없습니다.</p>}
          <details className="auto-run-item"><summary>종목별 점수와 제외 이유 ({signals.length}개)</summary>
            <div className="auto-run-decisions">{signals.map(signal => <div key={signal.code}>
              <strong>{signal.name} ({signal.code}) · {signal.score}점 · {signal.status}</strong>
              <span>{signal.reasons.join(' / ') || '확인된 사유 없음'}</span>
              {signal.entryTrigger !== null && <span>진입 감시가 {money(signal.entryTrigger)} · 최대 {signal.maxQuantity}주</span>}
            </div>)}</div>
          </details>
        </section>
        <section className="auto-diagnostics">
          <div className="auto-diagnostics-heading"><h4>자동 전략 성과</h4><span>자동 전략 청산 기준 · 수동 거래 제외</span></div>
          <div className="auto-funnel">
            <div>완료 거래 <strong>{performance.closed}건</strong></div>
            <div>승률 <strong>{performance.winRate === null ? '-' : performance.winRate.toFixed(1) + '%'}</strong></div>
            <div>전략 실현손익 <strong>{money(performance.netPnl)}</strong></div>
            <div>최대 낙폭 <strong>{performance.maxDrawdown === null ? '-' : performance.maxDrawdown.toFixed(2) + '%'}</strong></div>
            <div>전체 계좌 실현손익 <strong>{money(realizedPnl)}</strong></div>
          </div>
        </section>
        <section className="auto-run-log"><h4>최근 검사 실행 기록</h4>
          {(account.runs || []).length ? <div className="auto-run-items">{account.runs.slice(0, 10).map(run =>
            <details key={run.checkedAt} className="auto-run-item"><summary>{formatTime(run.processedAt)} · {run.status} · {run.scanned}종목 / 체결 {run.filled}건</summary>
              <p>{run.message}</p><p>시세 수집: {formatTime(run.checkedAt)}</p>
              {run.decisions.length > 0 && <div className="auto-run-decisions">{run.decisions.map(decision =>
                <div key={decision.code}><strong>{decision.name} ({decision.code}) · {decision.status}</strong><span>{decision.reason}</span></div>
              )}</div>}
            </details>
          )}</div> : <p className="ai-empty">검사 이력이 없습니다.</p>}
        </section>
        <div className="auto-actions">{!confirmReset
          ? <button type="button" className="outline-button" onClick={() => setConfirmReset(true)}>자동 전략 기록만 초기화</button>
          : <><span>공유 현금·보유 종목·전체 거래 내역은 유지되고 자동 전략 기록만 초기화됩니다.</span>
            <button type="button" className="outline-button" onClick={() => { writeAutoAccount(newAutoAccount()); setConfirmReset(false) }}>기록 초기화</button>
            <button type="button" className="outline-button" onClick={() => setConfirmReset(false)}>취소</button></>}
        </div>
        <p className="news-query">최근 시장 시세 수집: {formatTime(checkedAt)}. 가상매매 실적은 과거 수익을 보장하지 않습니다.</p>
      </div>
    </details>
  </section>
}
