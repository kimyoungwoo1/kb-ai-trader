import {useState} from 'react'

type Order={orderNo:string;orderDate:string;code:string;side:'BUY'|'SELL'|'UNKNOWN';
 orderQuantity:number;filledQuantity:number;remainingQuantity:number;orderPrice:number}
type RecentResponse={success:boolean;orders:Order[];checkedDates:string[];failedDates:string[];
 partial:boolean;message:string}
type ExactResponse={success:boolean;found:boolean;message:string;order?:Order}
const API='/api/live/trial'
const won=(n:number)=>n.toLocaleString('ko-KR')
const sideName=(s:string)=>s==='BUY'?'매수':s==='SELL'?'매도':'방향 확인 필요'

export default function LiveOrderLookup({token}:{token:string}){
 const [range,setRange]=useState<1|3|5>(3)
 const [recent,setRecent]=useState<RecentResponse|null>(null)
 const [recentLoading,setRecentLoading]=useState(false)
 const [day,setDay]=useState(()=>new Date(Date.now()+9*3600_000).toISOString().slice(0,10).replace(/-/g,''))
 const [code,setCode]=useState('')
 const [orderNo,setOrderNo]=useState('')
 const [side,setSide]=useState<'BUY'|'SELL'>('BUY')
 const [loading,setLoading]=useState(false)
 const [result,setResult]=useState<ExactResponse|null>(null)
 const [error,setError]=useState('')
 const scan=async()=>{
  setRecentLoading(true);setRecent(null);setError('')
  try{
   const response=await fetch(API,{method:'POST',cache:'no-store',
    headers:{'Content-Type':'application/json',Authorization:'Bearer '+token},
    body:JSON.stringify({action:'recentOrders',days:range}),signal:AbortSignal.timeout(65000)})
   const value=await response.json() as RecentResponse
   if(!response.ok||!value.success)throw Error(value.message||'최근 주문 조회 실패')
   setRecent(value)
  }catch(e){setError(e instanceof Error?e.message:'KB 주문 조회 실패')}
  finally{setRecentLoading(false)}
 }
 const lookup=async()=>{
  setLoading(true);setResult(null);setError('')
  try{
   const response=await fetch(API,{method:'POST',cache:'no-store',
    headers:{'Content-Type':'application/json',Authorization:'Bearer '+token},
    body:JSON.stringify({action:'lookup',day,code,orderNo,side}),signal:AbortSignal.timeout(45000)})
   const value=await response.json() as ExactResponse
   if(!response.ok||!value.success)throw Error(value.message||'주문 상태 조회 실패')
   setResult(value)
  }catch(e){setError(e instanceof Error?e.message:'KB 주문 조회 실패')}
  finally{setLoading(false)}
 }
 return <div className="panel" style={{padding:20,display:'grid',gap:12}}>
  <div className="panel-heading"><div><h3>KB증권 주문·체결 자동 조회</h3>
   <span>READ ONLY · SSQM2341 · 실주문 미전송</span></div></div>
  <p className="notification-hint">매수 날짜나 주문번호를 기억하지 않아도 돼. 최근 국내주식 주문을 직접 조회해 주문번호와 체결·미체결 수량을 보여줘.</p>
  <div style={{display:'flex',gap:8,flexWrap:'wrap',alignItems:'center'}}>
   <select className="live-trial-field" aria-label="최근 조회할 거래일" value={range}
     onChange={e=>{setRange(Number(e.target.value) as 1|3|5);setRecent(null)}}>
    <option value={1}>최근 1거래일</option>
    <option value={3}>최근 3거래일</option>
    <option value={5}>최근 5거래일</option>
   </select>
   <button type="button" className="outline-button" disabled={recentLoading||loading} onClick={()=>void scan()}>
    {recentLoading?'국내주식 주문 내역 조회 중...':'최근 주문 자동 조회'}
   </button>
  </div>
  {recent&&<div style={{display:'grid',gap:9}} aria-live="polite">
   <p className="notification-hint">{recent.message} · 확인 완료 {recent.checkedDates.length}거래일</p>
   {recent.partial&&<p role="alert" className="live-trial-inline-error">
     일부 조회 실패/페이지 제한이 발생했어. 조회되지 않은 거래일: {recent.failedDates.join(', ')||'목록 제한'}
   </p>}
   {recent.orders.length>0?<div className="notification-list">
     {recent.orders.map((o,i)=><article key={o.orderDate+'-'+o.orderNo+'-'+o.code+'-'+i}
       className="notification-item">
       <div className="notification-item-heading"><strong>{o.orderDate} · {sideName(o.side)} · {o.code}</strong>
        <span>KB 주문번호 {o.orderNo}</span></div>
       <p>주문 {won(o.orderQuantity)}주 · 체결 {won(o.filledQuantity)}주 · 미체결 {won(o.remainingQuantity)}주 · 지정가 {won(o.orderPrice)}원</p>
     </article>)}
   </div>:<p className="notification-hint">선택한 기간에 조회된 국내주식 주문이 없어. 오래전에 산 주식이나 미국주식 주문은 표시되지 않을 수 있어.</p>}
  </div>}
  <p className="notification-hint">참고: 이 API는 날짜별 국내주식 주문 조회야. 이미 보유 중인 주식의 매수일 전체를 역추적하는 기능은 아니고, 해외주식 내역도 조회하지 않아. 기존 보유종목 관리에는 과거 주문번호가 필요하지 않아.</p>
  <details style={{borderTop:'1px solid #2a3d55',paddingTop:12}}>
   <summary style={{cursor:'pointer',fontSize:12,color:'#abc3da'}}>특정 주문 직접 조회 (선택 사항)</summary>
   <div style={{display:'flex',gap:8,flexWrap:'wrap',alignItems:'center',marginTop:12}}>
    <input className="live-trial-field" aria-label="주문 날짜" value={day}
      onChange={e=>setDay(e.target.value)} maxLength={8} placeholder="주문일 YYYYMMDD" style={{width:145}}/>
    <input className="live-trial-field" aria-label="종목 코드" value={code}
      onChange={e=>setCode(e.target.value)} maxLength={6} placeholder="종목코드 6자리" style={{width:145}}/>
    <input className="live-trial-field" aria-label="주문 번호" value={orderNo}
      onChange={e=>setOrderNo(e.target.value)} maxLength={15} placeholder="KB 주문번호" style={{width:180}}/>
    <select className="live-trial-field" aria-label="매매 구분" value={side}
      onChange={e=>setSide(e.target.value as 'BUY'|'SELL')}>
     <option value="BUY">매수</option><option value="SELL">매도</option>
    </select>
    <button className="outline-button" onClick={()=>void lookup()}
      disabled={loading||recentLoading||!/^20[0-9]{6}$/.test(day)||!/^[0-9]{6}$/.test(code)||!/^[0-9]{1,15}$/.test(orderNo)}>
     {loading?'조회 중...':'지정 주문 조회'}
    </button>
   </div>
   {result&&<div className="notification-hint">{result.message}
    {result.order&&<p>주문 {won(result.order.orderQuantity)}주 · 체결 {won(result.order.filledQuantity)}주 · 미체결 {won(result.order.remainingQuantity)}주</p>}
   </div>}
  </details>
  {error&&<p role="alert" className="news-message">{error}</p>}
 </div>
}
