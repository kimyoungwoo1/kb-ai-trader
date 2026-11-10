import {kbQuotePrice} from './kbQuotePrice'
/**
 * Isolated, single-purpose Cloudflare Worker version for real KB TLS checks.
 * This is never the production main module and must NEVER be traffic-switched.
 * GET/POST accounts/orders are NOT exposed; only one-time secret-protected
 * diagnostic POST to exact path. No D1, order writes, or account data output.
 */
import {kbReadOnlyTlsRequest} from './kbSocketReadOnly'
import {connect} from 'cloudflare:sockets'
import {getKbAccessToken,KbAuthError} from './kbToken'

type Env={
 DEPLOY_PROBE_TOKEN?:string;KB_APP_KEY?:string;KB_APP_SECRET?:string;
 KB_EGRESS?:{
  readOnly(input:Parameters<typeof kbReadOnlyTlsRequest>[0]):ReturnType<typeof kbReadOnlyTlsRequest>;
  rootProbe():Promise<SafeResult>;
 }
}
type SafeResult={status:'PASS'|'BLOCKED'|'SKIPPED';httpStatus?:number;resultCode?:string;processCode?:string;processFlag?:string;detail?:string}
// Compare outbound TLS from this exact Version URL isolate to the working
// disposable diagnostics Worker. Never read or send brokerage credentials.
async function rootConnectionCheck():Promise<SafeResult>{
 const deadline=Date.now()+6000
 let socket:ReturnType<typeof connect>|undefined
 let writer:WritableStreamDefaultWriter<Uint8Array>|undefined
 let reader:ReadableStreamDefaultReader<Uint8Array>|undefined
 let phase='CONNECT'
 const bounded=async<T>(job:Promise<T>):Promise<T>=>{
  let timer:ReturnType<typeof setTimeout>|undefined
  try{
   const time=deadline-Date.now()
   if(time<=0)throw Error('TIMEOUT')
   return await Promise.race([job,new Promise<T>((_,reject)=>{
    timer=setTimeout(()=>reject(Error('TIMEOUT')),time)
   })])
  }finally{if(timer!==undefined)clearTimeout(timer)}
 }
 try{
  socket=connect({hostname:'developer.kbsec.com',port:32484},{secureTransport:'on'})
  void socket.closed.catch(()=>{})
  await bounded(socket.opened)
  phase='WRITE'
  writer=socket.writable.getWriter()
  await bounded(writer.write(new TextEncoder().encode(
   'GET / HTTP/1.1\\r\\nHost: developer.kbsec.com\\r\\nConnection: close\\r\\n\\r\\n'
  )))
  writer.releaseLock();writer=undefined
  phase='READ'
  reader=socket.readable.getReader()
  let data=''
  for(let i=0;i<4&&data.length<500&&!data.includes('\\r\\n');i++){
   const part=await bounded(reader.read())
   if(part.done)break
   data+=new TextDecoder().decode(part.value.subarray(0,500-data.length))
  }
  const statusLine=data.split('\r\n',1)[0].split(' ')
  const valid=(statusLine[0]==='HTTP/1.0'||statusLine[0]==='HTTP/1.1')&&
   /^[1-5][0-9]{2}$/.test(statusLine[1]||'')
  return valid?{status:'PASS',httpStatus:Number(statusLine[1]),detail:'ROOT_HTTP_RESPONSE'}:
   {status:'BLOCKED',detail:'ROOT_HTTP_STATUS_MISSING'}
 }catch(error){
  const isTimeout=error instanceof Error&&error.message==='TIMEOUT'
  return {status:'BLOCKED',detail:'ROOT_'+(isTimeout?'TIMEOUT_':'TRANSPORT_')+phase}
 }finally{
  try{reader?.releaseLock()}catch{}
  try{writer?.releaseLock()}catch{}
  try{socket?.close()}catch{}
 }
}

const id=(value:unknown)=>typeof value==='string'&&/^[a-zA-Z0-9_-]{1,16}$/.test(value)?value:
 typeof value==='number'&&Number.isSafeInteger(value)&&value>=0&&value<1e12?String(value):'unavailable'
const classify=(error:unknown):string=>{
 const msg=error instanceof Error?error.message:''
 if(/^(KB_SOCKET|KB_WIRE)_[A-Z_]+$/.test(msg))return msg
 return 'KB_PROBE_UNKNOWN'
}
const passed=(reply:{status:number;json:unknown},requireArray=false):SafeResult=>{
 const root=reply.json as any
 const header=root?.dataHeader
 const resultCode=id(header?.resultCode),processCode=id(header?.processCode),
  processFlag=id(header?.processFlag)
 const businessOkay=reply.status===200&&resultCode==='200'&&processFlag==='A'
 if(!businessOkay)return {
  status:'BLOCKED',httpStatus:reply.status,resultCode,processCode,processFlag,
  detail:'KB_BUSINESS_NOT_ACCEPTED'
 }
 if(requireArray&&!Array.isArray(root?.dataBody?.Record1))return{
  status:'BLOCKED',httpStatus:reply.status,resultCode,processCode,processFlag,
  detail:'KB_RECORD1_NOT_ARRAY'
 }
 return{status:'PASS',httpStatus:reply.status,resultCode,processCode,processFlag}
}
const payload=(dataBody:object)=>({dataHeader:{
 ipAddr:'127.0.0.1',macAddr:'00:00:00:00:00:00'
},dataBody})
export async function runKbTlsProof(env:Env,now=new Date()):Promise<{
 mode:'ISOLATED_TLS_READ_ONLY';realOrderSent:false;ready:boolean;
 checks:Record<string,SafeResult>
}>{
 const checks:Record<string,SafeResult>={}
 // Service Binding RPC to the private egress Worker is optional only in this
 // proof build. Production OAuth/cache/orders do not import this module.
 const kbRead=(input:Parameters<typeof kbReadOnlyTlsRequest>[0])=>
  env.KB_EGRESS?env.KB_EGRESS.readOnly(input):kbReadOnlyTlsRequest(input)
 const done=()=>{
  // OAuth failure is a valid, completed diagnostic. Subsequent account
  // endpoints cannot run without a valid token, so mark them SKIPPED rather
  // than returning an incomplete result or fabricating PASS/BLOCKED evidence.
  for(const key of ['oauth','holdings','valuation','orderInquiry']){
   if(!checks[key])checks[key]={status:'SKIPPED',detail:'KB_OAUTH_NOT_READY'}
  }
  if(!checks.quote)checks.quote={status:'SKIPPED',detail:'KB_OAUTH_NOT_READY'}
  return {
   mode:'ISOLATED_TLS_READ_ONLY' as const,realOrderSent:false as const,
   ready:['oauth','quote','holdings','valuation','orderInquiry'].every(x=>checks[x].status==='PASS'),
   checks
  }
 }
 if(!env.KB_APP_KEY||!env.KB_APP_SECRET){
  checks.oauth={status:'BLOCKED',detail:'KB_CREDENTIALS_NOT_BOUND'}
  return done()
 }
 let token:string
 try{
  const auth=await kbRead({
   path:'/oauth2/token',body:payload({
    appKey:env.KB_APP_KEY,appSecret:env.KB_APP_SECRET,
    grantType:'client_credentials'
   }),timeoutMs:16000
  })
  const obj=auth.json as any
  const candidate=obj?.dataBody?.access_token
  if(auth.status!==200||typeof candidate!=='string'||candidate.length<1){
   checks.oauth={status:'BLOCKED',httpStatus:auth.status,
    resultCode:id(obj?.dataHeader?.resultCode),
    processCode:id(obj?.dataHeader?.processCode),
    processFlag:id(obj?.dataHeader?.processFlag),
    detail:'KB_TOKEN_NOT_ISSUED'}
   return done()
  }
  token=candidate
  checks.oauth={status:'PASS',httpStatus:auth.status,detail:'KB_TOKEN_RECEIVED_PRIVATE'}
 }catch(error){
  checks.oauth={status:'BLOCKED',detail:classify(error)}
  // The old standalone diagnostic Worker reached HTTP 404 on GET /.
  // Test the same harmless GET inside this specific isolated version only
  // if the OAuth TLS socket failed before any credential write.
  if(['KB_SOCKET_TIMEOUT_CONNECT','KB_SOCKET_TRANSPORT_CONNECT'].includes(checks.oauth.detail||'')){
   try{
    checks.networkRoot=env.KB_EGRESS?await env.KB_EGRESS.rootProbe():await rootConnectionCheck()
   }catch{
    checks.networkRoot={status:'BLOCKED',detail:'ROOT_RPC_UNAVAILABLE'}
   }
  }
  return done()
 }
 // Exercise the same quote endpoint and header as automatic monitoring.
 try{
  const reply=await kbRead({path:quotePath,body:quoteBody(),
   token,quoteAppKey:env.KB_APP_KEY,timeoutMs:9000})
  checks.quote=quoteResult(reply.status,reply.json)
 }catch(error){
  checks.quote={status:'BLOCKED',detail:classify(error)}
 }
 const kstDate=new Date(now.getTime()+9*3600_000)
 kstDate.setUTCHours(12,0,0,0)
 while(kstDate.getUTCDay()===0||kstDate.getUTCDay()===6)
  kstDate.setUTCDate(kstDate.getUTCDate()-1)
 const day=kstDate.toISOString().slice(0,10).replace(/-/g,'')
 // All requests are sequential, bounded and strictly from the socket
 // allowlist. Brokerage response bodies never leave this Worker.
 const queries=[
  ['holdings','/api/v1/ssqm1801',payload({mkt_tm_ccd:'1',nxt_key:'',inq_clsf:'0',is_no:''})],
  ['valuation','/api/v1/ssqm2952',payload({excg_mktpr_ccd:'A'})],
  ['orderInquiry','/api/v1/ssqm2341',payload({ccls_clsf:'0',nxt_key:'',ordr_dt:day})]
 ] as const
 for(const [key,path,body] of queries){
  try{
   const reply=await kbRead({path,body,token,timeoutMs:16000})
   checks[key]=passed(reply,key==='orderInquiry'||key==='holdings')
  }catch(error){
   checks[key]={status:'BLOCKED',detail:classify(error)}
  }
 }
 return done()
}
const quotePath='/api/v1/ivu10140'
const quoteBody=()=>payload({excg_clsf:'1',shrt_cd:'005930'})
function quoteResult(status:number,json:unknown):SafeResult{
 const data=json as any
 const resultCode=String(data?.dataHeader?.resultCode??'')
 const body=data?.dataBody
 const raw=kbQuotePrice(body)
 const price=Number(String(raw??'').replace(/,/g,''))
 const valid=status===200&&['','0','0000','200'].includes(resultCode)&&Number.isFinite(price)&&price>0
 return {status:valid?'PASS':'BLOCKED',httpStatus:status,
  detail:valid?'KB_QUOTE_PRICE_VALID':status===200?'KB_QUOTE_INVALID':'KB_QUOTE_HTTP_ERROR'}
}
export async function compareKbQuoteTransports(env:Env){
 const attempts: Array<SafeResult&{transport:'fetch'|'tls';durationMs:number}>=[]
 let token:string
 try{
  // Use the normal HTTP OAuth route for one shared token, even when socket OAuth cannot connect.
  token=await getKbAccessToken({KB_APP_KEY:env.KB_APP_KEY,KB_APP_SECRET:env.KB_APP_SECRET})
 }catch(error){
  return {oauth:{status:'BLOCKED',httpStatus:error instanceof KbAuthError?error.httpStatus:undefined},attempts}
 }
 for(const transport of ['fetch','tls','tls','fetch'] as const){
  const start=Date.now()
  let check:SafeResult
  try{
   if(transport==='fetch'){
    const response=await fetch('https://developer.kbsec.com:32484'+quotePath,{
     method:'POST',headers:{Authorization:'bearer '+token,appKey:env.KB_APP_KEY!,'Content-Type':'application/json'},
     body:JSON.stringify(quoteBody()),signal:AbortSignal.timeout(12_000),redirect:'error'
    })
    const data=response.ok?await response.json().catch(()=>null):null
    check=quoteResult(response.status,data)
   }else{
    const input={path:quotePath,body:quoteBody(),token,quoteAppKey:env.KB_APP_KEY,timeoutMs:12_000}
    const reply=await (env.KB_EGRESS?env.KB_EGRESS.readOnly(input):kbReadOnlyTlsRequest(input))
    check=quoteResult(reply.status,reply.json)
   }
  }catch(error){
   check={status:'BLOCKED',detail:transport==='tls'?classify(error):
    error instanceof Error&&['TimeoutError','AbortError'].includes(error.name)?'KB_FETCH_TIMEOUT':'KB_FETCH_CONNECTION_ERROR'}
  }
  attempts.push({...check,transport,durationMs:Date.now()-start})
  if(check.httpStatus===429)break
 }
 return {oauth:{status:'PASS'},attempts}
}
export default{
 async fetch(request:Request,env:Env):Promise<Response>{
  if(request.method!=='POST'||new URL(request.url).pathname!=='/api/deploy/tls-proof'||
    !env.DEPLOY_PROBE_TOKEN||request.headers.get('X-Deploy-Probe')!==env.DEPLOY_PROBE_TOKEN){
   return Response.json({success:false},{status:404})
  }
  if(request.headers.get('X-KB-Diagnostic')==='quote-compare'){
   return Response.json({success:true,mode:'ISOLATED_KB_QUOTE_COMPARE',realOrderSent:false,
    ...await compareKbQuoteTransports(env)},{headers:{'Cache-Control':'no-store'}})
  }
  const result=await runKbTlsProof(env)
  return Response.json({success:true,...result},{headers:{
   'Cache-Control':'no-store','X-Content-Type-Options':'nosniff'
  }})
 }
}
