import { useEffect, useMemo, useState } from 'react'
import { AUTO_EVENT, readAutoAccount, type AutoRunDecision, type AutoRun } from './autoPaper'
import { PAPER_EVENT, readPaperLedger } from './paperLedger'
import type { TradeSignal } from './tradeSignals'
import { analyzeSignals } from './strategyDiagnostics'
import { summarizeTradingAnalytics, journalTrades, type AnalyticsPeriod, type JournalGroup } from './tradingAnalytics'
import { catalystReady, type CatalystSnapshot } from './marketCatalysts'

const money = (value: number) => Math.round(value).toLocaleString('ko-KR') + '원'
const signedMoney = (value: number) => (value > 0 ? '+' : '') + money(value)
const pct = (value: number) => (value > 0 ? '+' : '') + value.toFixed(2) + '%'
const formatTime = (value?: string | null) => value && Number.isFinite(Date.parse(value))
  ? new Date(value).toLocaleString('ko-KR') : '기록 없음'
const periods: { id: AnalyticsPeriod; label: string }[] = [
  { id: '7', label: '최근 7일' }, { id: '30', label: '최근 30일' }, { id: 'all', label: '전체' },
]
const groups: { id: JournalGroup; label: string }[] = [
  { id: 'all', label: '전체' }, { id: 'auto', label: '자동매매' },
  { id: 'manual', label: '수동' }, { id: 'test', label: '시험' },
]

function EquityGraph({ points }: { points: { at: string; value: number }[] }) {
  if (points.length < 2) return <div className="analysis-empty-chart">
    차트를 표시할 자산 추이 기록이 아직 없습니다. 자동 검사에서 기록이 쌓이면 표시돼요.
  </div>
  const values = points.map(point => point.value)
  const lower = Math.min(1_000_000, ...values)
  const upper = Math.max(1_000_000, ...values)
  const pad = Math.max((upper - lower) * 0.14, 3000)
  const min = lower - pad
  const max = upper + pad
  const width = 900, height = 260
  const left = 12, right = width - 12, top = 16, bottom = height - 18
  const first = Date.parse(points[0].at)
  const last = Date.parse(points[points.length - 1].at)
  const spans = Math.max(last - first, 1000)
  const xy = points.map((point, index) => ({
    x: left + (last > first ? (Date.parse(point.at) - first) / spans
      : index / Math.max(1, points.length - 1)) * (right - left),
    y: bottom - ((point.value - min) / (max - min)) * (bottom - top),
  }))
  const line = xy.map(p => p.x.toFixed(1) + ',' + p.y.toFixed(1)).join(' ')
  const area = left + ',' + bottom + ' ' + line + ' ' + right + ',' + bottom
  const baselineY = bottom - ((1_000_000 - min) / (max - min)) * (bottom - top)
  return <div className="analysis-chart">
    <svg viewBox={'0 0 ' + width + ' ' + height} role="img"
      aria-label="가상계좌 자산 변동 그래프. 초기 자산 100만원 기준선과 저장된 자산 관측치를 표시합니다."
      preserveAspectRatio="none">
      <defs>
        <linearGradient id="analytics-equity-fill" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="#3d8eef" stopOpacity="0.26" />
          <stop offset="100%" stopColor="#3d8eef" stopOpacity="0.015" />
        </linearGradient>
      </defs>
      {[0, 0.25, 0.5, 0.75, 1].map((fraction, index) =>
        <line key={index} x1={left} x2={right}
          y1={top + (bottom - top) * fraction} y2={top + (bottom - top) * fraction}
          stroke="#2b3b51" strokeDasharray="4 7" strokeWidth="1" />)}
      <line x1={left} x2={right} y1={baselineY} y2={baselineY}
        stroke="#8094ae" strokeDasharray="7 6" strokeWidth="1.3" />
      <polygon points={area} fill="url(#analytics-equity-fill)" />
      <polyline points={line} fill="none" stroke="#65b0ff"
        strokeWidth="2.9" strokeLinejoin="round" strokeLinecap="round" />
      <circle cx={xy[xy.length - 1].x} cy={xy[xy.length - 1].y} r="5" fill="#9cd4ff" />
    </svg>
    <div className="analysis-chart-range">
      <span>{formatTime(points[0].at)}</span>
      <span>초기자금 기준선 1,000,000원</span>
      <span>{formatTime(points[points.length - 1].at)}</span>
    </div>
  </div>
}
function Decision({ item }: { item: AutoRunDecision }) {
  const outcome = item.outcome || item.status
  const tone = outcome.includes('체결') ? 'filled' : outcome.includes('감시') ? 'watch'
    : item.status === '위험 주의' ? 'risk' : 'rejected'
  return <div className="analysis-decision">
    <div><strong>{item.name} <small>{item.code}</small></strong>
      <span className={'auto-review-decision auto-review-decision-' + tone}>{outcome}</span></div>
    <p>가격 {item.price != null ? money(item.price) : '기록 없음'} · 점수 {item.score ?? '-'} ·
      진입 감시 {item.entryTrigger ? money(item.entryTrigger) : '없음'}</p>
    <details><summary>선정·제외 판단 근거 확인</summary>
      <p className="analysis-reason">{item.reason || '기록된 판단 근거 없음'}</p>
    </details>
  </div>
}
export default function TradingAnalytics({ signals, catalysts, marketCoverage, onGoAuto }: {
  signals: TradeSignal[]
  catalysts: CatalystSnapshot | null
  marketCoverage: string
  onGoAuto: () => void
}) {
  const [account, setAccount] = useState(readAutoAccount)
  const [ledger, setLedger] = useState(readPaperLedger)
  const [period, setPeriod] = useState<AnalyticsPeriod>('30')
  const [group, setGroup] = useState<JournalGroup>('all')
  const [runIndex, setRunIndex] = useState(0)
  const [expanded, setExpanded] = useState(false)
  const [tradeCount, setTradeCount] = useState(15)
  const [time, setTime] = useState(() => Date.now())

  useEffect(() => {
    const update = () => {
      setAccount(readAutoAccount())
      setLedger(readPaperLedger())
    }
    window.addEventListener(AUTO_EVENT, update)
    window.addEventListener(PAPER_EVENT, update)
    window.addEventListener('storage', update)
    const timer = window.setInterval(() => setTime(Date.now()), 30_000)
    return () => {
      window.removeEventListener(AUTO_EVENT, update)
      window.removeEventListener(PAPER_EVENT, update)
      window.removeEventListener('storage', update)
      window.clearInterval(timer)
    }
  }, [])
  const now = useMemo(() => new Date(time), [time])
  const report = useMemo(() => summarizeTradingAnalytics(account, ledger, period, now),
    [account, ledger, period, now])
  const screening = useMemo(() => analyzeSignals(signals), [signals])
  const visibleTrades = useMemo(() => journalTrades(ledger, period, group, now),
    [ledger, period, group, now])
  const runs = report.recentRuns
  const selectedRun: AutoRun | undefined = runs[runIndex] || runs[0]
  const decisions = selectedRun?.decisions || []
  const closed = report.strategy.closed
  const maxDrawdown = report.performance.maxDrawdown
  const current = report.performance.totalEquity

  return <div className="analysis-dashboard">
    <div className="analysis-hero panel">
      <div>
        <div className="eyebrow">PAPER TRADING · PERFORMANCE &amp; AUDIT</div>
        <h1>매매 분석 대시보드</h1>
        <p>자동매매 성과, 가상계좌 자산 흐름, 실제 저장된 매매 판단 근거를 한곳에서 확인합니다.</p>
      </div>
      <div className="analysis-hero-actions">
        <span className="analysis-readonly">읽기 전용 · 실주문 없음</span>
        <button className="outline-button" type="button" onClick={onGoAuto}>자동매매 관리로</button>
      </div>
    </div>
    <div className="analysis-periods" role="group" aria-label="분석 기간 선택">
      {periods.map(item => <button type="button" key={item.id}
        aria-pressed={period === item.id}
        className={period === item.id ? 'selected' : ''}
        onClick={() => { setPeriod(item.id); setRunIndex(0); setExpanded(false); setTradeCount(15) }}>{item.label}</button>)}
    </div>

    <div className="analysis-kpi-grid">
      <article className="analysis-kpi featured">
        <span>통합 가상계좌 총자산</span>
        <strong>{money(current)}</strong>
        <small>현재 잔액 + 보유 종목 평가금액 · 수동·시험 거래 포함</small>
      </article>
      <article className="analysis-kpi">
        <span>통합 계좌 누적 수익률</span>
        <strong className={report.performance.returnPct < 0 ? 'negative-value' : 'positive-value'}>
          {pct(report.performance.returnPct)}</strong>
        <small>초기 100만원 기준 · 기간 필터와 무관</small>
      </article>
      <article className="analysis-kpi">
        <span>자동 전략 청산 / 승률</span>
        <strong>{report.strategy.count}건 <em>{report.strategy.winRate === null
          ? '승률 -' : report.strategy.winRate.toFixed(1) + '%'}</em></strong>
        <small>선택 기간 · 자동매도 기준 · 시험·수동 매도 제외</small>
      </article>
      <article className="analysis-kpi">
        <span>자동 전략 실현손익</span>
        <strong className={report.strategy.netPnl < 0 ? 'negative-value' : 'positive-value'}>
          {signedMoney(report.strategy.netPnl)}</strong>
        <small>선택 기간 · 거래 수수료·모의 슬리피지 반영</small>
      </article>
      <article className="analysis-kpi">
        <span>평균 자동 보유시간</span>
        <strong>{report.strategy.averageHoldingHours == null ? '기록 부족'
          : report.strategy.averageHoldingHours >= 24
            ? (report.strategy.averageHoldingHours / 24).toFixed(1) + '일'
            : report.strategy.averageHoldingHours.toFixed(1) + '시간'}</strong>
        <small>매수·매도 기록 연결 가능 {report.strategy.holdingSamples}/{report.strategy.count}건</small>
      </article>
      <article className="analysis-kpi">
        <span>관측 기준 최대 낙폭 (MDD)</span>
        <strong className="negative-value">{maxDrawdown === null ? '기록 부족' : '-' + maxDrawdown.toFixed(2) + '%'}</strong>
        <small>계좌 전체 자산 관측치 기준 · 실시간 최대 낙폭 아님</small>
      </article>
    </div>

    <section className="panel analysis-section">
      <div className="panel-heading"><div><h3>가상계좌 자산 추이</h3>
        <span>EQUITY HISTORY · 저장된 관측 기록</span></div>
        <span className="analysis-muted">{report.curve.length ? report.curve.length + '개 관측치' : '기록 없음'}</span>
      </div>
      <EquityGraph points={report.curve} />
      <p className="analysis-footnote">시장 검사 때 기록된 자산 관측치를 연결한 그래프야. 장중 30초마다 모든 가격을 저장한 데이터가 아니며, 수동·시험 청산의 영향도 포함될 수 있어. 보관된 관측 기록에만 기반하므로 과거 실제 MDD보다 낮게 계산될 수 있어.</p>
    </section>

    <div className="analysis-duo">
      <section className="panel analysis-section">
        <div className="panel-heading"><div><h3>자동 전략 청산 내역</h3><span>AUTO STRATEGY · EXCLUDES TRIAL</span></div></div>
        <div className="analysis-mini-stats">
          <div><span>수익 청산</span><b className="positive-value">{report.strategy.winners}건</b></div>
          <div><span>손실·본전 청산</span><b className="negative-value">{report.strategy.losers}건</b></div>
          <div><span>평균 실현손익</span><b>{report.strategy.averagePnl === null ? '-' : signedMoney(report.strategy.averagePnl)}</b></div>
          <div><span>손익비(Profit Factor)</span><b>{report.strategy.profitFactor === null
            ? '계산 불가' : report.strategy.profitFactor.toFixed(2)}</b></div>
        </div>
        {closed.length ? <div className="analysis-closed-list">{closed.slice(0, 12).map(fill =>
          <article key={fill.id}>
            <div><strong>{fill.name}</strong><span className={fill.pnl < 0 ? 'negative-value' : 'positive-value'}>{signedMoney(fill.pnl)}</span></div>
            <p>{formatTime(fill.at)} · {fill.quantity}주 · {fill.reason}</p>
          </article>)}</div> : <p className="ai-empty">선택 기간에 청산된 자동매매가 없어 승률을 계산할 수 없습니다.</p>}
        <p className="analysis-footnote">한 번의 자동매도 체결을 1건으로 집계해. 평균 보유시간은 연결 가능한 매수 기록이 있는 거래에만 표시해.</p>
      </section>

      <section className="panel analysis-section">
        <div className="panel-heading"><div><h3>최근 종목 선별 진단</h3><span>SCREENING SNAPSHOT</span></div></div>
        <div className="analysis-mini-stats">
          <div><span>정밀 분석 종목</span><b>{screening.inspected} / 50종목</b></div>
          <div><span>진입 관찰 후보</span><b>{screening.candidates}종목</b></div>
          <div><span>위험 주의</span><b>{screening.risky}종목</b></div>
          <div><span>데이터 부족</span><b>{screening.insufficient}종목</b></div>
        </div>
        <div className="analysis-breakdown">{screening.breakdown.map(item =>
          <div key={item.key} className="analysis-breakdown-row">
            <div><strong>{item.label}</strong><small>{item.description}</small></div>
            <div className="analysis-bar"><span style={{ width: (screening.inspected
              ? Math.min(100, 100 * item.count / screening.inspected) : 0) + '%' }}/></div>
            <b>{item.count}</b>
          </div>)}</div>
        <p className="analysis-footnote">선별 제외 원인은 중복으로 계산될 수 있어. 이 진단은 현재 브라우저에서 마지막으로 수집한 종목 기준이야.</p>
      </section>
    </div>

    <section className="panel analysis-section">
      <div className="panel-heading"><div><h3>매매 판단 이력</h3><span>RECENT MARKET SCANS &amp; REASONS</span></div>
        <span className="analysis-muted">저장된 검사 {runs.length}회</span>
      </div>
      {runs.length ? <>
        <div className="analysis-run-pills">{runs.slice(0, 10).map((run, index) =>
          <button type="button" key={run.checkedAt + index}
            className={selectedRun === run ? 'selected' : ''}
            onClick={() => { setRunIndex(index); setExpanded(false) }}>
            {formatTime(run.processedAt)} <small>{run.scanned}종목 · {run.status}</small>
          </button>)}</div>
        {selectedRun && <div className="analysis-run-summary">
          <span><small>검사</small><b>{selectedRun.scanned}종목</b></span>
          <span><small>관찰 후보</small><b>{selectedRun.candidates}종목</b></span>
          <span><small>그 회차 체결</small><b>{selectedRun.filled}건</b></span>
          <span><small>결과</small><b>{selectedRun.status}</b></span>
        </div>}
        <p className="analysis-run-message">{selectedRun?.message}</p>
        <div className="analysis-decisions">{decisions.slice(0, expanded ? undefined : 8).map(item =>
          <Decision item={item} key={item.code}/>)}</div>
        {!decisions.length && <p className="ai-empty">선택된 검사 회차에는 종목별 판단 기록이 없습니다.</p>}
        {decisions.length > 8 && <button type="button" className="outline-button"
          onClick={() => setExpanded(value => !value)}>
          {expanded ? '처음 8종목만 보기' : '검사한 ' + decisions.length + '종목 모두 보기'}
        </button>}
      </> : <p className="ai-empty">선택 기간에 저장된 시장 검사 기록이 없습니다. 자동매매가 장중 실행된 뒤 표시됩니다.</p>}
      <p className="analysis-footnote">검사 기록은 브라우저에 최근 30회만 보관돼. 판단 이력의 사유는 검사 시점의 스냅샷이며, 체결 시점과 동일하다고 단정할 수 없어.</p>
    </section>

    <section className="panel analysis-section">
      <div className="panel-heading"><div><h3>통합 가상 거래 원장</h3><span>AUTOMATIC · MANUAL · TRIAL SEPARATED</span></div>
        <span className="analysis-muted">선택 기간 {visibleTrades.length}건</span>
      </div>
      <div className="analysis-group-tabs" role="group" aria-label="거래 유형별 보기">
        {groups.map(item => <button type="button" key={item.id}
          aria-pressed={group === item.id} className={group === item.id ? 'selected' : ''}
          onClick={() => { setGroup(item.id); setTradeCount(15) }}>{item.label}</button>)}
      </div>
      {visibleTrades.length ? <div className="table-wrap"><table className="paper-table analysis-trades">
        <thead><tr><th>가상 체결 시각</th><th>종목</th><th>구분</th><th>수량</th><th>체결가</th><th>실현손익</th><th>체결 사유</th></tr></thead>
        <tbody>{visibleTrades.slice(0, tradeCount).map(trade => <tr key={trade.id}>
          <td>{formatTime(trade.time)}</td>
          <td><strong>{trade.name}</strong><small>{trade.code}</small></td>
          <td><span className={'analysis-origin origin-' + (trade.source || 'manual')}>
            {trade.source === 'test' ? '시험' : trade.source === 'auto' ? '자동' : '수동'} {trade.side === 'BUY' ? '매수' : '매도'}
          </span></td>
          <td>{trade.quantity}주</td><td>{money(trade.price)}</td>
          <td className={trade.realizedPnl === undefined ? '' : trade.realizedPnl < 0 ? 'negative-value' : 'positive-value'}>
            {trade.realizedPnl === undefined ? '-' : signedMoney(trade.realizedPnl)}</td>
          <td className="analysis-reason-cell">{trade.reason || '-'}</td>
        </tr>)}</tbody>
      </table></div> : <p className="ai-empty">선택 기간과 유형에 해당하는 가상 거래 기록이 없습니다.</p>}
      {visibleTrades.length > tradeCount && <button className="outline-button"
        type="button" onClick={() => setTradeCount(value => value + 20)}>거래 내역 더 보기</button>}
      <p className="analysis-footnote">이 표는 수동·시험 거래까지 포함한 공유 가상원장을 보여줘. 위의 자동 전략 승률과 실현손익은 시험·수동 매도를 제외해 따로 계산해.</p>
    </section>

    <section className="panel analysis-section">
      <div className="panel-heading"><div><h3>뉴스·공시 검증 상태</h3><span>CATALYST EVIDENCE · SOURCE TRACEABILITY</span></div>
        <span className={'analysis-source-state ' + (catalystReady(catalysts, now) ? 'ready' : 'blocked')}>
          {catalystReady(catalysts, now) ? '정보 검증 유효' : '신규 매수 보류/검증 지연'}
        </span>
      </div>
      <div className="analysis-mini-stats">
        <div><span>검사 시각</span><b>{formatTime(catalysts?.checkedAt)}</b></div>
        <div><span>언론 뉴스</span><b>{catalysts?.newsOk ? catalysts.articles.length + '건' : '조회 실패'}</b></div>
        <div><span>DART 공시</span><b>{catalysts?.dartOk
          ? catalysts.disclosures.length + '/' + catalysts.dartReported + '건' : '조회 실패'}</b></div>
        <div><span>공시 완전성</span><b>{catalysts?.dartComplete ? '검증' : '미확인'}</b></div>
      </div>
      <p className="analysis-footnote">일부 뉴스·공시 위험 신호는 종목 판단 사유에 기록돼 있지만, 과거 체결별 정확한 원문·발행 시각까지 보존된 데이터는 아직 부족해. 뉴스 유무별 승률이나 수익 기여도는 왜곡을 피하려고 계산하지 않았어.</p>
      <details className="auto-news-risk-details"><summary>시장 후보 수집 범위 및 기준일</summary>
        <p className="analysis-footnote">{marketCoverage}</p>
      </details>
      {catalysts && <details className="auto-news-risk-details"><summary>현재 수집한 뉴스·공시 원문 링크</summary>
        <div className="auto-news-risk-list">
          {catalysts.disclosures.slice(0, 10).map(item => <a key={'dart'+item.receipt_no}
            href={item.link} target="_blank" rel="noopener noreferrer">
            <b>DART · {item.company}</b><span>{item.title}</span></a>)}
          {catalysts.articles.slice(0, 10).map(item => <a key={'news'+item.link}
            href={item.link} target="_blank" rel="noopener noreferrer">
            <b>{item.source}</b><span>{item.title}</span></a>)}
        </div></details>}
    </section>
    <p className="analysis-footer">통계는 이 브라우저에 저장된 가상거래와 검사 이력을 기반으로 하며, 실제 수익이나 향후 투자 성과를 보장하지 않습니다. 브라우저 저장소를 삭제하면 기록이 사라질 수 있습니다.</p>
  </div>
}
