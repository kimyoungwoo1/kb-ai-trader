import { useEffect, useMemo, useState } from 'react'
import { PAPER_EVENT, ledgerEquity, readPaperLedger } from './paperLedger'
import { AUTO_EVENT, newAutoAccount, readAutoAccount, writeAutoAccount, type AutoAccount } from './autoPaper'
import type { TradeSignal } from './tradeSignals'
import { analyzeSignals, analyzePerformance } from './strategyDiagnostics'

const money = (value: number) => Math.round(value).toLocaleString('ko-KR') + '원'
const percent = (value: number) => (value > 0 ? '+' : '') + value.toFixed(2) + '%'
const formatTime = (value?: string) => {
  if (!value || !Number.isFinite(new Date(value).getTime())) return '기록 없음'
  return new Date(value).toLocaleString('ko-KR')
}

export default function AutoPaperLab({
  signals, checkedAt, onStart,
}: {
  signals: TradeSignal[]
  checkedAt: string
  onStart?: () => void
}) {
  const [account, setAccount] = useState<AutoAccount>(readAutoAccount)
  const [ledger, setLedger] = useState(readPaperLedger)
  const [confirmReset, setConfirmReset] = useState(false)

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
          <span className={'auto-state ' + (account.enabled ? 'auto-state-on' : 'auto-state-off')}>
            <span className="auto-state-dot" />
            {account.enabled ? '자동 검사 활성화' : '자동 검사 중지'}
          </span>
          <button type="button" className="outline-button" onClick={toggle}>
            {account.enabled ? '자동매매 중지' : '자동매매 시작'}
          </button>
        </div>
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
          <span>보유 종목</span><strong>{ledger.positions.length}종목</strong>
          <small>진입 감시 {account.pending.length}종목</small>
        </article>
        <article className="auto-overview-card">
          <span>누적 가상 거래</span><strong>{ledger.trades.length}건</strong>
          <small>공유 가상 현금 {money(ledger.cash)}</small>
        </article>
      </div>
      <div className="auto-activity-line">
        <span>{account.enabled ? '장중 새 시세를 5분 간격으로 검사합니다.' : '자동 실행이 중지되어 있습니다.'}</span>
        <span>최근 검사 {lastRun ? formatTime(lastRun.processedAt) : '아직 없음'}</span>
      </div>
      <p className="auto-operation-note">현재 자동 검사는 로그인한 브라우저가 열려 있을 때만 실행됩니다. 브라우저를 닫아도 실행되는 서버 자동매매는 아직 제공하지 않습니다. 실계좌 주문은 실행되지 않습니다.</p>
    </div>

    <section className="panel auto-main-panel">
      <div className="panel-heading"><div><h3>현재 가상 보유 종목</h3><span>MANUAL + AUTOMATIC PAPER POSITIONS</span></div></div>
      {ledger.positions.length ? <div className="table-wrap"><table className="paper-table">
        <thead><tr><th>종목</th><th>보유 수량</th><th>평균 매수가</th><th>최근 확인가</th><th>평가손익</th></tr></thead>
        <tbody>{ledger.positions.map(position => {
          const pnl = (position.lastPrice - position.averagePrice) * position.quantity
          return <tr key={position.code}>
            <td><strong>{position.name}</strong><small>{position.code} · {autoOwned.has(position.code) ? '자동 전략 포함' : '수동 가상매매'}</small></td>
            <td>{position.quantity.toLocaleString('ko-KR')}주</td>
            <td>{money(position.averagePrice)}</td>
            <td>{money(position.lastPrice)}</td>
            <td className={pnl < 0 ? 'negative-value' : 'positive-value'}>{pnl > 0 ? '+' : ''}{money(pnl)}</td>
          </tr>
        })}</tbody>
      </table></div> : <p className="ai-empty">현재 보유 중인 가상 종목이 없습니다. 매수 조건을 만족할 때 거래 내역에 자동 기록됩니다.</p>}
    </section>

    <section className="panel auto-main-panel">
      <div className="panel-heading"><div><h3>최근 가상 거래</h3><span>RECENT PAPER TRANSACTIONS</span></div></div>
      {ledger.trades.length ? <div className="table-wrap"><table className="paper-table">
        <thead><tr><th>체결 시각</th><th>종목</th><th>구분</th><th>수량</th><th>가상 체결가</th><th>실현손익</th></tr></thead>
        <tbody>{ledger.trades.slice(0, 8).map(trade => <tr key={trade.id}>
          <td>{formatTime(trade.time)}</td><td>{trade.name}<small>{trade.code}</small></td>
          <td>{trade.source === 'auto' ? '자동 ' : '수동 '}{trade.side === 'BUY' ? '매수' : '매도'}</td>
          <td>{trade.quantity.toLocaleString('ko-KR')}주</td><td>{money(trade.price)}</td>
          <td>{trade.realizedPnl === undefined ? '-' : money(trade.realizedPnl)}</td>
        </tr>)}</tbody>
      </table></div> : <p className="ai-empty">아직 거래 내역이 없습니다. 가상매매를 시작하면 이곳에 자동으로 기록됩니다.</p>}
    </section>

    <details className="panel auto-advanced">
      <summary><strong>고급 진단 및 전략 설정</strong><span>검사 종목·탈락 사유·실행 기록·성과 통계</span></summary>
      <div className="auto-advanced-inner">
        <p className="news-query">초기 자금 100만원 · 종목당 최대 20만원 · 최대 3종목 · 당일 실현손실 -1만원 이후 신규 진입 중단 · 익절 +6% / 손절 -3% · 최대 보유 15일. 수수료와 슬리피지는 모의 계산이며 실주문은 비활성화되어 있습니다.</p>
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
