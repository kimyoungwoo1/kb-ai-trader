import { useEffect, useMemo, useState } from 'react'
import { PAPER_EVENT, ledgerEquity, readPaperLedger } from './paperLedger'
import { AUTO_STORAGE_KEY, autoStats, newAutoAccount, readAutoAccount, runAutoCycle, type AutoAccount } from './autoPaper'
import type { TradeSignal } from './tradeSignals'

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
