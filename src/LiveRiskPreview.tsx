import { useRef, useState } from 'react'
import { validateLiveBuyInput } from './liveBuyValidation'
type Preview={
 permitted:boolean;code:string;quantity:number;limitPrice:number;
 notional:number;feeBuffer:number;requiredCash:number;orderableCash:number|null;
 buyingPower:number|null;reasons:string[];checkedAt:string
}
type PreviewResult={success:boolean;locked:boolean;executionEnabled:boolean;
 mode:string;message:string;preview:Preview}
export default function LiveRiskPreview({token}:{token:string}){
  const [code,setCode]=useState('')
  const [quantity,setQuantity]=useState('1')
  const [price,setPrice]=useState('')
  const [busy,setBusy]=useState(false)
  const [report,setReport]=useState<PreviewResult|null>(null)
  const [error,setError]=useState('')
  const requestSequence=useRef(0)
  const invalidate=()=>{
    requestSequence.current++
    setBusy(false)
    setReport(null)
    setError('')
  }
  const inputIssue=validateLiveBuyInput(code,quantity,price)
  const check=async()=>{
    if(inputIssue){
      setReport(null)
      setError('점검 요청 차단 · '+inputIssue+' 실제 주문 및 KB 조회 요청 없음')
      return
    }
    const requestId=++requestSequence.current
    setBusy(true);setError('');setReport(null)
    try{
      const response=await fetch('/api/live/trial',{
        method:'POST',cache:'no-store',
        headers:{'Content-Type':'application/json',Authorization:'Bearer '+token},
        body:JSON.stringify({action:'preflight',code,quantity:Number(quantity),limitPrice:Number(price)}),
        signal:AbortSignal.timeout(45_000)
      })
      const data=await response.json()
      if(!response.ok||!data.success)throw Error(data.message||'안전성 검사 실패')
      if(requestSequence.current===requestId)setReport(data)
    }catch(e){if(requestSequence.current===requestId)setError(e instanceof Error?e.message:'검사 요청 실패')}
    finally{if(requestSequence.current===requestId)setBusy(false)}
  }
  return <div className="panel" style={{padding:20,display:'grid',gap:12}}>
    <div className="panel-heading"><div><h3>실계좌 매수 안전성 검사</h3><span>READ ONLY · SSQM1802 · 실주문 차단</span></div></div>
    <p className="notification-hint">5만 원 이하 지정가 매수 계획을 입력하면 KB증권의 해당 종목 주문가능금액과 D1 주문 상태를 읽어 검증해. 이 버튼은 주식을 매수하거나 주문을 예약하지 않아.</p>
    <div style={{display:'flex',gap:8,flexWrap:'wrap',alignItems:'center'}}>
      <input className="live-trial-field" aria-label="시험 종목코드" placeholder="종목코드 6자리" maxLength={6}
        value={code} onChange={e=>{invalidate();setCode(e.target.value)}} style={{width:155}}/>
      <input className="live-trial-field" aria-label="시험 수량" placeholder="수량" inputMode="numeric"
        value={quantity} onChange={e=>{invalidate();setQuantity(e.target.value)}} style={{width:95}}/>
      <input className="live-trial-field" aria-label="시험 지정가" placeholder="지정가(원)" inputMode="numeric"
        value={price} onChange={e=>{invalidate();setPrice(e.target.value)}} style={{width:140}}/>
      <button type="button" className="outline-button" onClick={()=>void check()} disabled={busy}>
        {busy?'실계좌 조회 중...':'매수 가능 여부 점검'}
      </button>
    </div>
    {inputIssue&&code&&quantity&&price&&<p className="live-trial-inline-error" role="status">입력 조건 확인 · {inputIssue} · 실주문 잠금 유지</p>}
    {report&&<div style={{display:'grid',gap:7}} aria-live="polite">
      <strong>{report.preview.permitted?'안전성 조건 통과 · 실주문 잠금 유지':'검사 조건 미충족 · 실주문 잠금 유지'}</strong>
      <p className="notification-hint">{report.message}</p>
      <div className="notification-meta">
        <span>지정가 매수원금: {report.preview.notional.toLocaleString('ko-KR')}원</span>
        <span>검사 여유금: {report.preview.feeBuffer.toLocaleString('ko-KR')}원</span>
        <span>필요 현금: {report.preview.requiredCash.toLocaleString('ko-KR')}원</span>
        <span>실계좌 주문가능 현금: {report.preview.orderableCash?.toLocaleString('ko-KR')??'확인 불가'}원</span>
      </div>
      {report.preview.reasons.length>0&&<p role="alert" className="news-message">{report.preview.reasons.join(' · ')}</p>}
    </div>}
    {error&&<p role="alert" className="news-message">{error}</p>}
  </div>
}
