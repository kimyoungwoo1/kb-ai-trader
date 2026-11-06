/**
 * Once-only automatic cancellation of stale, verified open KB orders.
 *
 * A D1 UNIQUE claim is written BEFORE any cancel POST. If the process fails
 * after claim, the cancellation is NOT retried automatically. An acknowledged
 * cancellation is NOT proof the remaining order quantity was canceled;
 * read-only SSQM2341 reconciliation determines the final state.
 */
import { lookupKbOrder } from './kbOrderContract'
import { submitKbCancelOnce } from './kbOrderSubmit'
import type { KbCredentials } from './kbToken'

type Db=any
type Env=KbCredentials&{LIVE_TRADING_HARD_ENABLE?:string}
export const STALE_ORDER_MS=3*60_000
type Summary={examined:number;attempted:number;acknowledged:number;uncertain:number;deferred:number}
const safeNumber=(x:unknown)=>{if(x===null||x===undefined||x==='')return NaN;const n=Number(x);return Number.isSafeInteger(n)&&n>=0?n:NaN}
const changes=(x:any)=>Number(x?.meta?.changes)===1
const dayKst=(date:Date)=>new Date(date.getTime()+9*3600_000).toISOString().slice(0,10)
const regular=(date:Date)=>{
 const shifted=new Date(date.getTime()+9*3600_000),m=shifted.getUTCHours()*60+shifted.getUTCMinutes()
 return shifted.getUTCDay()>0&&shifted.getUTCDay()<6&&m>=540&&m<920
}
const empty=():Summary=>({examined:0,attempted:0,acknowledged:0,uncertain:0,deferred:0})
export async function cancelOverdueLiveOrders(db:Db|undefined,env:Env,now=new Date()):Promise<Summary>{
 const total=empty()
 // A normal deployment has no hard enable binding. Cancel writes remain disabled.
 if(!db||env.LIVE_TRADING_HARD_ENABLE!=='ALLOW_REAL_50000_TRIAL_2026'||!regular(now))return total
 const day=dayKst(now)
 const gate=await db.prepare('SELECT enabled,trading_day FROM live_execution_gate WHERE id=1').first()
 if(gate?.enabled!==1||gate?.trading_day!==day)return total
 const threshold=new Date(now.getTime()-STALE_ORDER_MS).toISOString()
 const query=await db.prepare(
  "SELECT id,trading_day,code,side,quantity,limit_price,broker_order_id,filled_quantity,created_at,state "+
  "FROM live_order_journal WHERE trading_day=? AND state IN ('ACCEPTED','PARTIAL') "+
  "AND broker_order_id IS NOT NULL AND created_at<=? ORDER BY created_at LIMIT 5"
 ).bind(day,threshold).all()
 if(!Array.isArray(query?.results))throw Error('주문 취소 대상 조회 실패')
 for(const raw of query.results){
  total.examined++
  const code=String(raw.code||''),orderNo=String(raw.broker_order_id||'')
  const quantity=safeNumber(raw.quantity),filled=safeNumber(raw.filled_quantity)
  if(!/^[0-9]{6}$/.test(code)||!/^[0-9]{1,15}$/.test(orderNo)||
    (raw.side!=='BUY'&&raw.side!=='SELL')||!Number.isSafeInteger(quantity)||quantity<1||
    !Number.isSafeInteger(filled)||filled>=quantity||!Number.isSafeInteger(safeNumber(raw.limit_price))){
   total.deferred++;continue
  }
  // A fresh read catches fills that happened since the previous Cron tick.
  let latest
  try{latest=await lookupKbOrder(env,day.replaceAll('-',''),orderNo,code,raw.side)}
  catch{total.deferred++;continue}
  if(!latest.found||!latest.order){total.deferred++;continue}
  const actual=latest.order
  if(actual.orderQuantity!==quantity||actual.orderPrice!==Number(raw.limit_price)||
    actual.filledQuantity<filled||actual.filledQuantity+actual.remainingQuantity>quantity||
    actual.remainingQuantity<=0){total.deferred++;continue}
  // Atomic claim: even if two Cron invocations race, exactly one can call SSAM1806.
  // It is safe to be overly conservative: a failed claim may require manual review.
  const claimed=await db.prepare(
   "INSERT OR IGNORE INTO live_order_cancel_attempts(order_id,original_broker_order_no,requested_at,status,updated_at) "+
   "SELECT id,broker_order_id,?,'CLAIMED',? FROM live_order_journal "+
   "WHERE id=? AND trading_day=? AND state IN ('ACCEPTED','PARTIAL') "+
   "AND broker_order_id=? AND filled_quantity<=? AND quantity>? "+
   "AND EXISTS(SELECT 1 FROM live_execution_gate WHERE id=1 AND enabled=1 AND trading_day=?)"
  ).bind(now.toISOString(),now.toISOString(),raw.id,day,orderNo,actual.filledQuantity,actual.filledQuantity,day).run()
  if(!changes(claimed)){total.deferred++;continue}
  const marked=await db.prepare(
    "UPDATE live_order_journal SET state='CANCEL_REQUESTED',filled_quantity=?,updated_at=? "+
    "WHERE id=? AND state IN ('ACCEPTED','PARTIAL') AND broker_order_id=? AND filled_quantity<=?"
  ).bind(actual.filledQuantity,now.toISOString(),raw.id,orderNo,actual.filledQuantity).run()
  if(!changes(marked)){total.deferred++;continue}
  // No automatic retry, even if OAuth, network, JSON parsing or persistence fails.
  total.attempted++
  let result
  try{result=await submitKbCancelOnce(env,code,orderNo)}
  catch{result={state:'UNKNOWN' as const}}
  const status=result.state==='ACCEPTED'?'ACKNOWLEDGED':result.state==='REJECTED'?'REJECTED':'UNKNOWN'
  if(status==='ACKNOWLEDGED')total.acknowledged++
  else total.uncertain++
  // Failure to persist leaves CLAIMED, also a permanent no-retry marker.
  try{
   await db.prepare(
     "UPDATE live_order_cancel_attempts SET status=?,cancel_broker_order_no=?,updated_at=? "+
     "WHERE order_id=? AND status='CLAIMED'"
   ).bind(status,result.state==='ACCEPTED'?result.brokerOrderNo:null,new Date().toISOString(),raw.id).run()
  }catch{total.uncertain++}
 }
 return total
}
