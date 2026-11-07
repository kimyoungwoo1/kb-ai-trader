import {useState} from 'react'
import {RefreshCw,ShieldCheck,ShieldAlert} from 'lucide-react'
type ReadinessCheck={id:string;label:string;status:'PASS'|'BLOCKED'|'UNVERIFIED';detail:string}
type ReadinessResult={success:boolean;locked:boolean;mode:string;brokerWritesVerified:boolean;readOnlyChecksPassed:boolean;checkedAt:string;checks:ReadinessCheck[];message?:string}
const statusLabel=(status:ReadinessCheck['status'])=>
 status==='PASS'?'확인 완료':status==='BLOCKED'?'확인 필요':'미검증'
export default function LiveReadiness({token}:{token:string}){
 const [busy,setBusy]=useState(false)
 const [result,setResult]=useState<ReadinessResult|null>(null)
 const [error,setError]=useState('')
 const inspect=async()=>{
  setBusy(true);setResult(null);setError('')
  try{
   const response=await fetch('/api/live/trial',{
    method:'POST',cache:'no-store',
    headers:{'Content-Type':'application/json',Authorization:'Bearer '+token},
    body:JSON.stringify({action:'readiness'}),signal:AbortSignal.timeout(60000)
   })
   const body=await response.json() as ReadinessResult
   if(!response.ok||!body.success)throw Error(body.message||'준비 상태 점검 실패')
   setResult(body)
  }catch(e){setError(e instanceof Error?e.message:'점검 요청에 실패했어.')}
  finally{setBusy(false)}
 }
 return <section className="panel" style={{padding:20,display:'grid',gap:12}}>
  <div className="panel-heading">
   <div><h3>실거래 준비 점검</h3><span>READ ONLY · D1 원장 + KB SSQM2341 실제 조회</span></div>
   <button className="outline-button" type="button" disabled={busy} onClick={()=>void inspect()}
    style={{display:'inline-flex',alignItems:'center',gap:7}}>
    <RefreshCw size={14}/>{busy?'KB증권 확인 중...':'실거래 준비 점검 실행'}
   </button>
  </div>
  <p className="notification-hint">서버 주문 잠금과 진행 중인 실주문을 확인하고 KB증권의 실제 주문·체결조회 API를 한 번 호출해. 매수·매도·취소 주문이나 D1 데이터 변경은 하지 않아.</p>
  {result&&<div style={{display:'grid',gap:11}} aria-live="polite">
   <div style={{display:'flex',alignItems:'center',gap:8}}>
    {result.readOnlyChecksPassed?<ShieldCheck size={17} color="#8ee1bd"/>:<ShieldAlert size={17} color="#ffd39a"/>}
    <strong>{result.readOnlyChecksPassed?'읽기 전용 검증 통과 · 실주문 전송은 미검증':'실거래 준비 조건 추가 확인 필요 · 주문 잠금 유지'}</strong>
   </div>
   <div className="notification-list">
    {result.checks.map(check=><div className="notification-item" key={check.id}>
     <div className="notification-item-heading"><strong>{check.label}</strong>
      <span style={{color:check.status==='PASS'?'#8ee1bd':check.status==='BLOCKED'?'#ffd39a':'#a8b7cf'}}>{statusLabel(check.status)}</span></div>
     <p>{check.detail}</p>
    </div>)}
   </div>
   <p className="notification-hint">점검 시각: {new Date(result.checkedAt).toLocaleString('ko-KR')} · 실제 주문 API 검증을 완료했거나 실거래가 허용됐다는 의미는 아니야.</p>
  </div>}
  {error&&<p className="live-trial-inline-error" role="alert">{error}</p>}
 </section>
}
