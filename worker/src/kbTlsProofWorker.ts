/**
 * Isolated, single-purpose Cloudflare Worker version for real KB TLS checks.
 * This is never the production main module and must NEVER be traffic-switched.
 * GET/POST accounts/orders are NOT exposed; only one-time secret-protected
 * diagnostic POST to exact path. No D1, order writes, or account data output.
 */
import {kbReadOnlyTlsRequest} from './kbSocketReadOnly'

type Env={
 DEPLOY_PROBE_TOKEN?:string;KB_APP_KEY?:string;KB_APP_SECRET?:string
}
type SafeResult={status:'PASS'|'BLOCKED'|'SKIPPED';httpStatus?:number;resultCode?:string;processCode?:string;processFlag?:string;detail?:string}
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
 const done=()=>{
  // OAuth failure is a valid, completed diagnostic. Subsequent account
  // endpoints cannot run without a valid token, so mark them SKIPPED rather
  // than returning an incomplete result or fabricating PASS/BLOCKED evidence.
  for(const key of ['oauth','holdings','valuation','orderInquiry']){
   if(!checks[key])checks[key]={status:'SKIPPED',detail:'KB_OAUTH_NOT_READY'}
  }
  return {
   mode:'ISOLATED_TLS_READ_ONLY' as const,realOrderSent:false as const,
   ready:['oauth','holdings','valuation','orderInquiry'].every(x=>checks[x].status==='PASS'),
   checks
  }
 }
 if(!env.KB_APP_KEY||!env.KB_APP_SECRET){
  checks.oauth={status:'BLOCKED',detail:'KB_CREDENTIALS_NOT_BOUND'}
  return done()
 }
 let token:string
 try{
  const auth=await kbReadOnlyTlsRequest({
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
  return done()
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
   const reply=await kbReadOnlyTlsRequest({path,body,token,timeoutMs:16000})
   checks[key]=passed(reply,key==='orderInquiry'||key==='holdings')
  }catch(error){
   checks[key]={status:'BLOCKED',detail:classify(error)}
  }
 }
 return done()
}
export default{
 async fetch(request:Request,env:Env):Promise<Response>{
  if(request.method!=='POST'||new URL(request.url).pathname!=='/api/deploy/tls-proof'||
    !env.DEPLOY_PROBE_TOKEN||request.headers.get('X-Deploy-Probe')!==env.DEPLOY_PROBE_TOKEN){
   return Response.json({success:false},{status:404})
  }
  const result=await runKbTlsProof(env)
  return Response.json({success:true,...result},{headers:{
   'Cache-Control':'no-store','X-Content-Type-Options':'nosniff'
  }})
 }
}
