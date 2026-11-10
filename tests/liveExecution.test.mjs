import test from 'node:test'
import assert from 'node:assert/strict'
import {build} from 'esbuild'
const bundle=await build({entryPoints:['worker/src/liveExecution.ts'],bundle:true,platform:'node',format:'esm',write:false})
const {getLiveGate,armLiveTrading,disarmLiveTrading,processLiveFill,reconcileLiveOrders,submitManualLimitBuy,diagnoseAutoBuy}=
  await import('data:text/javascript;base64,'+Buffer.from(bundle.outputFiles[0].contents).toString('base64'))
const REAL_DATE=globalThis.Date
const monday=new REAL_DATE('2026-11-09T00:30:00.000Z')
const holdClock=(at=monday)=>{
  globalThis.Date=class extends REAL_DATE{
    constructor(...args){super(...(args.length?args:[at.getTime()]))}
    static now(){return at.getTime()}
  }
  return ()=>{globalThis.Date=REAL_DATE}
}
const HARD='ALLOW_REAL_50000_TRIAL_2026'
const env=(key)=>({KB_APP_KEY:key,KB_APP_SECRET:'mock-only',LIVE_TRADING_HARD_ENABLE:HARD})
const stamp='2026-11-09T00:30:00.000Z'
const fill={id:'2026-11-09T00:30:00.000Z-buy-005930',at:stamp,code:'005930',side:'BUY',price:9000,quantity:1}
const activeStates=new Set(['RESERVED','SENDING','UNKNOWN','ACCEPTED','PARTIAL','CANCEL_REQUESTED'])
class Db {
  constructor(){this.gate={enabled:1,trading_day:'PERSISTENT_50000'};this.rows=[];this.actions=[]}
  prepare(sql){
    const self=this
    const operation={params:[],
      bind(...params){this.params=params;return this},
      async first(){
        if(sql.startsWith('SELECT enabled,trading_day'))return self.gate
        if(sql.includes('FROM server_paper_state'))return self.paper
        if(sql.includes("trading_day=? AND side='BUY'"))return {n:self.rows.filter(x=>x.trading_day===this.params[0]&&x.side==='BUY').length}
        if(sql.includes('FROM live_cancel_journal')&&sql.includes('COUNT(*)'))return {n:0}
        if(sql.includes('state IN')&&sql.includes('COUNT(*)'))return {n:self.rows.filter(x=>activeStates.has(x.state)).length}
        if(sql.includes('COUNT(DISTINCT code)'))return {n:new Set(self.rows.filter(x=>x.side==='BUY'&&!['REJECTED','CANCELED'].includes(x.state)).map(x=>x.code)).size}
        if(sql.includes('COALESCE(SUM(reserved_won)'))return {n:self.rows.filter(x=>x.side==='BUY'&&!['REJECTED','CANCELED'].includes(x.state)).reduce((n,x)=>n+x.reserved_won,0)}
        throw Error('Unhandled SQL first: '+sql)
      },
      async all(){
        if(sql.includes('SELECT * FROM live_order_journal'))return {results:self.rows.filter(x=>activeStates.has(x.state))}
        throw Error('Unhandled SQL all: '+sql)
      },
      async run(){
        self.actions.push(sql)
        if(sql.includes('INSERT INTO live_execution_gate')){
          self.gate=this.params.length===1?{enabled:0,trading_day:null}:{enabled:1,trading_day:this.params[0]}
          return {meta:{changes:1}}
        }
        if(sql.startsWith('INSERT OR IGNORE INTO live_order_journal')){
          const [id,day,code,quantity,price,reserved,created,,approval]=this.params
          const gateOk=sql.includes('enabled=0')?self.gate.enabled===0:self.gate.enabled===1&&self.gate.trading_day===approval
          if(!gateOk||self.rows.length)return {meta:{changes:0}}
          self.rows.push({id,trading_day:day,code,side:'BUY',quantity,limit_price:price,reserved_won:reserved,
            state:'RESERVED',broker_order_id:null,filled_quantity:0,created_at:created,updated_at:created})
          return {meta:{changes:1}}
        }
        if(sql.includes("SET state='SENDING'")){
          const [,id,day]=this.params
          const row=self.rows.find(x=>x.id===id&&x.state==='RESERVED')
          const gateOk=sql.includes('enabled=0')?self.gate.enabled===0:self.gate.enabled===1&&day===self.gate.trading_day
          if(!row||!gateOk)return {meta:{changes:0}}
          row.state='SENDING';return {meta:{changes:1}}
        }
        if(sql.includes('SET state=?,broker_order_id=?')){
          const [state,no,,id]=this.params
          const row=self.rows.find(x=>x.id===id&&x.state==='SENDING')
          if(!row)return {meta:{changes:0}}
          row.state=state;row.broker_order_id=no;return {meta:{changes:1}}
        }
        if(sql.includes('SET state=?,filled_quantity=?')){
          const [state,filled,,id,oldState,oldFilled,brokerNo]=this.params
          const row=self.rows.find(x=>x.id===id&&x.state===oldState&&x.filled_quantity===oldFilled&&x.broker_order_id===brokerNo)
          if(!row)return {meta:{changes:0}}
          row.state=state;row.filled_quantity=filled;return {meta:{changes:1}}
        }
        throw Error('Unhandled SQL run: '+sql)
      }
    }
    return operation
  }
}
function mockBroker(opts={loseAck:false}){
 const old=globalThis.fetch,seen=[]
 globalThis.fetch=async(url,options)=>{
  const path=String(url)
  seen.push(path)
  if(path.endsWith('/oauth2/token'))return Response.json({dataBody:{access_token:'mock-oauth',expires_in:3600}})
  if(path.endsWith('/api/v1/ssqm1802'))return Response.json({
    dataHeader:{resultCode:'200',processFlag:'A'},
    dataBody:{ordr_psbl_csh:'281959',mx_ordr_psbl_amt:'200000'}
  })
  if(path.endsWith('/api/v1/ssqm2952'))return Response.json({
    dataHeader:{resultCode:'200',processFlag:'A'},dataBody:{Record1:[]}
  })
  if(path.endsWith('/api/v1/ssqm1801'))return Response.json({
    dataHeader:{resultCode:'200',processFlag:'A'},dataBody:{Record1:[],nxt_key:''}
  })
  if(path.endsWith('/api/v1/ssam1802')){
    if(opts.loseAck)throw Error('simulated lost response')
    return Response.json({dataHeader:{resultCode:'200',processFlag:'A',processCode:'0005'},
      dataBody:{ordr_no:'0060000705'}})
  }
  if(path.endsWith('/api/v1/ssqm2341'))return Response.json({
    dataHeader:{resultCode:'200',processFlag:'A'},dataBody:{nxt_key:'',Record1:[{
      ordr_no:'0060000705',stnd_is_no:'A005930',trd_dl_ccd_nm:'매수',
      ordr_q:'1',tl_ccls_q:'1',nccls_q:'0',ordr_uprc:'9000'
    }]}
  })
  throw Error('Unknown mock endpoint: '+path)
 }
 return {seen,restore:()=>globalThis.fetch=old}
}
test('automatic buy diagnostics use account reads without reserving or submitting an order',async()=>{
 const db=new Db(),broker=mockBroker(),restoreClock=holdClock()
 db.paper={mode:'running',snapshot_json:JSON.stringify({screening:{
  checkedAt:stamp,signals:[{code:'005930',name:'테스트',price:9000}]
 }})}
 try{
  const result=await diagnoseAutoBuy(db,env('mock-auto-diagnostic'),monday)
  assert.equal(result.decision,'prechecks_passed')
  assert.equal(result.sample.quantity,1)
  assert.deepEqual(db.actions,[])
  assert.ok(broker.seen.some(url=>url.endsWith('/ssqm1801')))
  assert.ok(broker.seen.every(url=>!url.includes('/ssam')))
 }finally{broker.restore();restoreClock()}
})
test('production remains HARD LOCKED when execution flag is absent',async()=>{
 const db=new Db(),orig=globalThis.fetch
 let network=0
 globalThis.fetch=async()=>{network++;throw Error('must not call KB')}
 try{
  const gate=await getLiveGate(db,{KB_APP_KEY:'mock'},monday)
  assert.equal(gate.enabled,false)
  assert.equal(await processLiveFill(db,{KB_APP_KEY:'mock'},fill,monday),'locked')
  assert.equal(await armLiveTrading(db,{KB_APP_KEY:'mock'},'5만원 실주문 시작',monday),false)
  assert.equal(network,0)
  assert.equal(db.rows.length,0)
 }finally{globalThis.fetch=orig}
})
test('atomic D1 reservation/claim admits only one broker order across concurrent duplicate fills',async()=>{
 const revert=holdClock(),network=mockBroker(),db=new Db()
 try{
  const results=await Promise.all([processLiveFill(db,env('mock-concurrent'),fill,monday),
    processLiveFill(db,env('mock-concurrent'),fill,monday)])
  assert.equal(network.seen.filter(x=>x.endsWith('/api/v1/ssam1802')).length,1)
  assert.equal(db.rows.length,1)
  assert.ok(results.includes('accepted_not_filled'))
  assert.equal(db.rows[0].state,'ACCEPTED')
  assert.equal(db.rows[0].broker_order_id,'0060000705')
  const summary=await reconcileLiveOrders(db,env('mock-concurrent'))
  assert.equal(summary.updated,1)
  assert.equal(db.rows[0].state,'FILLED')
  assert.equal(db.rows[0].filled_quantity,1)
  assert.equal(network.seen.filter(x=>x.endsWith('/api/v1/ssam1802')).length,1)
 }finally{network.restore();revert()}
})
test('missing broker response permanently blocks automatic retry',async()=>{
 const revert=holdClock(),network=mockBroker({loseAck:true}),db=new Db()
 try{
  assert.equal(await processLiveFill(db,env('mock-lost-ack'),fill,monday),'unknown_order_result')
  assert.equal(db.rows[0].state,'UNKNOWN')
  assert.equal(await processLiveFill(db,env('mock-lost-ack'),fill,monday),'risk_blocked')
  assert.equal(network.seen.filter(x=>x.endsWith('/api/v1/ssam1802')).length,1)
  const state=await reconcileLiveOrders(db,env('mock-lost-ack'))
  assert.equal(state.unresolved,1)
  assert.equal(db.rows[0].state,'UNKNOWN')
 }finally{network.restore();revert()}
})
test('wrong confirmation or market closure blocks arming',async()=>{
 const db=new Db()
 assert.equal(await armLiveTrading(db,env('arm-key'),'wrong',monday),false)
 assert.equal(await armLiveTrading(db,env('arm-key'),'5만원 실주문 시작',new REAL_DATE('2026-11-08T23:00:00Z')),false)
 assert.equal(await disarmLiveTrading(db),true)
 assert.equal((await getLiveGate(db,env('arm-key'),monday)).enabled,false)
})

test('manual limit buys require auto OFF, share the daily claim and preserve confirmed quantity',async()=>{
 const revert=holdClock(),network=mockBroker(),db=new Db()
 const input={id:'4f835176-818a-4b7c-8f10-1b55beaa00ab',code:'005930',quantity:1,price:45000}
 const config=env('mock-manual-limit')
 try{
  assert.equal(await submitManualLimitBuy(db,config,input,monday),'manual_locked')
  assert.equal(network.seen.length,0)
  await disarmLiveTrading(db)
  assert.equal(await submitManualLimitBuy(db,config,{...input,price:49505},monday),'budget_exceeded')
  assert.equal(network.seen.length,0)
  const results=await Promise.all([
    submitManualLimitBuy(db,config,input,monday),
    submitManualLimitBuy(db,config,input,monday),
  ])
  assert.equal(results.filter(value=>value==='accepted_not_filled').length,1)
  assert.equal(network.seen.filter(url=>url.endsWith('/api/v1/ssam1802')).length,1)
  assert.equal(db.rows[0].quantity,1)
  assert.equal(db.rows[0].id,'manual-buy-'+input.id)
  assert.equal(db.gate.enabled,0)
 }finally{network.restore();revert()}
})

test('persistent approval waits outside regular hours and places an eligible next-day buy without rearming',async()=>{
 const tomorrow=new REAL_DATE('2026-11-10T00:35:00.000Z')
 const revert=holdClock(tomorrow),network=mockBroker(),db=new Db()
 const config=env('mock-persistent-approval')
 const closed=new REAL_DATE('2026-11-09T08:00:00.000Z')
 try{
  assert.equal((await getLiveGate(db,{...config,LIVE_TRADING_HARD_ENABLE:'ALLOW_REAL_10000_TRIAL_2026'},tomorrow)).armed,false)
  db.gate.trading_day='PERSISTENT'
  assert.equal((await getLiveGate(db,config,tomorrow)).armed,false,'legacy persistent approvals cannot enable 50k')
  db.gate.trading_day='2026-11-10'
  assert.equal((await getLiveGate(db,config,tomorrow)).armed,false,'legacy day approvals cannot enable 50k')
  assert.equal(await armLiveTrading(db,config,'실주문 시작',monday),false)
  assert.equal(await armLiveTrading(db,config,'5만원 실주문 시작',monday),true)
  assert.equal(db.gate.trading_day,'PERSISTENT_50000')
  assert.equal((await getLiveGate(db,config,closed)).armed,true)
  assert.equal((await getLiveGate(db,config,closed)).enabled,false)
  assert.equal((await getLiveGate(db,config,tomorrow)).enabled,true)
  assert.equal(await processLiveFill(db,config,{...fill,price:49504,quantity:9,at:tomorrow.toISOString()},tomorrow),'accepted_not_filled')
  assert.equal(db.rows[0].trading_day,'2026-11-10')
  assert.equal(db.rows[0].quantity,1)
  assert.equal(db.rows[0].reserved_won,50000)
  assert.equal(network.seen.filter(url=>url.endsWith('/api/v1/ssqm2341')).length,1)
  assert.equal(await disarmLiveTrading(db),true)
  assert.equal((await getLiveGate(db,config,tomorrow)).armed,false)
 }finally{network.restore();revert()}
})
