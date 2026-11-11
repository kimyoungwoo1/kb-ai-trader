#!/usr/bin/env node
// One-shot deployment preserving the five secrets from known-good version dafe0360.
// Only switches traffic after the NEW version's secret bindings are verified.
import { execFileSync } from 'node:child_process'
import { createHash, generateKeyPairSync, randomBytes } from 'node:crypto'
import { mkdtempSync, readFileSync, readdirSync, existsSync, rmSync } from 'node:fs'
import { join, relative, resolve, extname, sep, dirname } from 'node:path'
import { tmpdir } from 'node:os'
import { parseActiveVersion } from './parse-deployment-status.mjs'

const cwd = process.cwd()
const tlsProofOnly = process.argv.includes('--tls-proof-only')
const quoteCompare = process.argv.includes('--quote-compare')
const privateEgress = process.argv.includes('--private-egress')
const kbPlacement = process.argv.includes('--kb-placement')
const livePilot50000 = process.argv.includes('--live-pilot-50000')
if(process.argv.slice(2).some(arg=>!['--tls-proof-only','--private-egress','--live-pilot-50000','--quote-compare','--kb-placement'].includes(arg))||
  (kbPlacement&&tlsProofOnly)||(privateEgress&&!tlsProofOnly)||(quoteCompare&&!tlsProofOnly)||(livePilot50000&&(tlsProofOnly||privateEgress)))
  throw Error('지원하지 않는 배포 옵션 조합')
if(livePilot50000 && process.env.KB_LIVE_PILOT_CONFIRM!=='실계좌 5만원 시험배포 승인')
  throw Error('5만원 실주문 시험배포는 환경변수 KB_LIVE_PILOT_CONFIRM 승인 필요 · 실주문은 웹에서 별도로 활성화')
const livePilotFlag = 'ALLOW_REAL_50000_TRIAL_2026'
const name = 'kb-ai-trader'
const knownGood = 'dafe0360-d736-4bf2-8a82-eb4ed03e48a4'
const required = ['DASHBOARD_API_KEY','KB_APP_KEY','KB_APP_SECRET','GEMINI_API_KEY','DART_API_KEY']
const domain = 'https://kb-ai-trader.ksmsy1.workers.dev'
let token = '', accountId = '', switched = false, rollbackVersion = '', paperDbId = ''
const exec = (program,args,dir=cwd) => {
  const options={cwd:dir,encoding:'utf8',timeout:120000,stdio:['ignore','pipe','pipe']}
  if(process.platform==='win32'&&(program==='npm'||program==='npx')){
    const cli=join(dirname(process.execPath),'node_modules','npm','bin',program+'-cli.js')
    ensure(existsSync(cli),'Windows Node.js 설치의 '+program+' CLI를 찾지 못했습니다.')
    return execFileSync(process.execPath,[cli,...args],options)
  }
  return execFileSync(program,args,options)
}
const ensure = (ok,msg) => { if(!ok) throw Error(msg) }
const parseJson = (value, label='CLI') => {
  const raw=String(value||'')
  const at=raw.indexOf('{')
  if(at<0)throw Error(label+' JSON 응답 없음 · '+(raw.toLowerCase().includes('no healthy upstream')?'Cloudflare upstream 장애':'CLI 응답 형식 오류'))
  try {return JSON.parse(raw.slice(at))}
  catch {throw Error(label+' JSON 파싱 실패 · 응답 형식 오류')}
}
const delay = ms => new Promise(resolve => setTimeout(resolve,ms))
const upstreamError = error => /no healthy upstream|upstream connect|502|503|504|ETIMEDOUT|ECONNRESET|fetch failed/i.test(String(error?.message||error))
const cliRead=async(args,label)=>{
  for(let attempt=1;attempt<=4;attempt++){
    try{
      const output=exec('npx',args,join(cwd,'worker'))
      if(/no healthy upstream/i.test(output))throw Error('no healthy upstream')
      return output
    }catch(error){
      if(!upstreamError(error)||attempt===4)
        throw Error(label+' 실패 · '+(upstreamError(error)?'Cloudflare 연결 장애':'CLI 실행 오류')+' (운영 미변경)')
      console.warn('○ '+label+' 서버 응답 지연 · 재시도 '+attempt+'/4')
      await delay(800*attempt)
    }
  }
  throw Error(label+' 실패')
}
const bindingEntries = value => {
  const opts=[value?.resources?.bindings,value?.bindings,value?.result?.resources?.bindings,value?.result?.bindings]
  const v=opts.find(x=>x&&typeof x==='object')
  return Array.isArray(v)?v:v?Object.entries(v).map(([n,b])=>({name:b?.name||n,...b})):[]
}
const bindings = value => bindingEntries(value).map(b=>({name:b.name,type:b.type}))
function verifyVersion(version,label,dbRequired=false){
  const map=new Map(bindings(version).map(b=>[b.name,b.type]))
  for(const key of required) ensure(map.get(key)==='secret_text',label+': '+key+' 누락')
  for(const key of ['AI','ASSETS']) ensure(map.has(key),label+': '+key+' 누락')
  if(dbRequired) ensure(map.get('PAPER_DB')==='d1',label+': D1 PAPER_DB 바인딩 누락')
  console.log('✓ '+label+': Secret 5개·AI·ASSETS'+(dbRequired?'·D1 PAPER_DB':'')+' 확인')
}
const mimetype=path=>({'.html':'text/html','.css':'text/css','.js':'application/javascript','.svg':'image/svg+xml','.json':'application/json','.png':'image/png','.webp':'image/webp','.ico':'image/x-icon','.woff2':'font/woff2','.webmanifest':'application/manifest+json'}[extname(path)]||'application/octet-stream')
function walk(root){
  return readdirSync(root,{withFileTypes:true}).flatMap(entry=>{
    const full=join(root,entry.name)
    return entry.isDirectory()?walk(full):entry.isFile()?[full]:[]
  })
}
// Version URLs serve a newly uploaded version without changing production traffic.
// A missing/disabled Version URL is a hard deployment blocker.
const versionOrigin = (id) => {
  ensure(/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(id),'신규 버전 UUID 형식 오류')
  return 'https://'+id.slice(0,8).toLowerCase()+'-'+name+'.ksmsy1.workers.dev'
}
const probeVersion = async(origin,secret,label,{checkAccount=true}={}) => {
  let last='연결되지 않음'
  const gatewayBackoff=[10_000,20_000,40_000,60_000,90_000]
  const maxAttempts=checkAccount?gatewayBackoff.length+1:5
  for(let attempt=1;attempt<=maxAttempts;attempt++){
    try{
      const healthResponse=await fetch(origin+'/api/health',{
        cache:'no-store',headers:{'Cache-Control':'no-store'},signal:AbortSignal.timeout(15000)
      })
      if(!healthResponse.ok)throw Error('헬스 HTTP '+healthResponse.status)
      const health=await healthResponse.json()
      ensure(health?.success===true&&health?.service==='kb-ai-trader-api',
        label+': Worker 헬스체크 응답이 예상과 다름')
      const login=await fetch(origin+'/api/auth/login',{
        method:'POST',headers:{'Content-Type':'application/json'},body:'{bad',
        signal:AbortSignal.timeout(15000)
      })
      ensure(login.status===400,label+': 로그인 Secret 검사 실패 (HTTP '+login.status+')')
      const page=await fetch(origin+'/',{cache:'no-store',signal:AbortSignal.timeout(15000)})
      ensure(page.ok&&(await page.text()).includes('<html'),label+': 정적 대시보드 검사 실패')
      // The NEW isolated version has already passed a full KB-account check.
      // After switching traffic, repeat infrastructure checks only: a fresh
      // Worker isolate may need a new OAuth token. Repeating full KB OAuth
      // probes after a verified pass can falsely roll back a healthy release.
      if(!checkAccount){
        console.log('✓ '+label+': API 헬스·로그인·정적파일 정상 · KB 실조회는 배포 전 검증 결과 사용')
        return
      }
      const reply=await fetch(origin+'/api/deploy/verify',{
        method:'POST',cache:'no-store',headers:{'X-Deploy-Probe':secret},
        signal:AbortSignal.timeout(65000)
      })
      if(kbPlacement){
        const placement=reply.headers.get('cf-placement')||''
        ensure(/^remote-[A-Z]{3}$/.test(placement),'KB 지정 위치가 적용된 응답을 확인하지 못했습니다.')
        console.log('✓ KB 직접 연결 Worker 위치: '+placement)
      }
      let body
      try {body=await reply.json()}catch {throw Error('계좌 검사 응답 JSON 오류 (HTTP '+reply.status+')')}
      if(reply.ok && body?.success===true &&
          body?.checks?.holdings?.success===true && body?.checks?.valuation?.success===true){
        console.log('✓ '+label+': 로그인·정적파일·KB 보유종목·계좌평가 실조회 통과')
        return
      }
      const h=body?.checks?.holdings,v=body?.checks?.valuation
      const category=String(h?.auth_issue||v?.auth_issue||'')
      const upstream=Number(h?.upstream_status||v?.upstream_status)||0
      const gateway=[502,503,504,522,524].includes(upstream)
      const failure=new Error('KB 조회 실패: 보유 '+(h?.stage||'unknown')+'/'+(h?.http_status||reply.status)+
        ', 평가 '+(v?.stage||'unknown')+'/'+(v?.http_status||reply.status)+
        (upstream?' · KB HTTP '+upstream:'')+
        (category?' · 원인 '+category:''))
      failure.authIssue=category
      failure.gatewayIssue=gateway
      throw failure
    }catch(error){
      last=String(error?.message||'연결 오류').slice(0,220)
      const attemptLimit=checkAccount&&error?.gatewayIssue?maxAttempts:5
      console.warn('○ '+label+' 재확인 '+attempt+'/'+attemptLimit+' · '+last)
      // A rejected OAuth credential is a definitive failure: never hammer
      // the token issuer or deploy an unverified version.
      if(error?.authIssue==='auth_rejected')
        throw Error(label+' 검증 실패 · KB 인증 거부 · 계좌 검증 미통과 · 운영 전환 없음')
      // Keep the same candidate and wait for a transient KB outage to clear.
      // Both live reads still have to succeed before traffic can switch.
      if(attempt<attemptLimit){
        const interval=error?.authIssue==='auth_rate_limited'?30_000*attempt:
          String(error?.authIssue||'').startsWith('auth_')?12_000*attempt:
          error?.gatewayIssue?gatewayBackoff[attempt-1]:
          1500*attempt
        if(error?.gatewayIssue)console.warn('○ KB 연결 회복 대기 '+interval/1000+'초 · 같은 신규 버전 재검증')
        else if(interval>=12000)console.warn('○ KB 인증 재요청 간격 조정 · 인증 서버 부하 방지')
        await delay(interval)
      }else break
    }
  }
  throw Error(label+' 검증 실패 · '+last+(checkAccount?' · 운영 전환 전 검사 실패':' · 운영 전환 후 서비스 구조 검사 실패'))
}
const activeWranglerVersion = async () => {
  const output=await cliRead(['wrangler','deployments','status','--name',name],'Wrangler 현재 운영 버전 조회')
  return parseActiveVersion(output)
}
async function main(){
  ensure(existsSync('worker/wrangler.jsonc'),'저장소 루트에서 실행해야 합니다.')
  console.log('1/7 운영 버전·KB 바인딩 사전 검증')
  const preflight=await fetch(domain+'/api/health',{cache:'no-store',signal:AbortSignal.timeout(15000)})
  ensure(preflight.ok,'현재 운영 Worker가 정상 응답하지 않아 안전 배포를 중단합니다.')
  const health=await preflight.json()
  ensure(health?.success===true&&health?.service==='kb-ai-trader-api','현재 운영 Worker 헬스체크에 실패했습니다.')
  console.log('✓ 기존 운영 Worker 응답 정상 (KB 실계좌 연결은 배포 후 별도 검사)')
  // A rollback or an automatic deployment can change the currently active version.
  // The source version only needs to exist with the expected bindings.
  const auth=parseJson(await cliRead(['wrangler','auth','token','--json'],'Wrangler 인증 토큰 조회'),'Wrangler auth token')
  ensure(['oauth','api_token'].includes(auth.type)&&auth.token,'Wrangler 인증 조회 실패')
  token=auth.token
  const ids=[...new Set((await cliRead(['wrangler','whoami'],'Wrangler 계정 조회')).match(/\b[a-f0-9]{32}\b/gi)||[])]
  ensure(ids.length===1||process.env.CLOUDFLARE_ACCOUNT_ID,'Cloudflare 계정이 하나로 식별되지 않았습니다.')
  accountId=process.env.CLOUDFLARE_ACCOUNT_ID||ids[0]
  const root='https://api.cloudflare.com/client/v4/accounts/'+accountId
  async function api(url,{method='GET',body,authToken=token,headers={}}={}){
    // Only retry idempotent GET requests. Retrying D1 writes, asset uploads,
    // or deployment mutations could duplicate changes.
    const step=new URL(url).pathname.split('/').slice(-3).join('/')
    const maxAttempts=method==='GET'?4:1
    for(let attempt=1;attempt<=maxAttempts;attempt++){
      let response,raw
      try{
        response=await fetch(url,{method,headers:{Authorization:'Bearer '+authToken,...headers},body,signal:AbortSignal.timeout(30000)})
        raw=await response.text()
      }catch(error){
        if(method==='GET'&&attempt<maxAttempts){
          console.warn('○ Cloudflare API 연결 지연 ('+step+') · 재시도 '+attempt+'/'+maxAttempts)
          await delay(attempt*800)
          continue
        }
        throw Error('Cloudflare API 통신 실패 ('+step+', '+method+') · 운영 상태 확인 필요')
      }
      let value
      try {value=JSON.parse(raw)}
      catch {
        const upstream=/no healthy upstream|upstream connect/i.test(raw)
        if(method==='GET'&&attempt<maxAttempts&&(upstream||[502,503,504].includes(response.status))){
          console.warn('○ Cloudflare API upstream 지연 ('+step+', HTTP '+response.status+') · 재시도 '+attempt+'/'+maxAttempts)
          await delay(attempt*800)
          continue
        }
        throw Error('Cloudflare API 비JSON 응답 ('+step+', HTTP '+response.status+') · '+
          (upstream?'no healthy upstream':'예상하지 못한 응답')+' · 운영 변경 여부는 배포 단계에 따름')
      }
      if(!response.ok||value?.success===false){
        if(method==='GET'&&attempt<maxAttempts&&[502,503,504].includes(response.status)){
          console.warn('○ Cloudflare API 오류 ('+step+', HTTP '+response.status+') · 재시도 '+attempt+'/'+maxAttempts)
          await delay(attempt*800)
          continue
        }
        const errors=Array.isArray(value?.errors)?value.errors:[]
        throw Error('Cloudflare HTTP '+response.status+' ('+step+'): '+errors.map(x=>x.code+': '+x.message).join(' / ').slice(0,300))
      }
      return value.result??value
    }
    throw Error('Cloudflare API 재시도 초과 ('+step+')')
  }
  // The API accepts the Worker name directly as worker_id. Avoid fetching unrelated account data.
  const workerId=encodeURIComponent(name)
  const deployments=await api(root+'/workers/scripts/'+name+'/deployments')
  const sorted=(deployments.deployments||[]).sort((a,b)=>Date.parse(b.created_on)-Date.parse(a.created_on))
  const active=sorted[0]?.versions?.find(v=>v.percentage===100)
  ensure(active?.version_id,'현재 운영 버전을 확인할 수 없어 중단했습니다.')
  rollbackVersion=active.version_id
  const live=await api(root+'/workers/workers/'+workerId+'/versions/'+rollbackVersion)
  verifyVersion(live,'현재 운영 버전')
  // Safety: LIVE_TRADING_HARD_ENABLE is deliberately never inherited here.
  // Every normal deployment is intrinsically locked against broker order writes.
  const probeKey=randomBytes(32).toString('base64url')
  console.log('✓ 이번 배포 전용 KB 계좌 검사 인증키 생성 (출력하지 않음)')
  // Opt-in encrypted Web Push uses a persistent VAPID keypair. The first
  // release creates it inside the new Worker version; subsequent deploys
  // inherit that SAME key from the currently active deployment.
  const oldBindings=new Map(bindingEntries(live).map(b=>[b.name,b]))
  const pushNames=['VAPID_PUBLIC_KEY','VAPID_PRIVATE_KEY','VAPID_SUBJECT']
  const present=pushNames.filter(name=>oldBindings.has(name))
  ensure(present.length===0||present.length===pushNames.length,'VAPID 키가 일부만 설정되어 있습니다. 키가 교체되지 않도록 배포 중단')
  let pushBindings
  if(present.length===pushNames.length){
    pushBindings=pushNames.map(name=>({name,type:'inherit',version_id:rollbackVersion}))
    console.log('✓ 기존 VAPID 푸시 키 보존')
  }else{
    const {publicKey,privateKey}=generateKeyPairSync('ec',{namedCurve:'prime256v1'})
    const jwk=privateKey.export({format:'jwk'})
    const x=Buffer.from(jwk.x,'base64url'),y=Buffer.from(jwk.y,'base64url')
    const publicVapid=Buffer.concat([Buffer.from([4]),x,y]).toString('base64url')
    pushBindings=[
      {name:'VAPID_PUBLIC_KEY',type:'plain_text',text:publicVapid},
      {name:'VAPID_PRIVATE_KEY',type:'secret_text',text:jwk.d},
      {name:'VAPID_SUBJECT',type:'plain_text',text:domain},
    ]
    console.log('✓ 첫 웹 푸시 VAPID 키 생성 (키 출력 안 함)')
  }
  // Verify the historical safety reference, but always inherit current live
  // values. Reverting to a historical secret can silently break KB auth.
  const old=await api(root+'/workers/workers/'+workerId+'/versions/'+knownGood)
  verifyVersion(old,'과거 Secret 참조 버전')
  console.log('✓ 현재 운영 버전의 최신 인증키 사용 (과거 키로 되돌리지 않음)')
  // D1 is optional until the user runs scripts/setup-paper-cloud.mjs.
  // Once enabled, never silently deploy a new Worker version that loses it.
  const liveD1=bindingEntries(live).find(b=>b.name==='PAPER_DB'&&b.type==='d1')
  paperDbId=process.env.PAPER_DB_ID||liveD1?.database_id||liveD1?.id||''
  if(!paperDbId){
    try{
      const existing=await api(root+'/d1/database?per_page=100')
      const found=(Array.isArray(existing)?existing:existing?.result||[])
        .filter(d=>d.name==='kb-ai-trader-paper')
      ensure(found.length<=1,'같은 이름의 D1 데이터베이스가 중복됩니다.')
      if(found.length)paperDbId=found[0].uuid||found[0].id||''
    }catch(err){
      console.warn('참고: D1 조회 불가. 클라우드 백업 기능은 별도 설치 전까지 비활성화됩니다.')
    }
  }
  if(liveD1 && !paperDbId)throw Error('현재 D1 바인딩이 있는데 해당 ID를 확인할 수 없습니다. 중단합니다.')
  const activePilotBinding=oldBindings.get('LIVE_TRADING_HARD_ENABLE')
  const activePaperDbId=liveD1?.database_id||liveD1?.id
  if(livePilot50000)ensure(!!activePaperDbId&&paperDbId===activePaperDbId,
    '5만원 실주문 시험은 현재 운영과 같은 D1 주문 원장을 사용해야 합니다. 배포 중단')
  const preserveLiveApproval=livePilot50000&&
    activePilotBinding?.type==='plain_text'&&activePilotBinding.text===livePilotFlag
  const upgradingLegacyPilot=activePilotBinding?.type==='plain_text'&&activePilotBinding.text==='ALLOW_REAL_10000_TRIAL_2026'
  if(livePilot50000&&activePilotBinding)
    ensure(preserveLiveApproval||upgradingLegacyPilot,'현재 운영 실주문 플래그 값을 확인할 수 없어 승인 상태 보존 배포를 중단합니다.')
  if(paperDbId&&!tlsProofOnly){
    ensure(/^[0-9a-f]{32}$|^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(paperDbId),
      'D1 데이터베이스 ID 형식이 올바르지 않습니다.')
    await api(root+'/d1/database/'+paperDbId)
    // Idempotent, additive schema; never deletes saved account snapshots.
    for(const sql of [
      'CREATE TABLE IF NOT EXISTS paper_backup_head (id INTEGER PRIMARY KEY CHECK(id=1), revision INTEGER NOT NULL CHECK(revision>0), updated_at TEXT NOT NULL, snapshot_json TEXT NOT NULL)',
      'CREATE TABLE IF NOT EXISTS paper_backup_history (revision INTEGER PRIMARY KEY, updated_at TEXT NOT NULL, snapshot_json TEXT NOT NULL)',
      'CREATE INDEX IF NOT EXISTS idx_paper_backup_updated ON paper_backup_history(updated_at)',
      'CREATE TABLE IF NOT EXISTS paper_trade_lease (id INTEGER PRIMARY KEY CHECK(id=1), owner TEXT NOT NULL, lease_until INTEGER NOT NULL)',
      "CREATE TABLE IF NOT EXISTS server_paper_state (id INTEGER PRIMARY KEY CHECK(id=1), revision INTEGER NOT NULL, mode TEXT NOT NULL CHECK(mode IN ('running','stopped')), cycle_slot INTEGER NOT NULL DEFAULT -1, busy_until INTEGER NOT NULL DEFAULT 0, updated_at TEXT NOT NULL, snapshot_json TEXT NOT NULL, last_error TEXT)",
      "CREATE TABLE IF NOT EXISTS server_paper_cron_runs (slot INTEGER PRIMARY KEY, started_at TEXT NOT NULL, finished_at TEXT NOT NULL, result TEXT NOT NULL, message TEXT NOT NULL, scanned INTEGER NOT NULL DEFAULT 0, filled INTEGER NOT NULL DEFAULT 0)",
      "CREATE INDEX IF NOT EXISTS idx_server_paper_cron_result_slot ON server_paper_cron_runs(result,slot DESC)",
      "CREATE TABLE IF NOT EXISTS paper_notifications (id INTEGER PRIMARY KEY AUTOINCREMENT, event_key TEXT NOT NULL UNIQUE, kind TEXT NOT NULL, title TEXT NOT NULL, body TEXT NOT NULL, created_at TEXT NOT NULL, read_at TEXT)",
      "CREATE INDEX IF NOT EXISTS idx_paper_notifications_created ON paper_notifications(id DESC)",
      "CREATE TABLE IF NOT EXISTS paper_push_subscriptions (endpoint TEXT PRIMARY KEY, subscription_json TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL)",
      "CREATE TABLE IF NOT EXISTS paper_notification_settings (id INTEGER PRIMARY KEY CHECK(id=1), settings_json TEXT NOT NULL, updated_at TEXT NOT NULL)",
      "CREATE TABLE IF NOT EXISTS live_trial_settings (id INTEGER PRIMARY KEY CHECK(id=1), enabled INTEGER NOT NULL DEFAULT 0 CHECK(enabled=0), updated_at TEXT NOT NULL)",
      "CREATE TABLE IF NOT EXISTS live_trial_candidates (id INTEGER PRIMARY KEY AUTOINCREMENT, trading_day TEXT NOT NULL UNIQUE, event_id TEXT NOT NULL UNIQUE, code TEXT NOT NULL, name TEXT NOT NULL, side TEXT NOT NULL CHECK(side='BUY'), quantity INTEGER NOT NULL CHECK(quantity>0), limit_price INTEGER NOT NULL CHECK(limit_price>0), notional INTEGER NOT NULL CHECK(notional<=50000), reason TEXT NOT NULL, status TEXT NOT NULL CHECK(status='DRY_RUN_ONLY'), created_at TEXT NOT NULL)",
      "CREATE TABLE IF NOT EXISTS live_trial_activity (event_id TEXT PRIMARY KEY, code TEXT NOT NULL, side TEXT NOT NULL, decision TEXT NOT NULL, checked_at TEXT NOT NULL)",
      "CREATE INDEX IF NOT EXISTS idx_live_trial_activity_checked ON live_trial_activity(checked_at DESC, event_id DESC)",
      "CREATE TABLE IF NOT EXISTS live_order_journal (id TEXT PRIMARY KEY,trading_day TEXT NOT NULL,code TEXT NOT NULL,side TEXT NOT NULL CHECK(side IN ('BUY','SELL')),quantity INTEGER NOT NULL CHECK(quantity>0),limit_price INTEGER NOT NULL CHECK(limit_price>0),reserved_won INTEGER NOT NULL CHECK(reserved_won>=0 AND reserved_won<=50000),state TEXT NOT NULL CHECK(state IN ('RESERVED','SENDING','UNKNOWN','ACCEPTED','PARTIAL','FILLED','REJECTED','CANCEL_REQUESTED','CANCELED')),broker_order_id TEXT UNIQUE,filled_quantity INTEGER NOT NULL DEFAULT 0,created_at TEXT NOT NULL,updated_at TEXT NOT NULL)",
      "CREATE UNIQUE INDEX IF NOT EXISTS idx_live_order_one_buy_per_day ON live_order_journal(trading_day) WHERE side='BUY'",
      "CREATE TABLE IF NOT EXISTS kb_oauth_token_cache (id INTEGER PRIMARY KEY CHECK(id=1),key_fingerprint TEXT NOT NULL,nonce_b64 TEXT NOT NULL,token_b64 TEXT NOT NULL,expires_at INTEGER NOT NULL)",
      "CREATE TABLE IF NOT EXISTS live_execution_gate (id INTEGER PRIMARY KEY CHECK(id=1), enabled INTEGER NOT NULL DEFAULT 0 CHECK(enabled IN (0,1)), trading_day TEXT, updated_at TEXT NOT NULL)",
      "CREATE TABLE IF NOT EXISTS live_cancel_journal (order_id TEXT PRIMARY KEY, broker_order_id TEXT NOT NULL, status TEXT NOT NULL CHECK(status IN ('CLAIMED','ACKNOWLEDGED','UNKNOWN','REJECTED')), cancel_order_no TEXT UNIQUE, claimed_at TEXT NOT NULL, updated_at TEXT NOT NULL)"
    ]){
      const queryResult=await api(root+'/d1/database/'+paperDbId+'/query',{
        method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({sql})})
      const results=Array.isArray(queryResult)?queryResult:[queryResult]
      ensure(results.every(x=>x?.success!==false),'D1 초기 테이블 SQL 실행 실패')
    }
    console.log('✓ D1 가상매매 백업 데이터베이스 및 테이블 검증 완료')
  }else if(tlsProofOnly){
    console.log('✓ 격리 TLS 검증 모드: D1 SQL 조회·쓰기 및 마이그레이션 생략')
  }else{
    console.log('○ D1 백업 미설정: 자동매매는 기존대로 작동하고, 백업 메뉴에는 설정 필요 표시')
  }
  console.log('2/7 테스트 및 프런트엔드 빌드')
  exec('node',['--experimental-strip-types','--test','tests/tradeSignals.test.mjs','tests/autoStatus.test.mjs','tests/paperEngineCheck.test.mjs', 'tests/scanReview.test.mjs', 'tests/trialExit.test.mjs', 'tests/autoWatch.test.mjs', 'tests/maxPositions.test.mjs', 'tests/marketCatalysts.test.mjs', 'tests/kbOAuthReuse.test.mjs','tests/kbSharedToken.test.mjs','tests/kbAccountRead.test.mjs','tests/kbAccountBatch.test.mjs','tests/accountBatchRouting.test.mjs', 'tests/tradingAnalytics.test.mjs', 'tests/screeningHistory.test.mjs', 'tests/kbQuoteBatch.test.mjs', 'tests/paperCloudBackup.test.mjs', 'tests/paperTradeLease.test.mjs', 'tests/cloudAutoSync.test.mjs', 'tests/serverPaper.test.mjs','tests/serverPaperMonitor.test.mjs','tests/notifications.test.mjs','tests/notificationPreferences.test.mjs','tests/deploySmoke.test.mjs','tests/liveTrial.test.mjs','tests/deploymentStatus.test.mjs','tests/liveOrderJournal.test.mjs','tests/kbOrderContract.test.mjs','tests/kbOrderSubmit.test.mjs','tests/liveRiskPreflight.test.mjs','tests/liveTrialPreflight.test.mjs','tests/liveExecution.test.mjs','tests/livePilot50000.test.mjs','tests/liveCancel.test.mjs','tests/deployProbePolicy.test.mjs','tests/liveTrialUi.test.mjs','tests/kbRecentOrders.test.mjs','tests/liveHoldingsCrossCheck.test.mjs','tests/liveAccountView.test.mjs','tests/kbCancelProof.test.mjs','tests/liveReadiness.test.mjs','tests/deployOAuthDiagnostics.test.mjs','tests/kbSocketReadOnly.test.mjs','tests/kbTlsProofWorker.test.mjs','tests/kbPrivateEgress.test.mjs'])
  exec('npm',['run','build'])
  const dir=resolve(cwd,'dist')
  ensure(existsSync(join(dir,'index.html')),'index.html 빌드 누락')
  const files=walk(dir).filter(f=>!['wrangler.json','.assetsignore'].includes(relative(dir,f)))
  ensure(files.length>=2,'정적 파일 빌드 누락')
  const manifest={},assets=new Map()
  for(const file of files){
    const path='/'+relative(dir,file).split(sep).join('/')
    const data=readFileSync(file)
    const hash=createHash('sha256').update(data).digest('hex').slice(0,32)
    ensure(!assets.has(hash),'정적 파일 해시 충돌')
    assets.set(hash,{data,type:mimetype(file)})
    manifest[path]={hash,size:data.length}
  }
  console.log('✓ Assets 파일 '+files.length+'개 확인')
  console.log('3/7 API Worker 단독 번들 생성')
  const temp=mkdtempSync(join(tmpdir(),'kb-safe-deploy-'))
  let source
  try {
    const output=join(temp,'worker.mjs')
    exec('npx',['esbuild',tlsProofOnly?'worker/src/kbTlsProofWorker.ts':'worker/src/index.ts',
      '--bundle','--format=esm','--platform=browser','--target=es2022',
      ...(tlsProofOnly?['--external:cloudflare:sockets']:[]),'--outfile='+output])
    source=readFileSync(output)
  } finally {rmSync(temp,{force:true,recursive:true})}
  if(!tlsProofOnly)ensure(source.includes(Buffer.from('/api/auth/login')),'Worker 로그인 코드 누락')
  else ensure(source.includes(Buffer.from('/api/deploy/tls-proof')),'격리 TLS 진단 코드 누락')
  console.log('4/7 정적 파일 업로드 (운영 트래픽 변경 없음)')
  const session=await api(root+'/workers/scripts/'+name+'/assets-upload-session',{
    method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({manifest})
  })
  ensure(session.jwt&&Array.isArray(session.buckets),'Assets 세션 생성 실패')
  let jwt=session.jwt
  for(const bucket of session.buckets){
    const form=new FormData()
    for(const hash of bucket){
      const f=assets.get(hash)
      ensure(f,'업로드 파일을 찾을 수 없음: '+hash)
      form.append(hash,new Blob([f.data.toString('base64')],{type:f.type}))
    }
    const result=await api(root+'/workers/assets/upload?base64=true',{
      method:'POST',body:form,authToken:session.jwt
    })
    if(result.jwt)jwt=result.jwt
  }
  console.log('5/7 다섯 Secret을 정상 버전에서 상속한 새 버전 업로드')
  const config=JSON.parse(readFileSync(join(cwd,'worker/wrangler.jsonc'),'utf8'))
  const created=await api(root+'/workers/workers/'+workerId+'/versions',{
    method:'POST',headers:{'Content-Type':'application/json'},
    body:JSON.stringify({
      main_module:'worker.mjs',
      compatibility_date:config.compatibility_date||'2026-11-04',
      ...(kbPlacement?{placement:{host:'developer.kbsec.com:32484'}}:{}),
      annotations:{'workers/message':tlsProofOnly?'ISOLATED TLS READ-ONLY PROOF; DO NOT DEPLOY':(livePilot50000?'EXPLICIT LIVE 50000 PILOT · EXISTING APPROVAL POLICY':'paper watch + D1 backup + current live secrets + push notifications')},
      assets:{jwt,config:{not_found_handling:'single-page-application',run_worker_first:['/api/*']}},
      bindings:[
        {name:'AI',type:'ai'}, {name:'ASSETS',type:'assets'},
        ...(paperDbId?[{name:'PAPER_DB',type:'d1',database_id:paperDbId}]:[]),
        ...required.map(name=>({name,type:'inherit',version_id:rollbackVersion})),
        ...(oldBindings.has('KB_BASE_URL') ? [{name:'KB_BASE_URL',type:'inherit',version_id:rollbackVersion}] : []),
        ...(privateEgress?[{name:'KB_EGRESS',type:'service',service:'kb-ai-trader-egress'}]:[]),
        ...pushBindings,
        ...(livePilot50000?[{name:'LIVE_TRADING_HARD_ENABLE',type:'plain_text',text:livePilotFlag}]:[]),
        {name:'DEPLOY_PROBE_TOKEN',type:'secret_text',text:probeKey}
      ],
      modules:[{name:'worker.mjs',content_type:'application/javascript+module',content_base64:source.toString('base64')}]
    })
  })
  ensure(created.id,'새 버전 생성 응답에 ID가 없음')
  console.log('6/7 새 버전 Secret 바인딩 검증')
  // Cloudflare may return a new UUID before the version becomes readable
  // from GET. Never deploy a version until GET confirms its ID and bindings.
  const createdId=String(created.id)
  ensure(/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(createdId),
    'Cloudflare 버전 생성 응답의 ID가 UUID가 아닙니다.')
  let newVersion
  const versionUrl=root+'/workers/workers/'+workerId+'/versions/'+encodeURIComponent(createdId)
  for(let attempt=0;attempt<7;attempt++){
    try{
      newVersion=await api(versionUrl)
      break
    }catch(error){
      const transient=String(error?.message||'').includes('Cloudflare HTTP 404: 10071:')
      if(!transient)throw error
      if(attempt===6)throw Error('새 버전 생성 후에도 Cloudflare에서 해당 버전을 조회할 수 없습니다 (10071). 배포 중단 · 운영 버전 유지')
      const delay=Math.min(1000*2**attempt,8000)
      console.log('○ 새 버전이 아직 조회되지 않아 재확인 ('+(attempt+1)+'/7)')
      await new Promise(resolve=>setTimeout(resolve,delay))
    }
  }
  ensure(newVersion?.id===createdId,'신규 버전 조회 ID 불일치 · 배포 중단')
  verifyVersion(newVersion,'신규 버전',!!paperDbId)
  const newBindings=new Map(bindings(newVersion).map(x=>[x.name,x.type]))
  ensure(livePilot50000 ? newBindings.get('LIVE_TRADING_HARD_ENABLE')==='plain_text' :
    !newBindings.has('LIVE_TRADING_HARD_ENABLE'),
    '실주문 배포 플래그 일치 검증 실패 · 운영 전환 차단')
  ensure(newBindings.get('VAPID_PRIVATE_KEY')==='secret_text'
    &&newBindings.has('VAPID_PUBLIC_KEY')&&newBindings.has('VAPID_SUBJECT'),
    '신규 버전 웹 푸시 VAPID 바인딩이 누락됐습니다.')
  ensure(newBindings.get('DEPLOY_PROBE_TOKEN')==='secret_text',
    '신규 버전 배포 검사용 인증키가 누락됐습니다.')
  if(privateEgress)ensure(newBindings.get('KB_EGRESS')==='service',
    '격리 진단 Private Egress Service Binding 확인 실패 · 운영 전환 없음')
  console.log('✓ 신규 버전 푸시 암호화 키 바인딩 확인'+
    (privateEgress?' · 비공개 KB 조회 전용 RPC 연결 확인':''))
  // Mandatory smoke testing on the exact NEW version URL. Never change
  // production traffic when Version URLs are disabled or not yet propagated.
  console.log('7/7 신규 버전 URL에서 계좌 실조회 검증 (운영 트래픽 미변경)')
  const previewOrigin=versionOrigin(createdId)
  if(tlsProofOnly){
    console.log('○ 운영 전환 없는 격리 TLS 진단: 기존 KB Secret 상속 · '+
      (privateEgress?'Private Service Binding 조회 전용':'직접 TLS 조회 전용'))
    const result=await fetch(previewOrigin+'/api/deploy/tls-proof',{
      method:'POST',headers:{'X-Deploy-Probe':probeKey,...(quoteCompare?{'X-KB-Diagnostic':'quote-compare'}:{})},
      signal:AbortSignal.timeout(95000)
    })
    ensure(result.ok,'격리 TLS 진단 Worker 응답 실패 (HTTP '+result.status+')')
    let summary
    try{summary=await result.json()}catch{throw Error('격리 TLS 진단 응답 형식 오류')}
    if(quoteCompare){
      ensure(summary?.success===true&&summary.mode==='ISOLATED_KB_QUOTE_COMPARE'&&
        summary.realOrderSent===false&&Array.isArray(summary.attempts),'현재가 경로 비교 결과 오류')
      const safe=value=>typeof value==='string'&&/^[A-Za-z0-9_-]{1,48}$/.test(value)?value:
        Number.isSafeInteger(value)&&value>=0&&value<=999999?String(value):'-'
      console.log('○ OAuth '+safe(summary.oauth?.status)+' · HTTP '+safe(summary.oauth?.httpStatus))
      for(const attempt of summary.attempts){
        console.log('○ '+safe(attempt.transport)+' '+safe(attempt.status)+' · HTTP '+safe(attempt.httpStatus)+
          ' · '+safe(attempt.durationMs)+'ms · '+safe(attempt.detail))
      }
      console.log('✓ 경로 비교 종료 · 운영 트래픽 변경 없음')
      return
    }
    ensure(summary?.success===true&&summary?.mode==='ISOLATED_TLS_READ_ONLY'&&
      summary?.realOrderSent===false,'진단 Worker 모드 검증 실패 · 안전 중단')
    const safe=(v)=>typeof v==='string'&&/^[A-Za-z0-9_-]{1,36}$/.test(v)?v:
      typeof v==='number'&&Number.isInteger(v)&&v>=0&&v<=999999?String(v):'unavailable'
    for(const key of ['oauth','quote','holdings','valuation','orderInquiry']){
      const record=summary?.checks?.[key]
      ensure(['PASS','BLOCKED','SKIPPED'].includes(record?.status),
        '진단 응답 상태값 오류: '+key)
      console.log('○ TLS '+key+': '+safe(record.status)+
        ' · HTTP '+safe(record.httpStatus)+
        ' · KB resultCode '+safe(record.resultCode)+
        ' · processCode '+safe(record.processCode)+
        ' · '+safe(record.detail))
    }
    if(summary?.checks?.networkRoot){
      const record=summary.checks.networkRoot
      ensure(['PASS','BLOCKED'].includes(record.status),'격리 네트워크 비교 응답 오류')
      console.log('○ 같은 격리 버전 TLS GET / 비교: '+safe(record.status)+
        ' · HTTP '+safe(record.httpStatus)+' · '+safe(record.detail))
    }
    ensure(summary.ready===true&&['oauth','holdings','valuation','orderInquiry']
      .every(key=>summary.checks[key].status==='PASS'),
      'TLS 조회 검사 일부 미통과 · 운영 전환 없음 · 위 코드로 원인 확인')
    console.log('✅ TLS 읽기 전용 실제 KB 인증·계좌·주문조회 검증 통과 · 운영 전환 없음')
    return
  }
  await probeVersion(previewOrigin,probeKey,'신규 버전 사전 검사')
  console.log('✓ 신규 버전 운영 반영 허용 · 사전 실조회 성공')
  // Guard against another deployment switching the live Worker while we build.
  const latest=await api(root+'/workers/scripts/'+name+'/deployments')
  const latestSorted=(latest.deployments||[]).sort((a,b)=>Date.parse(b.created_on)-Date.parse(a.created_on))
  const currentVersion=latestSorted[0]?.versions?.find(v=>v.percentage===100)?.version_id
  ensure(currentVersion===rollbackVersion,
    '배포 중 다른 운영 버전이 반영됐습니다. 최신 버전과 Secret 상속을 다시 확인하기 위해 안전 중단합니다.')
  if(preserveLiveApproval){
    console.log('✓ 동일 운영 D1의 실주문 승인 상태 보존 · 게이트 변경 없음')
  }else if(livePilot50000){
    // First opt-in must not revive an approval left by a previously disabled version.
    const reset=await api(root+'/d1/database/'+paperDbId+'/query',{
      method:'POST',headers:{'Content-Type':'application/json'},
      body:JSON.stringify({sql:"INSERT INTO live_execution_gate(id,enabled,trading_day,updated_at) VALUES(1,0,NULL,datetime('now')) ON CONFLICT(id) DO UPDATE SET enabled=0,trading_day=NULL,updated_at=excluded.updated_at"})
    })
    ensure((Array.isArray(reset)?reset:[reset]).every(x=>x?.success!==false),
      '실주문 D1 게이트 초기 잠금 실패 · 배포 중단')
    console.log('✓ 5만원 시험배포 초기 실주문 게이트 OFF · 웹 승인 전 주문 불가')
  }
  // A failed/ambiguous deployment API response might already have changed
  // traffic. Mark the attempt before sending it and reconcile via Wrangler.
  switched=true
  await api(root+'/workers/scripts/'+name+'/deployments',{
    method:'POST',headers:{'Content-Type':'application/json'},
    body:JSON.stringify({strategy:'percentage',versions:[{percentage:100,version_id:createdId}]})
  })
  const activeAfter=await activeWranglerVersion()
  ensure(activeAfter===createdId,
    '운영 전환 후 실제 버전 불일치 · 확인된 버전 '+activeAfter)
  console.log('✓ Wrangler 운영 버전 ID 확인: '+activeAfter)
  // The specific new Worker version passed KB holdings+valuation before
  // switching, and Wrangler confirms this exact version is now serving 100%.
  // Validate production health/login/assets without a second wave of KB
  // OAuth requests. Transient token issuance must not cause false rollback.
  await probeVersion(domain,probeKey,'운영 전환 후 구조 재검사',{checkAccount:false})
  // This uploader uses the Cloudflare Versions API, not wrangler deploy.
  // Cron triggers must therefore be applied separately after the Worker code passes smoke checks.
  if(paperDbId){
    const schedulePath=root+'/workers/scripts/'+name+'/schedules'
    const scheduleEntries=value=>(Array.isArray(value)?value:value.schedules||[]).map(({cron})=>({cron}))
    const oldSchedules=scheduleEntries(await api(schedulePath))
    const managed=config.triggers.crons
    const retired='* * * * *'
    const scheduleKey=cron=>cron.trim().toLowerCase().replace(/\s+/g,' ')
    const managedKeys=managed.map(scheduleKey)
    const newSchedules=[...oldSchedules.filter(({cron})=>scheduleKey(cron)!==retired&&!managedKeys.includes(scheduleKey(cron))),
      ...managed.map(cron=>({cron}))]
    const putSchedules=schedules=>api(schedulePath,{
      method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify(schedules),
    })
    try{
      await putSchedules(newSchedules)
      const current=scheduleEntries(await api(schedulePath)).map(({cron})=>scheduleKey(cron))
      ensure(!current.includes(retired)&&managedKeys.every(cron=>current.includes(cron)),
        '정규장 및 마감 작업 Cron 등록 확인 실패')
    }catch(error){
      try{await putSchedules(oldSchedules)}
      catch{console.error('⚠ 기존 Cron 스케줄 복구 실패 · 운영 설정 확인 필요')}
      throw error
    }
    console.log('✓ 평일 정규장 1분 감시 · 15:35 마감 작업 Cron 확인')
  }
  console.log('✅ 운영 반영 성공: '+domain)
}
try {await main()} catch(e){
  console.error('중단: '+e.message)
  if(switched){
    console.error('운영 배포 전환 시도 이후 실패 · Wrangler로 이전 버전 복구 및 검증')
    try{
      const now=await activeWranglerVersion()
      if(now===rollbackVersion){
        console.error('✓ 이전 버전이 이미 운영 중 · 추가 롤백 불필요')
      }else{
        console.error('○ 현재 운영 버전 '+now+' · 복구 대상 '+rollbackVersion)
        exec('npx',['wrangler','rollback',rollbackVersion,'--name',name,
          '--message','Automatic recovery after failed verified deployment'],join(cwd,'worker'))
        const restored=await activeWranglerVersion()
        ensure(restored===rollbackVersion,'롤백 요청 후 운영 버전 확인 실패: '+restored)
        console.error('✅ Wrangler 롤백 및 실제 운영 버전 재확인 완료: '+restored)
      }
    }catch(error){
      console.error('⚠ 자동 복구 상태 미확인: '+String(error?.message||error).slice(0,220))
      console.error('수동 복구: npx wrangler rollback '+rollbackVersion+
        ' --name '+name+' --message "Manual restore after failed deployment"')
      console.error('복구 확인: npx wrangler deployments status --name '+name)
    }
  }else{
    console.error('✓ 운영 트래픽 변경 없음 · 현재 정상 운영 버전 유지')
  }
  process.exitCode=1
}
