/**
 * KB domestic order send adapter.
 * NO ROUTE/Cron calls this module yet. It is NOT enabled in production.
 * The caller must first atomically persist SENDING in D1 and satisfy the
 * daily budget/position checks; otherwise it must never call this adapter.
 * Never retry a submitted order when HTTP response was lost.
 */
import {getKbAccessToken,kbBaseUrl,type KbCredentials} from './kbToken'
import {makeLimitOrder,makeCancelOrder,parseOrderAck,parseCancelAck} from './kbOrderContract'

export type BrokerWriteResult =
 | {state:'ACCEPTED';brokerOrderNo:string}
 | {state:'REJECTED';reason:string}
 | {state:'UNKNOWN';reason:string}

function classifyResponse(value:unknown,httpStatus:number,side:'BUY'|'SELL'|'CANCEL'):BrokerWriteResult{
 const payload=value as any
 if(side==='CANCEL'){
  if(parseCancelAck(payload))return {state:'ACCEPTED',brokerOrderNo:String(payload.dataBody.ordr_no).trim()}
 }else{
  const ack=parseOrderAck(payload,side)
  if(ack.accepted&&ack.orderNo)return {state:'ACCEPTED',brokerOrderNo:ack.orderNo}
 }
 const header=payload?.dataHeader
 const businessCode=String(header?.resultCode??'').trim()
 const flag=String(header?.processFlag??'').trim()
 // Only a valid explicit broker rejection is considered final.
 if(httpStatus>=200&&httpStatus<500&&businessCode&&businessCode!=='200'&&flag)
  return {state:'REJECTED',reason:'KB 업무 거부 응답 · 코드 '+businessCode.slice(0,20)}
 return {state:'UNKNOWN',reason:'주문 처리 여부 불명 · 증권사 주문/체결조회로 확인 필요'}
}
async function once(env:KbCredentials,path:string,body:unknown,side:'BUY'|'SELL'|'CANCEL'):Promise<BrokerWriteResult>{
 // Obtain token before the write. An OAuth error cannot submit an order.
 const token=await getKbAccessToken(env)
 let response:Response
 try{
  response=await fetch(kbBaseUrl(env)+path,{
   method:'POST',headers:{Authorization:'Bearer '+token,'Content-Type':'application/json'},
   body:JSON.stringify(body),signal:AbortSignal.timeout(15000)
  })
 }catch{
  return {state:'UNKNOWN',reason:'주문 전송 응답 없음 · 재전송 금지'}
 }
 let data:unknown
 try {data=await response.json()}
 catch {return {state:'UNKNOWN',reason:'주문 응답 파싱 실패 · 재전송 금지'}}
 return classifyResponse(data,response.status,side)
}
export async function submitKbLimitOnce(env:KbCredentials,side:'BUY'|'SELL',
 input:{code:string;quantity:number;price:number}):Promise<BrokerWriteResult>{
 const request=makeLimitOrder(side,input)
 return once(env,request.path,request.body,side)
}
export async function submitKbCancelOnce(env:KbCredentials,code:string,brokerOrderNo:string):Promise<BrokerWriteResult>{
 const request=makeCancelOrder(code,brokerOrderNo)
 return once(env,request.path,request.body,'CANCEL')
}
