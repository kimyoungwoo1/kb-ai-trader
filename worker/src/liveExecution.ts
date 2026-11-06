/**
 * Real-account trial engine. HARD LOCKED by default: Cloudflare has no
 * LIVE_TRADING_HARD_ENABLE binding; D1 live_execution_gate defaults to OFF.
 * Only committed paper fills are eligible for live execution, never clients.
 */
import {readKbBuyingPower,evaluateBuyPreview} from './liveRiskPreflight'
import {lookupKbOrder} from './kbOrderContract'
import {submitKbLimitOnce} from './kbOrderSubmit'
import {getKbAccessToken,kbBaseUrl,type KbCredentials} from './kbToken'
import {transitionOrder,type OrderRecord} from './liveOrderJournal'

type Db=any
export type LiveEnv=KbCredentials&{LIVE_TRADING_HARD_ENABLE?:string}
export type LiveFill={id:string;at:string;code:string;side:'BUY'|'SELL';price:number;quantity:number;test?:boolean}
export const MAX_PILOT_WON=50_000
const hardSwitch=(env:LiveEnv)=>env.LIVE_TRADING_HARD_ENABLE==='ALLOW_REAL_50000_TRIAL_2026'
const tradingDay=(date:Date)=>new Date(date.getTime()+9*3600_000).toISOString().slice(0,10)
const inSession=(date:Date)=>{const k=new Date(date.getTime()+9*3600_000),m=k.getUTCHours()*60+k.getUTCMinutes();return k.getUTCDay()>=1&&k.getUTCDay()<=5&&m>=540&&m<930}
const num=(value:unknown)=>{const n=Number(value);return value===null||value===undefined||value===''||!Number.isSafeInteger(n)||n<0?NaN:n}
const changed=(result:any)=>Number(result?.meta?.changes)===1
const dateToKb=(day:string)=>day.replaceAll('-','')
const identity=(side:'BUY'|'SELL',eventId:string)=>'trial-'+side.toLowerCase()+'-'+eventId.replace(/[^A-Za-z0-9:_-]/g,'_').slice(0,103)
const rowFromDb=(r:any):OrderRecord=>({id:String(r.id),tradingDay:String(r.trading_day),code:String(r.code),side:r.side,
 quantity:Number(r.quantity),limitPrice:Number(r.limit_price),reservedWon:Number(r.reserved_won),
 state:r.state,brokerOrderId:r.broker_order_id??null,filledQuantity:Number(r.filled_quantity),updatedAt:String(r.updated_at)})
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
 if(!db||!hardSwitch(env)||confirmation!=='실계좌 5만원 자동매매 실행'||!inSession(now))return false
 try{
  const active=await db.prepare("SELECT COUNT(*) AS n FROM live_order_journal WHERE state IN ('RESERVED','SENDING','UNKNOWN','ACCEPTED','PARTIAL','CANCEL_REQUESTED')").first()
  if(num(active?.n)!==0)return false
  const today=tradingDay(now)
  await db.prepare('INSERT INTO live_execution_gate(id,enabled,trading_day,updated_at) VALUES(1,1,?,?) ON CONFLICT(id) DO UPDATE SET enabled=1,trading_day=excluded.trading_day,updated_at=excluded.updated_at')
   .bind(today,now.toISOString()).run()
  return true
 }catch{return false}
}
/** Read-only real account position query, using the existing SSQM2952 format. */
export async function readKbHeldQuantity(env:KbCredentials,code:string):Promise<number>{
 if(!/^[0-9]{6}$/.test(code))throw Error('종목코드 오류')
 const token=await getKbAccessToken(env)
 const response=await fetch(kbBaseUrl(env)+'/api/v1/ssqm2952',{
  method:'POST',headers:{Authorization:'Bearer '+token,'Content-Type':'application/json'},
  body:JSON.stringify({dataHeader:{ipAddr:'127.0.0.1',macAddr:'00:00:00:00:00:00'},dataBody:{excg_mktpr_ccd:'A'}}),
  signal:AbortSignal.timeout(15000)
 })
 if(!response.ok)throw Error('KB 보유수량 조회 실패')
 const payload:any=await response.json()
 if(String(payload?.dataHeader?.resultCode)!=='200'||!Array.isArray(payload?.dataBody?.Record1))
  throw Error('KB 보유수량 응답 검증 실패')
 let total=0
 for(const r of payload.dataBody.Record1){
  if(String(r?.is_cd??'').replace(/^A/,'')!==code)continue
  const units=[num(r?.ec_q),num(r?.hld_q)]
  if(units.some(n=>!Number.isSafeInteger(n)))throw Error('KB 보유수량 숫자 검증 실패')
  total+=Math.max(...units)
 }
 if(!Number.isSafeInteger(total))throw Error('KB 보유수량 합계 오류')
 return total
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
  db.prepare("SELECT COUNT(DISTINCT code) AS n FROM live_order_journal WHERE side='BUY' AND state NOT IN ('REJECTED','CANCELED')").first(),
  db.prepare("SELECT COALESCE(SUM(reserved_won),0) AS n FROM live_order_journal WHERE side='BUY' AND state NOT IN ('REJECTED','CANCELED')").first()
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
async function submitLiveBuy(db:Db,env:LiveEnv,fill:LiveFill,now:Date):Promise<string>{
 const quantity=Math.min(fill.quantity,Math.floor(49_500/fill.price))
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
 const id=identity('BUY',fill.id),day=tradingDay(now),stamp=now.toISOString()
 // Single D1 INSERT ... SELECT, protected by unique daily BUY index.
 const sql="INSERT OR IGNORE INTO live_order_journal (id,trading_day,code,side,quantity,limit_price,reserved_won,state,broker_order_id,filled_quantity,created_at,updated_at) "+
   "SELECT ?,?,?, 'BUY',?,?,?,'RESERVED',NULL,0,?,? WHERE EXISTS (SELECT 1 FROM live_execution_gate WHERE id=1 AND enabled=1 AND trading_day=?) "+
   "AND NOT EXISTS (SELECT 1 FROM live_order_journal WHERE trading_day=? AND side='BUY') "+
   "AND NOT EXISTS (SELECT 1 FROM live_order_journal WHERE state NOT IN ('REJECTED','CANCELED'))"
 const saved=await db.prepare(sql).bind(id,day,fill.code,quantity,fill.price,preview.requiredCash,stamp,stamp,day,day).run()
 if(!changed(saved))return 'duplicate_or_blocked'
 return claimAndSubmit(db,env,id,fill.code,'BUY',quantity,fill.price,now)
}
async function submitLiveSell(db:Db,env:LiveEnv,fill:LiveFill,now:Date):Promise<string>{
 const owned=await db.prepare("SELECT COALESCE(SUM(CASE WHEN side='BUY' THEN filled_quantity ELSE -filled_quantity END),0) AS shares FROM live_order_journal WHERE code=?").bind(fill.code).first()
 const shares=num(owned?.shares)
 if(!Number.isSafeInteger(shares)||shares<1)return 'no_trial_shares'
 const buy=await db.prepare("SELECT COUNT(*) AS n FROM live_order_journal WHERE code=? AND side='BUY' AND state='FILLED'").bind(fill.code).first()
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
async function claimAndSubmit(db:Db,env:LiveEnv,id:string,code:string,side:'BUY'|'SELL',quantity:number,price:number,now:Date):Promise<string>{
 const claimed=await db.prepare("UPDATE live_order_journal SET state='SENDING',updated_at=? WHERE id=? AND state='RESERVED' AND EXISTS(SELECT 1 FROM live_execution_gate WHERE id=1 AND enabled=1 AND trading_day=?)")
  .bind(new Date().toISOString(),id,tradingDay(now)).run()
 if(!changed(claimed))return 'not_claimed'
 // A crash AFTER claiming cannot lead to another submission. That row remains SENDING.
 if(!(await getLiveGate(db,env,new Date())).enabled)return 'disarmed_after_claim'
 let result
 try{result=await submitKbLimitOnce(env,side,{code,quantity,price})}
 catch{return 'unknown_order_result'
 }
 const state=result.state==='ACCEPTED'?'ACCEPTED':result.state==='REJECTED'?'REJECTED':'UNKNOWN'
 try{
  await db.prepare("UPDATE live_order_journal SET state=?,broker_order_id=?,updated_at=? WHERE id=? AND state='SENDING'")
   .bind(state,result.state==='ACCEPTED'?result.brokerOrderNo:null,new Date().toISOString(),id).run()
 }catch{return 'unknown_order_result'}
 return result.state==='ACCEPTED'?'accepted_not_filled':result.state==='REJECTED'?'rejected':'unknown_order_result'
}
/** Reconciliation never sends an order; it only reads records with KB order IDs. */
export async function reconcileLiveOrders(db:Db|undefined,env:LiveEnv):Promise<{checked:number;updated:number;unresolved:number}>{
 if(!db)return {checked:0,updated:0,unresolved:0}
 const result=await db.prepare("SELECT * FROM live_order_journal WHERE state IN ('SENDING','UNKNOWN','ACCEPTED','PARTIAL','CANCEL_REQUESTED') ORDER BY created_at LIMIT 10").all()
 const rows=Array.isArray(result?.results)?result.results:[]
 let checked=0,updated=0,unresolved=0
 for(const raw of rows){
  const row=rowFromDb(raw)
  if(!row.brokerOrderId){unresolved++;continue}
  checked++
  let found
  try{found=await lookupKbOrder(env,dateToKb(row.tradingDay),row.brokerOrderId,row.code,row.side)}
  catch{unresolved++;continue}
  if(!found.found||!found.order){unresolved++;continue}
  const actual=found.order
  if(actual.orderQuantity!==row.quantity||actual.orderPrice!==row.limitPrice||actual.filledQuantity<row.filledQuantity){
    unresolved++;continue
  }
  let next:'ACCEPTED'|'PARTIAL'|'FILLED'|'UNKNOWN'
  if(actual.filledQuantity===row.quantity&&actual.remainingQuantity===0)next='FILLED'
  else if(actual.remainingQuantity>0)next=actual.filledQuantity>0?'PARTIAL':'ACCEPTED'
  else{unresolved++;continue} // Final cancellation not inferred from absence/zero remaining.
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
