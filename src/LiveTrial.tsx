import { useCallback, useEffect, useState } from 'react'
import { AlertTriangle, CheckCircle2, Lock, RefreshCw, ShieldCheck } from 'lucide-react'
type Candidate={id:number;trading_day:string;code:string;name:string;quantity:number;limit_price:number;notional:number;reason:string;status:string;created_at:string}
type TrialStatus={enabled:boolean;brokerOrdersVerified:boolean;mode:string;message:string;limits:{budget:number;maxDailyBuys:number;maxSymbols:number;orderType:string};candidates:Candidate[]}
const API='/api/live/trial'
export default function LiveTrial({token}:{token:string}){
  const [status,setStatus]=useState<TrialStatus|null>(null)
  const [error,setError]=useState('')
  const [busy,setBusy]=useState(false)
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
    setBusy(true)
    try{
      const response=await fetch(API,{method:'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer '+token},
        body:JSON.stringify({action:'disable'})})
      const data=await response.json()
      if(!response.ok||!data.success)throw Error(data.message||'잠금 실패')
      await load()
    }catch(e){setError(e instanceof Error?e.message:'잠금 실패')}finally{setBusy(false)}
  }
  return <section className="notification-page">
    <div className="page-heading"><div><div className="eyebrow">LIVE TRADING · CONTROLLED PILOT</div>
      <h1>실계좌 시험매매</h1><p>KB증권 실주문 전송 전 안전 제어와 시험 신호를 검증합니다.</p></div>
      <button className="outline-button" disabled={busy} onClick={()=>void load()}><RefreshCw size={14}/> 새로고침</button>
    </div>
    <div className="panel" style={{padding:20,display:'grid',gap:14}}>
      <div style={{display:'flex',gap:10,alignItems:'center'}}><Lock size={21}/><strong>실주문 잠금 · 기본 비활성화</strong></div>
      <p className="notification-hint">현재는 주문 API에 요청을 전송하지 않는 안전 준비 단계입니다. KB증권 공식 주문·체결조회·취소 명세를 검증하고 별도 실주문 연결 구현 및 테스트가 완료되기 전에는 자동매매를 켤 수 없습니다.</p>
      <div className="notification-meta">
        <span>총 매수 한도: 50,000원</span><span>하루 매수: 최대 1회</span><span>동시 종목: 1개</span>
        <span>주문 방식: 지정가</span><span>중복 후보: 서버 D1에서 차단</span>
      </div>
      <div style={{display:'flex',gap:10,alignItems:'center'}}><ShieldCheck size={18}/>
        <span>실주문 API 검증: {status?.brokerOrdersVerified?'완료':'미완료 · 주문 불가'}</span>
      </div>
      <div className="notification-actions"><button className="outline-button" disabled={busy} onClick={()=>void disable()}><Lock size={14}/> 실주문 잠금 확인</button></div>
      {error&&<p role="alert" className="news-message"><AlertTriangle size={14}/>{error}</p>}
    </div>
    <div className="panel" style={{padding:20}}>
      <div className="panel-heading"><div><h3>시험매매 후보 기록</h3><span>SERVER D1 · DRY RUN ONLY</span></div></div>
      <p className="notification-hint">가상매매 서버에서 확정된 매수 신호 중 5만 원 이하·정규장·2분 이내·당일 첫 종목 조건을 통과한 후보만 기록됩니다. 후보가 기록되어도 실제 매수는 실행되지 않습니다.</p>
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
