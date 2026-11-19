import test from 'node:test'
import assert from 'node:assert/strict'
import {build} from 'esbuild'
const calls=[]
globalThis.liveStrategyCalls=calls
const bundle=await build({
 entryPoints:['worker/src/liveStrategy.ts'],bundle:true,platform:'node',format:'esm',write:false,
 plugins:[{name:'broker-test',setup(build){
  build.onResolve({filter:/\.\/liveExecution$/},()=>({path:'execution',namespace:'test'}))
  build.onResolve({filter:/\.\/liveTrial$/},()=>({path:'audit',namespace:'test'}))
  build.onLoad({filter:/.*/,namespace:'test'},args=>({contents:args.path==='execution'?
   `export const getLiveGate=async(db)=>({enabled:db.enabled});
    export const processLiveFill=async(db,env,fill)=>{globalThis.liveStrategyCalls.push(fill);return 'accepted'}`:
   'export const observePaperFill=async()=>{};export const recordLiveDecision=async()=>{}'}))
 }}],
})
const {runLiveStrategy}=await import('data:text/javascript;base64,'+Buffer.from(bundle.outputFiles[0].contents).toString('base64'))
const now=new Date()
const scanAt=new Date(now.getTime()-60_000).toISOString()
const candidate={code:'028670',name:'test',trigger:5140,scanAt}
const snapshot={account:{positions:[],fills:[]},liveScreening:{checkedAt:scanAt,candidates:[candidate]}}
const db={
 enabled:true,row:{mode:'running',snapshot_json:JSON.stringify(snapshot)},owned:[],
 prepare(){const self=this;return {async first(){return self.row},async all(){return {results:self.owned}}}},
}
test('live buys run without any paper fill and retain a separate signal identity',async()=>{
 calls.length=0
 await runLiveStrategy(db,{},async()=>({results:[{code:candidate.code,price:5150,checked_at:new Date().toISOString()}]}),now)
 assert.equal(calls.length,1)
 assert.equal(calls[0].side,'BUY')
 assert.equal(calls[0].quantity,1)
 assert.match(calls[0].id,/^live-entry-/)
})
test('a newer incomplete scan cancels an old live entry while the quote is pending',async()=>{
 calls.length=0
 db.row.snapshot_json=JSON.stringify(snapshot)
 await runLiveStrategy(db,{},async()=>{
  db.row.snapshot_json=JSON.stringify({...snapshot,liveScreening:undefined})
  return {results:[{code:candidate.code,price:5150,checked_at:new Date().toISOString()}]}
 },now)
 assert.equal(calls.length,0)
})
test('confirmed live holdings get exit quotes even when paper has no position or live candidates',async()=>{
 calls.length=0
 db.row.snapshot_json=JSON.stringify({account:{positions:[],fills:[]}})
 db.owned=[{code:'028670',limit_price:5000,filled_quantity:1,created_at:scanAt}]
 await runLiveStrategy(db,{},async()=>({results:[{code:'028670',price:5260,checked_at:new Date().toISOString()}]}),now)
 assert.equal(calls.length,1)
 assert.equal(calls[0].side,'SELL')
 assert.equal(calls[0].quantity,1)
 db.owned=[]
})
test('an unapproved gate performs no market reads or broker submission',async()=>{
 calls.length=0
 db.enabled=false
 await runLiveStrategy(db,{},async()=>{assert.fail('market read while locked')},now)
 assert.equal(calls.length,0)
})
