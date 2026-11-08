/**
 * PRIVATE service-bound egress Worker; never a public KB proxy.
 * The default HTTP fetch endpoint ALWAYS responds with 404.
 * Only RPC-capable Workers granted an explicit Cloudflare Service Binding
 * may invoke read-only KB OAuth/account/order inquiry. No order transmission.
 *
 * No KB app secrets are configured or stored in this Worker. Credentials
 * are supplied only over Cloudflare's private Service Binding RPC from the
 * authenticated, isolated proof Worker. Do not log RPC inputs or outputs.
 */
import {WorkerEntrypoint} from 'cloudflare:workers'
import {kbReadOnlyTlsRequest,type KbSocketReadRequest} from '../src/kbSocketReadOnly'
import {connect} from 'cloudflare:sockets'

export type EgressRootResult={status:'PASS'|'BLOCKED';httpStatus?:number;detail:string}

async function verifyRoot():Promise<EgressRootResult>{
 const deadline=Date.now()+8000
 let socket:ReturnType<typeof connect>|undefined
 let writer:WritableStreamDefaultWriter<Uint8Array>|undefined
 let reader:ReadableStreamDefaultReader<Uint8Array>|undefined
 let stage='CONNECT'
 const bounded=async<T>(promise:Promise<T>):Promise<T>=>{
  let timer:ReturnType<typeof setTimeout>|undefined
  try{
   const left=deadline-Date.now()
   if(left<=0)throw Error('TIMEOUT')
   return await Promise.race([promise,new Promise<T>((_,reject)=>{
    timer=setTimeout(()=>reject(Error('TIMEOUT')),left)
   })])
  }finally{if(timer!==undefined)clearTimeout(timer)}
 }
 try{
  socket=connect({hostname:'developer.kbsec.com',port:32484},{secureTransport:'on'})
  void socket.closed.catch(()=>{})
  await bounded(socket.opened)
  stage='WRITE'
  writer=socket.writable.getWriter()
  await bounded(writer.write(new TextEncoder().encode(
   'GET / HTTP/1.1\r\nHost: developer.kbsec.com\r\nConnection: close\r\n\r\n'
  )))
  writer.releaseLock();writer=undefined
  stage='READ'
  reader=socket.readable.getReader()
  let line=''
  for(let part=0;part<5&&line.length<250&&!line.includes('\r\n');part++){
   const item=await bounded(reader.read())
   if(item.done)break
   line+=new TextDecoder().decode(item.value.subarray(0,250-line.length))
  }
  const [protocol,code]=line.split('\r\n',1)[0].split(' ')
  if((protocol==='HTTP/1.1'||protocol==='HTTP/1.0')&&/^[1-5][0-9]{2}$/.test(code||''))
   return{status:'PASS',httpStatus:Number(code),detail:'ROOT_HTTP_RESPONSE'}
  return{status:'BLOCKED',detail:'ROOT_HTTP_STATUS_MISSING'}
 }catch(error){
  const timeout=error instanceof Error&&error.message==='TIMEOUT'
  return{status:'BLOCKED',detail:'ROOT_'+(timeout?'TIMEOUT_':'TRANSPORT_')+stage}
 }finally{
  try{reader?.releaseLock()}catch{}
  try{writer?.releaseLock()}catch{}
  try{socket?.close()}catch{}
 }
}

export default class KbPrivateEgress extends WorkerEntrypoint {
 // Even if someone accidentally enables a public route, this Worker never
 // provides credentials, proxy features or account data over HTTP.
 async fetch():Promise<Response>{
  return new Response('Not Found',{status:404,headers:{'Cache-Control':'no-store'}})
 }
 async readOnly(request:KbSocketReadRequest):Promise<{status:number;json:unknown;durationMs:number}>{
  return kbReadOnlyTlsRequest(request)
 }
 async rootProbe():Promise<EgressRootResult>{
  return verifyRoot()
 }
}
