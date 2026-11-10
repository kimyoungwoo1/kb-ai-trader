import {LIVE_BUY_LIMIT_WON,liveBuyRequiredCash} from '../../src/livePilotLimits'
/**
 * Read-only real-account preflight. No trade endpoint, no D1 writes.
 * Uses the user-supplied KB V2 SSQM1802 sample ("is_no" input,
 * "ordr_psbl_csh"/"mx_ordr_psbl_amt" output).
 * A passing result is NOT permission to send a brokerage order.
 */
import { getKbAccessToken, kbBaseUrl, type KbCredentials } from './kbToken'

export const PILOT_LIMIT_WON = LIVE_BUY_LIMIT_WON
export type BuyPreview = {
  permitted:boolean;code:string;quantity:number;limitPrice:number;notional:number;
  feeBuffer:number;requiredCash:number;orderableCash:number|null;
  buyingPower:number|null;reasons:string[];checkedAt:string
}
function safeWon(value:unknown):number|null{
  const raw=String(value??'').trim().replace(/,/g,'')
  if(!/^[0-9]{1,20}$/.test(raw))return null
  const num=Number(raw)
  return Number.isSafeInteger(num)&&num>=0?num:null
}
export function parseBuyingPower(response:unknown):{orderableCash:number;buyingPower:number}{
  const data=response as any
  if(String(data?.dataHeader?.resultCode)!=='200'||String(data?.dataHeader?.processFlag)!=='A')
    throw Error('KB 주문가능금액 업무 응답 실패')
  const orderableCash=safeWon(data?.dataBody?.ordr_psbl_csh)
  const buyingPower=safeWon(data?.dataBody?.mx_ordr_psbl_amt)
  if(orderableCash===null||buyingPower===null)throw Error('주문가능금액 필드 누락/범위 오류')
  return {orderableCash,buyingPower}
}
export function evaluateBuyPreview(code:string,price:number,quantity:number,
  balances:{orderableCash:number;buyingPower:number}|null,
  options:{now?:Date;activeTrialOrders?:number;otherTrialSymbols?:number;dailyBuys?:number}={}):BuyPreview{
  const reasons:string[]=[]
  const now=options.now||new Date()
  const validCode=/^[0-9]{6}$/.test(code)
  if(!validCode)reasons.push('종목코드 형식 오류')
  if(!Number.isSafeInteger(price)||price<1)reasons.push('지정가 오류')
  if(quantity!==1)reasons.push('매수 수량은 1주로 제한됩니다.')
  const notional=Number.isSafeInteger(price)&&Number.isSafeInteger(quantity)&&price>0&&quantity>0?
    price*quantity:0
  const requiredCash=liveBuyRequiredCash(notional)
  const reserve=requiredCash-notional
  if(!Number.isSafeInteger(notional)||notional<=0||notional>PILOT_LIMIT_WON)reasons.push('5만 원 원금 한도 초과/금액 오류')
  if(requiredCash>PILOT_LIMIT_WON)reasons.push('수수료 여유금 포함 총 5만 원 한도 초과')
  if(options.dailyBuys===null||!Number.isSafeInteger(options.dailyBuys)||options.dailyBuys<0)
    reasons.push('당일 매수건수 검증 실패')
  else if(options.dailyBuys>=1)reasons.push('당일 매수 1회 제한')
  if(options.activeTrialOrders===null||!Number.isSafeInteger(options.activeTrialOrders)||options.activeTrialOrders<0)
    reasons.push('실주문 진행 상태 검증 실패')
  else if(options.activeTrialOrders>0)reasons.push('미확인/진행 중 실주문이 있어 신규 주문 차단')
  if(options.otherTrialSymbols===null||!Number.isSafeInteger(options.otherTrialSymbols)||options.otherTrialSymbols<0)
    reasons.push('시험 운용 보유종목 검증 실패')
  else if(options.otherTrialSymbols>0)reasons.push('시험 운용 동시 1종목 제한')
  if(!balances)reasons.push('KB 실계좌 주문가능 현금 검증 실패')
  else {
    if(!Number.isSafeInteger(balances.orderableCash)||balances.orderableCash<0||
       !Number.isSafeInteger(balances.buyingPower)||balances.buyingPower<0)
      reasons.push('KB 주문가능 현금 숫자 검증 실패')
    else if(requiredCash>balances.orderableCash||requiredCash>balances.buyingPower)
      reasons.push('KB 실제 주문가능금액 부족')
  }
  // No live orders outside regular continuous session (KST weekdays 09:00-15:30).
  const kst=new Date(now.getTime()+9*3600_000)
  const minutes=kst.getUTCHours()*60+kst.getUTCMinutes()
  if(kst.getUTCDay()<1||kst.getUTCDay()>5||minutes<540||minutes>=930)
    reasons.push('정규장 외 신규 주문 금지')
  return {permitted:reasons.length===0,code,quantity,limitPrice:price,notional,
    feeBuffer:reserve,requiredCash,
    orderableCash:balances?.orderableCash??null,buyingPower:balances?.buyingPower??null,
    reasons,checkedAt:now.toISOString()}
}
export async function readKbBuyingPower(env:KbCredentials,code:string):Promise<{orderableCash:number;buyingPower:number}>{
  if(!/^[0-9]{6}$/.test(code))throw Error('종목코드 오류')
  const token=await getKbAccessToken(env)
  const response=await fetch(kbBaseUrl(env)+'/api/v1/ssqm1802',{
    method:'POST',headers:{Authorization:'Bearer '+token,'Content-Type':'application/json'},
    body:JSON.stringify({dataHeader:{ipAddr:'127.0.0.1',macAddr:'00:00:00:00:00:00'},dataBody:{is_no:code}}),
    signal:AbortSignal.timeout(15000)
  })
  if(!response.ok)throw Error('KB 주문가능금액 HTTP '+response.status)
  return parseBuyingPower(await response.json())
}
