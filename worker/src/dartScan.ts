import {isKbGatewayFailure,isKbReadTransportFailure} from './kbAccountRead'

type Filing = {corp_name?:string;stock_code?:string;report_nm?:string;rcept_dt?:string;rcept_no?:string;flr_nm?:string;rm?:string}
type Page = {status?:string;total_count?:number;list?:Filing[]}
type Window = {filings:Filing[];total:number;error?:string}
type FetchPage = (url:string,init:RequestInit)=>Promise<Response>

let history:{key:string;range:string;expiresAt:number;value:Window}|undefined

export async function fetchDartScan(key:string,start:string,end:string,fetchPage:FetchPage){
 const yesterday = new Date(Date.UTC(+end.slice(0,4),+end.slice(4,6)-1,+end.slice(6,8)-1))
  .toISOString().slice(0,10).replaceAll('-','')
 const range = start+':'+yesterday
 const cached = history?.key===key && history.range===range && history.expiresAt>Date.now() ? history.value : undefined
 const deadline = Date.now()+45_000

 const readWindow = async (from:string,to:string):Promise<Window> => {
  const filings = new Map<string,Filing>()
  let total = 0
  let retry = true
  const read = async (page:number):Promise<{data?:Page;error?:string;transient?:boolean}> => {
   const budget = deadline-Date.now()
   if(budget<=0) return {error:'DART 조회 시간 한도 초과'}
   const params = new URLSearchParams({crtfc_key:key,bgn_de:from,end_de:to,page_count:'100',
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
  if(initial.data?.status==='013') return {filings:[],total}
  total = Number(initial.data?.total_count)
  if(!Number.isSafeInteger(total)||total<=0) return {filings:[],total:0,error:'DART 공시 건수 확인 실패'}
  const add = (data?:Page) => {
   if(!Array.isArray(data?.list)||Number(data.total_count)!==total) return false
   for(const item of data.list){
    if(typeof item?.rcept_no!=='string'||!item.rcept_no||filings.has(item.rcept_no)) return false
    filings.set(item.rcept_no,item)
   }
   return true
  }
  let error = add(initial.data) ? undefined : 'DART 공시 목록 불일치 (1페이지)'
  const pages = Math.min(30,Math.ceil(total/100))
  for(let startPage=2;!error&&startPage<=pages;startPage+=2){
   const batch = await Promise.all(Array.from({length:Math.min(2,pages-startPage+1)},(_,i)=>read(startPage+i)))
   for(const [index,page] of batch.entries()){
    const pageNo = startPage+index
    let result=page
    if(result.transient&&retry){retry=false;result=await read(pageNo)}
    if(result.error||!add(result.data)){error=(result.error||'DART 공시 목록 불일치')+' ('+pageNo+'페이지)';break}
   }
  }
  return {filings:[...filings.values()],total,error:error||(filings.size!==total?'DART 공시 수집 미완료':undefined)}
 }

 const [today,previous] = await Promise.all([
  readWindow(end,end),
  cached ?? readWindow(start,yesterday).then(value=>{
   if(!value.error) history={key,range,expiresAt:Date.now()+5*60_000,value}
   return value
  }),
 ])
 const paginationError = today.error ? end+' '+today.error : previous.error ? range+' '+previous.error : null
 return {combined:[...today.filings,...previous.filings],total:today.total+previous.total,paginationError}
}
