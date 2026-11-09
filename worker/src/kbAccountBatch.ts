/**
 * UI-only KB account batch coordinator.
 * Avoids 3 simultaneous upstream sessions and duplicate refreshes within one
 * Worker isolate. Never consumed by order, execution, or risk verification.
 */
export type AccountBatchEntry={success:boolean;status:number;http_status?:number;error_type?:string;[key:string]:unknown}
export type AccountBatchResult={success:true;results:Record<string,AccountBatchEntry>;checked_at:string;cache_age_ms?:number}
type Route=['holdings'|'valuation'|'deposit',string]
const routes:Route[]=[
 ['holdings','/api/kb/holdings'],
 ['valuation','/api/kb/valuation'],
 ['deposit','/api/kb/deposit'],
]
let cache:{key:string;expires:number;savedAt:number;result:AccountBatchResult}|null=null
let inflight:{key:string;promise:Promise<AccountBatchResult>}|null=null

const originUnreachable=(r:AccountBatchEntry)=>(
 !r.success && (
   [502,503,504,522,524].includes(Number(r.http_status)) ||
   ['NETWORK','TIMEOUT'].includes(String(r.error_type||'')) ||
   (r.status===502 && String(r.stage||'')==='authentication')
 )
)
export async function runAccountBatch(key:string,fetchRoute:(route:string)=>Promise<AccountBatchEntry>,
 now=Date.now()):Promise<AccountBatchResult>{
 if(cache?.key===key&&now<cache.expires){
  return {...cache.result,cache_age_ms:Math.max(0,now-cache.savedAt)}
 }
 if(inflight?.key===key)return inflight.promise
 const task=(async()=>{
  const results:Record<string,AccountBatchEntry>={}
  let blocked=false
  for(const [name,path] of routes){
   if(blocked){
    results[name]={success:false,status:503,stage:'account_upstream_cooldown',
      message:'KB 연결 장애로 나머지 화면 조회를 보류했습니다.'}
    continue
   }
   try{
    results[name]=await fetchRoute(path)
   }catch{
    results[name]={success:false,status:502,stage:'account_batch',
      error_type:'NETWORK',message:'계좌 조회 중 연결 오류'}
   }
   // The gateway is already unreachable; avoid immediately opening two more
   // connections. No broker order is submitted from this code path.
   blocked=originUnreachable(results[name])
  }
  const result:AccountBatchResult={success:true,results,checked_at:new Date().toISOString()}
  // Cache a consistent read-only UI snapshot for at most 10 seconds, or a
  // gateway failure for 15 seconds to prevent refresh storms. Never persist
  // potentially stale account data to D1.
  const anyFailed=Object.values(results).some(x=>!x.success)
  cache={key,savedAt:Date.now(),expires:Date.now()+(anyFailed?15_000:10_000),result}
  return result
 })()
 inflight={key,promise:task}
 try{return await task}
 finally{if(inflight?.promise===task)inflight=null}
}
