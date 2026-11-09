import test from 'node:test'
import assert from 'node:assert/strict'
import {build} from 'esbuild'
const bundle=await build({entryPoints:['worker/src/kbOrderSubmit.ts'],bundle:true,platform:'node',format:'esm',write:false})
const {submitKbLimitOnce,submitKbCancelOnce}=await import('data:text/javascript;base64,'+Buffer.from(bundle.outputFiles[0].contents).toString('base64'))
const env={KB_APP_KEY:'unconnected-order-test',KB_APP_SECRET:'redacted'}
const key='/oauth2/token'
const orig=globalThis.fetch
const tokenReply=()=>Response.json({dataBody:{access_token:'dummy-test-token',expires_in:120}})
test('a broker order response is classified as ACCEPTED but not FILLED',async()=>{
 const calls=[]
 globalThis.fetch=async(url,options)=>{
  calls.push(String(url))
  if(String(url).endsWith(key))return tokenReply()
  if(String(url).endsWith('/api/v1/ssam1802'))
   return Response.json({dataHeader:{resultCode:'200',processFlag:'A',processCode:'0005'},dataBody:{ordr_no:'0060000705'}})
  throw Error('Unexpected endpoint')
 }
 try{
  const r=await submitKbLimitOnce(env,'BUY',{code:'005930',price:9000,quantity:1})
  assert.deepEqual(r,{state:'ACCEPTED',brokerOrderNo:'0060000705'})
  assert.equal(calls.filter(x=>x.endsWith('/api/v1/ssam1802')).length,1)
 }finally{globalThis.fetch=orig}
})
test('lost broker response is UNKNOWN with exactly one order POST',async()=>{
 let orderPosts=0
 globalThis.fetch=async(url)=>{
  if(String(url).endsWith(key))return tokenReply()
  orderPosts++
  throw new Error('simulated timeout')
 }
 try{
  const r=await submitKbLimitOnce({...env,KB_APP_KEY:'fresh-key-timeout'},'BUY',{code:'005930',price:9000,quantity:1})
  assert.equal(r.state,'UNKNOWN')
  assert.equal(orderPosts,1)
 }finally{globalThis.fetch=orig}
})
test('well-formed rejection is REJECTED; malformed HTTP success is UNKNOWN',async()=>{
 let mode='reject'
 globalThis.fetch=async(url)=>{
  if(String(url).endsWith(key))return tokenReply()
  return mode==='reject'
   ? Response.json({dataHeader:{resultCode:'401',processFlag:'E',processCode:'0021'}})
   : Response.json({dataHeader:{resultCode:'200',processFlag:'A'},dataBody:{ordr_no:''}})
 }
 try{
  const rejected=await submitKbLimitOnce({...env,KB_APP_KEY:'fresh-key-reject'},'BUY',{code:'005930',quantity:1,price:9000})
  assert.equal(rejected.state,'REJECTED')
  mode='ambiguous'
  const unknown=await submitKbLimitOnce({...env,KB_APP_KEY:'fresh-key-missing-ack'},'BUY',{code:'005930',quantity:1,price:9000})
  assert.equal(unknown.state,'UNKNOWN')
 }finally{globalThis.fetch=orig}
})
test('cancel is only accepted on 0014 and a new cancellation number',async()=>{
 globalThis.fetch=async(url)=>{
  if(String(url).endsWith(key))return tokenReply()
  assert.ok(String(url).endsWith('/api/v1/ssam1806'))
  return Response.json({dataHeader:{resultCode:'200',processFlag:'A',processCode:'0014'},dataBody:{ordr_no:'0060000712'}})
 }
 try{
  const r=await submitKbCancelOnce({...env,KB_APP_KEY:'fresh-key-cancel'},'005930','0060000705')
  assert.equal(r.state,'ACCEPTED')
  assert.equal(r.brokerOrderNo,'0060000712')
 }finally{globalThis.fetch=orig}
})

test('write redirects stay UNKNOWN and are never followed for buys, sells or cancels',async()=>{
 const order={code:'005930',price:9000,quantity:1}
 const writes=[
  ()=>submitKbLimitOnce(env,'BUY',order),
  ()=>submitKbLimitOnce(env,'SELL',order),
  ()=>submitKbCancelOnce(env,order.code,'0060000705'),
 ]
 for(const status of [307,308]){
  const redirects=[]
  globalThis.fetch=async(url,options)=>{
   if(String(url).endsWith(key))return tokenReply()
   redirects.push(options.redirect)
   return Response.json({dataHeader:{resultCode:'400',processFlag:'E'}},{
    status,
    headers:{Location:'/other-order-endpoint'},
   })
  }
  try{
   for(const write of writes)assert.equal((await write()).state,'UNKNOWN')
   assert.deepEqual(redirects,['manual','manual','manual'])
  }finally{globalThis.fetch=orig}
 }
})

test('success-shaped broker body on HTTP 503 never acknowledges any write',async()=>{
 const order={code:'005930',price:9000,quantity:1}
 const codes={ssam1802:'0005',ssam1801:'0004',ssam1806:'0014'}
 globalThis.fetch=async(url)=>{
  if(String(url).endsWith(key))return tokenReply()
  const code=codes[String(url).split('/').at(-1)]
  return Response.json({
   dataHeader:{resultCode:'200',processFlag:'A',processCode:code},
   dataBody:{ordr_no:'0060000712'},
  },{status:503})
 }
 try{
  assert.equal((await submitKbLimitOnce(env,'BUY',order)).state,'UNKNOWN')
  assert.equal((await submitKbLimitOnce(env,'SELL',order)).state,'UNKNOWN')
  assert.equal((await submitKbCancelOnce(env,order.code,'0060000705')).state,'UNKNOWN')
 }finally{globalThis.fetch=orig}
})
