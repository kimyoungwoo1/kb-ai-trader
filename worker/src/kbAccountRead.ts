/** KB account READ-ONLY transport. Never reuse for orders or cancels. */
export type SafeAccountResult =
 {success:true;status:number;data:unknown} |
 {success:false;status:number;issue:'NETWORK'|'TIMEOUT'|'NON_JSON'|'HTTP_ERROR';contentType:string;retried:boolean}
export async function readKbAccountJson(url:string,headers:Record<string,string>,body:unknown,signal?:AbortSignal):Promise<SafeAccountResult>{
 let retried=false
 for(let attempt=0;attempt<2;attempt++){
  let response:Response
  try{
   signal?.throwIfAborted()
   const timeout=AbortSignal.timeout(20000)
   response=await fetch(url,{method:'POST',headers,body:JSON.stringify(body),signal:signal?AbortSignal.any([signal,timeout]):timeout})
  }catch(error){
   const transient=error instanceof Error&&(error.name==='TimeoutError'||error.name==='AbortError'||error instanceof TypeError)
   if(attempt===0&&transient&&!signal?.aborted){retried=true;continue}
   return {success:false,status:0,issue:error instanceof Error&&error.name==='TimeoutError'?'TIMEOUT':'NETWORK',contentType:'',retried}
  }
  const contentType=(response.headers.get('content-type')||'').split(';')[0].trim().slice(0,60)
  // Some KB/WAF gateway failures return HTML instead of JSON, often with 502/503.
  // Retry only read-only upstream transport failures, never ambiguous 200 responses.
  if((response.status===502||response.status===503||response.status===504||response.status===522)&&attempt===0){
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
