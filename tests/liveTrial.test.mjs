import test from 'node:test'
import assert from 'node:assert/strict'
import { build } from 'esbuild'
const result=await build({entryPoints:['worker/src/liveTrial.ts'],bundle:true,platform:'node',format:'esm',write:false})
const {liveTrialApi,validateTrialCandidate,observePaperFill}=await import('data:text/javascript;base64,'+Buffer.from(result.outputFiles[0].contents).toString('base64'))
const now=new Date('2026-11-09T00:35:00.000Z')
const candidate=(overrides={})=>({eventId:'2026-11-09-buy-005930',code:'005930',name:'삼성전자',side:'BUY',quantity:1,limitPrice:9000,reason:'진입 조건',createdAt:now.toISOString(),...overrides})
function db(){
 const entries=[],settings=[]
 return {entries,settings,prepare(sql){
  return {
   bind(...params){return {async run(){
    if(sql.includes('live_trial_candidates')){
      const [tradingDay,eventId,code,name,quantity,price,notional,reason,createdAt]=params
      if(entries.some(e=>e.trading_day===tradingDay||e.event_id===eventId))return {meta:{changes:0}}
      entries.push({trading_day:tradingDay,event_id:eventId,code,name,quantity,price,notional,reason,createdAt})
      return {meta:{changes:1}}
    }
    if(sql.includes('live_trial_settings')){settings.push(params);return {meta:{changes:1}}}
    throw Error('Unexpected SQL '+sql)
   }}},
   async first(){return null},
   async all(){return {results:entries}}
  }
 }}
}
test('hard budget, single lot size and fresh KST market session',()=>{
 assert.equal(validateTrialCandidate(candidate(),now),null)
 assert.match(validateTrialCandidate(candidate({quantity:2}),now),/1만 원/)
 assert.match(validateTrialCandidate(candidate({limitPrice:10001}),now),/1만 원/)
 assert.match(validateTrialCandidate(candidate({limitPrice:9000.5}),now),/지정가/)
 assert.match(validateTrialCandidate(candidate({side:'SELL'}),now),/실매수/)
 assert.match(validateTrialCandidate(candidate({code:'INVALID'}),now),/종목코드/)
 assert.match(validateTrialCandidate(candidate({createdAt:'2026-11-08T23:20:00Z'}),now),/120초/)
 assert.match(validateTrialCandidate(candidate(),new Date('2026-11-08T23:00:00Z')),/정규장/)
})
test('user cannot arm, buy, sell, cancel or bypass locked real-trading mode',async()=>{
 const state=db()
 for(const action of ['enable','order','buy','sell','cancel']){
  const resp=await liveTrialApi(state,{action})
  assert.equal(resp.status,423)
  assert.equal((await resp.json()).enabled,false)
 }
 const status=await (await liveTrialApi(state,{action:'status'})).json()
 assert.equal(status.enabled,false)
 assert.equal(status.brokerOrdersVerified,false)
 assert.equal(status.limits.budget,10000)
 assert.equal(status.limits.maxDailyBuys,1)
})
test('audit only uses committed BUY fill, one unique candidate per day, never brokers',async()=>{
 const state=db()
 const fill={id:'2026-11-09-buy-005930',at:now.toISOString(),code:'005930',name:'삼성전자',side:'BUY',quantity:1,price:9000,reason:'진입 조건'}
 assert.equal(await observePaperFill(state,fill,now),true)
 assert.equal(await observePaperFill(state,fill,now),false)
 assert.equal(await observePaperFill(state,{...fill,id:'other',code:'000660'},now),false)
 assert.equal(await observePaperFill(state,{...fill,id:'over',price:20000},now),false)
 assert.equal(await observePaperFill(state,{...fill,side:'SELL'},now),false)
 assert.equal(state.entries.length,1)
 assert.equal(state.entries[0].notional,9000)
})
