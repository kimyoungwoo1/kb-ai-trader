import { useState } from 'react'
import {
  Activity, ArrowDownRight, ArrowUpRight, Bell, BriefcaseBusiness,
  CandlestickChart, ChevronDown, CircleHelp, Clock3, Command,
  LayoutDashboard, LineChart, ListFilter, Search, Settings2,
  ShieldCheck, Wallet, Wifi, WifiOff
} from 'lucide-react'

type MenuKey = 'overview' | 'account' | 'holdings' | 'watchlist' | 'paper' | 'history'

const menu: { key: MenuKey; label: string; icon: typeof LayoutDashboard }[] = [
  { key: 'overview', label: '대시보드', icon: LayoutDashboard },
  { key: 'account', label: '계좌 현황', icon: Wallet },
  { key: 'holdings', label: '보유 종목', icon: BriefcaseBusiness },
  { key: 'watchlist', label: '관심 종목', icon: ListFilter },
  { key: 'paper', label: '가상 트레이딩', icon: CandlestickChart },
  { key: 'history', label: '거래 기록', icon: Activity },
]

const chartData = [
  { day: '월', value: 42 }, { day: '화', value: 48 }, { day: '수', value: 45 },
  { day: '목', value: 57 }, { day: '금', value: 53 }, { day: '월', value: 63 },
  { day: '화', value: 59 }, { day: '수', value: 72 }, { day: '목', value: 68 },
  { day: '금', value: 79 }, { day: '월', value: 75 }, { day: '화', value: 88 },
]

function App() {
  const [active, setActive] = useState<MenuKey>('overview')
  const [showNotice, setShowNotice] = useState(true)

  const activeLabel = menu.find(item => item.key === active)?.label ?? '대시보드'

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="brand">
          <div className="brand-mark"><CandlestickChart size={21} /></div>
          <div><strong>KB AI TRADER</strong><span>SWING TERMINAL</span></div>
        </div>

        <div className="workspace-label">WORKSPACE</div>
        <nav className="nav-list">
          {menu.map(({ key, label, icon: Icon }) => (
            <button key={key} className={`nav-item ${active === key ? 'active' : ''}`} onClick={() => setActive(key)}>
              <Icon size={18} strokeWidth={1.8} />
              <span>{label}</span>
              {key === 'paper' && <span className="soon">준비중</span>}
            </button>
          ))}
        </nav>

        <div className="sidebar-bottom">
          <div className="security-card">
            <ShieldCheck size={18} />
            <div><b>안전 모드</b><span>실주문 기능 비활성화</span></div>
            <span className="green-dot" />
          </div>
          <button className="nav-item muted"><Settings2 size={18} /><span>설정</span></button>
          <div className="profile"><div className="avatar">K</div><div><b>개인 트레이더</b><span>KB증권 연동 준비</span></div><ChevronDown size={15} /></div>
        </div>
      </aside>

      <main className="main">
        <header className="topbar">
          <div className="breadcrumbs">WORKSPACE <span>/</span> <b>{activeLabel}</b></div>
          <div className="top-actions">
            <div className="connection"><span className="status-dot" /> KB증권 미연결</div>
            <button className="icon-button" aria-label="알림"><Bell size={18} /></button>
            <button className="help-button"><CircleHelp size={16} /> 도움말</button>
          </div>
        </header>

        <div className="content">
          <section className="page-heading">
            <div>
              <div className="eyebrow"><span className="live-dot" /> PERSONAL TRADING SPACE</div>
              <h1>{activeLabel}</h1>
              <p>국내 주식 스윙 트레이딩을 위한 통합 관리 화면입니다.</p>
            </div>
            <div className="heading-date"><Clock3 size={15} /> 계좌 연동 전</div>
          </section>

          {showNotice && (
            <div className="notice">
              <div className="notice-icon"><ShieldCheck size={19} /></div>
              <div><b>안전한 초기 설정</b><p>현재는 화면 구성 단계입니다. KB증권 계좌 조회를 연결하기 전까지 실제 계좌 데이터는 표시되지 않으며, 매수·매도 주문 기능은 제공하지 않습니다.</p></div>
              <button onClick={() => setShowNotice(false)} aria-label="안내 닫기">×</button>
            </div>
          )}

          <section className="section-title">
            <div><h2>계좌 요약</h2><span>ACCOUNT OVERVIEW</span></div>
            <button className="outline-button" onClick={() => setActive('account')}><Wallet size={15} /> 계좌 연결 준비</button>
          </section>

          <div className="stats-grid">
            <article className="stat-card primary-stat">
              <div className="stat-top"><span>총 평가금액</span><Wallet size={17} /></div>
              <div className="stat-value">연동 대기</div>
              <div className="stat-foot">KB증권 계좌 조회 후 표시</div>
            </article>
            <article className="stat-card">
              <div className="stat-top"><span>예수금</span><span className="stat-icon"><Wallet size={16} /></span></div>
              <div className="stat-value">—</div><div className="stat-foot">계좌 연결 필요</div>
            </article>
            <article className="stat-card">
              <div className="stat-top"><span>평가 손익</span><span className="stat-icon"><LineChart size={16} /></span></div>
              <div className="stat-value">—</div><div className="stat-foot">계좌 연결 필요</div>
            </article>
            <article className="stat-card">
              <div className="stat-top"><span>보유 종목</span><span className="stat-icon"><BriefcaseBusiness size={16} /></span></div>
              <div className="stat-value">— <small>종목</small></div><div className="stat-foot">계좌 연결 필요</div>
            </article>
          </div>

          <div className="dashboard-grid">
            <section className="panel performance-panel">
              <div className="panel-heading"><div><h3>자산 추이</h3><span>PORTFOLIO PERFORMANCE</span></div><button className="period-select">최근 12일 <ChevronDown size={14} /></button></div>
              <div className="empty-chart">
                <div className="chart-placeholder"><div className="chart-line line-one" /><div className="chart-line line-two" /><div className="chart-line line-three" /><div className="chart-empty-icon"><LineChart size={25} /></div></div>
                <div className="chart-labels"><span>시작</span><span>최근</span></div>
                <div className="chart-message">계좌 연동 후 자산 추이를 확인할 수 있습니다.</div>
              </div>
            </section>

            <section className="panel status-panel">
              <div className="panel-heading"><div><h3>연동 상태</h3><span>CONNECTION STATUS</span></div><span className="waiting-badge">연결 대기</span></div>
              <div className="status-row"><div className="status-symbol"><WifiOff size={17} /></div><div><b>KB증권 API</b><span>인증 정보 미등록</span></div><span className="state-text">미연결</span></div>
              <div className="status-row"><div className="status-symbol"><Activity size={17} /></div><div><b>계좌 데이터</b><span>조회 전</span></div><span className="state-text">대기</span></div>
              <div className="status-row"><div className="status-symbol"><Command size={17} /></div><div><b>매매 엔진</b><span>1차 개발 범위 제외</span></div><span className="state-text">중지</span></div>
              <div className="security-note"><ShieldCheck size={15} /><span>실제 주문 API는 연결하지 않습니다.</span></div>
            </section>
          </div>

          <section className="panel holdings-panel">
            <div className="panel-heading"><div><h3>보유 종목</h3><span>POSITIONS</span></div><button className="text-button" onClick={() => setActive('holdings')}>전체 보기 <ArrowUpRight size={14} /></button></div>
            <div className="table-wrap"><table><thead><tr><th>종목명</th><th>보유 수량</th><th>평균 매입가</th><th>현재가</th><th>평가 손익</th><th>수익률</th></tr></thead><tbody><tr><td colSpan={6} className="empty-row"><div><BriefcaseBusiness size={21} /><b>표시할 보유 종목이 없습니다.</b><span>KB증권 계좌를 연결하면 실제 보유 내역이 표시됩니다.</span></div></td></tr></tbody></table></div>
          </section>

          <footer><span>KB AI TRADER <i>v0.1.0</i></span><span><span className="green-dot" /> PAPER-READY · REAL ORDER DISABLED</span></footer>
        </div>
      </main>
    </div>
  )
}

export default App