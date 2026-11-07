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
/** Unauthenticated HTTP/1.1 probe through the already-tested TLS socket.
 * Does not use the broker token endpoint, account APIs, secrets, or trade APIs.
 * Only a sanitized status/error code is returned; never expose response bytes.
 */
async function tlsHttpCheck():Promise<Check>{
 const start=Date.now()
 let socket:ReturnType<typeof connect>|undefined
 let reader:ReadableStreamDefaultReader<Uint8Array>|undefined
 let writer:WritableStreamDefaultWriter<Uint8Array>|undefined
 const timeout=async<T>(promise:Promise<T>,ms:number):Promise<T>=>{
  let timer:ReturnType<typeof setTimeout>|undefined
  try{
   return await Promise.race([promise,new Promise<T>((_,reject)=>{
    timer=setTimeout(()=>reject(new DOMException('Timeout','TimeoutError')),ms)
   })])
  }finally{if(timer!==undefined)clearTimeout(timer)}
 }
 try{
  socket=connect({hostname:host,port:targetPort},{secureTransport:'on'})
  void socket.closed.catch(()=>{})
  await timeout(socket.opened,8000)
  writer=socket.writable.getWriter()
  const request='GET / HTTP/1.1\r\nHost: '+host+'\r\nAccept: */*\r\nConnection: close\r\n\r\n'
  await timeout(writer.write(new TextEncoder().encode(request)),8000)
  writer.releaseLock()
  writer=undefined
  reader=socket.readable.getReader()
  let head=''
  for(let part=0;part<8&&head.length<1024&&!head.includes('\r\n');part++){
   const left=Math.max(1,10_000-elapsed(start))
   const piece=await timeout(reader.read(),left)
   if(piece.done)break
   head+=new TextDecoder().decode(piece.value.slice(0,Math.max(0,1024-head.length)))
  }
  const match=/^HTTP\/1\.[01] ([1-5][0-9]{2})(?: |\r?\n)/.exec(head)
  return match?{reachable:true,status:Number(match[1]),durationMs:elapsed(start)}:
   {reachable:false,error:'NO_HTTP_STATUS',durationMs:elapsed(start)}
 }catch(error){
  return {reachable:false,error:failure(error),durationMs:elapsed(start)}
 }finally{
  try{await reader?.cancel()}catch{}
  try{reader?.releaseLock()}catch{}
  try{writer?.releaseLock()}catch{}
  try{socket?.close()}catch{}
 }
}
export default {
 async fetch(request:Request):Promise<Response>{
  if(request.method!=='GET'||new URL(request.url).pathname!=='/'){
   return new Response('Not found',{status:404})
  }
  const [httpsCustomPort,httpsDefaultPort,tlsSocket,tlsHttp]=await Promise.all([
   fetchCheck('https://'+host+':'+targetPort+'/'),
   fetchCheck('https://'+host+'/'),
   socketCheck(),
   tlsHttpCheck()
  ])
  return Response.json({
   mode:'NETWORK_ONLY_NO_CREDENTIALS_NO_ORDERS',
   target:host,customPort:targetPort,
   httpsCustomPort,httpsDefaultPort,tlsSocket,tlsHttp,
   note:'Network-only results. tlsSocket means a connection opened; tlsHttp tests a sanitized HTTP/1.1 response. Neither proves KB OAuth or trading access.'
  },{headers:{'Cache-Control':'no-store','X-Content-Type-Options':'nosniff'}})
 }
}
