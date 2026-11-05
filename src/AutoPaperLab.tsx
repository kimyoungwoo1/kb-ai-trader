import { useEffect, useMemo, useState } from 'react'
import { PAPER_EVENT, ledgerEquity, readPaperLedger } from './paperLedger'
import { AUTO_STORAGE_KEY, autoStats, newAutoAccount, readAutoAccount, runAutoCycle, type AutoAccount } from './autoPaper'
import type { TradeSignal } from './tradeSignals'
import { analyzeSignals, analyzePerformance } from './strategyDiagnostics'

type Quote = { code: string; name: string; price: number | null; quoteError?: string }
const money = (value: number) => Math.round(value).toLocaleString('ko-KR') + '원'

export default function AutoPaperLab({ signals, quotes, checkedAt }: { signals: TradeSignal[]; quotes: Quote[]; checkedAt: string }) {
  const [account, setAccount] = useState<AutoAccount>(readAutoAccount)
  const [ledger, setLedger] = useState(readPaperLedger)
  useEffect(() => {
    const sync = () => setLedger(readPaperLedger())
    window.addEventListener(PAPER_EVENT, sync)
    window.addEventListener('storage', sync)
    return () => { window.removeEventListener(PAPER_EVENT, sync); window.removeEventListener('storage', sync) }
  }, [])
  const [confirmReset, setConfirmReset] = useState(false)
  const metrics = useMemo(() => autoStats(account), [account])
  const screening = useMemo(() => analyzeSignals(signals), [signals])
  const performance = useMemo(() => analyzePerformance(account, ledger), [account, ledger])
  const save = (next: AutoAccount) => { localStorage.setItem(AUTO_STORAGE_KEY, JSON.stringify(next)); setAccount(next) }
  useEffect(() => {
    if (!checkedAt || !quotes.length) return
    const current = readAutoAccount()
    if (!current.enabled || current.lastCycle === checkedAt) return
    const next = runAutoCycle(current, signals, quotes, checkedAt)
    localStorage.setItem(AUTO_STORAGE_KEY, JSON.stringify(next))
    setAccount(next)
  }, [checkedAt, quotes, signals])
  function toggle() {
    const next = { ...account, enabled: !account.enabled,
      lastMessage: account.enabled ? '자동 가상매매 중지 · 기존 가상 포지션은 유지됩니다.' : '자동 가상매매 활성화 · 다음 시장 데이터 수집 때부터 실행됩니다.' }
    // Do not execute against a snapshot that was collected before enabling.
    if (!account.enabled && checkedAt) next.lastCycle = checkedAt
    save(next)
  }
  const lastRun = (account.runs || [])[0]
  const formatTime = (value: string) => value ? new Date(value).toLocaleString('ko-KR') : '기록 없음'
  const currentEquity = ledgerEquity(ledger)
  const combinedReturn = (currentEquity / 1000000 - 1) * 100
  return <section className="panel disclosure-panel auto-lab">
    <div className="panel-heading"><div><h3>자동 가상매매 검증</h3><span>ISOLATED PAPER ACCOUNT · REAL ORDER DISABLED</span></div>
      <button type="button" className="outline-button" onClick={toggle}>{account.enabled ? '자동 가상매매 중지' : '자동 가상매매 시작'}</button>
    </div>
    <p className="news-message">{account.lastMessage} · 실행 시점: 시장 뉴스 페이지에서 새 시장 데이터를 수집할 때 · 백그라운드 자동 실행 없음</p>
    <p className="news-query">수동 가상 트레이딩과 동일한 잔액·보유 종목·전체 체결 내역을 공유합니다. 아래 자동 체결 기록은 자동 전략 체결만 별도로 표시합니다. 초기 100만원 · 종목당 최대 20만원 · 최대 3종목 · 실현손익 기준 당일 -1만원 이후 신규 진입 중단 · 가상 익절 +6% / 손절 -3% · 15일 보유 제한. 수수료 및 슬리피지는 예시 가정치이며 매매 성과를 보장하지 않습니다.</p>
    <div className="auto-monitor">
      <div><span>엔진 설정</span><strong>{account.enabled ? '활성화 · 새 수집 대기' : '중지됨'}</strong></div>
      <div><span>최근 검사 시각</span><strong>{lastRun ? formatTime(lastRun.processedAt) : '아직 검사 없음'}</strong></div>
      <div><span>최근 검사 결과</span><strong>{lastRun ? lastRun.status : '미실행'}</strong></div>
      <div><span>최근 검사 종목 / 후보 / 가상 체결</span><strong>{lastRun ? lastRun.scanned + '종목 / ' + lastRun.candidates + '건 / ' + lastRun.filled + '건' : '—'}</strong></div>
    </div>
    <section className="auto-run-log"><h4>검사 실행 기록 <small>최근 30회 · 브라우저에 저장</small></h4>
      {(account.runs || []).length ? <div className="auto-run-items">{(account.runs || []).slice(0, 10).map(run => <details key={run.checkedAt} className="auto-run-item"><summary><time>{formatTime(run.processedAt)}</time> · {run.status} · {run.scanned}종목 / 후보 {run.candidates}건 / 체결 {run.filled}건</summary><p>{run.message}</p><p>시세 수집: {formatTime(run.checkedAt)}</p>{run.decisions.length ? <div className="auto-run-decisions">{run.decisions.map(decision => <div key={decision.code}><strong>{decision.name} ({decision.code}) · {decision.status}</strong><span>{decision.reason}</span></div>)}</div> : <p>분석된 종목이 없습니다.</p>}</details>)}</div> : <p className="ai-empty">아직 검사 기록이 없습니다. 자동 가상매매를 켠 상태에서 ‘시장 데이터 수집’을 다시 누르면 검사 결과가 기록됩니다.</p>}
    </section>
    <section className="auto-diagnostics">
      <div className="auto-diagnostics-heading"><h4>매수 조건 진단</h4><span>최근 조회된 종목 기준 · 서로 겹치는 제외 사유</span></div>
      <div className="auto-funnel"><div>검사 종목 <strong>{screening.inspected}</strong></div><div>관찰 후보 <strong>{screening.candidates}</strong></div><div>2점 이상 미통과 <strong>{screening.nearMisses}</strong></div><div>평균 점수 <strong>{screening.meanScore === null ? '-' : screening.meanScore.toFixed(1)}</strong></div></div>
      {screening.inspected > 0 ? <div className="auto-diagnostic-list">{screening.breakdown.map(item => <div key={item.key} className="auto-diagnostic-row"><div><strong>{item.label}</strong><small>{item.description}</small></div><div className="auto-diagnostic-progress"><span style={{ width: (100 * item.count / screening.inspected) + '%' }} /></div><b>{item.count} / {screening.inspected}</b></div>)}</div> : <p className="ai-empty">시장 데이터를 수집하면 제외 조건의 빈도를 볼 수 있어.</p>}
      <p className="news-query">진단은 지금 화면에 수집된 최대 10종목만 계산해. 여러 검사 회차의 통계와 섞지 않으며, 후보 조건을 자동 완화하지 않아.</p>
    </section>
    <section className="auto-diagnostics">
      <div className="auto-diagnostics-heading"><h4>자동 가상매매 성과 검증</h4><span>전략 자동매도 기록만 · 수동매매 제외</span></div>
      <div className="auto-funnel">
        <div>완료 매매 <strong>{performance.closed}건</strong></div>
        <div>전략 승률 <strong>{performance.winRate === null ? '-' : performance.winRate.toFixed(1) + '%'}</strong></div>
        <div>평균 실현손익 <strong>{performance.averagePnl === null ? '-' : money(performance.averagePnl)}</strong></div>
        <div>손익비율(PF) <strong>{performance.profitFactor === null ? '-' : performance.profitFactor.toFixed(2)}</strong></div>
        <div>전략 실현손익 <strong>{money(performance.netPnl)}</strong></div>
        <div>관측 최대 낙폭 <strong>{performance.maxDrawdown === null ? '-' : performance.maxDrawdown.toFixed(2) + '%'}</strong></div>
      </div>
      <p className="news-query">가상 수수료·세금·슬리피지 추정치를 반영한 전략 청산 기록 기준. 전체 가상잔고 수익률은 수동·자동 거래가 합쳐진 값이므로 전략 성과와 다를 수 있어. 최대 낙폭은 시장 시세 수집 시점만 기록하며, 아직 성과를 검증할 충분한 거래가 쌓이지 않았을 수 있어.</p>
    </section>
    <div className="auto-stats">
      <div><span>가상 총자산</span><strong>{money(currentEquity)}</strong></div>
      <div><span>누적 수익률</span><strong>{combinedReturn.toFixed(2)}%</strong></div>
      <div><span>종료 거래 / 승률</span><strong>{metrics.closed}건 / {metrics.winRate === null ? '-' : metrics.winRate.toFixed(1) + '%'}</strong></div>
      <div><span>최대 낙폭(관측)</span><strong>{metrics.maxDrawdown.toFixed(2)}%</strong></div>
      <div><span>실현손익</span><strong>{money(metrics.realized)}</strong></div>
      <div><span>대기 신호 / 전체 보유</span><strong>{account.pending.length}건 / {ledger.positions.length}종목</strong></div>
      <div><span>공유 가상 예수금</span><strong>{money(ledger.cash)}</strong></div>
    </div>
    {account.pending.length > 0 && <div className="auto-subsection"><h4>진입 감시 중</h4>{account.pending.map(p => <p key={p.code}>{p.name} ({p.code}) · 다음 시세에서 {money(p.trigger)} 돌파 확인</p>)}</div>}
    {account.positions.length > 0 && <div className="auto-subsection"><h4>가상 보유 종목</h4><div className="table-wrap"><table className="paper-table"><thead><tr><th>종목</th><th>수량</th><th>매수가</th><th>최근가</th><th>손절</th><th>익절</th></tr></thead><tbody>{account.positions.map(p => <tr key={p.code}><td>{p.name}</td><td>{p.quantity}</td><td>{money(p.entry)}</td><td>{money(p.last)}</td><td>{money(p.stop)}</td><td>{money(p.target)}</td></tr>)}</tbody></table></div></div>}
    <div className="auto-subsection"><h4>최근 가상 체결 기록</h4>{account.fills.length ? <div className="table-wrap"><table className="paper-table"><thead><tr><th>시간</th><th>종목</th><th>구분</th><th>수량</th><th>가상 체결가</th><th>비용</th><th>손익</th><th>사유</th></tr></thead><tbody>{account.fills.slice(0, 20).map(f => <tr key={f.id}><td>{new Date(f.at).toLocaleString('ko-KR')}</td><td>{f.name}</td><td>{f.side === 'BUY' ? '가상매수' : '가상매도'}</td><td>{f.quantity}</td><td>{money(f.price)}</td><td>{money(f.costs)}</td><td>{f.pnl === null ? '-' : money(f.pnl)}</td><td>{f.reason}</td></tr>)}</tbody></table></div> : <p className="ai-empty">아직 가상 체결이 없어. 신호 조건에 맞을 때만 새로운 시세 수집에서 가상 체결해.</p>}</div>
    <div className="auto-actions">{!confirmReset ? <button type="button" className="outline-button" onClick={() => setConfirmReset(true)}>자동 가상계좌 초기화</button> : <><span>자동 엔진 기록만 초기화합니다. 공유 현금과 수동·자동 체결 내역은 유지됩니다.</span><button type="button" className="outline-button" onClick={() => { save(newAutoAccount()); setConfirmReset(false) }}>자동 기록만 초기화</button><button type="button" className="outline-button" onClick={() => setConfirmReset(false)}>취소</button></>}</div>
  </section>
}
