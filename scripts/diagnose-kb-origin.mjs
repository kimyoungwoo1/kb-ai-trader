#!/usr/bin/env node
// Safe read-only *network* probe. No KB secrets, access tokens, D1 or broker orders.
// Run in Codespaces to compare direct network path to Cloudflare Worker edge.
// HTTP 403/404 from GET / proves HTTP reached an upstream; HTTP 522 does not.
const target='https://developer.kbsec.com:32484/'
const attempts=3
for(let n=1;n<=attempts;n++){
 const started=performance.now()
 try{
  const response=await fetch(target,{
   method:'GET',redirect:'manual',cache:'no-store',
   headers:{Accept:'text/plain'},
   signal:AbortSignal.timeout(25000),
  })
  const type=(response.headers.get('content-type')||'unknown').split(';',1)[0]
  const ray=response.headers.get('cf-ray')
  await response.body?.cancel().catch(()=>{})
  const durationMs=Math.round(performance.now()-started)
  console.log(JSON.stringify({probe:n,code:response.status,contentType:type,durationMs,
   ...(ray&&/^[A-Za-z0-9-]{1,50}$/.test(ray)?{cfRay:ray}:{})}))
 }catch(error){
  const durationMs=Math.round(performance.now()-started)
  const kind=error instanceof Error&&error.name==='TimeoutError'?'TIMEOUT':'NETWORK_ERROR'
  console.log(JSON.stringify({probe:n,error:kind,durationMs}))
 }
}
console.log('No API credentials were used. This does not verify OAuth, accounts, or broker orders.')


import {lookup} from 'node:dns/promises'
import {connect as tcpConnect} from 'node:net'
import {connect as tlsConnect} from 'node:tls'
const host='developer.kbsec.com'
const safe=(e)=>/^[A-Z_0-9]{3,40}$/.test(String(e?.code))?e.code:'UNKNOWN'
const dns=await lookup(host,{all:true}).catch(error=>{console.log(JSON.stringify({stage:'dns',error:safe(error)}));return []})
console.log(JSON.stringify({stage:'dns',v4:dns.filter(x=>x.family===4).length,v6:dns.filter(x=>x.family===6).length}))
const families=[...new Set(dns.map(x=>x.family))]
const check=(port,family,tls=false)=>new Promise(resolve=>{
 const started=performance.now()
 const socket=tls?tlsConnect({host,port,family,servername:host,rejectUnauthorized:true}):tcpConnect({host,port,family})
 let done=false
 const finish=(status,code)=>{
  if(done)return;done=true;socket.destroy()
  const info={stage:tls?'tls':'tcp',port,family,status,elapsedMs:Math.round(performance.now()-started),...(code?{code}:{})}
  console.log(JSON.stringify(info));resolve()
 }
 socket.setTimeout(7000,()=>finish('TIMEOUT'))
 socket.once(tls?'secureConnect':'connect',()=>finish('CONNECTED'))
 socket.once('error',error=>finish('ERROR',safe(error)))
})
for(const family of families){
 await check(443,family)
 await check(32484,family)
 await check(32484,family,true)
}
