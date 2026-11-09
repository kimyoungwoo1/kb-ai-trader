import test from 'node:test'
import assert from 'node:assert/strict'
import {build} from 'esbuild'
const built=await build({entryPoints:['worker/src/liveExecution.ts'],bundle:true,platform:'node',format:'esm',write:false})
const {cancelStaleLiveOrders,reconcileLiveOrders}=await import('data:text/javascript;base64,'+Buffer.from(built.outputFiles[0].contents).toString('base64'))
const ActualDate=globalThis.Date
const now=new ActualDate('2026-11-09T00:36:00Z')
const freeze=()=>{globalThis.Date=class extends ActualDate{
 constructor(...args){super(...(args.length?args:[now.getTime()]))}
 static now(){return now.getTime()}
};return ()=>{globalThis.Date=ActualDate}}
const env={KB_APP_KEY:'cancel-test-only',KB_APP_SECRET:'dummy',LIVE_TRADING_HARD_ENABLE:'ALLOW_REAL_10000_TRIAL_2026'}
const order=()=>({id:'trial-buy-sample',trading_day:'2026-11-09',side:'BUY',code:'005930',
 quantity:5,limit_price:9000,reserved_won:45450,state:'ACCEPTED',
 broker_order_id:'0060000705',filled_quantity:0,created_at:'2026-11-09T00:30:00Z',updated_at:'2026-11-09T00:30:00Z'})
class MemoryD1{
 constructor(){this.order=order();this.claim=null;this.failMark=false}
 prepare(sql){
  const db=this
  return {params:[],bind(...p){this.params=p;return this},
   async first(){
    if(sql.startsWith('SELECT enabled,trading_day'))return {enabled:1,trading_day:'2026-11-09'}
    if(sql.startsWith('SELECT status,cancel_order_no,broker_order_id FROM live_cancel_journal'))
     return db.claim
    throw Error('unexpected read '+sql)
   },
   async all(){
    if(sql.includes("state IN ('ACCEPTED','PARTIAL')")&&sql.includes('SELECT *'))
     return {results:['ACCEPTED','PARTIAL'].includes(db.order.state)&&
      !(db.claim&&sql.includes('NOT EXISTS'))?[db.order]:[]}
    if(sql.includes('SELECT * FROM live_order_journal WHERE state IN'))return {results:[db.order]}
    throw Error('unexpected list '+sql)
   },
   async run(){
    if(sql.includes('INSERT OR IGNORE INTO live_cancel_journal')){
     if(db.claim)return {meta:{changes:0}}
     db.claim={status:'CLAIMED',cancel_order_no:null,broker_order_id:this.params[3]};return {meta:{changes:1}}
    }
    if(sql.includes("SET state='CANCEL_REQUESTED'")){
     if(db.failMark)return {meta:{changes:0}}
     db.order.state='CANCEL_REQUESTED';return {meta:{changes:1}}
    }
    if(sql.includes('SET status=?,cancel_order_no=?')){
     db.claim.status=this.params[0];db.claim.cancel_order_no=this.params[1];return {meta:{changes:1}}
    }
    if(sql.includes("SET state='CANCELED'")){
     const [filled,,id,previousFilled,brokerNo]=this.params
     if(db.order.id!==id||db.order.state!=='CANCEL_REQUESTED'||
        db.order.filled_quantity!==previousFilled||db.order.broker_order_id!==brokerNo)
       return {meta:{changes:0}}
     db.order.state='CANCELED';db.order.filled_quantity=filled
     return {meta:{changes:1}}
    }
    if(sql.includes('SET state=?,filled_quantity=?')){
     db.order.state=this.params[0];db.order.filled_quantity=this.params[1];return {meta:{changes:1}}
    }
    throw Error('unexpected write '+sql)
   }
  }
 }
}
function broker({cancelFails=false,partial=0,completeCancel=false,canceledQuantity=5,cancelOriginal='0060000705',cancelNo='0060000706'}={}){
 const original=globalThis.fetch,calls=[]
 globalThis.fetch=async(url)=>{
  const path=String(url);calls.push(path)
  if(path.endsWith('/oauth2/token'))return Response.json({dataBody:{access_token:'token',expires_in:3600}})
  if(path.endsWith('/api/v1/ssqm2341'))return Response.json({dataHeader:{resultCode:'200',processFlag:'A'},
    dataBody:{nxt_key:'',Record1:completeCancel?[{
      ordr_no:cancelNo,orgn_ordr_no:cancelOriginal,stnd_is_no:'A005930',
      trd_dl_ccd_nm:'매수',ordr_q:String(canceledQuantity),tl_ccls_q:'0',
      nccls_q:'0',ordr_uprc:'0',crct_cncl_ccd:String(canceledQuantity)+'주취완'
    }]:[{ordr_no:'0060000705',stnd_is_no:'A005930',
      trd_dl_ccd_nm:'매수',ordr_q:'5',tl_ccls_q:String(partial),
      nccls_q:String(5-partial),ordr_uprc:'9000'}]}})
  if(path.endsWith('/api/v1/ssam1806')){
   if(cancelFails)throw Error('lost cancellation response')
   return Response.json({dataHeader:{resultCode:'200',processFlag:'A',processCode:'0014'},
    dataBody:{ordr_no:'0060000706'}})
  }
  throw Error('unexpected broker route')
 }
 return {calls,restore:()=>globalThis.fetch=original}
}
test('five-minute unfilled order gets exactly one cancellation and remains pending until verified',async()=>{
 const unfreeze=freeze(),b=broker(),db=new MemoryD1()
 try{
  const first=await cancelStaleLiveOrders(db,env,now)
  assert.equal(first.attempted,1)
  assert.equal(first.accepted,1)
  assert.equal(db.order.state,'CANCEL_REQUESTED')
  assert.equal(db.claim.status,'ACKNOWLEDGED')
  assert.equal(db.claim.cancel_order_no,'0060000706')
  const second=await cancelStaleLiveOrders(db,env,now)
  assert.equal(second.attempted,0)
  assert.equal(b.calls.filter(x=>x.endsWith('/api/v1/ssam1806')).length,1)
  const reconciled=await reconcileLiveOrders(db,env)
  assert.equal(reconciled.checked,1)
  assert.equal(db.order.state,'CANCEL_REQUESTED')
 }finally{b.restore();unfreeze()}
})
test('partial fill during cancel remains cancel pending, no duplicate cancel',async()=>{
 const unfreeze=freeze(),b=broker({partial:2}),db=new MemoryD1()
 try{
  assert.equal((await cancelStaleLiveOrders(db,env,now)).accepted,1)
  const status=await reconcileLiveOrders(db,env)
  assert.equal(status.updated,1)
  assert.equal(db.order.state,'CANCEL_REQUESTED')
  assert.equal(db.order.filled_quantity,2)
  assert.equal((await cancelStaleLiveOrders(db,env,now)).attempted,0)
 }finally{b.restore();unfreeze()}
})
test('lost cancellation ACK is UNKNOWN and never resubmits',async()=>{
 const unfreeze=freeze(),b=broker({cancelFails:true}),db=new MemoryD1()
 try{
  assert.equal((await cancelStaleLiveOrders(db,env,now)).unknown,1)
  assert.equal(db.claim.status,'UNKNOWN')
  assert.equal((await cancelStaleLiveOrders(db,env,now)).attempted,0)
  assert.equal(b.calls.filter(x=>x.endsWith('/api/v1/ssam1806')).length,1)
 }finally{b.restore();unfreeze()}
})
test('cannot send cancel unless order state is durably marked',async()=>{
 const unfreeze=freeze(),b=broker(),db=new MemoryD1()
 db.failMark=true
 try{
  assert.equal((await cancelStaleLiveOrders(db,env,now)).accepted,0)
  assert.equal(db.claim.status,'CLAIMED')
  const callsAfterClaim=b.calls.length
  assert.equal((await cancelStaleLiveOrders(db,env,now)).attempted,0)
  assert.equal(b.calls.length,callsAfterClaim,'A prior claim avoids another broker lookup')
  assert.equal(b.calls.filter(x=>x.endsWith('/api/v1/ssam1806')).length,0)
 }finally{b.restore();unfreeze()}
})
test('without hard lock flag, cancellation never contacts the broker',async()=>{
 const unfreeze=freeze(),b=broker(),db=new MemoryD1()
 try{
  assert.deepEqual(await cancelStaleLiveOrders(db,{KB_APP_KEY:'test'},now),{attempted:0,accepted:0,unknown:0,skipped:0})
  assert.equal(b.calls.length,0)
 }finally{b.restore();unfreeze()}
})

test('completed broker cancellation row closes remaining shares only after exact proof',async()=>{
 const unfreeze=freeze(),b=broker({completeCancel:true}),db=new MemoryD1()
 db.order.state='CANCEL_REQUESTED'
 db.claim={status:'ACKNOWLEDGED',cancel_order_no:'0060000706',broker_order_id:'0060000705'}
 try{
  const verified=await reconcileLiveOrders(db,env)
  assert.equal(verified.updated,1)
  assert.equal(db.order.state,'CANCELED')
  assert.equal(db.order.filled_quantity,0)
  assert.equal(b.calls.filter(x=>x.endsWith('/api/v1/ssam1806')).length,0)
  assert.equal((await cancelStaleLiveOrders(db,env,now)).attempted,0)
 }finally{b.restore();unfreeze()}
})
test('2 filled plus 3 verified canceled conserves shares and marks partial cancellation closed',async()=>{
 const unfreeze=freeze(),b=broker({completeCancel:true,canceledQuantity:3}),db=new MemoryD1()
 db.order.state='CANCEL_REQUESTED'
 db.order.filled_quantity=2
 db.claim={status:'ACKNOWLEDGED',cancel_order_no:'0060000706',broker_order_id:'0060000705'}
 try{
  const verified=await reconcileLiveOrders(db,env)
  assert.equal(verified.updated,1)
  assert.equal(db.order.state,'CANCELED')
  assert.equal(db.order.filled_quantity,2)
  assert.equal(b.calls.filter(x=>x.includes('/ssam')).length,0)
 }finally{b.restore();unfreeze()}
})
test('wrong linked original order number leaves cancel unconfirmed, never guesses finality',async()=>{
 const unfreeze=freeze(),b=broker({completeCancel:true,cancelOriginal:'0060000999'}),db=new MemoryD1()
 db.order.state='CANCEL_REQUESTED'
 db.claim={status:'ACKNOWLEDGED',cancel_order_no:'0060000706',broker_order_id:'0060000705'}
 try{
  const verified=await reconcileLiveOrders(db,env)
  assert.equal(verified.unresolved,1)
  assert.equal(db.order.state,'CANCEL_REQUESTED')
 }finally{b.restore();unfreeze()}
})
test('cancellation quantity mismatch does not mark CANCELED',async()=>{
 const unfreeze=freeze(),b=broker({completeCancel:true,canceledQuantity:4}),db=new MemoryD1()
 db.order.state='CANCEL_REQUESTED'
 db.claim={status:'ACKNOWLEDGED',cancel_order_no:'0060000706',broker_order_id:'0060000705'}
 try{
  const verified=await reconcileLiveOrders(db,env)
  assert.equal(verified.unresolved,1)
  assert.equal(db.order.state,'CANCEL_REQUESTED')
 }finally{b.restore();unfreeze()}
})
test('no cancel acknowledgment never treats a matching cancel row as final',async()=>{
 const unfreeze=freeze(),b=broker({completeCancel:true}),db=new MemoryD1()
 db.order.state='CANCEL_REQUESTED'
 db.claim={status:'UNKNOWN',cancel_order_no:null,broker_order_id:'0060000705'}
 try{
  const verified=await reconcileLiveOrders(db,env)
  assert.equal(verified.unresolved,1)
  assert.equal(db.order.state,'CANCEL_REQUESTED')
 }finally{b.restore();unfreeze()}
})
