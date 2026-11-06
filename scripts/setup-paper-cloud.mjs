#!/usr/bin/env node
// One-time explicit setup of the dedicated Cloudflare D1 PAPER backup database.
// Does not modify any existing paper trading history or Cloudflare secrets.
import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'

const root=process.cwd()
if(!existsSync('worker/wrangler.jsonc'))throw Error('저장소 루트에서 실행해 주세요.')
const run=(bin,args,dir=root)=>execFileSync(bin,args,{
  cwd:dir,encoding:'utf8',stdio:['ignore','pipe','pipe'],timeout:120000})
const ensure=(ok,msg)=>{if(!ok)throw Error(msg)}
const parse=text=>JSON.parse(text.slice(text.indexOf('{')))
const auth=parse(run('npx',['wrangler','auth','token','--json'],root+'/worker'))
ensure(auth?.token,'Cloudflare 로그인 인증이 필요합니다.')
const token=auth.token
const ids=[...new Set(run('npx',['wrangler','whoami'],root+'/worker')
  .match(/\b[a-f0-9]{32}\b/gi)||[])]
const account=process.env.CLOUDFLARE_ACCOUNT_ID||(ids.length===1?ids[0]:null)
ensure(account,'Cloudflare 계정 ID를 결정할 수 없습니다. CLOUDFLARE_ACCOUNT_ID를 지정해 주세요.')
const endpoint='https://api.cloudflare.com/client/v4/accounts/'+account+'/d1/database'
async function cf(url,method='GET',body){
  const response=await fetch(url,{method,headers:{
    Authorization:'Bearer '+token,'Content-Type':'application/json',
  },body:body?JSON.stringify(body):undefined})
  const result=await response.json()
  ensure(response.ok&&result.success!==false,
    'Cloudflare D1 API 오류 '+response.status+': '
      +(result.errors||[]).map(item=>item.message).join(' / '))
  return result.result??result
}
const response=await cf(endpoint+'?per_page=100')
const entries=Array.isArray(response)?response:response?.result||[]
const existing=entries.filter(db=>db.name==='kb-ai-trader-paper')
ensure(existing.length<=1,'같은 이름의 D1 데이터베이스가 둘 이상입니다. 직접 정리해야 합니다.')
const database=existing[0]||await cf(endpoint,'POST',{name:'kb-ai-trader-paper'})
const databaseId=database.uuid||database.id
ensure(databaseId,'생성한 데이터베이스 ID를 확인할 수 없습니다.')
console.log(existing.length?'✓ 기존 D1 백업 데이터베이스 재사용':'✓ D1 가상매매 백업 데이터베이스 최초 생성')
console.log('✓ 데이터베이스 ID: '+databaseId)
console.log('✓ 초기 테이블 생성과 Secret 보존 배포 스크립트 시작')
const child=spawnSync(process.execPath,['scripts/deploy-verified-production.mjs'],{
  cwd:root,env:{...process.env,PAPER_DB_ID:databaseId},stdio:'inherit'
})
if(child.error)throw child.error
process.exitCode=child.status??1
