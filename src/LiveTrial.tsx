import { useCallback, useEffect, useState } from 'react'
import { AlertTriangle, CheckCircle2, Lock, RefreshCw, ShieldCheck } from 'lucide-react'
import LiveOrderLookup from './LiveOrderLookup'
import LiveRiskPreview from './LiveRiskPreview'
import LiveAccountHoldings from './LiveAccountHoldings'
import LiveReadiness from './LiveReadiness'
import type {AccountHolding,AccountValuation} from './liveAccountView'
type Candidate={id:number;trading_day:string;code:string;name:string;quantity:number;limit_price:number;notional:number;reason:string;status:string;created_at:string}
type LiveOrder={id:string;code:string;side:'BUY'|'SELL';trading_day:string;quantity:number;limit_price:number;reserved_won:number;filled_quantity:number;state:string;broker_order_id:string|null;cancel_status?:string|null;cancel_order_no?:string|null;updated_at:string}
type TrialStatus={enabled:boolean;hardEnabled?:boolean;brokerOrdersVerified:boolean;mode:string;message:string;limits:{budget:number;maxDailyBuys:number;maxSymbols:number;orderType:string};candidates:Candidate[];orders?:LiveOrder[]}
const API='/api/live/trial'
function orderStatusLabel(order:LiveOrder):string{
 if(order.state==='CANCELED')return order.filled_quantity>0?
   order.side==='BUY'?
    '미체결분 취소 완료 · '+order.filled_quantity+'주 매수 체결 보유':
    '미체결분 취소 완료 · '+order.filled_quantity+'주 매도 체결 · 잔여 보유분 확인 필요':
   '미체결분 취소 완료'
 if(order.state==='CANCEL_REQUESTED'){
   if(order.cancel_status==='ACKNOWLEDGED')return '취소 요청 접수 · 증권사 최종 취소 확인 대기'
   if(order.cancel_status==='UNKNOWN')return '취소 응답 불명 · 재전송 금지 · 수동 확인 필요'
   if(order.cancel_status==='REJECTED')return '취소 요청 거부 · 원주문 확인 필요'
   return '취소 요청 처리 여부 불명 · 재전송 금지'
 }
 if(order.state==='FILLED')return '체결 완료'
 if(order.state==='PARTIAL')return '부분체결 · 잔여 주문 진행'
 if(order.state==='ACCEPTED')return '주문 접수 · 체결 확인 중'
 if(order.state==='SENDING'||order.state==='UNKNOWN')return '주문 응답 불명 · 중복 주문 차단'
 if(order.state==='REJECTED')return '주문 거부'
 return order.state
}
type Props={
  token:string;holdings:AccountHolding[];accountSummary:AccountValuation|null;
  deposit:Record<string,unknown>|null;depositMessage:string;accountMessage:string;
  accountLoading:boolean;onRefreshAccount:()=>void|Promise<void>
}
export default function LiveTrial({token,holdings,accountSummary,deposit,depositMessage,accountMessage,accountLoading,onRefreshAccount}:Props){
  const [status,setStatus]=useState<TrialStatus|null>(null)
  const [error,setError]=useState('')
  const [busy,setBusy]=useState(false)
  const [feedback,setFeedback]=useState('')
  const [confirmation,setConfirmation]=useState('')
  // Account data is centrally loaded once by App after login.
  // Switching to this menu must never start a second brokerage lookup.
  // The existing explicit Refresh button still calls App's shared refresh.
  const arm=async()=>{
    setBusy(true);setError('');setFeedback('')
    try{
      const response=await fetch(API,{method:'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer '+token},
        body:JSON.stringify({action:'arm',confirmation})})
      const data=await response.json()
      if(!response.ok||!data.success)throw Error(data.message||'서버 실거래 잠금 상태')
      setConfirmation('')
      await load()
      setFeedback('✓ '+String(data.message||'오늘 1만원 시험매매 승인 완료')+' · 실제 주문이 발생할 수 있습니다.')
    }catch(e){setError(e instanceof Error?e.message:'활성화 불가')}
    finally{setBusy(false)}
  }
  const load=useCallback(async()=>{
    try{
      const response=await fetch(API,{method:'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer '+token},body:JSON.stringify({action:'status'}),cache:'no-store'})
      const data=await response.json()
      if(!response.ok||!data.success)throw Error(data.message||'조회 실패')
      setStatus(data);setError('')
    }catch(e){setError(e instanceof Error?e.message:'서버 연결 오류')}
  },[token])
  useEffect(()=>{void load();const id=setInterval(()=>void load(),30000);return()=>clearInterval(id)},[load])
  const disable=async()=>{
    setBusy(true);setError('');setFeedback('')
    try{
      const response=await fetch(API,{method:'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer '+token},
        body:JSON.stringify({action:'disable'})})
      const data=await response.json()
      if(!response.ok||!data.success)throw Error(data.message||'잠금 실패')
      await load()
      setFeedback('✓ '+(data.message||'실주문 잠금 상태를 확인했습니다.')+' · '+new Date().toLocaleTimeString('ko-KR'))
    }catch(e){setError(e instanceof Error?e.message:'잠금 실패')}finally{setBusy(false)}
  }
  return <section className="notification-page">
    <div className="page-heading"><div><div className="eyebrow">LIVE TRADING · CONTROLLED PILOT</div>
      <h1>실계좌 시험매매</h1><p>KB증권 실주문 전송 전 안전 제어와 시험 신호를 검증합니다.</p></div>
      <button className="outline-button" disabled={busy} onClick={()=>void load()}><RefreshCw size={14}/> 새로고침</button>
    </div>
    <div className="panel" style={{padding:20,display:'grid',gap:14}}>
      <div style={{display:'flex',gap:10,alignItems:'center'}}><Lock size={21}/><strong>{status?.enabled?'실계좌 시험 자동매매 · 오늘 정규장 활성화':'실주문 잠금 · 기본 비활성화'}</strong></div>
      <p className="notification-hint">{status?.message||'서버 설정과 당일 D1 실행 승인 모두 확인되기 전에는 실주문이 발송되지 않습니다. 기존 계좌 조회와 가상매매는 독립적으로 동작합니다.'}</p>
      <div className="notification-meta">
        <span>총 매수 한도: 10,000원</span><span>하루 매수: 최대 1회</span><span>동시 종목: 1개</span>
        <span>주문 방식: 지정가</span><span>중복 후보: 서버 D1에서 차단</span>
      </div>
      <div style={{display:'flex',gap:10,alignItems:'center'}}><ShieldCheck size={18}/>
        <span>실주문 API 검증: {status?.brokerOrdersVerified?'완료':'실운영 미검증 · 소액 시험 전 확인'}</span>
      </div>
      <div className="notification-actions"><button className="outline-button" disabled={busy} onClick={()=>void disable()}><Lock size={14}/> 실주문 잠금 확인</button></div>
      {status?.hardEnabled&&!status.enabled&&<p role="alert" className="live-trial-inline-error">실제 KB 계좌에서 자동 주문이 발생할 수 있습니다. 하루 1회, 원금 1만원 상한이며 장중 가상매매의 새 체결 신호만 사용합니다. 승인 후 자동 매수는 별도 재확인 없이 전송될 수 있습니다. KB 주문번호와 체결을 증권사 앱에서 반드시 확인해 주세요.</p>}
      {status?.hardEnabled&&!status.enabled&&<div style={{display:'flex',gap:10,flexWrap:'wrap',alignItems:'center'}}>
        <input className="live-trial-field" aria-label="실주문 활성화 확인 문구" style={{width:300}}
          placeholder="실계좌 1만원 자동매매 실행" value={confirmation}
          onChange={e=>setConfirmation(e.target.value)}/>
        <button className="outline-button" disabled={busy||confirmation!=='실계좌 1만원 자동매매 실행'}
          onClick={()=>void arm()}>오늘 실거래 활성화</button>
      </div>}
      {feedback&&<p role="status" aria-live="polite" className="live-trial-inline-success"><CheckCircle2 size={14}/>{feedback}</p>}
      {error&&<p role="alert" className="news-message"><AlertTriangle size={14}/>{error}</p>}
    </div>
    <LiveReadiness token={token}/>
    <LiveAccountHoldings holdings={holdings} summary={accountSummary} deposit={deposit}
      depositMessage={depositMessage} accountMessage={accountMessage} accountLoading={accountLoading}
      onRefreshAccount={onRefreshAccount} pilotOrders={status?.orders}/>
    <div className="panel" style={{padding:20}}>
      <div className="panel-heading"><div><h3>실계좌 주문 원장</h3><span>SERVER D1 · 중복 주문/체결 추적</span></div></div>
      <p className="notification-hint">KB 주문번호가 확인되지 않은 SENDING·UNKNOWN 상태는 새 주문으로 자동 재전송하지 않습니다. 잠금은 기존에 접수된 주문을 취소하지 않습니다.</p>
      {status?.orders?.length?<div className="notification-list">{status.orders.map(order=>
        <article key={order.id} className="notification-item">
          <div className="notification-item-heading"><strong>{order.side==='BUY'?'매수':'매도'} · {order.code}</strong><span>{orderStatusLabel(order)}</span></div>
          <p className="notification-hint">{order.quantity}주 × {order.limit_price.toLocaleString('ko-KR')}원 · 체결 {order.filled_quantity}주 · KB 원주문번호 {order.broker_order_id||'확인 불가'}</p>
          {order.cancel_order_no&&<p className="notification-hint">KB 취소 주문번호 {order.cancel_order_no} · {order.state==='CANCELED'?'증권사 취소 완료 증빙 확인':'취소 요청 접수 확인 · 최종 완료 미확정'}</p>}
          {(order.state==='UNKNOWN'||order.state==='SENDING'||order.cancel_status==='UNKNOWN')&&<p className="live-trial-inline-error">증권사 처리 여부를 확인하기 전까지 동일 주문을 자동으로 다시 보내지 않아.</p>}
        </article>)}</div>:<p className="notification-hint">실계좌 주문 기록 없음 · 실제 주문 미전송</p>}
    </div>
    <LiveRiskPreview token={token} holdings={holdings} holdingsLoaded={Boolean(accountSummary||holdings.length)}/>
    <LiveOrderLookup token={token}/>
    <div className="panel" style={{padding:20}}>
      <div className="panel-heading"><div><h3>시험매매 후보 기록</h3><span>SERVER D1 · DRY RUN ONLY</span></div></div>
      <p className="notification-hint">가상매매 서버에서 확정된 매수 신호 중 1만 원 이하·정규장·2분 이내·당일 첫 종목 조건을 통과한 후보만 기록됩니다. 후보가 기록되어도 실제 매수는 실행되지 않습니다.</p>
      {status?.candidates?.length?<div className="notification-list">{status.candidates.map(item=>
        <article key={item.id} className="notification-item">
          <div className="notification-item-heading"><div><span className="notification-tag">DRY RUN</span>
          <strong>{item.name} ({item.code})</strong></div><span>{new Date(item.created_at).toLocaleString('ko-KR')}</span></div>
          <p>{item.quantity}주 × {item.limit_price.toLocaleString('ko-KR')}원 · 총 {item.notional.toLocaleString('ko-KR')}원</p>
          <p>{item.reason}</p>
        </article>)}</div>:<div className="ai-empty"><CheckCircle2 size={18}/> 아직 기록된 주문 후보가 없습니다.</div>}
    </div>
  </section>
}
