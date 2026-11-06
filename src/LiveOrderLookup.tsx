import { useState } from 'react'
type Result = {success:boolean;found:boolean;message:string;verifiedPages?:number;order?:{
 orderNo:string;code:string;side:string;orderQuantity:number;filledQuantity:number;remainingQuantity:number;orderPrice:number
}}
const API='/api/live/trial'
export default function LiveOrderLookup({token}:{token:string}){
 const [day,setDay]=useState(()=>new Date(Date.now()+9*3600_000).toISOString().slice(0,10).replace(/-/g,''))
 const [code,setCode]=useState('')
 const [orderNo,setOrderNo]=useState('')
 const [side,setSide]=useState<'BUY'|'SELL'>('BUY')
 const [loading,setLoading]=useState(false)
 const [result,setResult]=useState<Result|null>(null)
 const [error,setError]=useState('')
 const lookup=async()=>{
  setLoading(true);setResult(null);setError('')
  try{
   const response=await fetch(API,{method:'POST',cache:'no-store',headers:{
    'Content-Type':'application/json',Authorization:'Bearer '+token},
    body:JSON.stringify({action:'lookup',day,code,orderNo,side}),signal:AbortSignal.timeout(45_000)})
   const value=await response.json() as Result
   if(!response.ok||!value.success)throw Error(value.message||'주문 상태 조회 실패')
   setResult(value)
  }catch(e){setError(e instanceof Error?e.message:'KB 주문 조회 실패')}
  finally{setLoading(false)}
 }
 return <div className="panel" style={{padding:20,display:'grid',gap:12}}>
  <div className="panel-heading"><div><h3>KB증권 주문·체결 조회</h3><span>READ ONLY · SSQM2341 · 실주문 미전송</span></div></div>
  <p className="notification-hint">기존 KB증권 주문번호를 입력하면 매수/매도 주문수량과 체결·미체결 수량을 조회해. 조회되지 않아도 주문 미접수로 확정하지 않아.</p>
  <div style={{display:'flex',gap:8,flexWrap:'wrap',alignItems:'center'}}>
    <input className="live-trial-field" aria-label="주문 날짜" value={day} onChange={e=>setDay(e.target.value)} maxLength={8} placeholder="주문일 YYYYMMDD" style={{width:150}}/>
    <input className="live-trial-field" aria-label="종목 코드" value={code} onChange={e=>setCode(e.target.value)} maxLength={6} placeholder="종목코드 6자리" style={{width:145}}/>
    <input className="live-trial-field" aria-label="주문 번호" value={orderNo} onChange={e=>setOrderNo(e.target.value)} maxLength={15} placeholder="KB 주문번호" style={{width:175}}/>
    <select className="live-trial-field" aria-label="매매 구분" value={side} onChange={e=>setSide(e.target.value as 'BUY'|'SELL')}>
     <option value="BUY">매수</option><option value="SELL">매도</option>
    </select>
    <button className="outline-button" onClick={()=>void lookup()} disabled={loading||!/^20[0-9]{6}$/.test(day)||!/^[0-9]{6}$/.test(code)||!/^[0-9]{1,15}$/.test(orderNo)}>
      {loading?'조회 중...':'체결 상태 조회'}
    </button>
  </div>
  {result&&<div className="notification-hint">{result.message}
   {result.order&&<p><strong>{result.order.orderNo}</strong> · 주문 {result.order.orderQuantity}주 · 체결 {result.order.filledQuantity}주 · 미체결 {result.order.remainingQuantity}주 · 지정가 {result.order.orderPrice.toLocaleString('ko-KR')}원</p>}
  </div>}
  {error&&<p role="alert" className="news-message">{error}</p>}
 </div>
}
