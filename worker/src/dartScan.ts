import {isKbGatewayFailure,isKbReadTransportFailure} from './kbAccountRead'

type Filing = {corp_name?:string;stock_code?:string;report_nm?:string;rcept_dt?:string;rcept_no?:string;flr_nm?:string;rm?:string}
type Page = {status?:string;total_count?:number;list?:Filing[]}
type Window = {filings:Filing[];total:number;error?:string}
type FetchPage = (url:string,init:RequestInit)=>Promise<Response>

const pageSize = 100
const maxPages = 30
const cacheMs = 5 * 60_000

type Progress = {total:number;expiresAt:number;pages:Array<[number,Filing[]]>}
type ProgressDb = {
 prepare(sql:string): {bind(...values:unknown[]): {
  first<T>():Promise<T|null>;run():Promise<unknown>
 }}
}

let history:{key:string;range:string;expiresAt:number;value:Window}|undefined

export async function fetchDartScan(key:string,start:string,end:string,fetchPage:FetchPage,db?:ProgressDb){
 const yesterday = new Date(Date.UTC(+end.slice(0,4),+end.slice(4,6)-1,+end.slice(6,8)-1))
  .toISOString().slice(0,10).replaceAll('-','')
 const range = start+':'+yesterday
 const cached = history?.key===key && history.range===range && history.expiresAt>Date.now() ? history.value : undefined
 const startedAt = Date.now()
 const deadline = startedAt+45_000

 const readWindow = async (from:string,to:string):Promise<Window> => {
  const slot = from===to ? 'today' : 'history'
  const windowRange = from+':'+to
  const loadProgress = async ():Promise<Progress|null> => {
   try {
    const row = await db?.prepare('SELECT payload FROM dart_scan_progress WHERE slot=? AND window_range=?')
     .bind(slot,windowRange).first<{payload:string|null}>()
    const saved = row?.payload ? JSON.parse(row.payload) as Progress : null
    return saved && saved.expiresAt>startedAt ? saved : null
   } catch { return null }
  }
  const saveProgress = async (progress:Progress|null) => {
   try {
    await db?.prepare(`INSERT INTO dart_scan_progress(slot,window_range,scan_started_at,payload) VALUES(?,?,?,?)
     ON CONFLICT(slot) DO UPDATE SET window_range=excluded.window_range,
     scan_started_at=excluded.scan_started_at,payload=excluded.payload
     WHERE excluded.scan_started_at >= dart_scan_progress.scan_started_at`)
     .bind(slot,windowRange,startedAt,progress ? JSON.stringify(progress) : null).run()
   } catch { /* A storage failure must not interrupt disclosure verification. */ }
  }
  const progress = loadProgress()
  const pagesRead = new Map<number,Filing[]>()
  const receiptNumbers = new Set<string>()
  let total = 0
  let retry = true
  const read = async (page:number):Promise<{data?:Page;error?:string;transient?:boolean}> => {
   const budget = deadline-Date.now()
   if(budget<=0) return {error:'DART 조회 시간 한도 초과'}
   const params = new URLSearchParams({crtfc_key:key,bgn_de:from,end_de:to,page_count:String(pageSize),
    page_no:String(page),sort:'date',sort_mth:'desc'})
   try {
    const response = await fetchPage('https://opendart.fss.or.kr/api/list.json?'+params,{
     redirect:'manual',signal:AbortSignal.timeout(Math.min(8_000,budget)),
     headers:{Accept:'application/json','User-Agent':'curl/8.5.0',Referer:'https://opendart.fss.or.kr/'},
    })
    if(!response.ok){
     await response.body?.cancel().catch(()=>{})
     return {error:'DART HTTP '+response.status,transient:isKbGatewayFailure(response.status)}
    }
    const data = await response.json() as Page
    if(data?.status!=='000' && !(page===1 && data?.status==='013'))
     return {error:'DART 응답 '+(/^[0-9]{3}$/.test(data?.status??'')?data.status:'형식 오류')}
    return {data}
   } catch(error){
    return {error:'DART 연결 또는 응답 실패',transient:isKbReadTransportFailure(error)}
   }
  }
  let initial = await read(1)
  if(initial.transient){
   retry=false
   initial=await read(1)
  }
  if(initial.error) return {filings:[],total,error:initial.error+' (1페이지)'}
  const saved = await progress
  if(initial.data?.status==='013'){
   if(saved) await saveProgress(null)
   return {filings:[],total}
  }
  total = Number(initial.data?.total_count)
  if(!Number.isSafeInteger(total)||total<=0){
   if(saved) await saveProgress(null)
   return {filings:[],total:0,error:'DART 공시 건수 확인 실패'}
  }

  const pages = Math.min(maxPages,Math.ceil(total/pageSize))
  const accept = (page:number,list?:Filing[]) => {
   if(!Array.isArray(list)||list.length!==Math.min(pageSize,total-(page-1)*pageSize)) return false
   const ids = new Set<string>()
   for(const item of list){
    const id = item?.rcept_no
    if(typeof id!=='string'||!id||ids.has(id)||receiptNumbers.has(id)) return false
    ids.add(id)
   }
   for(const id of ids) receiptNumbers.add(id)
   pagesRead.set(page,list)
   return true
  }
  if(!accept(1,initial.data?.list)){
   if(saved) await saveProgress(null)
   return {filings:[],total,error:'DART 공시 목록 불일치 (1페이지)'}
  }

  const firstPage = initial.data?.list
  const reusing = saved?.total===total && JSON.stringify(saved.pages[0]?.[1])===JSON.stringify(firstPage)
  if(reusing){
   for(const [page,list] of saved.pages.slice(1)) accept(page,list)
  }
  const missing = Array.from({length:pages-1},(_,i)=>i+2).filter(page=>!pagesRead.has(page))
  let error: string|undefined
  let changed = false
  for(let i=0;i<missing.length&&Date.now()<deadline;i+=2){
   const batch = missing.slice(i,i+2)
   const results = await Promise.all(batch.map(read))
   for(const [index,pageNo] of batch.entries()){
    let result = results[index]
    if(result.transient&&retry){retry=false;result=await read(pageNo)}
    if(result.error){
     error ??= result.error+' ('+pageNo+'페이지)'
     continue
    }
    if(Number(result.data?.total_count)!==total || !accept(pageNo,result.data?.list)){
     changed = true
     error = 'DART 공시 목록 불일치 ('+pageNo+'페이지)'
    }
   }
  }
  const entries = [...pagesRead].sort(([a],[b])=>a-b)
  const filings = entries.flatMap(([,list])=>list)
  error ??= filings.length!==total ? 'DART 공시 수집 미완료' : undefined
  if(error && !changed && pagesRead.size<pages){
   await saveProgress({total,expiresAt:reusing?saved.expiresAt:startedAt+cacheMs,pages:entries})
  }else if(saved){
   await saveProgress(null)
  }
  return {filings,total,error}
 }

 const [today,previous] = await Promise.all([
  readWindow(end,end),
  cached ?? readWindow(start,yesterday).then(value=>{
   if(!value.error) history={key,range,expiresAt:Date.now()+cacheMs,value}
   return value
  }),
 ])
 const paginationError = today.error ? end+' '+today.error : previous.error ? range+' '+previous.error : null
 return {combined:[...today.filings,...previous.filings],total:today.total+previous.total,paginationError}
}
