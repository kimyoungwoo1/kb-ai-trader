/**
 * UI-only KB account batch coordinator.
 * Coalesces refreshes within one Worker isolate. A slow KB endpoint does not
 * delay the start of the others. Used only for dashboard reads.
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

export async function runAccountBatch(key:string,fetchRoute:(route:string,signal:AbortSignal)=>Promise<AccountBatchEntry>,
 now=Date.now(), budgetMs=40_000):Promise<AccountBatchResult>{
 if(cache?.key===key&&now<cache.expires){
  return {...cache.result,cache_age_ms:Math.max(0,now-cache.savedAt)}
 }
 if(inflight?.key===key)return inflight.promise
 const task=(async()=>{
  const results:Record<string,AccountBatchEntry>={}
  const controller=new AbortController()
  let timer:ReturnType<typeof setTimeout>|undefined
  const deadline=new Promise<null>(resolve=>{
   timer=setTimeout(()=>{
    resolve(null)
    controller.abort()
   },budgetMs)
  })
  try{
   await Promise.all(routes.map(async ([name,path])=>{
    try{
     const entry=await Promise.race([fetchRoute(path,controller.signal),deadline])
     results[name]=entry??{success:false,status:504,stage:'account_batch_deadline',
       error_type:'TIMEOUT',message:'KB 응답이 계좌 조회 시간 한도를 초과했습니다.'}
    }catch{
     results[name]={success:false,status:502,stage:'account_batch',
       error_type:'NETWORK',message:'계좌 조회 중 연결 오류'}
    }
   }))
  }finally{clearTimeout(timer)}
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
