/**
 * Live brokerage pre-activation diagnostics, strictly READ ONLY.
 * This checks real KB SSQM2341 and D1 risk gates, never SSAM writes.
 * Passing proves lookup compatibility only; it does NOT authorize trades.
 */
import {getLiveGate,type LiveEnv} from './liveExecution'
import {listKbRecentOrders,type RecentKbIssue} from './kbOrderContract'
import {KbAuthError} from './kbToken'

const isRegularSession=(at:Date)=>{const k=new Date(at.getTime()+9*3600_000),m=k.getUTCHours()*60+k.getUTCMinutes();return k.getUTCDay()>=1&&k.getUTCDay()<=5&&m>=540&&m<930}
type Db=any
export type ReadinessCheck={
 id:string;label:string;status:'PASS'|'BLOCKED'|'UNVERIFIED';detail:string
}
const failureLabels:Record<RecentKbIssue,string>={
 AUTH_FAILED:'KB OAuth 토큰 발급 또는 인증 실패',
 AUTH_RATE_LIMITED:'KB OAuth 인증 요청 제한',
 HTTP_401:'주문조회 인증 실패 (HTTP 401)',
 HTTP_403:'주문조회 접근 권한 없음 (HTTP 403)',
 HTTP_404:'주문조회 API 경로 또는 서비스 확인 필요 (HTTP 404)',
 HTTP_429:'주문조회 요청 제한 (HTTP 429)',
 HTTP_5XX:'KB 주문조회 서버 오류 (HTTP 5xx)',
 HTTP_OTHER:'KB 주문조회 HTTP 오류',
 RESPONSE_NOT_JSON:'주문조회 JSON 응답 형식 오류',
 BUSINESS_REJECTED:'KB 주문조회 업무 응답 거부 · 거래일 또는 API 권한 확인 필요',
 RECORD1_MISSING:'KB 성공 헤더는 받았지만 주문내역 Record1 배열이 없음 · 빈 결과인지 응답 구조 확인 필요',
 RECORD_ROW_INVALID:'KB 주문내역 행 형식·수량 확인 실패',
 NEXT_KEY_REPEATED:'KB 주문내역 연속조회 키 반복',
 PAGE_LIMIT:'KB 주문내역 연속조회 페이지 제한 도달',
 TIMEOUT:'KB 주문조회 응답 시간 초과',
 NETWORK_FAILURE:'KB 주문조회 연결 실패',
 UNKNOWN_ERROR:'KB 주문조회 미분류 오류'
}
const nonnegative=(value:unknown):number|null=>{
 if(value===null||value===undefined||value==='')return null
 const n=Number(value)
 return Number.isSafeInteger(n)&&n>=0?n:null
}
export async function diagnoseLiveReadiness(db:Db|undefined,env:LiveEnv,now=new Date()):Promise<{
 success:true;locked:true;mode:'READ_ONLY_READINESS';brokerWritesVerified:false;
 readOnlyChecksPassed:boolean;checkedAt:string;checks:ReadinessCheck[]
}>{
 const checks:ReadinessCheck[]=[]
 const add=(id:string,label:string,status:ReadinessCheck['status'],detail:string)=>
  checks.push({id,label,status,detail})
 if(!db){
  add('journal','운영 D1 주문 원장','BLOCKED','데이터베이스가 연결되지 않았어.')
 }else{
  try{
   const [rawGate,orders,unknownCancels]=await Promise.all([
    db.prepare('SELECT enabled,trading_day FROM live_execution_gate WHERE id=1').first(),
    db.prepare("SELECT COUNT(*) AS total FROM live_order_journal WHERE state IN ('RESERVED','SENDING','UNKNOWN','ACCEPTED','PARTIAL','CANCEL_REQUESTED')").first(),
    db.prepare("SELECT COUNT(*) AS total FROM live_cancel_journal WHERE status IN ('CLAIMED','UNKNOWN','REJECTED')").first()
   ])
   const active=nonnegative(orders?.total),unconfirmed=nonnegative(unknownCancels?.total)
   if(rawGate?.enabled===0){
    add('gate','운영 D1 실주문 잠금','PASS','D1 실주문 게이트 OFF 확인.')
   }else{
    add('gate','운영 D1 실주문 잠금','BLOCKED',
     rawGate?.enabled===1?'실주문 게이트가 ON이야. 운영 설정을 직접 확인해야 해.':'게이트 값을 확인할 수 없어.')
   }
   if(active===null||unconfirmed===null)
    add('journal','미확인 주문·취소 원장','BLOCKED','주문/취소 집계 결과를 검증할 수 없어.')
   else if(active>0||unconfirmed>0)
    add('journal','미확인 주문·취소 원장','BLOCKED',
     `진행/미확정 주문 ${active}건, 미확정 취소 ${unconfirmed}건 · 신규 주문 차단.`)
   else
    add('journal','미확인 주문·취소 원장','PASS','진행/미확정 주문과 취소 요청 0건.')
  }catch{
   add('journal','운영 D1 주문 원장','BLOCKED','D1 읽기 실패 · 실거래 준비 확인 불가.')
  }
 }
 const gate=await getLiveGate(db,env,now)
 add('hardSwitch','서버 실주문 하드 잠금',gate.hardEnabled?'BLOCKED':'PASS',
  gate.hardEnabled?'실주문 서버 플래그가 활성화되어 있어 별도 확인이 필요해.':
   '기본 배포에서 실주문 하드 잠금 유지.')
 add('hours','정규장 주문 허용 시간',isRegularSession(now)?'PASS':'UNVERIFIED',
  isRegularSession(now)?'현재 정규장 시간.':'현재 정규장 외 · 실거래 주문 금지.')
 if(!env.KB_APP_KEY||!env.KB_APP_SECRET){
  add('kbQuery','KB 실제 주문·체결조회 SSQM2341','BLOCKED','KB 조회 인증 설정이 없어.')
 }else{
  try{
   // One recent business date at most. Empty Record1 is a successful query.
   // Partial/failed query never counts as proof of brokerage compatibility.
   const result=await listKbRecentOrders(env,1,now)
   if(result.partial||result.checkedDates.length!==1){
    const day=result.failedDates[0]||'조회일 확인 필요'
    const issue=result.failedReasons?.[day]
    const business=issue==='BUSINESS_REJECTED'?result.failedBusinessCodes?.[day]:null
    const codes=business?
     ` · KB resultCode=${business.resultCode}, processCode=${business.processCode}, processFlag=${business.processFlag}`:''
    add('kbQuery','KB 실제 주문·체결조회 SSQM2341','BLOCKED',
     `조회일 ${day} · ${issue?failureLabels[issue]:'조회 결과 불완전'}${codes} · 주문 접수 여부 판단 불가.`)
   }else{
    add('kbQuery','KB 실제 주문·체결조회 SSQM2341','PASS',
     `읽기 전용 실제 조회 성공 · ${result.checkedDates[0]} · 조회된 주문 ${result.orders.length}건. 주문 0건도 정상 응답이야.`)
   }
  }catch(error){
   const issue=error instanceof KbAuthError?
    error.rateLimited?'KB OAuth 토큰 발급 요청 제한':'KB OAuth 토큰 발급 실패':
    'KB 조회 자체를 완료하지 못함'
   add('kbQuery','KB 실제 주문·체결조회 SSQM2341','BLOCKED',
    issue+' · 실제 주문 기능 활성화 금지.')
  }
 }
 add('brokerWrite','KB 매수·매도·취소 주문 전송','UNVERIFIED',
  '실제 주문을 보내지 않았으므로 주문 접수·체결·취소 처리 검증은 아직 완료되지 않았어.')
 return {
  success:true,locked:true,mode:'READ_ONLY_READINESS',brokerWritesVerified:false,
  readOnlyChecksPassed:checks.filter(c=>c.id!=='hours'&&c.id!=='brokerWrite')
   .every(c=>c.status==='PASS'),
  checkedAt:now.toISOString(),checks
 }
}
