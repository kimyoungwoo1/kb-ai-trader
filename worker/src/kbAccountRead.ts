/** KB account READ-ONLY transport. Never reuse for orders or cancels. */
export type SafeAccountResult =
 {success:true;status:number;data:unknown} |
 {success:false;status:number;issue:'NETWORK'|'TIMEOUT'|'NON_JSON'|'HTTP_ERROR';contentType:string;retried:boolean}
export const isKbGatewayFailure = (status?: number | null) =>
 [502,503,504,522,524].includes(status ?? 0)
export const isKbReadTransportFailure = (error: unknown) =>
 error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError' || error instanceof TypeError)

export type AccountReadFetch = typeof fetchKbObserved

export async function readKbAccountJson(url:string,headers:Record<string,string>,body:unknown,signal?:AbortSignal, retryTransient=true, fetchRead:AccountReadFetch=fetchKbObserved):Promise<SafeAccountResult>{
 const requestId=crypto.randomUUID()
 let retried=false
 for(let attempt=0;attempt<2;attempt++){
  let response:Response
  try{
   signal?.throwIfAborted()
   const timeout=AbortSignal.timeout(20000)
   response=await fetchRead(url,{method:'POST',headers,body:JSON.stringify(body),signal:signal?AbortSignal.any([signal,timeout]):timeout},{requestId,attempt:attempt+1})
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
   error:error instanceof Error && /too many subrequests|subrequest limit/i.test(error.message)
     ? 'SubrequestLimit' : ['TimeoutError','AbortError','TypeError'].includes(name)?name:'TransportError'})
  throw error
 }
}

const accountReadPaths = new Set(['/api/v1/ssqm1801','/api/v1/ssqm2952','/api/v1/ssqm0004','/api/v1/ssqm1802'])
export const isKbAccountReadPath = (path: string) => accountReadPaths.has(path)
export type KbAccountEgress = {KB_MARKET_EGRESS?: MarketEgress}

export type MarketEgress = { fetch(request: Request): Promise<Response> }
type QuoteTrace = { requestId: string; attempt: number }
export const marketRead = async (
  endpoint: string, init: RequestInit, trace: QuoteTrace, timeoutMs: number, egress?: MarketEgress,
  bindingGraceMs = 0
) => {
  const url = new URL(endpoint)
  const usePrivate = !!egress && trace.attempt === 1 && url.origin === 'https://developer.kbsec.com:32484'
  const timeout = AbortSignal.timeout(timeoutMs + (usePrivate ? bindingGraceMs : 0))
  const signal = init.signal ? AbortSignal.any([init.signal, timeout]) : timeout
  if (!usePrivate) {
    if (egress) console.log(JSON.stringify({event:'kb_market_route',request_id:trace.requestId,
      attempt:trace.attempt,route:'direct',path:url.pathname}))
    return fetchKbObserved(endpoint, {...init,signal},trace)
  }
  console.log(JSON.stringify({event:'kb_market_route',request_id:trace.requestId,
    attempt:trace.attempt,route:'private-worker',path:url.pathname}))
  const headers = new Headers(init.headers)
  headers.set('X-KB-Request-ID',trace.requestId)
  headers.set('X-KB-Attempt',String(trace.attempt))
  headers.set('X-KB-Timeout',String(timeoutMs))
  const startedAt = Date.now()
  const report = (stage: 'kb_upstream' | 'service_binding' | 'unclassified', outcome: string, status: number | null) => {
    console.log(JSON.stringify({event:'kb_market_result',request_id:trace.requestId,
      attempt:trace.attempt,route:'private-worker',path:url.pathname,stage,outcome,
      http_status:status,duration_ms:Date.now()-startedAt}))
  }
  let response: Response
  try {
    response = await egress.fetch(new Request('https://market-egress.internal'+url.pathname,{...init,headers,signal}))
  } catch (error) {
    const timeoutError = timeout.aborted || (error instanceof Error && error.name === 'TimeoutError')
    report('service_binding', init.signal?.aborted ? 'cancelled' : timeoutError ? 'timeout' : 'error', null)
    throw new TypeError('KB market egress binding failed')
  }
  const failure = response.headers.get('X-KB-Egress-Error')
  if (response.status === 502 && failure === 'timeout') {
    report('kb_upstream','timeout',null)
    throw new DOMException('KB market egress timeout','TimeoutError')
  }
  if (response.status === 502 && failure === 'transport') {
    report('kb_upstream','transport_error',null)
    throw new TypeError('KB market egress transport failed')
  }
  // Either hop can produce these statuses without an origin marker.
  report([400,404].includes(response.status) ? 'unclassified' : 'kb_upstream',
    'http_response',response.status)
  return response
}

// Route only explicitly permitted, read-only account APIs through the private Worker.
export const accountRead = (egress?: MarketEgress): typeof fetchKbObserved | undefined => {
  if (!egress) return undefined
  return async (endpoint, init, trace = {requestId:crypto.randomUUID(),attempt:1}) => {
    const url = new URL(endpoint)
    if (url.origin !== 'https://developer.kbsec.com:32484' || init.method !== 'POST' || !isKbAccountReadPath(url.pathname))
      return fetchKbObserved(endpoint, init, trace)
    try {
      const response = await marketRead(endpoint, {...init, redirect:'manual'}, { ...trace, attempt:1 }, 6000, egress, 750)
      if (!isKbGatewayFailure(response.status) && response.status !== 404)
        return response
      await response.body?.cancel().catch(()=>{})
    } catch (error) {
      if (!isKbReadTransportFailure(error)) throw error
    }
    init.signal?.throwIfAborted()
    return fetchKbObserved(endpoint, {...init,redirect:'manual'}, {...trace,attempt:2})
  }
}

