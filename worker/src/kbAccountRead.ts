/** KB account READ-ONLY transport. Never reuse for orders or cancels. */
export type SafeAccountResult =
 {success:true;status:number;data:unknown} |
 {success:false;status:number;issue:'NETWORK'|'TIMEOUT'|'NON_JSON'|'HTTP_ERROR';contentType:string;retried:boolean}
export const isKbGatewayFailure = (status?: number | null) =>
 [502,503,504,522,524].includes(status ?? 0)
export const isKbReadTransportFailure = (error: unknown) =>
 error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError' || error instanceof TypeError)

export async function readKbAccountJson(url:string,headers:Record<string,string>,body:unknown,signal?:AbortSignal, retryTransient=true):Promise<SafeAccountResult>{
 const requestId=crypto.randomUUID()
 let retried=false
 for(let attempt=0;attempt<2;attempt++){
  let response:Response
  try{
   signal?.throwIfAborted()
   const timeout=AbortSignal.timeout(20000)
   response=await fetchKbObserved(url,{method:'POST',headers,body:JSON.stringify(body),signal:signal?AbortSignal.any([signal,timeout]):timeout},{requestId,attempt:attempt+1})
  }catch(error){
   const transient=isKbReadTransportFailure(error)
   if(attempt===0&&retryTransient&&transient&&!signal?.aborted){retried=true;continue}
   return {success:false,status:0,issue:error instanceof Error&&error.name==='TimeoutError'?'TIMEOUT':'NETWORK',contentType:'',retried}
  }
  const contentType=(response.headers.get('content-type')||'').split(';')[0].trim().slice(0,60)
  // Some KB/WAF gateway failures return HTML instead of JSON, often with 502/503.
  // Retry only read-only upstream transport failures, never ambiguous 200 responses.
  if(isKbGatewayFailure(response.status)&&retryTransient&&attempt===0){
   retried=true
   await response.body?.cancel().catch(()=>{})
   continue
  }
  let data:unknown
  try{data=await response.json()}
  catch{return {success:false,status:response.status,issue:'NON_JSON',contentType,retried}}
  if(!response.ok)return {success:false,status:response.status,issue:'HTTP_ERROR',contentType,retried}
  return {success:true,status:response.status,data}
 }
 return {success:false,status:0,issue:'NETWORK',contentType:'',retried}
}

/** Log only fixed KB transport metadata. Never log headers, bodies or error messages. */
export async function fetchKbObserved(
 url:string, init:RequestInit, trace={requestId:crypto.randomUUID(),attempt:1}
):Promise<Response>{
 const parsed=new URL(url)
 if(parsed.hostname!=='developer.kbsec.com')return fetch(url,init)
 const path=/^\/oauth2\/token$|^\/api\/v1\/[a-z0-9]+$/.test(parsed.pathname)?parsed.pathname:'other'
 const start=Date.now()
 const base={event:'kb_upstream',request_id:trace.requestId,attempt:trace.attempt,
  started_at:new Date(start).toISOString(),path}
 const emit=(fields:Record<string,unknown>)=>{
  try{console.log(JSON.stringify({...base,...fields,duration_ms:Date.now()-start}))}catch{}
 }
 try{
  const response=await fetch(url,init)
  const ray=response.headers.get('cf-ray')||''
  emit({upstream_status:response.status,
   upstream_cf_ray:/^[a-fA-F0-9]{16,32}-[A-Z]{3}$/.test(ray)?ray:null,error:null})
  return response
 }catch(error){
  const name=error instanceof Error?error.name:''
  emit({upstream_status:null,upstream_cf_ray:null,
   error:['TimeoutError','AbortError','TypeError'].includes(name)?name:'TransportError'})
  throw error
 }
}
