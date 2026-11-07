import test from 'node:test'
import assert from 'node:assert/strict'
import {readFileSync} from 'node:fs'
import {build} from 'esbuild'

const output=await build({entryPoints:['worker/src/kbOrderContract.ts'],bundle:true,platform:'node',format:'esm',write:false})
const {recentKbTradingDates,listKbRecentOrders}=await import('data:text/javascript;base64,'+Buffer.from(output.outputFiles[0].contents).toString('base64'))
const saturday=new Date('2026-11-07T00:30:00Z')
const env={KB_APP_KEY:'recent-orders-autodiscovery-test-key',KB_APP_SECRET:'mock-only'}
const entry=(orderNo,code='A005930')=>({ordr_no:orderNo,stnd_is_no:code,
 trd_dl_ccd_nm:'매수',ordr_q:'5',tl_ccls_q:'3',nccls_q:'2',ordr_uprc:'9000'})
const reply=(lines=[],next='')=>Response.json({
 dataHeader:{resultCode:'200',processFlag:'A'},dataBody:{Record1:lines,nxt_key:next}
})
test('weekend auto-scan picks the latest KST business dates without asking for a buy date',()=>{
 assert.deepEqual(recentKbTradingDates(saturday,3),['20261106','20261105','20261104'])
 assert.deepEqual(recentKbTradingDates(saturday,1),['20261106'])
 assert.throws(()=>recentKbTradingDates(saturday,20),/범위/)
})
test('one-click recent discovery finds order numbers on dates and handles next page',async()=>{
 const before=globalThis.fetch,paths=[],days=[]
 globalThis.fetch=async(url,opts)=>{
  paths.push(String(url))
  if(String(url).endsWith('/oauth2/token'))return Response.json({dataBody:{access_token:'mock-token',expires_in:3600}})
  if(!String(url).endsWith('/api/v1/ssqm2341'))throw Error('Unexpected brokerage endpoint')
  const data=JSON.parse(opts.body).dataBody
  days.push(data.ordr_dt)
  if(data.ordr_dt==='20261106'&&data.nxt_key==='')return reply([entry('0000123456')],'NEXT')
  if(data.ordr_dt==='20261106'&&data.nxt_key==='NEXT')return reply([entry('0000123457')])
  if(data.ordr_dt==='20261105')return reply()
  if(data.ordr_dt==='20261104')return reply([entry('0000123458')])
  throw Error('Unexpected date/next key')
 }
 try{
  const found=await listKbRecentOrders(env,3,saturday)
  assert.equal(found.partial,false)
  assert.deepEqual(found.checkedDates,['20261106','20261105','20261104'])
  assert.equal(found.orders.length,3)
  assert.equal(found.orders[0].orderNo,'0000123456')
  assert.equal(found.orders[0].orderDate,'20261106')
  assert.equal(found.orders[0].filledQuantity,3)
  assert.equal(found.orders[0].remainingQuantity,2)
  assert.deepEqual(days,['20261106','20261106','20261105','20261104'])
  assert.equal(paths.filter(path=>path.includes('/ssam')).length,0,'No order submission')
 }finally{globalThis.fetch=before}
})
test('unavailable days are reported as incomplete, not mistaken for no historic orders',async()=>{
 const before=globalThis.fetch
 globalThis.fetch=async(url,opts)=>{
  if(String(url).endsWith('/oauth2/token'))return Response.json({dataBody:{access_token:'mock-token',expires_in:3600}})
  if(JSON.parse(opts.body).dataBody.ordr_dt==='20261105')return new Response('unavailable',{status:503})
  return reply()
 }
 try{
  const found=await listKbRecentOrders({...env,KB_APP_KEY:'recent-orders-partial-key'},3,saturday)
  assert.equal(found.partial,true)
  assert.deepEqual(found.failedDates,['20261105'])
  assert.equal(found.failedReasons['20261105'],'HTTP_5XX')
  assert.equal(found.checkedDates.length,2)
  assert.equal(found.orders.length,0)
 }finally{globalThis.fetch=before}
})
test('recent orders UI offers one-click scan and makes order number optional',()=>{
 const ui=readFileSync('src/LiveOrderLookup.tsx','utf8')
 assert.match(ui,/action:'recentOrders'/)
 assert.match(ui,/최근 주문 자동 조회/)
 assert.match(ui,/<details/)
 assert.match(ui,/오래전에 산 주식이나 미국주식/)
})

test('empty Record1 on broker success is unverified, not fabricated as zero orders',async()=>{
 const before=globalThis.fetch
 globalThis.fetch=async(url)=>{
  if(String(url).endsWith('/oauth2/token'))
   return Response.json({dataBody:{access_token:'mock-token',expires_in:3600}})
  return Response.json({dataHeader:{resultCode:'200',processFlag:'A'},dataBody:{nxt_key:''}})
 }
 try{
  const found=await listKbRecentOrders({...env,KB_APP_KEY:'recent-orders-missing-list'},1,saturday)
  assert.equal(found.partial,true)
  assert.deepEqual(found.failedDates,['20261106'])
  assert.equal(found.failedReasons['20261106'],'RECORD1_MISSING')
  assert.equal(found.checkedDates.length,0)
 }finally{globalThis.fetch=before}
})
test('explicit empty Record1 array is an authenticated read success, never an order',async()=>{
 const before=globalThis.fetch
 globalThis.fetch=async(url)=>{
  if(String(url).endsWith('/oauth2/token'))
   return Response.json({dataBody:{access_token:'mock-token',expires_in:3600}})
  return reply()
 }
 try{
  const found=await listKbRecentOrders({...env,KB_APP_KEY:'recent-orders-empty-list'},1,saturday)
  assert.equal(found.partial,false)
  assert.deepEqual(found.checkedDates,['20261106'])
  assert.deepEqual(found.orders,[])
  assert.deepEqual(found.failedReasons,{})
 }finally{globalThis.fetch=before}
})
test('KB business rejection displays safe category without exposing provider message',async()=>{
 const before=globalThis.fetch
 globalThis.fetch=async(url)=>{
  if(String(url).endsWith('/oauth2/token'))
   return Response.json({dataBody:{access_token:'mock-token',expires_in:3600}})
  return Response.json({dataHeader:{resultCode:'5007',processFlag:'N',processCode:'F123',processMessage:'PRIVATE ACCOUNT RECORD'},dataBody:{accountNumber:'SENSITIVE'}})
 }
 try{
  const found=await listKbRecentOrders({...env,KB_APP_KEY:'recent-orders-reject'},1,saturday)
  assert.equal(found.partial,true)
  assert.equal(found.failedReasons['20261106'],'BUSINESS_REJECTED')
  assert.deepEqual(found.failedBusinessCodes['20261106'],{resultCode:'5007',processCode:'F123',processFlag:'N'})
  assert.ok(!JSON.stringify(found).includes('PRIVATE ACCOUNT RECORD'))
  assert.ok(!JSON.stringify(found).includes('SENSITIVE'))
 }finally{globalThis.fetch=before}
})
test('HTTP 429 is classified without retrying the read-only broker endpoint',async()=>{
 const before=globalThis.fetch
 let calls=0
 globalThis.fetch=async(url)=>{
  if(String(url).endsWith('/oauth2/token'))
   return Response.json({dataBody:{access_token:'mock-token',expires_in:3600}})
  calls++
  return Response.json({message:'PRIVATE RATE LIMIT BODY'},{status:429})
 }
 try{
  const found=await listKbRecentOrders({...env,KB_APP_KEY:'recent-orders-limit'},1,saturday)
  assert.equal(found.failedReasons['20261106'],'HTTP_429')
  assert.equal(calls,1)
  assert.ok(!JSON.stringify(found).includes('PRIVATE RATE LIMIT BODY'))
 }finally{globalThis.fetch=before}
})

test('broker status fields with unsafe characters are never revealed in diagnostics',async()=>{
 const previous=globalThis.fetch
 globalThis.fetch=async(url)=>{
  if(String(url).endsWith('/oauth2/token'))
   return Response.json({dataBody:{access_token:'mock-token',expires_in:3600}})
  return Response.json({dataHeader:{resultCode:'5007',processCode:'account=123-45-6789 private',processFlag:'N',processMessage:'Secret user details'},dataBody:{}})
 }
 try{
  const found=await listKbRecentOrders({...env,KB_APP_KEY:'recent-orders-code-sanitization'},1,saturday)
  assert.equal(found.failedBusinessCodes['20261106'].resultCode,'5007')
  assert.equal(found.failedBusinessCodes['20261106'].processCode,'미제공')
  assert.ok(!JSON.stringify(found).includes('123-45-6789'))
  assert.ok(!JSON.stringify(found).includes('Secret user details'))
 }finally{globalThis.fetch=previous}
})
