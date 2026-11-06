#!/usr/bin/env node
// One-shot deployment preserving the five secrets from known-good version dafe0360.
// Only switches traffic after the NEW version's secret bindings are verified.
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, readdirSync, existsSync, rmSync } from 'node:fs'
import { join, relative, resolve, extname, sep } from 'node:path'
import { tmpdir } from 'node:os'

const cwd = process.cwd()
const name = 'kb-ai-trader'
const knownGood = 'dafe0360-d736-4bf2-8a82-eb4ed03e48a4'
const required = ['DASHBOARD_API_KEY','KB_APP_KEY','KB_APP_SECRET','GEMINI_API_KEY','DART_API_KEY']
const domain = 'https://kb-ai-trader.ksmsy1.workers.dev'
let token = '', accountId = '', switched = false, rollbackVersion = '', paperDbId = ''
const exec = (program,args,dir=cwd) => execFileSync(program,args,{cwd:dir,encoding:'utf8',timeout:120000,stdio:['ignore','pipe','pipe']})
const ensure = (ok,msg) => { if(!ok) throw Error(msg) }
const parseJson = text => JSON.parse(text.slice(text.indexOf('{')))
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
const mimetype=path=>({'.html':'text/html','.css':'text/css','.js':'application/javascript','.svg':'image/svg+xml','.json':'application/json','.png':'image/png','.webp':'image/webp','.ico':'image/x-icon','.woff2':'font/woff2'}[extname(path)]||'application/octet-stream')
function walk(root){
  return readdirSync(root,{withFileTypes:true}).flatMap(entry=>{
    const full=join(root,entry.name)
    return entry.isDirectory()?walk(full):entry.isFile()?[full]:[]
  })
}
async function main(){
  ensure(existsSync('worker/wrangler.jsonc'),'저장소 루트에서 실행해야 합니다.')
  console.log('1/7 정상 Secret 보유 버전 검증 (현재 운영 버전 번호 무관)')
  // A rollback or an automatic deployment can change the currently active version.
  // The source version only needs to exist with the expected bindings.
  const auth=parseJson(exec('npx',['wrangler','auth','token','--json'],join(cwd,'worker')))
  ensure(['oauth','api_token'].includes(auth.type)&&auth.token,'Wrangler 인증 조회 실패')
  token=auth.token
  const ids=[...new Set(exec('npx',['wrangler','whoami'],join(cwd,'worker')).match(/\b[a-f0-9]{32}\b/gi)||[])]
  ensure(ids.length===1||process.env.CLOUDFLARE_ACCOUNT_ID,'Cloudflare 계정이 하나로 식별되지 않았습니다.')
  accountId=process.env.CLOUDFLARE_ACCOUNT_ID||ids[0]
  const root='https://api.cloudflare.com/client/v4/accounts/'+accountId
  async function api(url,{method='GET',body,authToken=token,headers={}}={}){
    const response=await fetch(url,{method,headers:{Authorization:'Bearer '+authToken,...headers},body})
    const value=await response.json()
    if(!response.ok||value.success===false)
      throw Error('Cloudflare HTTP '+response.status+': '+(value.errors||[]).map(x=>x.code+': '+x.message).join(' / '))
    return value.result??value
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
  const old=await api(root+'/workers/workers/'+workerId+'/versions/'+knownGood)
  verifyVersion(old,'Secret 상속 기준 버전')
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
  if(paperDbId){
    ensure(/^[0-9a-f]{32}$|^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(paperDbId),
      'D1 데이터베이스 ID 형식이 올바르지 않습니다.')
    await api(root+'/d1/database/'+paperDbId)
    // Idempotent, additive schema; never deletes saved account snapshots.
    for(const sql of [
      'CREATE TABLE IF NOT EXISTS paper_backup_head (id INTEGER PRIMARY KEY CHECK(id=1), revision INTEGER NOT NULL CHECK(revision>0), updated_at TEXT NOT NULL, snapshot_json TEXT NOT NULL)',
      'CREATE TABLE IF NOT EXISTS paper_backup_history (revision INTEGER PRIMARY KEY, updated_at TEXT NOT NULL, snapshot_json TEXT NOT NULL)',
      'CREATE INDEX IF NOT EXISTS idx_paper_backup_updated ON paper_backup_history(updated_at)',
      'CREATE TABLE IF NOT EXISTS paper_trade_lease (id INTEGER PRIMARY KEY CHECK(id=1), owner TEXT NOT NULL, lease_until INTEGER NOT NULL)'
    ]){
      const queryResult=await api(root+'/d1/database/'+paperDbId+'/query',{
        method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({sql})})
      const results=Array.isArray(queryResult)?queryResult:[queryResult]
      ensure(results.every(x=>x?.success!==false),'D1 초기 테이블 SQL 실행 실패')
    }
    console.log('✓ D1 가상매매 백업 데이터베이스 및 테이블 검증 완료')
  }else{
    console.log('○ D1 백업 미설정: 자동매매는 기존대로 작동하고, 백업 메뉴에는 설정 필요 표시')
  }
  console.log('2/7 테스트 및 프런트엔드 빌드')
  exec('node',['--experimental-strip-types','--test','tests/tradeSignals.test.mjs','tests/autoStatus.test.mjs','tests/paperEngineCheck.test.mjs', 'tests/scanReview.test.mjs', 'tests/trialExit.test.mjs', 'tests/autoWatch.test.mjs', 'tests/maxPositions.test.mjs', 'tests/marketCatalysts.test.mjs', 'tests/kbOAuthReuse.test.mjs', 'tests/tradingAnalytics.test.mjs', 'tests/screeningHistory.test.mjs', 'tests/kbQuoteBatch.test.mjs', 'tests/paperCloudBackup.test.mjs', 'tests/paperTradeLease.test.mjs', 'tests/cloudAutoSync.test.mjs'])
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
    exec('npx',['esbuild','worker/src/index.ts','--bundle','--format=esm','--platform=browser','--target=es2022','--outfile='+output])
    source=readFileSync(output)
  } finally {rmSync(temp,{force:true,recursive:true})}
  ensure(source.includes(Buffer.from('/api/auth/login')),'Worker 로그인 코드 누락')
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
      annotations:{'workers/message':'paper watch + D1 backup + inherited secret bindings'},
      assets:{jwt,config:{not_found_handling:'single-page-application',run_worker_first:['/api/*']}},
      bindings:[
        {name:'AI',type:'ai'}, {name:'ASSETS',type:'assets'},
        ...(paperDbId?[{name:'PAPER_DB',type:'d1',database_id:paperDbId}]:[]),
        ...required.map(name=>({name,type:'inherit',version_id:knownGood}))
      ],
      modules:[{name:'worker.mjs',content_type:'application/javascript+module',content_base64:source.toString('base64')}]
    })
  })
  ensure(created.id,'새 버전 생성 응답에 ID가 없음')
  console.log('6/7 새 버전 Secret 바인딩 검증')
  verifyVersion(await api(root+'/workers/workers/'+workerId+'/versions/'+created.id),'신규 버전',!!paperDbId)
  console.log('7/7 검증 완료. 운영에 새 버전 배포')
  await api(root+'/workers/scripts/'+name+'/deployments',{
    method:'POST',headers:{'Content-Type':'application/json'},
    body:JSON.stringify({strategy:'percentage',versions:[{percentage:100,version_id:created.id}]})
  })
  switched=true
  // A malformed login body yields HTTP 400 when the password Secret exists, 503 otherwise.
  const login=await fetch(domain+'/api/auth/login',{method:'POST',headers:{'Content-Type':'application/json'},body:'{bad'})
  ensure(login.status===400,'로그인 Secret 동작 검사 실패: HTTP '+login.status)
  const page=await fetch(domain,{cache:'no-store'})
  ensure(page.ok&&(await page.text()).includes('<html'),'대시보드 정적 파일 응답 검사 실패')
  console.log('✅ 운영 반영 성공: '+domain)
}
try {await main()} catch(e){
  console.error('중단: '+e.message)
  if(switched){
    console.error('로그인 또는 대시보드 확인 실패: 정상 버전 자동 복구 시도')
    try{
      const r=await fetch('https://api.cloudflare.com/client/v4/accounts/'+accountId+'/workers/scripts/'+name+'/deployments',{
        method:'POST',headers:{Authorization:'Bearer '+token,'Content-Type':'application/json'},
        body:JSON.stringify({strategy:'percentage',versions:[{percentage:100,version_id:rollbackVersion}]})
      })
      const result=await r.json()
      console.error(r.ok&&result.success!==false?'정상 버전 복구 요청 성공':'자동 복구 실패 — Cloudflare에서 이전 정상 버전으로 롤백하세요.')
    }catch{console.error('자동 복구 실패 — Cloudflare에서 이전 정상 버전으로 롤백하세요.')}
  }else console.error('운영 트래픽은 변경되지 않았습니다.')
  process.exitCode=1
}
