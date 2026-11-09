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
