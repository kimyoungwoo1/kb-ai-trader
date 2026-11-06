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
