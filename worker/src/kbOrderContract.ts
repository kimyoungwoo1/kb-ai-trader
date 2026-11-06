/**
 * KB securities V2 order contract. Source: user-provided all_kbstock_sample_V2.zip
 * (SSAM1801/1802/1806 and SSQM2341).
 *
 * Order request BUILDERS ONLY — no order transmission in this module.
 * Read-only order lookup is supported and never retries a write.
 */
import {getKbAccessToken,kbBaseUrl,type KbCredentials} from './kbToken'

type Input = {code:string;quantity:number;price:number}
export type OrderLine = {
 orderNo:string;code:string;side:'BUY'|'SELL'|'UNKNOWN';
 orderQuantity:number;filledQuantity:number;remainingQuantity:number;
 orderPrice:number;cancelOrAmend:string
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
 if(side==='BUY'&&input.quantity*input.price>50_000)throw Error('5만 원 매수 한도 초과')
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
     remainingQuantity:rem,orderPrice:p,cancelOrAmend:String(row?.crct_cncl_ccd??'').trim()}
 })
 return {lines,nextKey:String(data?.dataBody?.nxt_key??'').trim()}
}
export function findOrder(lines:OrderLine[],orderNo:string,code:string,side:'BUY'|'SELL'){
 const match=lines.filter(x=>x.orderNo===orderNo&&x.code===code&&x.side===side)
 if(match.length>1)throw Error('체결조회 주문번호 중복 응답')
 return match[0]||null
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
