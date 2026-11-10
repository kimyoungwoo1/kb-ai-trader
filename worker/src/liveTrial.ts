import { getLiveGate, disarmLiveTrading, armLiveTrading, type LiveEnv } from './liveExecution'
import { evaluateBuyPreview, readKbBuyingPower } from './liveRiskPreflight'
import { lookupKbOrder, listKbRecentOrders, listKbRecentOrdersForView } from './kbOrderContract'
import {KbAuthError} from './kbToken'
import {diagnoseLiveReadiness} from './liveReadiness'
/**
 * Real-money trial guard. This version is a deliberately fail-closed
 * readiness layer: it NEVER calls a brokerage order endpoint.
 * Real execution requires an independently verified KB order/contract
 * implementation (including ack, fill, cancel and unknown-status reconciliation).
 */
export const LIVE_TRIAL_BUDGET=10_000
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
  if(!/^[0-9]{6}$/.test(value.code))return '유효하지 않은 종목코드'
  if(!Number.isSafeInteger(value.quantity)||value.quantity<1)return '수량 오류'
  if(!Number.isSafeInteger(value.limitPrice)||value.limitPrice<1)return '지정가 오류'
  if(value.limitPrice*value.quantity>LIVE_TRIAL_BUDGET)return '1만 원 한도 초과'
  if(!isRegularSession(now))return '정규장 외 주문 금지'
  if(!value.eventId||value.eventId.length>140)return '후보 ID 오류'
  const age=now.getTime()-Date.parse(value.createdAt)
  if(!Number.isFinite(age)||age<0||age>120_000)return '120초 초과 신호'
  return null
}
const limits={budget:LIVE_TRIAL_BUDGET,maxDailyBuys:LIVE_TRIAL_DAILY_BUYS,maxSymbols:LIVE_TRIAL_MAX_SYMBOLS,orderType:'지정가'}
export async function liveTrialApi(db:Db|undefined,input:unknown,env?:LiveEnv):Promise<Response>{
  if(!db)return reply({success:false,message:'실계좌 보호용 D1 연결이 필요합니다.'},503)
  const body=input&&typeof input==='object'?input as Record<string,unknown>:{}
  const action=String(body.action||'status')
  try{
    if(action==='status'){
      const settings=await db.prepare('SELECT enabled,updated_at FROM live_trial_settings WHERE id=1').first()
      const rows=await db.prepare('SELECT id,trading_day,event_id,code,name,side,quantity,limit_price,notional,reason,status,created_at FROM live_trial_candidates ORDER BY id DESC LIMIT 30').all()
      const gate=await getLiveGate(db,env||{})
      const journal=await db.prepare("SELECT j.id,j.trading_day,j.code,j.side,j.quantity,j.limit_price,j.reserved_won,j.state,j.broker_order_id,j.filled_quantity,j.created_at,j.updated_at,c.status AS cancel_status,c.cancel_order_no FROM live_order_journal j LEFT JOIN live_cancel_journal c ON c.order_id=j.id ORDER BY j.created_at DESC LIMIT 20").all()
      const progress=await readLiveProgress(db)
      return reply({success:true,enabled:gate.enabled,hardEnabled:gate.hardEnabled,brokerOrdersVerified:false,
        mode:gate.enabled?'ARMED_PILOT':'LOCKED_PILOT',limits,updatedAt:settings?.updated_at||null,
        candidates:rows.results||[],orders:journal.results||[],gate,progress,
        message:gate.enabled?'실계좌 시험 운용 활성화 · 당일 1만 원 및 1종목·1회 제한':
        '실주문 잠금 상태 · 보유·예수금 조회와 자동 가상매매는 기존대로 동작합니다.'})
    }
    if(action==='readiness'){
      // Read-only D1/KB checks; never runs a broker order or changes the gate.
      const diagnostic=await diagnoseLiveReadiness(db,env||{})
      return reply(diagnostic)
    }
    if(action==='preflight'){
      const code=String(body.code||''),quantity=Number(body.quantity),limitPrice=Number(body.limitPrice)
      if(!env?.KB_APP_KEY||!env?.KB_APP_SECRET)
        return reply({success:false,message:'KB 실계좌 인증 설정이 없어 주문 안전성 점검을 중단합니다.'},503)
      if(!/^[0-9]{6}$/.test(code)||!Number.isSafeInteger(quantity)||quantity<1||
        !Number.isSafeInteger(limitPrice)||limitPrice<1||
        quantity*limitPrice>LIVE_TRIAL_BUDGET)
        return reply({success:false,locked:true,message:'종목코드·주문 수량·지정가·1만 원 한도를 확인해 주세요.'},400)
      const day=kstTradingDay()
      // Read authoritative order journal first. Never infer safety from a
      // browser-local balance or uncommitted simulated position.
      const [today,unfinished,positions,committed]=await Promise.all([
        db.prepare("SELECT COUNT(*) AS total FROM live_order_journal WHERE side='BUY' AND trading_day=?").bind(day).first(),
        db.prepare("SELECT COUNT(*) AS total FROM live_order_journal WHERE state IN ('RESERVED','SENDING','UNKNOWN','ACCEPTED','PARTIAL','CANCEL_REQUESTED')").first(),
        db.prepare("SELECT COUNT(DISTINCT code) AS total FROM live_order_journal WHERE side='BUY' AND (state NOT IN ('REJECTED','CANCELED') OR (state='CANCELED' AND filled_quantity>0))").first(),
        db.prepare("SELECT COALESCE(SUM(reserved_won),0) AS total FROM live_order_journal WHERE side='BUY' AND (state NOT IN ('REJECTED','CANCELED') OR (state='CANCELED' AND filled_quantity>0))").first()
      ])
      // Null or omitted SQL aggregates must fail closed, never coerce to zero.
      const requiredNonnegative=(value:unknown):number => {
        if(value===null||value===undefined||value==='')return NaN
        const parsed=Number(value)
        return Number.isSafeInteger(parsed)&&parsed>=0?parsed:NaN
      }
      const pendingWon=requiredNonnegative(committed?.total)
      const countFields=[today?.total,unfinished?.total,positions?.total].map(requiredNonnegative)
      if(!Number.isSafeInteger(pendingWon)||pendingWon<0||
        countFields.some(n=>!Number.isSafeInteger(n)||n<0))
        return reply({success:false,locked:true,message:'D1 실주문 원장 검증 실패 · 안전 차단'},503)
      // Read-only request against KB's per-symbol buying power endpoint.
      // A provider error is a rejection of this preflight, NEVER a trade trigger.
      let balances
      try{balances=await readKbBuyingPower(env,code)}
      catch{return reply({success:false,locked:true,message:'KB 주문가능금액 실조회 실패 · 주문 안전성 점검 보류'},503)}
      const preview=evaluateBuyPreview(code,limitPrice,quantity,balances,{
        dailyBuys:countFields[0],activeTrialOrders:countFields[1],
        otherTrialSymbols:countFields[2],
      })
      if(pendingWon+preview.requiredCash>LIVE_TRIAL_BUDGET){
        preview.permitted=false
        preview.reasons.push('기존 시험 주문 예약금 포함 1만 원 한도 초과')
      }
      return reply({success:true,locked:true,executionEnabled:false,mode:'READ_ONLY_PREFLIGHT',
        preview,message:preview.permitted?
          '실계좌 주문가능금액·시험 한도 점검 통과. 실제 주문은 잠금 상태로 전송되지 않았습니다.':
          '실계좌 주문 안전성 점검에서 차단 조건이 발견됐습니다. 실제 주문은 전송되지 않았습니다.'})
    }
    if(action==='recentOrders'){
      if(!env?.KB_APP_KEY||!env?.KB_APP_SECRET)
        return reply({success:false,message:'KB 조회 인증 설정 없음'},503)
      const days=Number(body.days??3)
      if(days!==1&&days!==3&&days!==5)
        return reply({success:false,message:'최근 1·3·5거래일 중 선택해 주세요.'},400)
      const result=await listKbRecentOrdersForView(env,days as 1|3|5)
      return reply({success:true,...result,
        message:result.partial?'일부 날짜 조회가 완료되지 않았습니다. 누락된 날짜를 확인하세요.':
          result.orders.length?'최근 국내주식 주문·체결 내역 조회 완료':
          '조회 범위에 국내주식 주문 기록 없음 · 오래된 보유종목/해외주식은 해당하지 않을 수 있습니다.'})
    }
    if(action==='lookup'){
      if(!env?.KB_APP_KEY||!env?.KB_APP_SECRET)return reply({success:false,message:'KB 조회 인증 설정 없음'},503)
      const orderNo=String(body.orderNo||''),code=String(body.code||'')
      const day=String(body.day||''),side=body.side==='SELL'?'SELL':body.side==='BUY'?'BUY':null
      if(!side||!/^[0-9]{1,15}$/.test(orderNo)||!/^[0-9]{6}$/.test(code)||
         !/^20[0-9]{6}$/.test(day))return reply({success:false,message:'조회 조건 확인 필요'},400)
      // Read-only KB SSQM2341: returns only matching order, never the full
      // brokerage account order list or access token.
      const result=await lookupKbOrder(env,day,orderNo,code,side)
      return reply({success:true,...result,message:result.found?
        '증권사 주문/체결 조회 결과':'조회 날짜에 일치하는 주문 없음 · 미접수 확정은 아님'})
    }
    if(action==='disable'){
      if(!(await disarmLiveTrading(db)))return reply({success:false,message:'D1 실주문 잠금 설정 실패'},503)
      await db.prepare("INSERT INTO live_trial_settings(id,enabled,updated_at) VALUES(1,0,?) ON CONFLICT(id) DO UPDATE SET enabled=0,updated_at=excluded.updated_at")
        .bind(new Date().toISOString()).run()
      return reply({success:true,enabled:false,message:'실주문 신규 발송 차단. 기존 접수 주문은 별도 확인이 필요합니다.'})
    }
    if(action==='arm'){
      // Even with the explicit deployment flag, do not arm on a stale
      // or unreachable KB order-history service. This check does not submit.
      if(String(body.confirmation||'')!=='실계좌 1만원 자동매매 실행')
        return reply({success:false,enabled:false,message:'1만원 실거래 실행 확인 문구가 일치하지 않습니다.'},423)
      if(!env?.KB_APP_KEY||!env?.KB_APP_SECRET)
        return reply({success:false,enabled:false,message:'KB 주문조회 인증 정보가 없습니다.'},423)
      try {
        const verified=await listKbRecentOrders(env,1)
        if(verified.partial||verified.checkedDates.length!==1){
          const date=verified.failedDates[0]
          const reason=date?verified.failedReasons[date]:'INCOMPLETE'
          const business=date?verified.failedBusinessCodes[date]:null
          const code=business?
            ' · 업무코드 '+business.resultCode+'/'+business.processCode+'/'+business.processFlag+' · '+String(business.processMessage||'미제공'):''
          return reply({success:false,enabled:false,
            message:'KB 주문·체결조회 미완료 ('+String(reason||'UNKNOWN')+code+') · 실주문 차단. 상태를 확인하고 재시도하세요.'},423)
        }
      }catch(error){
        const reason=error instanceof KbAuthError?
          (error.rateLimited?'KB 인증 요청 제한':'KB OAuth 인증 실패 (HTTP '+error.httpStatus+')'):
          error instanceof Error&&error.name==='TimeoutError'?'주문조회 시간 초과':
          '주문조회 연결/응답 실패'
        return reply({success:false,enabled:false,
          message:reason+' · 실주문 잠금 유지. KB 인증 및 주문조회 정상화 후 재시도하세요.'},423)
      }
      const success=await armLiveTrading(db,env||{},String(body.confirmation||''))
      return reply({success,enabled:success,message:success?
        '실계좌 1만 원 시험 운용이 오늘 정규장 동안만 활성화됐습니다.':
        '서버 실거래 잠금 또는 확인 조건 미충족 · 실주문 비활성화'},success?200:423)
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
    "INSERT OR IGNORE INTO live_trial_candidates(trading_day,event_id,code,name,side,quantity,limit_price,notional,reason,status,created_at) VALUES(?,?,?,?,'BUY',?,?,?,?,'DRY_RUN_ONLY',?)"
  ).bind(date,candidate.eventId,candidate.code,candidate.name,candidate.quantity,
    candidate.limitPrice,candidate.quantity*candidate.limitPrice,candidate.reason,now.toISOString()).run()
  return (result.meta?.changes||0)===1
}


async function readLiveProgress(db:Db){
  try{
    const [paper,tick,decisions]=await Promise.all([
      db.prepare('SELECT mode FROM server_paper_state WHERE id=1').first(),
      db.prepare('SELECT result,message,finished_at,scanned,filled FROM server_paper_cron_runs ORDER BY slot DESC LIMIT 1').first(),
      db.prepare('SELECT event_id,code,side,decision,checked_at FROM live_trial_activity ORDER BY checked_at DESC,event_id DESC LIMIT 10').all(),
    ])
    return {paperMode:paper?.mode??null,tick:tick??null,decisions:decisions.results??[]}
  }catch{return null}
}

export async function recordLiveDecision(db:Db|undefined,fill:{id:string;code:string;side:string},decision:string,now=new Date()){
  if(!db||decision==='locked'||!/^\d{6}$/.test(fill.code)||
     !/^[A-Za-z0-9:_.-]{1,120}$/.test(fill.id)||!['BUY','SELL'].includes(fill.side))return
  await db.prepare('INSERT OR IGNORE INTO live_trial_activity(event_id,code,side,decision,checked_at) VALUES(?,?,?,?,?)')
    .bind(fill.id,fill.code,fill.side,decision,now.toISOString()).run()
}
