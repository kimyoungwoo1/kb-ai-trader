import test from 'node:test'
import assert from 'node:assert/strict'
import {build} from 'esbuild'
const result=await build({entryPoints:['worker/src/kbAccountRead.ts'],bundle:true,platform:'node',format:'esm',write:false})
const {readKbAccountJson,accountRead}=await import('data:text/javascript;base64,'+Buffer.from(result.outputFiles[0].contents).toString('base64'))
const run=()=>readKbAccountJson('https://developer.kbsec.com:32484/api/v1/ssqm1801',{Authorization:'Bearer mock'},{})

test('temporary upstream 502 HTML is retried once and recovers',async()=>{
 const old=globalThis.fetch;let calls=0
 globalThis.fetch=async()=>{calls++;return calls===1?new Response('<html>Bad Gateway</html>',{status:502,headers:{'content-type':'text/html'}}):Response.json({dataBody:{Record1:[]}})}
 try{
  const r=await run()
  assert.equal(r.success,true)
  assert.equal(calls,2)
 }finally{globalThis.fetch=old}
})
test('temporary upstream 522 HTML is retried once and recovers',async()=>{
 const old=globalThis.fetch;let calls=0
 globalThis.fetch=async()=>{calls++;return calls===1?new Response('<html>Bad Gateway</html>',{status:522,headers:{'content-type':'text/html'}}):Response.json({dataBody:{Record1:[]}})}
 try{
  const r=await run()
  assert.equal(r.success,true)
  assert.equal(calls,2)
 }finally{globalThis.fetch=old}
})
test('repeated 502 HTML fails closed with safe status/type not body or credentials',async()=>{
 const old=globalThis.fetch;let calls=0
 globalThis.fetch=async()=>{calls++;return new Response('<html>account=SECRET</html>',{status:502,headers:{'content-type':'text/html'}})}
 try{
  const r=await run()
  assert.equal(r.success,false)
  assert.equal(r.status,502)
  assert.equal(r.issue,'NON_JSON')
  assert.equal(r.contentType,'text/html')
  assert.equal(r.retried,true)
  assert.equal(calls,2)
  assert.ok(!JSON.stringify(r).includes('SECRET'))
 }finally{globalThis.fetch=old}
})
test('invalid HTTP 200 page is never retried or interpreted as account data',async()=>{
 const old=globalThis.fetch;let calls=0
 globalThis.fetch=async()=>{calls++;return new Response('<html>Login</html>',{status:200,headers:{'content-type':'text/html'}})}
 try{
  const r=await run()
  assert.equal(r.success,false)
  assert.equal(r.status,200)
  assert.equal(r.issue,'NON_JSON')
  assert.equal(calls,1)
 }finally{globalThis.fetch=old}
})
test('upstream 401 is never retried and non-JSON body is not exposed',async()=>{
 const old=globalThis.fetch;let calls=0
 globalThis.fetch=async()=>{calls++;return new Response('unauthorized',{status:401})}
 try{
  const r=await run()
  assert.equal(r.success,false)
  assert.equal(r.status,401)
  assert.equal(calls,1)
 }finally{globalThis.fetch=old}
})

const holdingsUrl = 'https://developer.kbsec.com:32484/api/v1/ssqm1801'
const holdingsInit = {method:'POST',body:'{}'}

test('a prompt holdings response does not start a backup read',async()=>{
 const saved=globalThis.fetch
 let direct=0
 globalThis.fetch=async()=>{direct++;return Response.json({})}
 try{
  for(const status of [200,401,429]){
   const read=accountRead({fetch:async()=>new Response(null,{status})},1)
   assert.equal((await read(holdingsUrl,holdingsInit)).status,status)
  }
  assert.equal(direct,0)
 }finally{globalThis.fetch=saved}
})

test('a slow private holdings read starts a backup and aborts the losing request',async()=>{
 const saved=globalThis.fetch
 let primarySignal,direct=0
 globalThis.fetch=async()=>{direct++;return Response.json({route:'direct'})}
 const read=accountRead({fetch(request){
  primarySignal=request.signal
  return new Promise((_,reject)=>primarySignal.addEventListener('abort',()=>reject(primarySignal.reason),{once:true}))
 }},1)
 try{
  assert.deepEqual(await (await read(holdingsUrl,holdingsInit)).json(),{route:'direct'})
  assert.equal(direct,1)
  assert.equal(primarySignal.aborted,true)
 }finally{globalThis.fetch=saved}
})

test('gateway failure on the backup does not hide a usable private response',async()=>{
 const saved=globalThis.fetch
 let finish
 globalThis.fetch=async()=>{
  setTimeout(()=>finish(Response.json({route:'private'})),5)
  return new Response(null,{status:522})
 }
 try{
  const read=accountRead({fetch:()=>new Promise(resolve=>{finish=resolve})},1)
  assert.deepEqual(await (await read(holdingsUrl,holdingsInit)).json(),{route:'private'})
 }finally{globalThis.fetch=saved}
})
