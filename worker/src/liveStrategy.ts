import {getLiveGate,processLiveFill,type LiveEnv,type LiveFill} from './liveExecution'
import {observePaperFill,recordLiveDecision} from './liveTrial'
import {liveEntry,type Pending,type Quote} from './liveCandidates'
type Post = (path:string,body:unknown)=>Promise<any>

/** The live strategy consumes verified screening directly and owns its entry watch.
 * Broker submission remains behind the existing account checks and atomic claim.
 */
export async function runLiveStrategy(db:any,env:LiveEnv,post:Post,now=new Date()){
 if(!db||!(await getLiveGate(db,env,now)).enabled)return
 const row=await db.prepare('SELECT mode,snapshot_json FROM server_paper_state WHERE id=1').first()
 if(row?.mode!=='running')return
 const snapshot=JSON.parse(row.snapshot_json)
 const owned=await db.prepare(`SELECT code,limit_price,filled_quantity,created_at FROM live_order_journal
  WHERE side='BUY' AND id NOT LIKE 'manual-buy-%' AND filled_quantity>0
  AND state IN ('FILLED','CANCELED') AND NOT EXISTS(
   SELECT 1 FROM live_order_journal sell WHERE sell.side='SELL' AND sell.code=live_order_journal.code)`).all()

 // Confirmed pilot holdings receive exit monitoring independently of paper positions.
 for(const holding of owned.results??[]){
  const response=await post('/api/kb/quotes',{stocks:[{code:holding.code}]})
  const quote:Quote|undefined=response.results?.find((item:Quote)=>item.code===holding.code)
  const checked=Date.parse(quote?.checked_at??'')
  if(!quote||quote.error||!Number.isFinite(checked)||Date.now()-checked<0||Date.now()-checked>30_000||
   !Number.isSafeInteger(quote.price)||quote.price!<=0)continue
  const basis=Number(holding.limit_price)
  const age=now.getTime()-Date.parse(holding.created_at)
  if(!Number.isSafeInteger(basis)||basis<=0||!Number.isFinite(age)||age<0)continue
  if(quote.price!<basis*1.05&&quote.price!>basis*0.97&&age<15*24*3600_000)continue
  const fill:LiveFill={id:'live-exit-'+holding.code+'-'+Date.parse(holding.created_at),code:holding.code,
   side:'SELL',price:quote.price!,quantity:Number(holding.filled_quantity),at:quote.checked_at}
  const decision=await processLiveFill(db,env,fill)
  await recordLiveDecision(db,fill,decision)
 }
 const scan=snapshot.liveScreening
 if(!scan||!Array.isArray(scan.candidates))return
 const created=Date.parse(scan.checkedAt)
 if(!Number.isFinite(created)||now.getTime()-created<0||now.getTime()-created>180_000)return
 const candidates:Pending[]=scan.candidates.slice(0,5)
 if(!candidates.length)return
 const response=await post('/api/kb/quotes',{stocks:candidates.map(item=>({code:item.code,name:item.name}))})
 const latest=await db.prepare('SELECT mode,snapshot_json FROM server_paper_state WHERE id=1').first()
 if(latest?.mode!=='running')return
 const current=JSON.parse(latest.snapshot_json).liveScreening
 if(current?.checkedAt!==scan.checkedAt || JSON.stringify(current.candidates)!==JSON.stringify(candidates))return
 for(const candidate of candidates){
  const quote=response.results?.find((item:Quote)=>item.code===candidate.code)
  if(!quote)continue
  const fill=liveEntry(candidate,quote,new Date())
  if(!fill)continue
  await observePaperFill(db,{...fill,name:candidate.name,reason:'실계좌 독립 진입 조건 충족'})
  const decision=await processLiveFill(db,env,fill)
  await recordLiveDecision(db,fill,decision)
  // An ambiguous or accepted request must be reconciled before considering another symbol.
  if(!['budget_exceeded','already_held_in_real_account'].includes(decision))break
 }
}
