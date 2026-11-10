import { useCallback, useEffect, useState } from 'react'
import { AlertTriangle, CheckCircle2, Lock, RefreshCw } from 'lucide-react'
import LiveOrderLookup from './LiveOrderLookup'
import LiveAccountHoldings from './LiveAccountHoldings'
import LiveReadiness from './LiveReadiness'
import type {AccountHolding,AccountValuation} from './liveAccountView'
export type LiveOrder={id:string;code:string;side:'BUY'|'SELL';trading_day:string;quantity:number;limit_price:number;reserved_won:number;filled_quantity:number;state:string;broker_order_id:string|null;cancel_status?:string|null;cancel_order_no?:string|null;updated_at:string}
type LiveProgress={
 paperMode:string|null;tick:{result:string;message:string;finished_at:string;scanned:number;filled:number}|null;
 decisions:{event_id:string;code:string;side:string;decision:string;checked_at:string}[]
}
type TrialStatus={enabled:boolean;hardEnabled?:boolean;mode:string;message:string;limits:{budget:number;maxDailyBuys:number;maxSymbols:number;orderType:string};orders?:LiveOrder[];progress?:LiveProgress|null}
const API='/api/live/trial'
const decisionLabels:Record<string,string>={
 accepted_not_filled:'KB 주문 접수 · 체결 확인 대기', rejected:'KB 주문 거부',
 unknown_order_result:'주문 접수 여부 미확정 · 원장 확인 필요',
 budget_exceeded:'지정가가 시험 예산을 초과해 매수 보류',
 account_not_verified:'KB 계좌·주문가능금액 조회 미확인',
 already_held_in_real_account:'실계좌에 이미 보유한 종목',
 journal_unavailable:'서버 주문 원장 확인 실패', risk_blocked:'주문 한도 또는 위험 조건 미충족',
 duplicate_or_blocked:'중복 주문 또는 원장 제한으로 보류', not_claimed:'서버 주문 전송권 미확보',
 disarmed_after_claim:'전송 직전 잠금 또는 정규장 종료', stale_signal:'신호 유효시간 초과',
 invalid_signal:'신호 데이터 검증 실패', no_trial_shares:'시험매매로 보유한 수량 없음',
 sell_not_safe:'시험 매도 조건 미충족', real_holding_insufficient:'실계좌 매도 가능 수량 부족',
 execution_error:'주문 처리 상태 확인 필요 · 원장 확인',
}
export function orderStatusLabel(order:LiveOrder):string{
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
  const [statusError,setStatusError]=useState('')
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
      const response=await fetch(API,{method:'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer '+token},body:JSON.stringify({action:'status'}),cache:'no-store',signal:AbortSignal.timeout(15_000)})
      const data=await response.json()
      if(!response.ok||!data.success)throw Error(data.message||'조회 실패')
      setStatus(data);setStatusError('')
    }catch(e){setStatusError(e instanceof Error?e.message:'서버 연결 오류')}
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
  const autoOrders=status?.orders?.filter(order=>!order.id.startsWith('manual-buy-'))??[]
  return <section className="notification-page">
    <div className="page-heading"><div><div className="eyebrow">LIVE TRADING · CONTROLLED PILOT</div>
      <h1>실계좌 자동매매</h1><p>실주문 잠금, 자동매매 진행 상황, 주문·체결을 확인합니다.</p></div>
      <button className="outline-button" disabled={busy} onClick={()=>void load()}><RefreshCw size={14}/> 새로고침</button>
    </div>
    <div className="panel" style={{padding:20,display:'grid',gap:14}}>
      <div style={{display:'flex',gap:10,alignItems:'center'}}><Lock size={21}/><strong>{!status||statusError?'실주문 상태 확인 필요':status.enabled?'실계좌 자동매매 · 오늘 정규장 활성화':'실주문 잠금 · 기본 비활성화'}</strong></div>
      <p className="notification-hint">{status?.message||'서버 설정과 당일 D1 실행 승인 모두 확인되기 전에는 실주문이 발송되지 않습니다. 기존 계좌 조회와 가상매매는 독립적으로 동작합니다.'}</p>
      <div className="notification-meta">
        <span>총 매수 한도: 10,000원</span><span>하루 매수: 최대 1회</span><span>동시 종목: 1개</span>
        <span>주문 방식: 지정가</span><span>중복 후보: 서버 D1에서 차단</span>
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
      {(error||statusError)&&<p role="alert" className="news-message"><AlertTriangle size={14}/>{error||statusError}</p>}
    </div>
    <div className="panel" style={{padding:20}}>
      <div className="panel-heading"><div><h3>실계좌 자동매매 진행 상황</h3><span>서버에서 30초마다 상태 갱신</span></div></div>
      {!status?.progress?<p className="notification-hint">{status||statusError?'서버 진행 기록을 확인할 수 없습니다.':'서버 진행 상황 조회 중'}</p>:<>
        <p className="notification-hint">{statusError?'상태 조회 실패 · 아래는 마지막으로 확인한 기록':!status.enabled?'실주문 잠금 상태':status.progress.paperMode!=='running'?'서버 자동 가상매매가 중지돼 새 실주문 신호를 받지 않습니다.':'실주문 활성화 · 서버의 새 체결 신호를 받아 주문 조건을 검사합니다.'}</p>
        {status.progress.tick&&<p className="notification-hint">
          최근 서버 감시 {new Date(status.progress.tick.finished_at).toLocaleString('ko-KR')} · {status.progress.tick.message} · 가상 체결 {status.progress.tick.filled}건
        </p>}
        {status.progress.decisions.length?<div className="notification-list">{status.progress.decisions.map(item=>
          <article key={item.event_id} className="notification-item">
            <div className="notification-item-heading"><strong>{item.side==='BUY'?'매수':'매도'} · {item.code}</strong>
              <span>{new Date(item.checked_at).toLocaleString('ko-KR')}</span></div>
            <p>{decisionLabels[item.decision]??'주문 판단 결과 확인 필요'}</p>
          </article>)}</div>:<p className="notification-hint">기록된 실주문 판단 없음 · 접수와 체결은 아래 주문 원장에서 확인</p>}
      </>}
    </div>
    <div className="panel" style={{padding:20}}>
      <div className="panel-heading"><div><h3>실계좌 주문 원장</h3><span>SERVER D1 · 중복 주문/체결 추적</span></div></div>
      <p className="notification-hint">KB 주문번호가 확인되지 않은 SENDING·UNKNOWN 상태는 새 주문으로 자동 재전송하지 않습니다. 잠금은 기존에 접수된 주문을 취소하지 않습니다.</p>
      {!status?<p className="notification-hint">서버 주문 원장 확인 대기</p>:autoOrders.length?<div className="notification-list">{autoOrders.map(order=>
        <article key={order.id} className="notification-item">
          <div className="notification-item-heading"><strong>{order.side==='BUY'?'매수':'매도'} · {order.code}</strong><span>{orderStatusLabel(order)}</span></div>
          <p className="notification-hint">{order.quantity}주 × {order.limit_price.toLocaleString('ko-KR')}원 · 체결 {order.filled_quantity}주 · KB 원주문번호 {order.broker_order_id||'확인 불가'} · 갱신 {new Date(order.updated_at).toLocaleString('ko-KR')}</p>
          {order.cancel_order_no&&<p className="notification-hint">KB 취소 주문번호 {order.cancel_order_no} · {order.state==='CANCELED'?'증권사 취소 완료 증빙 확인':'취소 요청 접수 확인 · 최종 완료 미확정'}</p>}
          {(order.state==='UNKNOWN'||order.state==='SENDING'||order.cancel_status==='UNKNOWN')&&<p className="live-trial-inline-error">증권사 처리 여부를 확인하기 전까지 동일 주문을 자동으로 다시 보내지 않아.</p>}
        </article>)}</div>:<p className="notification-hint">자동매매 주문 기록 없음</p>}
    </div>
    <LiveReadiness token={token}/>
    <details className="panel" style={{padding:20}}>
      <summary>계좌 잔고·기존 보유종목</summary>
    <LiveAccountHoldings holdings={holdings} summary={accountSummary} deposit={deposit}
      depositMessage={depositMessage} accountMessage={accountMessage} accountLoading={accountLoading}
      onRefreshAccount={onRefreshAccount} pilotOrders={status?.orders}/>
    </details>
    <details className="panel" style={{padding:20}}>
      <summary>KB 주문·체결 조회</summary>
      <LiveOrderLookup token={token}/>
    </details>
  </section>
}
