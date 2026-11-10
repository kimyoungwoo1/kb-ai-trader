import test from 'node:test'
import assert from 'node:assert/strict'
import {build} from 'esbuild'
const output=await build({entryPoints:['worker/src/liveTrial.ts'],bundle:true,platform:'node',format:'esm',write:false})
const {liveTrialApi}=await import('data:text/javascript;base64,'+Buffer.from(output.outputFiles[0].contents).toString('base64'))
const cash=()=>Response.json({dataHeader:{resultCode:'200',processFlag:'A'},dataBody:{ordr_psbl_csh:'280000',mx_ordr_psbl_amt:'280000'}})
function mockDb(counts={daily:0,active:0,positions:0,committed:0}){
 const calls=[]
 return {calls,prepare(sql){
  calls.push(sql)
  return {bind(){return this},async first(){
   if(sql.includes("trading_day=? AND side='BUY'"))return {n:counts.daily}
   if(sql.includes('state IN'))return {n:counts.active}
   if(sql.includes('COUNT(DISTINCT code)'))return {n:counts.positions}
   if(sql.includes('SUM(reserved_won)'))return {n:counts.committed}
   throw Error('unexpected sql '+sql)
  },async run(){throw Error('read-only preflight attempted D1 write')}}
 }}
}
const env={KB_APP_KEY:'preflight-account-auth-test-1',KB_APP_SECRET:'secret'}

test('preflight never sends a broker order and remains locked when successful',async()=>{
 const fetchOriginal=globalThis.fetch
 const calls=[]
 globalThis.fetch=async(url,opts)=>{
  calls.push(String(url))
  if(String(url).endsWith('/oauth2/token'))return Response.json({dataBody:{access_token:'mock_token',expires_in:3600}})
  if(String(url).endsWith('/api/v1/ssqm1802'))return cash()
  throw Error('attempted order or unknown API')
 }
 const db=mockDb()
 try{
  // A market session is required; this test uses present wall-clock time.
  const result=await liveTrialApi(db,{action:'preflight',code:'005930',quantity:1,limitPrice:9000},env)
  const body=await result.json()
  assert.equal(body.success,true)
  assert.equal(body.locked,true)
  assert.equal(body.executionEnabled,false)
  assert.equal(body.mode,'READ_ONLY_PREFLIGHT')
  assert.equal(body.preview.notional,9000)
  assert.equal(calls.filter(u=>u.includes('ssam')).length,0)
  assert.ok(db.calls.every(x=>x.trimStart().startsWith('SELECT')))
 }finally{globalThis.fetch=fetchOriginal}
})
test('invalid order values never call broker and never attempt writes',async()=>{
 const original=globalThis.fetch
 let calls=0
 globalThis.fetch=async()=>{calls++;throw Error('must not fetch')}
 try{
  const db=mockDb()
  const r=await liveTrialApi(db,{action:'preflight',code:'005930',quantity:3,limitPrice:9000},env)
  assert.equal(r.status,400)
  assert.equal(calls,0)
  assert.equal(db.calls.length,0)
  for(const action of ['enable','buy','sell','cancel','order']){
   assert.equal((await liveTrialApi(db,{action},env)).status,423)
  }
 }finally{globalThis.fetch=original}
})
test('unknown live order journal state fails closed before API read',async()=>{
 const original=globalThis.fetch
 let calls=0
 globalThis.fetch=async()=>{calls++;throw Error('unexpected')}
 try{
  const db=mockDb({daily:null,active:0,positions:0,committed:0})
  const r=await liveTrialApi(db,{action:'preflight',code:'005930',quantity:1,limitPrice:9000},env)
  assert.equal(r.status,503)
  assert.equal(calls,0)
 }finally{globalThis.fetch=original}
})
