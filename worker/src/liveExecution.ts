/**
 * Real-account trial engine. HARD LOCKED by default: Cloudflare has no
 * LIVE_TRADING_HARD_ENABLE binding; D1 live_execution_gate defaults to OFF.
 * Automatic trades require committed paper fills. Manual buys use a separate gate.
 */
import {readKbBuyingPower,evaluateBuyPreview} from './liveRiskPreflight'
import {lookupKbOrder,lookupKbCancelEvidence,listKbRecentOrders} from './kbOrderContract'
import {submitKbLimitOnce,submitKbCancelOnce} from './kbOrderSubmit'
import {getKbAccessToken,kbBaseUrl,type KbCredentials} from './kbToken'
import {transitionOrder,type OrderRecord} from './liveOrderJournal'

type Db=any
export type LiveEnv=KbCredentials&{LIVE_TRADING_HARD_ENABLE?:string}
export type LiveFill={id:string;at:string;code:string;side:'BUY'|'SELL';price:number;quantity:number;test?:boolean}
export const MAX_PILOT_WON=10_000
const hardSwitch=(env:LiveEnv)=>env.LIVE_TRADING_HARD_ENABLE==='ALLOW_REAL_10000_TRIAL_2026'
const tradingDay=(date:Date)=>new Date(date.getTime()+9*3600_000).toISOString().slice(0,10)
const inSession=(date:Date)=>{const k=new Date(date.getTime()+9*3600_000),m=k.getUTCHours()*60+k.getUTCMinutes();return k.getUTCDay()>=1&&k.getUTCDay()<=5&&m>=540&&m<930}
const num=(value:unknown)=>{const n=Number(value);return value===null||value===undefined||value===''||!Number.isSafeInteger(n)||n<0?NaN:n}
const changed=(result:any)=>Number(result?.meta?.changes)===1
const dateToKb=(day:string)=>day.replaceAll('-','')
const identity=(side:'BUY'|'SELL',eventId:string)=>'trial-'+side.toLowerCase()+'-'+eventId.replace(/[^A-Za-z0-9:_-]/g,'_').slice(0,103)
const rowFromDb=(r:any):OrderRecord=>({id:String(r.id),tradingDay:String(r.trading_day),code:String(r.code),side:r.side,
 quantity:Number(r.quantity),limitPrice:Number(r.limit_price),reservedWon:Number(r.reserved_won),
 state:r.state,brokerOrderId:r.broker_order_id??null,filledQuantity:Number(r.filled_quantity),updatedAt:String(r.updated_at)})
const manualGateSql='EXISTS (SELECT 1 FROM live_execution_gate WHERE id=1 AND enabled=0)'
async function manualGateOpen(db:Db,env:LiveEnv,now:Date){
 if(!hardSwitch(env)||!inSession(now))return false
 const row=await db.prepare('SELECT enabled,trading_day FROM live_execution_gate WHERE id=1').first()
 return row?.enabled===0
}
export async function submitManualLimitBuy(db:Db,env:LiveEnv,input:{id:string;code:string;price:number;quantity:number},now=new Date()){
 if(!/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(input.id)||
    !/^\d{6}$/.test(input.code)||!Number.isSafeInteger(input.price)||input.price<1||
    !Number.isSafeInteger(input.quantity)||input.quantity<1)return 'invalid_signal'
 if(!(await manualGateOpen(db,env,now)))return 'manual_locked'
 if(input.quantity>Math.floor(9_900/input.price))return 'budget_exceeded'
 try{
  const history=await listKbRecentOrders(env,1,now)
  if(history.partial||history.checkedDates.length!==1)return 'history_unavailable'
  if(history.orders.some(order=>order.code===input.code&&order.remainingQuantity>0))return 'duplicate_or_blocked'
 }catch{return 'history_unavailable'}
 return submitLiveBuy(db,env,{...input,at:now.toISOString(),side:'BUY'},now,true)
}
export async function getLiveGate(db:Db|undefined,env:LiveEnv,now=new Date()){
 if(!db)return {enabled:false,hardEnabled:hardSwitch(env),reason:'D1 연결 없음'}
 try{
  const row=await db.prepare('SELECT enabled,trading_day,updated_at FROM live_execution_gate WHERE id=1').first()
  const enabled=hardSwitch(env)&&row?.enabled===1&&row?.trading_day===tradingDay(now)&&inSession(now)
  return {enabled,hardEnabled:hardSwitch(env),tradingDay:row?.trading_day||null,
    reason:enabled?'오늘 정규장에 한해 주문 허용':'기본 잠금 · 주문 발송 불가'}
 }catch{return {enabled:false,hardEnabled:hardSwitch(env),reason:'D1 실행 잠금 확인 실패'}}
}
export async function disarmLiveTrading(db:Db|undefined){
 if(!db)return false
 try{
  await db.prepare('INSERT INTO live_execution_gate(id,enabled,trading_day,updated_at) VALUES(1,0,NULL,?) ON CONFLICT(id) DO UPDATE SET enabled=0,trading_day=NULL,updated_at=excluded.updated_at')
   .bind(new Date().toISOString()).run()
  return true
 }catch{return false}
}
export async function armLiveTrading(db:Db|undefined,env:LiveEnv,confirmation:string,now=new Date()){
 if(!db||!hardSwitch(env)||confirmation!=='실계좌 1만원 자동매매 실행'||!inSession(now))return false
 try{
  const [active,cancels]=await Promise.all([
   db.prepare("SELECT COUNT(*) AS n FROM live_order_journal WHERE state IN ('RESERVED','SENDING','UNKNOWN','ACCEPTED','PARTIAL','CANCEL_REQUESTED')").first(),
   db.prepare("SELECT COUNT(*) AS n FROM live_cancel_journal WHERE status IN ('CLAIMED','UNKNOWN','REJECTED')").first()
  ])
  if(num(active?.n)!==0||num(cancels?.n)!==0)return false
  const today=tradingDay(now)
  const armed=await db.prepare("INSERT INTO live_execution_gate(id,enabled,trading_day,updated_at) SELECT 1,1,?,? "+
   "WHERE NOT EXISTS(SELECT 1 FROM live_order_journal WHERE state IN ('RESERVED','SENDING','UNKNOWN','ACCEPTED','PARTIAL','CANCEL_REQUESTED')) "+
   "AND NOT EXISTS(SELECT 1 FROM live_cancel_journal WHERE status IN ('CLAIMED','UNKNOWN','REJECTED')) "+
   "ON CONFLICT(id) DO UPDATE SET enabled=1,trading_day=excluded.trading_day,updated_at=excluded.updated_at")
   .bind(today,now.toISOString()).run()
  return changed(armed)
 }catch{return false}
}
/** Independent KB holdings cross-check before any REAL order.
 * SSQM2952 may omit/collapse positions; a zero balance is not proof that
 * no shares are held. Cross-validate against the dashboard's SSQM1801 source.
 * No real-money write is ever sent by these reads.
 */
function stockQuantity(row:any,codeField:'is_cd'|'is_no',quantityField:'hld_q'|'gnrl_q'):number|null{
 const rawCode=String(row?.[codeField]??'').trim().replace(/^A(?=[0-9]{6}$)/,'')
 if(rawCode!==''){
   if(!/^[0-9]{6}$/.test(rawCode))return null // foreign equity; not in domestic trial
   if(row?.[quantityField]===null||row?.[quantityField]===undefined||row?.[quantityField]==='')
     throw Error('KB 보유수량 필수 숫자 필드 누락 · 실주문 차단')
   const amount=num(row[quantityField])
   if(!Number.isSafeInteger(amount))throw Error('KB 보유수량 숫자 검증 실패 · 실주문 차단')
   return amount
 }
 // A missing security code means this row cannot prove that target is absent.
 throw Error('KB 보유종목코드 필드 누락 · 실주문 차단')
}
export async function readKbHeldQuantity(env:KbCredentials,code:string):Promise<number>{
 if(!/^[0-9]{6}$/.test(code))throw Error('종목코드 오류')
 const token=await getKbAccessToken(env)
 const headers={Authorization:'Bearer '+token,'Content-Type':'application/json'}
 const body=(dataBody:unknown)=>JSON.stringify({
  dataHeader:{ipAddr:'127.0.0.1',macAddr:'00:00:00:00:00:00'},dataBody
 })
 const valuationResponse=await fetch(kbBaseUrl(env)+'/api/v1/ssqm2952',{
  method:'POST',headers,body:body({excg_mktpr_ccd:'A'}),
  signal:AbortSignal.timeout(15000)
 })
 if(!valuationResponse.ok)throw Error('KB 자산평가 보유수량 조회 실패')
 const valuation:any=await valuationResponse.json()
 if(String(valuation?.dataHeader?.resultCode)!=='200'||!Array.isArray(valuation?.dataBody?.Record1))
  throw Error('KB 자산평가 수량 검증 실패')
 let valuationShares=0
 for(const row of valuation.dataBody.Record1){
  const rawCode=String(row?.is_cd??'').trim().replace(/^A(?=[0-9]{6}$)/,'')
  if(rawCode!==code){if(!rawCode)throw Error('KB 자산평가 종목코드 누락');continue}
  const rawQuantity=row?.hld_q??row?.ec_q
  if(rawQuantity===null||rawQuantity===undefined||rawQuantity==='')
   throw Error('KB 자산평가 보유수량 누락')
  const q=num(rawQuantity)
  if(!Number.isSafeInteger(q))throw Error('KB 자산평가 보유수량 오류')
  valuationShares+=q
 }
 if(!Number.isSafeInteger(valuationShares))throw Error('KB 자산평가 수량 합산 오류')
 let availableShares=0,nextKey=''
 const seen=new Set<string>()
 for(let page=0;page<10;page++){
  const response=await fetch(kbBaseUrl(env)+'/api/v1/ssqm1801',{
   method:'POST',headers,body:body({mkt_tm_ccd:'1',nxt_key:nextKey,inq_clsf:'0',is_no:''}),
   signal:AbortSignal.timeout(15000)
  })
  if(!response.ok)throw Error('KB 실제 보유종목 조회 실패')
  const holdings:any=await response.json()
  if(String(holdings?.dataHeader?.resultCode)!=='200'||!Array.isArray(holdings?.dataBody?.Record1))
   throw Error('KB 보유종목 응답 검증 실패')
  for(const row of holdings.dataBody.Record1){
   const rawCode=String(row?.is_no??'').trim().replace(/^A(?=[0-9]{6}$)/,'')
   if(!rawCode)throw Error('KB 보유종목코드 누락 · 실주문 차단')
   if(rawCode!==code)continue
   const q=stockQuantity(row,'is_no','gnrl_q')
   if(q===null)throw Error('국내주식 보유수량 확인 실패')
   availableShares+=q
  }
  if(!Number.isSafeInteger(availableShares))throw Error('KB 보유종목 수량 합산 오류')
  const next=String(holdings.dataBody.nxt_key??'').trim()
  if(!next){
   if(valuationShares!==availableShares)
    throw Error('KB 계좌평가·보유종목 수량 불일치 · 실주문 차단')
   return valuationShares
  }
  if(seen.has(next))throw Error('KB 보유종목 다음키 반복')
  seen.add(next);nextKey=next
 }
 throw Error('KB 보유종목 페이지 한도 초과 · 실주문 차단')
}
/** Read-only SSQM1801 orderable stock check before any live SELL. */
export async function readKbSellableQuantity(env:KbCredentials,code:string):Promise<number>{
 if(!/^[0-9]{6}$/.test(code))throw Error('종목코드 오류')
 const token=await getKbAccessToken(env)
 let nextKey='',total=0
 const seen=new Set<string>()
 for(let page=0;page<10;page++){
  const response=await fetch(kbBaseUrl(env)+'/api/v1/ssqm1801',{
   method:'POST',headers:{Authorization:'Bearer '+token,'Content-Type':'application/json'},
   body:JSON.stringify({dataHeader:{ipAddr:'127.0.0.1',macAddr:'00:00:00:00:00:00'},
     dataBody:{inq_clsf:'1',is_no:'',mkt_tm_ccd:'1',nxt_key:nextKey}}),
   signal:AbortSignal.timeout(15000)
  })
  if(!response.ok)throw Error('KB 주문가능 보유수량 HTTP 오류')
  const payload:any=await response.json()
  if(String(payload?.dataHeader?.resultCode)!=='200'||!Array.isArray(payload?.dataBody?.Record1))
   throw Error('KB 주문가능 보유수량 검증 실패')
  for(const row of payload.dataBody.Record1){
   if(String(row?.is_no??'').replace(/^A/,'')!==code)continue
   const n=num(row?.ordr_psbl_q)
   if(!Number.isSafeInteger(n))throw Error('KB 매도 가능 수량 숫자 오류')
   total+=n
  }
  const next=String(payload.dataBody.nxt_key??'').trim()
  if(!next){
   if(!Number.isSafeInteger(total))throw Error('매도 가능 수량 합계 오류')
   return total
  }
  if(seen.has(next))throw Error('KB 보유수량 다음키 반복')
  seen.add(next);nextKey=next
 }
 throw Error('KB 주문가능 보유수량 페이지 한도 초과')
}
async function journalSummary(db:Db,now:Date){
 const day=tradingDay(now)
 const [buy,active,held,principal]=await Promise.all([
  db.prepare("SELECT COUNT(*) AS n FROM live_order_journal WHERE trading_day=? AND side='BUY'").bind(day).first(),
  db.prepare("SELECT COUNT(*) AS n FROM live_order_journal WHERE state IN ('RESERVED','SENDING','UNKNOWN','ACCEPTED','PARTIAL','CANCEL_REQUESTED')").first(),
  db.prepare("SELECT COUNT(DISTINCT code) AS n FROM live_order_journal WHERE side='BUY' AND (state NOT IN ('REJECTED','CANCELED') OR (state='CANCELED' AND filled_quantity>0))").first(),
  db.prepare("SELECT COALESCE(SUM(reserved_won),0) AS n FROM live_order_journal WHERE side='BUY' AND (state NOT IN ('REJECTED','CANCELED') OR (state='CANCELED' AND filled_quantity>0))").first()
 ])
 const values=[buy?.n,active?.n,held?.n,principal?.n].map(num)
 if(values.some(v=>!Number.isSafeInteger(v)))throw Error('D1 원장 위험금액 조회 실패')
 return {dailyBuys:values[0],active:values[1],symbols:values[2],principal:values[3]}
}
/** This is the ONLY entry point for prospective live trades from Cron. */
export async function processLiveFill(db:Db|undefined,env:LiveEnv,fill:LiveFill,now=new Date()):Promise<string>{
 if(!db||!hardSwitch(env))return 'locked'
 if(!(await getLiveGate(db,env,now)).enabled)return 'locked'
 if(!fill||fill.test||!['BUY','SELL'].includes(fill.side)||!/^[0-9]{6}$/.test(String(fill.code))||
    !Number.isSafeInteger(fill.price)||fill.price<1||!Number.isSafeInteger(fill.quantity)||fill.quantity<1||
    !/^[A-Za-z0-9:_.-]{1,120}$/.test(fill.id||''))return 'invalid_signal'
 const age=now.getTime()-Date.parse(fill.at)
 if(!Number.isFinite(age)||age<0||age>90_000)return 'stale_signal'
 return fill.side==='BUY'?submitLiveBuy(db,env,fill,now):submitLiveSell(db,env,fill,now)
}
async function submitLiveBuy(db:Db,env:LiveEnv,fill:LiveFill,now:Date,manual=false):Promise<string>{
 const quantity=manual?fill.quantity:Math.min(fill.quantity,Math.floor(9_900/fill.price))
 if(quantity<1)return 'budget_exceeded'
 let balances,held:number
 try{[balances,held]=await Promise.all([readKbBuyingPower(env,fill.code),readKbHeldQuantity(env,fill.code)])}
 catch{return 'account_not_verified'}
 if(held>0)return 'already_held_in_real_account'
 let summary
 try{summary=await journalSummary(db,now)}catch{return 'journal_unavailable'}
 const preview=evaluateBuyPreview(fill.code,fill.price,quantity,balances,{
  now,dailyBuys:summary.dailyBuys,activeTrialOrders:summary.active,otherTrialSymbols:summary.symbols
 })
 if(!preview.permitted||summary.principal+preview.requiredCash>MAX_PILOT_WON)return 'risk_blocked'
 const day=tradingDay(now),stamp=now.toISOString()
 if(manual){
  const checkedAt=new Date()
  if(!inSession(checkedAt)||tradingDay(checkedAt)!==day)return 'manual_locked'
 }
 const id=manual?'manual-buy-'+fill.id:identity('BUY',fill.id)
 const gate=manual?manualGateSql:'EXISTS (SELECT 1 FROM live_execution_gate WHERE id=1 AND enabled=1 AND trading_day=?)'
 const cancelGuard=manual?" AND NOT EXISTS (SELECT 1 FROM live_cancel_journal WHERE status IN ('CLAIMED','UNKNOWN','REJECTED'))":''
 // Single D1 INSERT ... SELECT, protected by unique daily BUY index.
 const sql="INSERT OR IGNORE INTO live_order_journal (id,trading_day,code,side,quantity,limit_price,reserved_won,state,broker_order_id,filled_quantity,created_at,updated_at) "+
   "SELECT ?,?,?, 'BUY',?,?,?,'RESERVED',NULL,0,?,? WHERE "+gate+" "+
   "AND NOT EXISTS (SELECT 1 FROM live_order_journal WHERE trading_day=? AND side='BUY') "+
   "AND NOT EXISTS (SELECT 1 FROM live_order_journal WHERE state NOT IN ('REJECTED','CANCELED'))"+cancelGuard
 const saved=await db.prepare(sql).bind(id,day,fill.code,quantity,fill.price,preview.requiredCash,stamp,stamp,...(manual?[]:[day]),day).run()
 if(!changed(saved))return 'duplicate_or_blocked'
 return claimAndSubmit(db,env,id,fill.code,'BUY',quantity,fill.price,now,manual)
}
async function submitLiveSell(db:Db,env:LiveEnv,fill:LiveFill,now:Date):Promise<string>{
 const owned=await db.prepare("SELECT COALESCE(SUM(CASE WHEN side='BUY' THEN filled_quantity ELSE -filled_quantity END),0) AS shares FROM live_order_journal WHERE code=? AND id NOT LIKE 'manual-buy-%'").bind(fill.code).first()
 const shares=num(owned?.shares)
 if(!Number.isSafeInteger(shares)||shares<1)return 'no_trial_shares'
 const buy=await db.prepare("SELECT COUNT(*) AS n FROM live_order_journal WHERE code=? AND id NOT LIKE 'manual-buy-%' AND side='BUY' AND (state='FILLED' OR (state='CANCELED' AND filled_quantity>0))").bind(fill.code).first()
 const existing=await db.prepare("SELECT COUNT(*) AS n FROM live_order_journal WHERE code=? AND side='SELL'").bind(fill.code).first()
 if(num(buy?.n)!==1||num(existing?.n)!==0)return 'sell_not_safe'
 let realHolding:number,realSellable:number
 try{[realHolding,realSellable]=await Promise.all([
   readKbHeldQuantity(env,fill.code),readKbSellableQuantity(env,fill.code)
 ])}catch{return 'account_not_verified'}
 if(realHolding<shares||realSellable<shares)return 'real_holding_insufficient'
 const id=identity('SELL',fill.id),day=tradingDay(now),stamp=now.toISOString()
 const sql="INSERT OR IGNORE INTO live_order_journal (id,trading_day,code,side,quantity,limit_price,reserved_won,state,broker_order_id,filled_quantity,created_at,updated_at) "+
  "SELECT ?,?,?,'SELL',?,?,0,'RESERVED',NULL,0,?,? WHERE EXISTS(SELECT 1 FROM live_execution_gate WHERE id=1 AND enabled=1 AND trading_day=?) "+
  "AND NOT EXISTS(SELECT 1 FROM live_order_journal WHERE side='SELL' AND code=?) "+
  "AND NOT EXISTS(SELECT 1 FROM live_order_journal WHERE state IN ('RESERVED','SENDING','UNKNOWN','ACCEPTED','PARTIAL','CANCEL_REQUESTED'))"
 const saved=await db.prepare(sql).bind(id,day,fill.code,shares,fill.price,stamp,stamp,day,fill.code).run()
 if(!changed(saved))return 'duplicate_or_blocked'
 return claimAndSubmit(db,env,id,fill.code,'SELL',shares,fill.price,now)
}
async function claimAndSubmit(db:Db,env:LiveEnv,id:string,code:string,side:'BUY'|'SELL',quantity:number,price:number,now:Date,manual=false):Promise<string>{
 const claimed=await db.prepare("UPDATE live_order_journal SET state='SENDING',updated_at=? WHERE id=? AND state='RESERVED' AND "+
  (manual?manualGateSql:"EXISTS(SELECT 1 FROM live_execution_gate WHERE id=1 AND enabled=1 AND trading_day=?)"))
  .bind(new Date().toISOString(),id,...(manual?[]:[tradingDay(now)])).run()
 if(!changed(claimed))return 'not_claimed'
 // A crash AFTER claiming cannot lead to another submission. That row remains SENDING.
 const checkAt=new Date()
 if(manual){
  if(!(await manualGateOpen(db,env,checkAt))||tradingDay(checkAt)!==tradingDay(now)){
   await db.prepare("UPDATE live_order_journal SET state='REJECTED',updated_at=? WHERE id=? AND state='SENDING'")
    .bind(checkAt.toISOString(),id).run()
   return 'disarmed_after_claim'
  }
 }else if(!(await getLiveGate(db,env,checkAt)).enabled)return 'disarmed_after_claim'
 let result
 try{result=await submitKbLimitOnce(env,side,{code,quantity,price})}
 catch{return 'unknown_order_result'
 }
 const state=result.state==='ACCEPTED'?'ACCEPTED':result.state==='REJECTED'?'REJECTED':'UNKNOWN'
 try{
  const stored=await db.prepare("UPDATE live_order_journal SET state=?,broker_order_id=?,updated_at=? WHERE id=? AND state='SENDING'")
   .bind(state,result.state==='ACCEPTED'?result.brokerOrderNo:null,new Date().toISOString(),id).run()
  if(!changed(stored))return 'unknown_order_result'
 }catch{return 'unknown_order_result'}
 return result.state==='ACCEPTED'?'accepted_not_filled':result.state==='REJECTED'?'rejected':'unknown_order_result'
}
/**
 * Cancel unresolved BUY/SELL limit orders after 5 minutes of age.
 * A durable UNIQUE cancel claim is persisted BEFORE contacting KB.
 * Lost ACK, a crash or duplicated Cron invocation NEVER sends another cancel.
 * An accepted cancel request is NOT proof that the remaining shares were canceled.
 */
export async function cancelStaleLiveOrders(
 db:Db|undefined,env:LiveEnv,now=new Date()
):Promise<{attempted:number;accepted:number;unknown:number;skipped:number}>{
 const result={attempted:0,accepted:0,unknown:0,skipped:0}
 if(!db||!hardSwitch(env)||!(await getLiveGate(db,env,now)).enabled)return result
 const rowsResult=await db.prepare(
  "SELECT * FROM live_order_journal WHERE state IN ('ACCEPTED','PARTIAL') AND broker_order_id IS NOT NULL AND id NOT LIKE 'manual-buy-%' AND created_at<=? AND NOT EXISTS (SELECT 1 FROM live_cancel_journal WHERE order_id=live_order_journal.id) ORDER BY created_at ASC LIMIT 10"
 ).bind(new Date(now.getTime()-5*60_000).toISOString()).all()
 const rows=Array.isArray(rowsResult?.results)?rowsResult.results:[]
 for(const raw of rows){
  const row=rowFromDb(raw)
  if(!/^[0-9]{1,15}$/.test(row.brokerOrderId||'')||!Number.isSafeInteger(row.filledQuantity)||
      row.filledQuantity>=row.quantity||row.filledQuantity<0){
   result.skipped++;continue
  }
  // IMPORTANT: an ACK may be stale. Read the broker status before claiming.
  // If the broker reports a fill, let reconciliation settle it first.
  let broker
  try{broker=await lookupKbOrder(env,dateToKb(row.tradingDay),row.brokerOrderId!,row.code,row.side)}
  catch{result.skipped++;continue}
  if(!broker.found||!broker.order||broker.order.filledQuantity<row.filledQuantity||
     broker.order.orderQuantity!==row.quantity||broker.order.orderPrice!==row.limitPrice||
     broker.order.remainingQuantity<=0){
   result.skipped++;continue
  }
  // Conditional claim: ensures the same order cannot be cancelled twice,
  // even with simultaneous Cron executions. The UNIQUE primary key persists
  // indefinitely and is NOT cleared by a timeout.
  const claim=await db.prepare(
   "INSERT OR IGNORE INTO live_cancel_journal(order_id,broker_order_id,status,cancel_order_no,claimed_at,updated_at) "+
   "SELECT id,broker_order_id,'CLAIMED',NULL,?,? FROM live_order_journal "+
   "WHERE id=? AND state IN ('ACCEPTED','PARTIAL') AND broker_order_id=? "+
   "AND NOT EXISTS (SELECT 1 FROM live_cancel_journal WHERE order_id=?)"
  ).bind(now.toISOString(),now.toISOString(),row.id,row.brokerOrderId,row.id).run()
  if(!changed(claim)){result.skipped++;continue}
  // First claim is irrevocable: a crash here leaves the order for manual review.
  result.attempted++
  try{
   const marked=await db.prepare(
    "UPDATE live_order_journal SET state='CANCEL_REQUESTED',updated_at=? "+
    "WHERE id=? AND state IN ('ACCEPTED','PARTIAL') AND broker_order_id=?"
   ).bind(new Date().toISOString(),row.id,row.brokerOrderId).run()
   if(!changed(marked)){result.unknown++;continue}
  }catch{result.unknown++;continue}
  // If the user disarms in the interim, NEVER send a cancel write. Claim remains.
  if(!(await getLiveGate(db,env,new Date())).enabled){result.unknown++;continue}
  let status:'ACKNOWLEDGED'|'UNKNOWN'|'REJECTED'='UNKNOWN'
  let cancelNo:string|null=null
  try{
   const ack=await submitKbCancelOnce(env,row.code,row.brokerOrderId!)
   status=ack.state==='ACCEPTED'?'ACKNOWLEDGED':ack.state==='REJECTED'?'REJECTED':'UNKNOWN'
   if(ack.state==='ACCEPTED')cancelNo=ack.brokerOrderNo
  }catch{status='UNKNOWN'}
  try{
   await db.prepare(
    "UPDATE live_cancel_journal SET status=?,cancel_order_no=?,updated_at=? "+
    "WHERE order_id=? AND status='CLAIMED'"
   ).bind(status,cancelNo,new Date().toISOString(),row.id).run()
  }catch{status='UNKNOWN'}
  if(status==='ACKNOWLEDGED')result.accepted++
  else result.unknown++
 }
 return result
}

/** Read-only reconciliation. An accepted cancel acknowledgment NEVER proves
 * the original open shares were canceled. Terminal CANCELED requires an
 * independent SSQM2341 completion row linked by both order numbers, plus
 * quantity conservation. Ambiguous results remain CANCEL_REQUESTED.
 */
export async function reconcileLiveOrders(db:Db|undefined,env:LiveEnv):Promise<{checked:number;updated:number;unresolved:number}>{
 if(!db)return {checked:0,updated:0,unresolved:0}
 const result=await db.prepare("SELECT * FROM live_order_journal WHERE state IN ('SENDING','UNKNOWN','ACCEPTED','PARTIAL','CANCEL_REQUESTED') ORDER BY created_at LIMIT 10").all()
 const rows=Array.isArray(result?.results)?result.results:[]
 let checked=0,updated=0,unresolved=0
 for(const raw of rows){
  const row=rowFromDb(raw)
  if(!row.brokerOrderId){unresolved++;continue}
  let actual:null|Awaited<ReturnType<typeof lookupKbOrder>>['order']=null
  let canceled=false
  let canceledFilled=row.filledQuantity
  if(row.state==='CANCEL_REQUESTED'){
   let cancelInfo:any
   try{
    cancelInfo=await db.prepare('SELECT status,cancel_order_no,broker_order_id FROM live_cancel_journal WHERE order_id=?')
     .bind(row.id).first()
   }catch{unresolved++;continue}
   if(cancelInfo?.status==='ACKNOWLEDGED'&&
      cancelInfo?.broker_order_id===row.brokerOrderId&&
      /^[0-9]{1,15}$/.test(String(cancelInfo?.cancel_order_no??''))&&
      cancelInfo.cancel_order_no!==row.brokerOrderId){
    let proof
    try{
     proof=await lookupKbCancelEvidence(env,dateToKb(row.tradingDay),
      row.brokerOrderId,String(cancelInfo.cancel_order_no),row.code,row.side,
      row.quantity,row.filledQuantity)
    }catch{unresolved++;continue}
    checked++
    if(proof.confirmed){
     canceled=true
     canceledFilled=proof.filledQuantity
    }else if(proof.fullyFilled){
     actual={orderNo:row.brokerOrderId,code:row.code,side:row.side,
       orderQuantity:row.quantity,filledQuantity:row.quantity,remainingQuantity:0,
       orderPrice:row.limitPrice,cancelOrAmend:'',originalOrderNo:''}
    }else if(proof.original){
     actual=proof.original
    }else{unresolved++;continue}
   }
  }
  if(!actual&&!canceled){
   let found
   try{found=await lookupKbOrder(env,dateToKb(row.tradingDay),row.brokerOrderId,row.code,row.side)}
   catch{unresolved++;continue}
   checked++
   if(!found.found||!found.order){unresolved++;continue}
   actual=found.order
  }
  if(canceled){
   try{
    transitionOrder(row,'CANCELED',canceledFilled,row.brokerOrderId)
    const update=await db.prepare(
     "UPDATE live_order_journal SET state='CANCELED',filled_quantity=?,updated_at=? "+
     "WHERE id=? AND state='CANCEL_REQUESTED' AND filled_quantity=? AND broker_order_id=?"
    ).bind(canceledFilled,new Date().toISOString(),row.id,row.filledQuantity,row.brokerOrderId).run()
    if(changed(update))updated++;else unresolved++
   }catch{unresolved++}
   continue
  }
  if(!actual){unresolved++;continue}
  if(actual.orderQuantity!==row.quantity||actual.orderPrice!==row.limitPrice||
     actual.filledQuantity<row.filledQuantity){
    unresolved++;continue
  }
  let next:'ACCEPTED'|'PARTIAL'|'FILLED'|'CANCEL_REQUESTED'
  if(actual.filledQuantity===row.quantity&&actual.remainingQuantity===0)next='FILLED'
  else if(actual.remainingQuantity>0)
   next=row.state==='CANCEL_REQUESTED'?'CANCEL_REQUESTED':actual.filledQuantity>0?'PARTIAL':'ACCEPTED'
  else{unresolved++;continue}
  if(next===row.state&&actual.filledQuantity===row.filledQuantity)continue
  try{
   transitionOrder(row,next,actual.filledQuantity,row.brokerOrderId)
   const updatedRow=await db.prepare('UPDATE live_order_journal SET state=?,filled_quantity=?,updated_at=? WHERE id=? AND state=? AND filled_quantity=? AND broker_order_id=?')
    .bind(next,actual.filledQuantity,new Date().toISOString(),row.id,row.state,row.filledQuantity,row.brokerOrderId).run()
   if(changed(updatedRow))updated++;else unresolved++
  }catch{unresolved++}
 }
 return {checked,updated,unresolved}
}
