import {isKbGatewayFailure} from './kbAccountRead'
/**
 * UI-only KB account batch coordinator.
 * Coalesces refreshes within one Worker isolate. Holdings confirms KB is
 * reachable before launching valuation and deposit together.
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
 now=Date.now(), budgetMs=30_000):Promise<AccountBatchResult>{
 if(cache?.key===key&&now<cache.expires){
  return {...cache.result,cache_age_ms:Math.max(0,now-cache.savedAt)}
 }
 if(inflight?.key===key)return inflight.promise
 const task=(async()=>{
  const startedAt=Date.now()
  const results:Record<string,AccountBatchEntry>={}
  const controller=new AbortController()
  const deadlineAt=startedAt+budgetMs
  let timer:ReturnType<typeof setTimeout>|undefined
  const deadline=new Promise<null>(resolve=>{
   timer=setTimeout(()=>{
    resolve(null)
    controller.abort()
   },budgetMs)
  })
  const read=async(path:string):Promise<AccountBatchEntry|null>=>{
   try{return await Promise.race([fetchRoute(path,controller.signal),deadline])}
   catch{return {success:false,status:502,stage:'account_batch',
     error_type:'NETWORK',message:'계좌 조회 중 연결 오류'}}
  }
  const canRetry=()=>!controller.signal.aborted&&deadlineAt-Date.now()>=5_000
  const transient=(entry:AccountBatchEntry)=>!entry.success&&(isKbGatewayFailure(entry.http_status)||
   entry.error_type==='NETWORK'||entry.error_type==='TIMEOUT')
 const authOrLimit=(entry:AccountBatchEntry)=>entry.stage==='authentication'||
    [401,403,429].some(status=>status===entry.status||status===entry.http_status)
  try{
   const readEntry=async(path:string):Promise<AccountBatchEntry>=>(await read(path))??{
    success:false,status:504,stage:'account_batch_deadline',error_type:'TIMEOUT',
    message:'KB 응답이 계좌 조회 시간 한도를 초과했습니다.'
   }
   const [[holdingName,holdingPath],...otherRoutes]=routes
   const holdings=await readEntry(holdingPath)
   results[holdingName]=holdings
   if(transient(holdings)&&!authOrLimit(holdings)){
    const retry=canRetry()?await read(holdingPath):null
    if(retry&&(retry.success||authOrLimit(retry)))results[holdingName]=retry
   }
   if(transient(results[holdingName])||controller.signal.aborted){
    for(const [name] of otherRoutes)results[name]={
     success:false,status:503,stage:'account_upstream_unavailable',
     message:'KB 연결 지연으로 조회가 보류되었습니다.'
    }
   }else{
    await Promise.all(otherRoutes.map(async ([name,path])=>{results[name]=await readEntry(path)}))
   }
   const candidates=otherRoutes.filter(([name])=>transient(results[name]))
   if(candidates.length&&canRetry()&&!Object.values(results).some(authOrLimit)){
    // A single sequential probe avoids sending a second burst when KB is down.
    const [[name,path],...remaining]=candidates
    const probe=await read(path)
    if(probe?.success)results[name]=probe
    else if(probe&&authOrLimit(probe))results[name]=probe
    if(probe?.success&&canRetry()){
     await Promise.all(remaining.map(async ([name,path])=>{
      const result=await read(path)
      if(result&&(result.success||authOrLimit(result)))results[name]=result
     }))
    }
   }
  }finally{clearTimeout(timer)}
  const result:AccountBatchResult={success:true,results,checked_at:new Date().toISOString()}
  // Cache a consistent read-only UI snapshot for at most 10 seconds, or a
  // gateway failure for 15 seconds to prevent refresh storms. Never persist
  // potentially stale account data to D1.
  const anyFailed=Object.values(results).some(x=>!x.success)
  if(anyFailed){
   console.log(JSON.stringify({event:'kb_account_batch_incomplete',
    started_at:new Date(startedAt).toISOString(),duration_ms:Date.now()-startedAt,
    deadline_reached:controller.signal.aborted,
    statuses:Object.fromEntries(routes.map(([name])=>[name,results[name].status]))}))
  }
  cache={key,savedAt:Date.now(),expires:Date.now()+(anyFailed?15_000:10_000),result}
  return result
 })()
 inflight={key,promise:task}
 try{return await task}
 finally{if(inflight?.promise===task)inflight=null}
}
