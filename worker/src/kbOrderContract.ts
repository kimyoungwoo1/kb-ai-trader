import {LIVE_BUY_LIMIT_WON,isLiveOrderTick,liveBuyRequiredCash} from '../../src/livePilotLimits'
/**
 * KB securities V2 order contract. Source: user-provided all_kbstock_sample_V2.zip
 * (SSAM1801/1802/1806 and SSQM2341).
 *
 * Order request BUILDERS ONLY — no order transmission in this module.
 * Read-only order lookup is supported and never retries a write.
 */
import {getKbAccessToken,kbBaseUrl,KbAuthError,type KbCredentials} from './kbToken'
import {fetchKbObserved,isKbGatewayFailure,isKbReadTransportFailure} from './kbAccountRead'

type Input = {code:string;quantity:number;price:number}
export type OrderLine = {
 orderNo:string;code:string;side:'BUY'|'SELL'|'UNKNOWN';
 orderQuantity:number;filledQuantity:number;remainingQuantity:number;
 orderPrice:number;cancelOrAmend:string;originalOrderNo:string
}
const header = () => ({ipAddr:'127.0.0.1',macAddr:'00:00:00:00:00:00'})
const number = (value:unknown):number => {
 const raw=String(value??'').trim().replace(/,/g,'')
 if(!/^[-]?[0-9]+$/.test(raw))return NaN
 const n=Number(raw)
 return Number.isSafeInteger(n)?n:NaN
}
const six = (value:string) => /^[0-9]{6}$/.test(value)
export function makeLimitOrder(side:'BUY'|'SELL',input:Input){
 if(side!=='BUY'&&side!=='SELL')throw Error('매매 구분 오류')
 if(!six(input.code)||!Number.isSafeInteger(input.quantity)||input.quantity<1||
   !Number.isSafeInteger(input.price)||input.price<1)throw Error('지정가 매매 요청값 오류')
 if(side==='BUY'&&input.quantity!==1)throw Error('매수 수량은 1주로 제한됩니다.')
 if(side==='BUY'&&liveBuyRequiredCash(input.price)>LIVE_BUY_LIMIT_WON)throw Error('수수료 여유금 포함 5만 원 매수 한도 초과')
 if(!isLiveOrderTick(input.price))throw Error('거래소 호가단위에 맞지 않는 지정가')
 const path=side==='BUY'?'/api/v1/ssam1802':'/api/v1/ssam1801'
 return {path,body:{dataHeader:header(),dataBody:{
   ordr_uprc:String(input.price),ordr_ccd:'00',mkt_tm_clsf:'1',
   is_cd:input.code,ordr_q:String(input.quantity),sor_ordr_ccd:'S'
 }}}
}
export function makeCancelOrder(code:string,brokerOrderNo:string){
 if(!six(code)||!/^[0-9]{1,15}$/.test(brokerOrderNo))throw Error('원주문번호 또는 종목코드 오류')
 return {path:'/api/v1/ssam1806',body:{dataHeader:header(),dataBody:{
   crct_clsf:'2',is_cd:code,ordr_q:'',orgn_ordr_no:brokerOrderNo
 }}}
}
export function makeOrderInquiry(day:string,key=''){
 if(!/^[0-9]{8}$/.test(day)||key.length>100)throw Error('체결조회 일자/다음키 오류')
 return {path:'/api/v1/ssqm2341',body:{dataHeader:header(),dataBody:{
   ccls_clsf:'0',nxt_key:key,ordr_dt:day
 }}}
}
export function parseOrderAck(response:unknown,side:'BUY'|'SELL'){
 const data=response as any
 const orderNo=String(data?.dataBody?.ordr_no??'').trim()
 const resultCode=String(data?.dataHeader?.resultCode??'')
 const processFlag=String(data?.dataHeader?.processFlag??'')
 const expected=side==='BUY'?'0005':'0004'
 const processCode=String(data?.dataHeader?.processCode??'')
 if(resultCode!=='200'||processFlag!=='A'||processCode!==expected||!/^[0-9]+$/.test(orderNo))
  return {accepted:false,orderNo:null as string|null}
 return {accepted:true,orderNo}
}
export function parseCancelAck(response:unknown){
 const data=response as any
 return String(data?.dataHeader?.resultCode)==='200' &&
  String(data?.dataHeader?.processFlag)==='A' &&
  String(data?.dataHeader?.processCode)==='0014' &&
  /^[0-9]+$/.test(String(data?.dataBody?.ordr_no??'').trim())
}
export function parseOrderLines(response:unknown):{lines:OrderLine[];nextKey:string}{
 const data=response as any
 if(String(data?.dataHeader?.resultCode)!=='200'||data?.dataHeader?.processFlag!=='A')
  throw Error('KB 체결조회 업무 응답 실패')
 const list=data?.dataBody?.Record1
 if(!Array.isArray(list))throw Error('체결조회 Record1 형식 오류')
 const lines:OrderLine[]=list.map((row:any)=>{
   const no=String(row?.ordr_no??'').trim()
   const rawCode=String(row?.stnd_is_no??'').trim()
   const code=rawCode.startsWith('A')?rawCode.slice(1):rawCode
   const sideRaw=String(row?.trd_dl_ccd_nm??'').trim()
   const side:OrderLine['side']=sideRaw==='매수'?'BUY':sideRaw==='매도'?'SELL':'UNKNOWN'
   const q=number(row?.ordr_q),f=number(row?.tl_ccls_q),rem=number(row?.nccls_q),p=number(row?.ordr_uprc)
   if(!/^[0-9]+$/.test(no)||!six(code)||![q,f,rem,p].every(Number.isSafeInteger)||
     q<0||f<0||rem<0||f+rem>q)throw Error('체결조회 행 수량/번호 검증 실패')
   return {orderNo:no,code,side,orderQuantity:q,filledQuantity:f,
     remainingQuantity:rem,orderPrice:p,cancelOrAmend:String(row?.crct_cncl_ccd??'').trim(),
     originalOrderNo:String(row?.orgn_ordr_no??'').trim()}
 })
 return {lines,nextKey:String(data?.dataBody?.nxt_key??'').trim()}
}
export function findOrder(lines:OrderLine[],orderNo:string,code:string,side:'BUY'|'SELL'){
 const match=lines.filter(x=>x.orderNo===orderNo&&x.code===code&&x.side===side)
 if(match.length>1)throw Error('체결조회 주문번호 중복 응답')
 return match[0]||null
}
/** Read-only final cancel evidence. Based on the supplied KB V2 SSQM2341
 * sample, a completed cancellation has its OWN order number, links back to
 * orgn_ordr_no, and marks crct_cncl_ccd with e.g. "1주취완".
 * Never infer a cancel from missing original orders or zero unfilled shares.
 */
export type CancelEvidence={
 confirmed:boolean;fullyFilled:boolean;filledQuantity:number;original:OrderLine|null;
 verifiedPages:number;reason:string
}
export function confirmKbCancelLines(
 lines:OrderLine[],originalOrderNo:string,cancelOrderNo:string,code:string,
 side:'BUY'|'SELL',originalQuantity:number,previousFilled:number
):Omit<CancelEvidence,'verifiedPages'>{
 const match=(x:OrderLine)=>x.code===code&&x.side===side
 const originals=lines.filter(x=>match(x)&&x.orderNo===originalOrderNo)
 const cancellations=lines.filter(x=>match(x)&&x.orderNo===cancelOrderNo)
 if(originals.length>1||cancellations.length>1)
  throw Error('KB 주문·취소 주문번호 중복 · 상태 확정 금지')
 const original=originals[0]||null
 const cancel=cancellations[0]||null
 const base={original,confirmed:false,fullyFilled:false,filledQuantity:previousFilled,
   reason:'취소 체결 증빙 없음 · 확인 대기'}
 if(!Number.isSafeInteger(originalQuantity)||originalQuantity<1||
    !Number.isSafeInteger(previousFilled)||previousFilled<0||previousFilled>originalQuantity)
  throw Error('기존 체결수량 검증 실패')
 if(original){
  if(original.orderQuantity!==originalQuantity||original.filledQuantity<previousFilled||
     original.filledQuantity>originalQuantity)
   throw Error('KB 원주문 수량 불일치 · 상태 확정 금지')
  if(original.filledQuantity===originalQuantity&&original.remainingQuantity===0)
   return {...base,fullyFilled:true,filledQuantity:originalQuantity,reason:'증권사 전량 체결 확인'}
 }
 if(!cancel)return {...base,filledQuantity:original?.filledQuantity??previousFilled}
 // The order acknowledgment alone is not sufficient. This EXACT cancel
 // transaction must link back to the saved order and be marked as completed.
 if(cancel.originalOrderNo!==originalOrderNo||cancel.orderNo===originalOrderNo||
    cancel.orderPrice!==0||cancel.filledQuantity!==0||cancel.remainingQuantity!==0)
  return {...base,filledQuantity:original?.filledQuantity??previousFilled,
   reason:'취소번호·원주문 연결 또는 취소 상세 검증 미완료'}
 const amount=cancel.cancelOrAmend.match(/^([1-9][0-9]*)주취완$/)
 if(!amount)return {...base,filledQuantity:original?.filledQuantity??previousFilled,
   reason:'KB 취소 완료 표시 미확인'}
 const canceled=Number(amount[1])
 if(!Number.isSafeInteger(canceled)||canceled!==cancel.orderQuantity)
  return {...base,filledQuantity:original?.filledQuantity??previousFilled,
   reason:'취소 수량 증빙 불일치'}
 const brokerFilled=original?.filledQuantity??previousFilled
 // If a new fill occurred after our last poll, and the original row has
 // vanished from the history page, do NOT assume it didn't happen.
 // Exact cancel quantity plus known fills must equal the original quantity.
 if(brokerFilled+canceled!==originalQuantity||brokerFilled<previousFilled||
    (original&&original.remainingQuantity!==0))
  return {...base,filledQuantity:brokerFilled,reason:'체결·취소 합산이 원주문 수량과 불일치'}
 return {...base,confirmed:true,filledQuantity:brokerFilled,reason:'증권사 미체결 취소 완료 확인'}
}
export async function lookupKbCancelEvidence(
 env:KbCredentials,day:string,originalOrderNo:string,cancelOrderNo:string,
 code:string,side:'BUY'|'SELL',originalQuantity:number,previousFilled:number
):Promise<CancelEvidence>{
 if(!/^20[0-9]{6}$/.test(day)||!six(code)||
    !/^[0-9]{1,15}$/.test(originalOrderNo)||
    !/^[0-9]{1,15}$/.test(cancelOrderNo)||originalOrderNo===cancelOrderNo)
  throw Error('KB 취소조회 식별자 검증 실패')
 const token=await getKbAccessToken(env)
 const collected:OrderLine[]=[]
 const visited=new Set<string>()
 let nextKey=''
 for(let page=0;page<10;page++){
  const {path,body}=makeOrderInquiry(day,nextKey)
  const response=await fetch(kbBaseUrl(env)+path,{
   method:'POST',headers:{Authorization:'Bearer '+token,'Content-Type':'application/json'},
   body:JSON.stringify(body),signal:AbortSignal.timeout(15000)
  })
  if(!response.ok)throw Error('KB 취소 확인 조회 HTTP '+response.status)
  const parsed=parseOrderLines(await response.json())
  collected.push(...parsed.lines.filter(x=>x.code===code&&x.side===side&&
    (x.orderNo===originalOrderNo||x.orderNo===cancelOrderNo)))
  // Require a complete day-scoped snapshot, NOT a first-page match.
  if(!parsed.nextKey)
   return {...confirmKbCancelLines(collected,originalOrderNo,cancelOrderNo,code,side,
     originalQuantity,previousFilled),verifiedPages:page+1}
  if(visited.has(parsed.nextKey))throw Error('KB 취소확인 다음키 반복')
  visited.add(parsed.nextKey)
  nextKey=parsed.nextKey
 }
 throw Error('KB 취소확인 페이지 상한 초과 · 취소 완료 미확정')
}

export async function lookupKbOrder(env:KbCredentials,day:string,orderNo:string,code:string,side:'BUY'|'SELL'){
 if(!/^[0-9]{1,15}$/.test(orderNo)||!six(code)||!/^20[0-9]{6}$/.test(day))
  throw Error('조회 조건 오류')
 const token=await getKbAccessToken(env)
 let nextKey=''
 const visited=new Set<string>()
 for(let page=0;page<10;page++){
   const {path,body}=makeOrderInquiry(day,nextKey)
   // Query is read-only. Returned data is filtered to requested order only.
   const response=await fetch(kbBaseUrl(env)+path,{
     method:'POST',headers:{Authorization:'Bearer '+token,'Content-Type':'application/json'},
     body:JSON.stringify(body),signal:AbortSignal.timeout(15000)
   })
   if(!response.ok)throw Error('체결조회 HTTP '+response.status)
   const parsed=parseOrderLines(await response.json())
   const found=findOrder(parsed.lines,orderNo,code,side)
   if(found)return {found:true,order:found,verifiedPages:page+1}
   if(!parsed.nextKey)return {found:false,order:null,verifiedPages:page+1}
   if(visited.has(parsed.nextKey))throw Error('KB 체결조회 다음키 반복')
   visited.add(parsed.nextKey)
   nextKey=parsed.nextKey
 }
 throw Error('KB 체결조회 페이지 상한 초과 · 주문 상태 미확정')
}

/** Read-only discovery: users never need to remember a historical order number.
 * SSQM2341 is date-scoped and limited to domestic stocks. Old purchases and
 * foreign equity transactions may not appear and must NOT be inferred missing.
 */
export function recentKbTradingDates(now=new Date(),days:1|3|5=3):string[]{
 if(![1,3,5].includes(days)||!Number.isFinite(now.getTime()))throw Error('최근 조회 범위 오류')
 const date=new Date(now.getTime()+9*3600_000)
 date.setUTCHours(12,0,0,0)
 const result:string[]=[]
 while(result.length<days){
  if(date.getUTCDay()>=1&&date.getUTCDay()<=5)
   result.push(date.toISOString().slice(0,10).replace(/-/g,''))
  date.setUTCDate(date.getUTCDate()-1)
 }
 return result
}
/** Machine-safe categories for failed READ-ONLY order history queries.
 * No brokerage response body, balances, personal records or credentials are emitted.
 */
export type RecentKbIssue='AUTH_FAILED'|'AUTH_RATE_LIMITED'|'HTTP_401'|'HTTP_403'|'HTTP_404'|
 'HTTP_429'|'HTTP_5XX'|'HTTP_OTHER'|'RESPONSE_NOT_JSON'|'BUSINESS_REJECTED'|
 'RECORD1_MISSING'|'RECORD_ROW_INVALID'|'NEXT_KEY_REPEATED'|'PAGE_LIMIT'|
 'TIMEOUT'|'NETWORK_FAILURE'|'UNKNOWN_ERROR'
const safeIssue=(error:unknown):RecentKbIssue=>{
 if(error instanceof KbAuthError)
  return error.rateLimited?'AUTH_RATE_LIMITED':'AUTH_FAILED'
 const message=error instanceof Error?error.message:''
 if(message==='KB_ORDER_NON_JSON')return 'RESPONSE_NOT_JSON'
 if(message==='KB_ORDER_BUSINESS_REJECTED')return 'BUSINESS_REJECTED'
 if(message==='KB_ORDER_RECORD1_MISSING')return 'RECORD1_MISSING'
 if(message==='KB_ORDER_RECORD_ROW_INVALID')return 'RECORD_ROW_INVALID'
 if(message==='KB_ORDER_NEXT_KEY_REPEATED')return 'NEXT_KEY_REPEATED'
 if(message==='KB_ORDER_PAGE_LIMIT')return 'PAGE_LIMIT'
 if(message==='TimeoutError'||(error instanceof Error&&error.name==='TimeoutError'))return 'TIMEOUT'
 if(message==='KB_ORDER_HTTP_401')return 'HTTP_401'
 if(message==='KB_ORDER_HTTP_403')return 'HTTP_403'
 if(message==='KB_ORDER_HTTP_404')return 'HTTP_404'
 if(message==='KB_ORDER_HTTP_429')return 'HTTP_429'
 if(/^KB_ORDER_HTTP_5[0-9]{2}$/.test(message))return 'HTTP_5XX'
 if(/^KB_ORDER_HTTP_[0-9]{3}$/.test(message))return 'HTTP_OTHER'
 if(error instanceof TypeError||error instanceof Error&&/fetch failed|network|ECONN|ETIMEDOUT/i.test(message))
  return 'NETWORK_FAILURE'
 return 'UNKNOWN_ERROR'
}
export type RecentKbOrder=OrderLine&{orderDate:string}
export async function listKbRecentOrders(env:KbCredentials,days:1|3|5=3,now=new Date()):Promise<{
 orders:RecentKbOrder[];checkedDates:string[];failedDates:string[];partial:boolean;
 failedReasons:Record<string,RecentKbIssue>;failedBusinessCodes:Record<string,{resultCode:string;processCode:string;processFlag:string;processMessage?:string}>
}>{
 const dates=recentKbTradingDates(now,days)
 const token=await getKbAccessToken(env)
 const checkedDates:string[]=[],failedDates:string[]=[]
 const failedReasons:Record<string,RecentKbIssue>={}
 const failedBusinessCodes:Record<string,{resultCode:string;processCode:string;processFlag:string;processMessage?:string}>={}
 // Only vendor status fields pass through. Never output dataBody or messages.
 const safeStatus=(value:unknown)=>typeof value==='string'&&/^[A-Za-z0-9_-]{1,16}$/.test(value)?value:
   typeof value==='number'&&Number.isSafeInteger(value)&&value>=0&&value<=999999999999?String(value):'미제공'
 const records:RecentKbOrder[]=[]
 let partial=false
 for(const day of dates){
  let nextKey=''
  const visited=new Set<string>()
  let dayComplete=false
  try{
   for(let page=0;page<3;page++){
    const {path,body}=makeOrderInquiry(day,nextKey)
    // Retry a read-only history page once on transport or gateway failure.
    const requestId=crypto.randomUUID()
    let response:Response|undefined
    for(let attempt=1;attempt<=2;attempt++){
     try{
      response=await fetchKbObserved(kbBaseUrl(env)+path,{
       method:'POST',headers:{Authorization:'Bearer '+token,'Content-Type':'application/json'},
       body:JSON.stringify(body),signal:AbortSignal.timeout(attempt===1?20000:10000)
      },{requestId,attempt})
     }catch(error){
      if(attempt===2||!isKbReadTransportFailure(error))throw error
      continue
     }
     if(attempt===2||!isKbGatewayFailure(response.status))break
     await response.body?.cancel().catch(()=>{})
    }
    if(!response)throw Error('KB_ORDER_NO_RESPONSE')
    if(!response.ok)throw Error('KB_ORDER_HTTP_'+response.status)
    let payload:any
    try{payload=await response.json()}
    catch{throw Error('KB_ORDER_NON_JSON')}
    // The production SSQM2341 response for an empty day uses a business
    // status. Accept only the observed first-page empty shape in history views
    // and pre-arming checks. Exact order and cancel verification stay strict.
    const header=payload?.dataHeader
    const recordsOnPage=payload?.dataBody?.Record1
    const nextPage=payload?.dataBody?.nxt_key
    if(page===0&&response.status===200&&String(header?.resultCode)==='200'&&
       String(header?.processCode)==='1861'&&String(header?.processFlag)==='B'&&
       /^조회할 자료가 없습니다\.?$/.test(String(header?.processMessage??'').trim())&&
       (recordsOnPage==null||(Array.isArray(recordsOnPage)&&recordsOnPage.length===0))&&
       (nextPage==null||(typeof nextPage==='string'&&!nextPage.trim()))){
      dayComplete=true
      break
    }
    if(String(payload?.dataHeader?.resultCode)!=='200'||
       String(payload?.dataHeader?.processFlag)!=='A'){
      failedBusinessCodes[day]={
       resultCode:safeStatus(payload?.dataHeader?.resultCode),
       processCode:safeStatus(payload?.dataHeader?.processCode),
       processFlag:safeStatus(payload?.dataHeader?.processFlag),
       // Display only a short, sanitized vendor explanation. Never expose
       // raw account/order bodies, identifiers, or HTTP authorization.
       processMessage:(()=>{
        const message=String(payload?.dataHeader?.processMessage??'').trim()
        return /^[가-힣 .,()·:_-]{2,90}$/.test(message)?message:'미제공'
       })()
      }
      throw Error('KB_ORDER_BUSINESS_REJECTED')
    }
    if(!Array.isArray(payload?.dataBody?.Record1))
      throw Error('KB_ORDER_RECORD1_MISSING')
    let parsed
    try{parsed=parseOrderLines(payload)}
    catch{throw Error('KB_ORDER_RECORD_ROW_INVALID')}
    for(const line of parsed.lines)records.push({...line,orderDate:day})
    if(!parsed.nextKey){dayComplete=true;break}
    if(visited.has(parsed.nextKey))throw Error('KB_ORDER_NEXT_KEY_REPEATED')
    visited.add(parsed.nextKey)
    nextKey=parsed.nextKey
   }
  }catch(error){
   failedDates.push(day)
   failedReasons[day]=safeIssue(error)
   partial=true
   continue
  }
  if(dayComplete)checkedDates.push(day)
  else{
   failedDates.push(day)
   failedReasons[day]='PAGE_LIMIT'
   partial=true
  }
 }
 const seen=new Set<string>()
 const orders=records.filter(row=>{
   const key=[row.orderDate,row.orderNo,row.code,row.side].join(':')
   if(seen.has(key))return false
   seen.add(key);return true
 }).slice(0,100)
 if(orders.length<records.length)partial=true
 return {orders,checkedDates,failedDates,failedReasons,failedBusinessCodes,partial}
}

// Share only simultaneous UI reads within this isolate. Arming and order
// reconciliation still make their own brokerage checks.
const pendingOrderViews = new Map<string, ReturnType<typeof listKbRecentOrders>>()
export async function listKbRecentOrdersForView(env:KbCredentials,days:1|3|5,now=new Date()){
 const dates=recentKbTradingDates(now,days)
 const key=JSON.stringify([kbBaseUrl(env),env.KB_APP_KEY,env.KB_APP_SECRET,dates])
 const pending=pendingOrderViews.get(key)
 if(pending)return pending
 const request=listKbRecentOrders(env,days,now)
 pendingOrderViews.set(key,request)
 try{return await request}
 finally{pendingOrderViews.delete(key)}
}
