/**
 * Real-money trial guard. This version is a deliberately fail-closed
 * readiness layer: it NEVER calls a brokerage order endpoint.
 * Real execution requires an independently verified KB order/contract
 * implementation (including ack, fill, cancel and unknown-status reconciliation).
 */
export const LIVE_TRIAL_BUDGET=50_000
export const LIVE_TRIAL_DAILY_BUYS=1
export const LIVE_TRIAL_MAX_SYMBOLS=1
type Db=any
export type TrialCandidate={
  eventId:string;code:string;name:string;quantity:number;limitPrice:number;
  reason:string;createdAt:string;side:'BUY'|'SELL';
}
const reply=(data:unknown,status=200)=>Response.json(data,{status,headers:{'Cache-Control':'no-store'}})
export function kstTradingDay(at=new Date()):string{
  return new Date(at.getTime()+9*3600_000).toISOString().slice(0,10)
}
export function isRegularSession(at=new Date()):boolean{
  const k=new Date(at.getTime()+9*3600_000),mins=k.getUTCHours()*60+k.getUTCMinutes()
  return k.getUTCDay()>=1&&k.getUTCDay()<=5&&mins>=540&&mins<930
}
export function validateTrialCandidate(value:TrialCandidate,now=new Date()):string|null{
  if(!value||value.side!=='BUY')return '실매수 후보만 허용'
  if(!/^\\d{6}$/.test(value.code))return '유효하지 않은 종목코드'
  if(!Number.isSafeInteger(value.quantity)||value.quantity<1)return '수량 오류'
  if(!Number.isSafeInteger(value.limitPrice)||value.limitPrice<1)return '지정가 오류'
  if(value.limitPrice*value.quantity>LIVE_TRIAL_BUDGET)return '5만 원 한도 초과'
  if(!isRegularSession(now))return '정규장 외 주문 금지'
  if(!value.eventId||value.eventId.length>140)return '후보 ID 오류'
  const age=now.getTime()-Date.parse(value.createdAt)
  if(!Number.isFinite(age)||age<0||age>120_000)return '120초 초과 신호'
  return null
}
const limits={budget:LIVE_TRIAL_BUDGET,maxDailyBuys:LIVE_TRIAL_DAILY_BUYS,maxSymbols:LIVE_TRIAL_MAX_SYMBOLS,orderType:'지정가'}
export async function liveTrialApi(db:Db|undefined,input:unknown):Promise<Response>{
  if(!db)return reply({success:false,message:'실계좌 보호용 D1 연결이 필요합니다.'},503)
  const body=input&&typeof input==='object'?input as Record<string,unknown>:{}
  const action=String(body.action||'status')
  try{
    if(action==='status'){
      const settings=await db.prepare('SELECT enabled,updated_at FROM live_trial_settings WHERE id=1').first()
      const rows=await db.prepare('SELECT id,trading_day,event_id,code,name,side,quantity,limit_price,notional,reason,status,created_at FROM live_trial_candidates ORDER BY id DESC LIMIT 30').all()
      return reply({success:true,enabled:false,brokerOrdersVerified:false,mode:'PREPARATION_ONLY',limits,
        updatedAt:settings?.updated_at||null,candidates:rows.results||[],
        message:'KB 공식 주문·체결·취소 응답 명세가 검증되지 않아 실주문은 서버에서 차단됩니다. 자동주문 기능은 아직 활성화할 수 없습니다.'})
    }
    if(action==='disable'){
      await db.prepare("INSERT INTO live_trial_settings(id,enabled,updated_at) VALUES(1,0,?) ON CONFLICT(id) DO UPDATE SET enabled=0,updated_at=excluded.updated_at")
        .bind(new Date().toISOString()).run()
      return reply({success:true,enabled:false,message:'실주문 잠금 상태입니다. 대기 중인 실제 주문은 없습니다.'})
    }
    if(action==='enable'||action==='order'||action==='buy'||action==='sell'||action==='cancel')
      return reply({success:false,enabled:false,message:'실주문 차단: KB 공식 주문·체결·취소 API 검증 전에는 활성화 및 주문을 허용하지 않습니다.'},423)
    return reply({success:false,message:'지원하지 않는 시험매매 요청입니다.'},400)
  }catch{
    return reply({success:false,message:'시험매매 안전 상태를 확인할 수 없어 모든 실주문을 차단합니다.'},503)
  }
}
export async function observePaperFill(db:Db|undefined,fill:any,now=new Date()):Promise<boolean>{
  if(!db||fill?.side!=='BUY'||fill?.test)return false
  // Only committed paper fills, not client-supplied signals, may create audit entries.
  // We intentionally never call a broker order endpoint here.
  const candidate:TrialCandidate={
    eventId:String(fill.id||''),code:String(fill.code||''),name:String(fill.name||'').slice(0,80),
    side:'BUY',quantity:Number(fill.quantity),limitPrice:Number(fill.price),
    reason:String(fill.reason||'').slice(0,200),createdAt:String(fill.at||'')
  }
  const problem=validateTrialCandidate(candidate,now)
  if(problem)return false
  const date=kstTradingDay(now)
  // At most 1 unique BUY candidate per trading day, even after Cron replays.
  // Any conflict is ignored rather than replaced or retried.
  const result=await db.prepare(
    "INSERT OR IGNORE INTO live_trial_candidates(trading_day,event_id,code,name,side,quantity,limit_price,notional,reason,status,created_at) VALUES(?,?,?,?,?,'BUY',?,?,?,'DRY_RUN_ONLY',?)"
  ).bind(date,candidate.eventId,candidate.code,candidate.name,candidate.quantity,
    candidate.limitPrice,candidate.quantity*candidate.limitPrice,candidate.reason,now.toISOString()).run()
  return (result.meta?.changes||0)===1
}
