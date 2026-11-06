import test from 'node:test'
import assert from 'node:assert/strict'
import { build } from 'esbuild'
const out=await build({entryPoints:['worker/src/kbOrderContract.ts'],bundle:true,platform:'node',format:'esm',write:false,
 external:['./kbToken']})
// esbuild external depends on import; bundle in CJS for local test
const mod=await build({entryPoints:['worker/src/kbOrderContract.ts'],bundle:true,platform:'node',format:'esm',write:false})
const {makeLimitOrder,makeCancelOrder,makeOrderInquiry,parseOrderAck,parseCancelAck,parseOrderLines,findOrder,lookupKbOrder}=
 await import('data:text/javascript;base64,'+Buffer.from(mod.outputFiles[0].contents).toString('base64'))
const head=(processCode,resultCode='200')=>({resultCode,resultMessage:'성공',processFlag:'A',processCode})
const orderSample=(side='BUY')=>({dataHeader:head(side==='BUY'?'0005':'0004'),
 dataBody:{ordr_no:'0060000705',is_cd:'005930',ordr_q:'0000000001'}})
const fillSample=(nextKey='')=>({dataHeader:head('0015'),
 dataBody:{nxt_key:nextKey,Record1:[{ordr_no:'0060000705',stnd_is_no:'A005930',
 trd_dl_ccd_nm:'매수',ordr_q:'000000000000000001',tl_ccls_q:'000000000000000000',
 nccls_q:'000000000000000001',ordr_uprc:'000000000000049000',crct_cncl_ccd:' '}]}})
test('KB V2 buy/sell limit order has exact SSAM1801/1802 fields',()=>{
 const buy=makeLimitOrder('BUY',{code:'005930',quantity:1,price:49000})
 assert.equal(buy.path,'/api/v1/ssam1802')
 assert.deepEqual(buy.body.dataBody,{ordr_uprc:'49000',ordr_ccd:'00',
 mkt_tm_clsf:'1',is_cd:'005930',ordr_q:'1',sor_ordr_ccd:'S'})
 assert.equal(makeLimitOrder('SELL',{code:'005930',quantity:1,price:49000}).path,'/api/v1/ssam1801')
 assert.throws(()=>makeLimitOrder('BUY',{code:'005930',quantity:2,price:49000}),/5만 원/)
 assert.throws(()=>makeLimitOrder('BUY',{code:'005930',quantity:1,price:49000.5}),/지정가/)
})
test('KB V2 cancellation and fill-history request only use specified fields',()=>{
 const cancel=makeCancelOrder('005930','0060000705')
 assert.equal(cancel.path,'/api/v1/ssam1806')
 assert.deepEqual(cancel.body.dataBody,{crct_clsf:'2',is_cd:'005930',ordr_q:'',
 orgn_ordr_no:'0060000705'})
 assert.deepEqual(makeOrderInquiry('20261109').body.dataBody,
 {ccls_clsf:'0',nxt_key:'',ordr_dt:'20261109'})
 assert.throws(()=>makeCancelOrder('005930','not-no'),/원주문번호/)
})
test('KB response must have successful business fields AND valid order number',()=>{
 assert.deepEqual(parseOrderAck(orderSample('BUY'),'BUY'),{accepted:true,orderNo:'0060000705'})
 assert.equal(parseOrderAck(orderSample('SELL'),'SELL').accepted,true)
 assert.equal(parseOrderAck({...orderSample(),dataHeader:head('0000')},'BUY').accepted,false)
 assert.equal(parseOrderAck({...orderSample(),dataHeader:head('0005','400')},'BUY').accepted,false)
 assert.equal(parseOrderAck({...orderSample(),dataBody:{ordr_no:' '}},'BUY').accepted,false)
 assert.equal(parseCancelAck({dataHeader:head('0014'),dataBody:{ordr_no:'0060000712'}}),true)
 assert.equal(parseCancelAck({dataHeader:head('0014'),dataBody:{ordr_no:''}}),false)
})
test('order history safely maps open and filled quantities and validates page key',()=>{
 const parsed=parseOrderLines(fillSample('NEXTKEY'))
 assert.equal(parsed.lines[0].code,'005930')
 assert.equal(parsed.lines[0].side,'BUY')
 assert.equal(parsed.lines[0].remainingQuantity,1)
 assert.equal(parsed.lines[0].filledQuantity,0)
 assert.equal(parsed.nextKey,'NEXTKEY')
 assert.equal(findOrder(parsed.lines,'0060000705','005930','BUY')?.orderNo,'0060000705')
 assert.equal(findOrder(parsed.lines,'anything','005930','BUY'),null)
 assert.throws(()=>parseOrderLines({...fillSample(),dataBody:{Record1:[{...fillSample().dataBody.Record1[0],nccls_q:'2'}]}}),/검증 실패/)
})
test('read-only reconciliation fetches SSQM2341 only and never sends a buy order',async()=>{
 const real=globalThis.fetch
 const calls=[]
 globalThis.fetch=async(input,options)=>{
  calls.push({url:String(input),body:JSON.parse(options.body)})
  if(String(input).endsWith('/oauth2/token'))return Response.json({dataBody:{access_token:'token-value',expires_in:180}})
  if(String(input).endsWith('/api/v1/ssqm2341'))return Response.json(fillSample())
  throw Error('Unexpected brokerage endpoint')
 }
 try{
  const r=await lookupKbOrder({KB_APP_KEY:'test-reconcile-key',KB_APP_SECRET:'secret'},'20261109','0060000705','005930','BUY')
  assert.equal(r.found,true)
  assert.equal(r.order.remainingQuantity,1)
  assert.equal(calls.filter(c=>c.url.endsWith('/api/v1/ssqm2341')).length,1)
  assert.equal(calls.filter(c=>c.url.includes('ssam')).length,0)
 }finally{globalThis.fetch=real}
})
