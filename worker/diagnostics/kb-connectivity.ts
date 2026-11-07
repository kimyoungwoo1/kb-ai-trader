/**
 * Separate disposable Cloudflare Worker network diagnostic.
 * NO KB credentials, no account access, no order requests, no D1,
 * and never deployed as kb-ai-trader.
 */
import {connect} from 'cloudflare:sockets'
const host='developer.kbsec.com'
const targetPort=32484
type Check={reachable:boolean;status?:number;error?:string;durationMs:number}
const elapsed=(start:number)=>Date.now()-start
const failure=(error:unknown):string=>{
 const name=error instanceof Error?error.name:'UnknownError'
 return name==='TimeoutError'?'TIMEOUT':name==='AbortError'?'TIMEOUT':name==='TypeError'?'FETCH_FAILED':'CONNECTION_FAILED'
}
async function fetchCheck(url:string):Promise<Check>{
 const start=Date.now()
 try{
  // Unauthenticated HEAD to root: HTTP status (even 404/405) proves the
  // network path reached an HTTP server. No token or brokerage API is called.
  const response=await fetch(url,{method:'HEAD',redirect:'manual',
   signal:AbortSignal.timeout(9000),cache:'no-store'})
  return {reachable:true,status:response.status,durationMs:elapsed(start)}
 }catch(error){
  return {reachable:false,error:failure(error),durationMs:elapsed(start)}
 }
}
async function socketCheck():Promise<Check>{
 const start=Date.now()
 let socket:ReturnType<typeof connect>|undefined
 try{
  socket=connect({hostname:host,port:targetPort},{secureTransport:'on'})
  // Avoid unhandled closed-promise rejections on abrupt upstream reset.
  void socket.closed.catch(()=>{})
  await Promise.race([
   socket.opened,
   new Promise((_,reject)=>setTimeout(()=>reject(new DOMException('Timeout','TimeoutError')),9000))
  ])
  // A socket-open result is a transport/TLS handshake observation, not
  // proof of a valid authenticated KB HTTP request.
  return {reachable:true,durationMs:elapsed(start)}
 }catch(error){
  return {reachable:false,error:failure(error),durationMs:elapsed(start)}
 }finally{
  try{socket?.close()}catch{}
 }
}
export default {
 async fetch(request:Request):Promise<Response>{
  if(request.method!=='GET'||new URL(request.url).pathname!=='/'){
   return new Response('Not found',{status:404})
  }
  const [httpsCustomPort,httpsDefaultPort,tlsSocket]=await Promise.all([
   fetchCheck('https://'+host+':'+targetPort+'/'),
   fetchCheck('https://'+host+'/'),
   socketCheck()
  ])
  return Response.json({
   mode:'NETWORK_ONLY_NO_CREDENTIALS_NO_ORDERS',
   target:host,customPort:targetPort,
   httpsCustomPort,httpsDefaultPort,tlsSocket,
   note:'A successful HTTP status does not prove KB OAuth or trading access.'
  },{headers:{'Cache-Control':'no-store','X-Content-Type-Options':'nosniff'}})
 }
}
