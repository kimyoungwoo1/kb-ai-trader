/**
 * Experimental, READ-ONLY ONLY KB transport using TLS sockets.
 * ISOLATED: not imported by the production dashboard, OAuth cache, or live
 * execution engine. This must not become an order transport without separate
 * review and actual broker-side read verification.
 */
import {connect} from 'cloudflare:sockets'
import {decodeKbHttpResponse,decodeKbJson} from './kbHttpWire'

const host='developer.kbsec.com'
const port=32484
const paths=new Set([
 '/oauth2/token',
 '/api/v1/ssqm1801',
 '/api/v1/ssqm2952',
 '/api/v1/ssqm0004',
 '/api/v1/ssqm1802',
 '/api/v1/ssqm2341'
])
const encoder=new TextEncoder()
const endBy=async<T>(task:Promise<T>,deadline:number):Promise<T>=>{
 let timer:ReturnType<typeof setTimeout>|undefined
 try{
  const remaining=deadline-Date.now()
  if(remaining<=0)throw Error('KB_SOCKET_TIMEOUT')
  return await Promise.race([task,new Promise<T>((_,reject)=>{
   timer=setTimeout(()=>reject(Error('KB_SOCKET_TIMEOUT')),remaining)
  })])
 }finally{if(timer!==undefined)clearTimeout(timer)}
}
const safeHeader=(value:string)=>{
 if(value.length>16000||/[\r\n\u0000-\u001f\u007f]/.test(value))
  throw Error('KB_SOCKET_HEADER_INVALID')
 return value
}
export type KbSocketReadRequest={
 path:string;body:unknown;token?:string;timeoutMs?:number
}
export async function kbReadOnlyTlsRequest(input:KbSocketReadRequest):Promise<{
 status:number;json:unknown;durationMs:number
}>{
 const {path}=input
 if(!paths.has(path))throw Error('KB_SOCKET_READ_ONLY_PATH_REQUIRED')
 if(input.token!==undefined&&path==='/oauth2/token')
  throw Error('KB_SOCKET_TOKEN_HEADER_NOT_ALLOWED')
 if(input.token!==undefined&&(!input.token||input.token.length>4096))
  throw Error('KB_SOCKET_TOKEN_INVALID')
 const deadline=Date.now()+Math.max(1000,Math.min(input.timeoutMs??15000,25000))
 const start=Date.now()
 const body=JSON.stringify(input.body)
 if(typeof body!=='string'||encoder.encode(body).length>128*1024)
  throw Error('KB_SOCKET_REQUEST_SIZE')
 const serialized=encoder.encode(body)
 // CRLF and header injection blocked. No URL, path or arbitrary header input.
 const request=encoder.encode('POST '+path+' HTTP/1.1\r\n'+
  'Host: '+host+':'+port+'\r\n'+
  'Content-Type: application/json\r\n'+
  'Accept: application/json\r\n'+
  'Accept-Encoding: identity\r\n'+
  'Connection: close\r\n'+
  (input.token?'Authorization: Bearer '+safeHeader(input.token)+'\r\n':'')+
  'Content-Length: '+serialized.length+'\r\n\r\n')
 // The unauthenticated TLS GET probe succeeded with a single write.
 // Send one full Content-Length framed request to avoid a fragmented request
 // leaving the upstream waiting for its body. This is still read-only/OAuth.
 const fullRequest=new Uint8Array(request.length+serialized.length)
 fullRequest.set(request)
 fullRequest.set(serialized,request.length)
 let phase:'CONNECT'|'WRITE'|'READ_HEADERS'|'READ_BODY'|'JSON'='CONNECT'
 let socket:ReturnType<typeof connect>|undefined
 let writer:WritableStreamDefaultWriter<Uint8Array>|undefined
 let reader:ReadableStreamDefaultReader<Uint8Array>|undefined
 try{
  socket=connect({hostname:host,port},{secureTransport:'on'})
  void socket.closed.catch(()=>{})
  await endBy(socket.opened,deadline)
  phase='WRITE'
  writer=socket.writable.getWriter()
  await endBy(writer.write(fullRequest),deadline)
  writer.releaseLock();writer=undefined
  phase='READ_HEADERS'
  reader=socket.readable.getReader()
  let buffer=new Uint8Array(0)
  for(;;){
   const part=await endBy(reader.read(),deadline)
   if(!part.done){
    if(buffer.length+part.value.length>1024*1024)
     throw Error('KB_SOCKET_RESPONSE_TOO_LARGE')
    const next=new Uint8Array(buffer.length+part.value.length)
    next.set(buffer);next.set(part.value,buffer.length);buffer=next
    // Do not expose or log any received bytes.
    if(buffer.includes(13)&&buffer.includes(10))phase='READ_BODY'
   }
   const reply=decodeKbHttpResponse(buffer,part.done)
   if(reply){
    phase='JSON'
    return {status:reply.status,json:decodeKbJson(reply.body),
     durationMs:Date.now()-start}
   }
   if(part.done)throw Error('KB_SOCKET_RESPONSE_TRUNCATED')
  }
 }catch(error){
  // Never expose Error.cause, URL query, credentials, token, socket peer
  // bytes or response text. Only the fixed phase is returned to the caller.
  const msg=error instanceof Error?error.message:''
  if(msg==='KB_SOCKET_TIMEOUT')throw Error('KB_SOCKET_TIMEOUT_'+phase)
  if(/^KB_(WIRE|SOCKET)_[A-Z_]+$/.test(msg))throw Error(msg)
  throw Error('KB_SOCKET_TRANSPORT_'+phase)
 }finally{
  // Cleanup is best-effort: do not let cancel() stall the diagnostic result.
  try{reader?.releaseLock()}catch{}
  try{writer?.releaseLock()}catch{}
  try{socket?.close()}catch{}
 }
}
