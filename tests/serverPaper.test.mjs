import test from 'node:test'
import assert from 'node:assert/strict'
import { build } from 'esbuild'

const built = await build({ entryPoints:['worker/src/serverPaper.ts'], bundle:true, platform:'node', format:'esm',write:false })
const { serverPaperApi, serverPaperTick, KbWatchUnavailable } = await import('data:text/javascript;base64,'+Buffer.from(built.outputFiles[0].contents).toString('base64'))
const original = {
  format:1,savedAt:'2026-11-06T01:00:00.000Z',
  account:{enabled:true,cash:1000000,positions:[],pending:[],fills:[],runs:[],equityHistory:[],lastCycle:'',lastMessage:''},
  ledger:{cash:1000000,positions:[],trades:[]},screening:null,
}
const makeDb=()=>{
  let server=null, leaseUntil=0, updates=0
  return {
    get server(){return server},
    get updates(){return updates},
    setLease(v){leaseUntil=v},
    prepare(sql){
      return {
        async first(){
          if(sql.startsWith('SELECT revision, mode'))return server
          if(sql.startsWith('SELECT revision, snapshot_json'))return {revision:5,snapshot_json:JSON.stringify(original)}
          throw Error('Unexpected first '+sql)
        },
        bind(...params){
          return {
            async run(){
              if(sql.startsWith('INSERT OR IGNORE INTO server_paper_state')){
                if(server || leaseUntil>params[2] || params[3]!==5) return {success:true,meta:{changes:0}}
                server={revision:1,mode:'stopped',cycle_slot:-1,busy_until:0,updated_at:params[0],snapshot_json:params[1],last_error:null}
                return {success:true,meta:{changes:1}}
              }
              if(sql.startsWith('UPDATE server_paper_state SET revision=revision+1, mode=')){
                const [mode,at,snapshot,rev]=params
                if(!server||server.revision!==rev)return {success:true,meta:{changes:0}}
                server={...server,revision:rev+1,mode,updated_at:at,snapshot_json:snapshot,last_error:null}
                updates++
                return {success:true,meta:{changes:1}}
              }
              if(sql.includes('cycle_slot=?, busy_until=?')){
                const [slot,busy,rev,before,now]=params
                if(!server||server.mode!=='running'||server.revision!==rev||server.cycle_slot>=before||server.busy_until>=now) return {success:true,meta:{changes:0}}
                server={...server,revision:rev+1,cycle_slot:slot,busy_until:busy}
                updates++
                return {success:true,meta:{changes:1}}
              }
              if(sql.startsWith('UPDATE server_paper_state SET snapshot_json=?')){
                const [snapshot,at,error,rev,slot]=params
                if(!server||server.revision!==rev||server.cycle_slot!==slot)return {success:true,meta:{changes:0}}
                server={...server,snapshot_json:snapshot,updated_at:at,revision:rev+1,last_error:error,busy_until:sql.includes('busy_until=0')?0:server.busy_until}
                return {success:true,meta:{changes:1}}
              }
              if(sql.startsWith('UPDATE server_paper_state SET busy_until=0 WHERE')) {
                const [rev,slot]=params
                if(!server||server.revision!==rev||server.cycle_slot!==slot)return {meta:{changes:0}}
                server={...server,busy_until:0}
                return {meta:{changes:1}}
              }
              if(sql.includes('last_error=?, busy_until=0')){
                const [error,rev,slot]=params
                if(!server||server.revision!==rev||server.cycle_slot!==slot)return {success:true,meta:{changes:0}}
                server={...server,last_error:error,busy_until:0}
                updates++
                return {success:true,meta:{changes:1}}
              }
              throw Error('Unexpected run '+sql)
            },
          }
        },
      }
    },
  }
}
const parse=async response=>({status:response.status,data:await response.json()})
test('migration requires matching local/D1 trade signature and an expired browser lease',async()=>{
  const db=makeDb()
  assert.equal((await parse(await serverPaperApi(db,'migrate','wrong'))).status,409)
  db.setLease(Date.now()+90000)
  assert.equal((await parse(await serverPaperApi(db,'migrate','0::0:'))).status,409)
  db.setLease(0)
  const imported=await parse(await serverPaperApi(db,'migrate','0::0:'))
  assert.equal(imported.status,200)
  assert.equal(imported.data.mode,'stopped')
  assert.equal(imported.data.snapshot.ledger.cash,1000000)
  assert.equal(imported.data.snapshot.account.enabled,false)
  assert.equal((await parse(await serverPaperApi(db,'migrate','0::0:'))).data.revision,1)
})
test('conditional status omits the large journal when the revision has not changed',async()=>{
  const db=makeDb()
  await serverPaperApi(db,'migrate','0::0:')
  const full=await parse(await serverPaperApi(db,'status'))
  assert.equal(full.status,200)
  assert.equal(full.data.snapshot.ledger.cash,1000000)
  const smaller=await parse(await serverPaperApi(db,'status','',full.data.revision))
  assert.equal(smaller.data.unchanged,true)
  assert.equal(smaller.data.snapshot,undefined)
  assert.equal(smaller.data.revision,full.data.revision)
  await serverPaperApi(db,'start')
  const changed=await parse(await serverPaperApi(db,'status','',full.data.revision))
  assert.equal(changed.data.unchanged,undefined)
  assert.equal(changed.data.mode,'running')
  assert.equal(changed.data.snapshot.account.enabled,true)
})
test('heartbeat returns metadata without reading or serializing a paper snapshot',async()=>{
  const db=makeDb()
  await serverPaperApi(db,'migrate','0::0:')
  const heart=await parse(await serverPaperApi(db,'heartbeat'))
  assert.equal(heart.data.heartbeat,true)
  assert.equal(heart.data.migrated,true)
  assert.equal(heart.data.snapshot,undefined)
  assert.equal(heart.data.revision,1)
  await serverPaperApi(db,'start')
  const later=await parse(await serverPaperApi(db,'heartbeat'))
  assert.equal(later.data.mode,'running')
  assert.equal(later.data.revision,2)
})
test('start and stop are D1-authoritative and never erase prior trades',async()=>{
  const db=makeDb()
  await serverPaperApi(db,'migrate','0::0:')
  assert.equal((await parse(await serverPaperApi(db,'start'))).data.mode,'running')
  assert.equal((await parse(await serverPaperApi(db,'stop'))).data.mode,'stopped')
  assert.equal(db.server.revision,3)
  assert.equal(JSON.parse(db.server.snapshot_json).ledger.trades.length,0)
})
test('duplicate scheduled minute does not reserve or trade twice',async()=>{
  const db=makeDb()
  await serverPaperApi(db,'migrate','0::0:')
  await serverPaperApi(db,'start')
  const time=new Date('2026-11-06T01:20:00Z')
  let calls=0
  const fetcher=async()=>{calls++;throw Error('provider unavailable')}
  await serverPaperTick(db,fetcher,time)
  await serverPaperTick(db,fetcher,time)
  assert.equal(calls,1)
  assert.match(db.server.last_error,/provider unavailable/)
})
test('failed KB scan stops additional lookups and backs off across scheduled minutes',async()=>{
  const db=makeDb()
  await serverPaperApi(db,'migrate','0::0:')
  await serverPaperApi(db,'start')
  const calls=[]
  const post=async (path, body)=>{
    calls.push(path)
    if(path==='/api/market/discover')return {success:true,candidates:Array.from({length:25},(_,i)=>({code:String(100000+i),name:'Test'}))}
    if(path==='/api/market/investor-flow'){
      assert.equal(body.stocks.length,7)
      return {success:true,results:[{price:null}]}
    }
    throw Error('unexpected provider call')
  }
  const fail=await serverPaperTick(db,post,new Date('2026-11-06T01:20:00Z'))
  assert.equal(fail.result,'error')
  assert.match(fail.message,/유효한 가격 없음/)
  assert.deepEqual(calls,['/api/market/discover','/api/market/investor-flow'])
  const wait=await serverPaperTick(db,post,new Date('2026-11-06T01:21:00Z'))
  assert.equal(wait.result,'kb_cooldown')
  assert.equal(calls.length,2)
  const retried=await serverPaperTick(db,post,new Date('2026-11-06T01:22:00Z'))
  assert.equal(retried.result,'error')
  assert.deepEqual(calls,['/api/market/discover','/api/market/investor-flow','/api/market/investor-flow'])
  const secondCooldown=await serverPaperTick(db,post,new Date('2026-11-06T01:23:00Z'))
  assert.equal(secondCooldown.result,'kb_cooldown')
  assert.equal(calls.length,3)
})

test('a scan resumes after repeated KB 522 failures and a partial response',async()=>{
  const db=makeDb()
  await serverPaperApi(db,'migrate','0::0:')
  await serverPaperApi(db,'start')
  let reads=0
  const stock={code:'100000',name:'Test',price:5000}
  const missing={code:'100001',name:'Missing',price:5100}
  const post=async (path, body)=>{
    if(path==='/api/market/discover')return {success:true,candidates:[stock,missing]}
    if(path==='/api/market/investor-flow'){
      reads++
      if(reads<=2)throw new KbWatchUnavailable('KB 시세·수급 HTTP 522')
      if(reads===3)return {success:true,results:[stock,{...missing,investorError:'수급 응답 오류'}]}
      assert.deepEqual(body.stocks.map(item=>item.code),[missing.code])
      return {success:true,results:[missing]}
    }
    if(path==='/api/market/disclosures')return {success:true,complete:true,disclosures:[]}
    if(path==='/api/market/research')return {success:true,diagnostics:[{status:200,count:1}],articles:[]}
    throw Error('unexpected provider call '+path)
  }
  const tick=minute=>serverPaperTick(db,post,new Date('2026-11-06T01:'+minute+':00Z'))
  assert.equal((await tick(20)).result,'error')
  assert.equal((await tick(22)).result,'error')
  const partial=await tick(24)
  assert.match(partial.message,/신규 매수 보류/)
  assert.equal(partial.filled,0)
  assert.equal(partial.partial,true)
  assert.equal(JSON.parse(db.server.snapshot_json).screening,null)
  assert.equal((await tick(25)).result,'kb_cooldown')
  assert.equal((await tick(26)).result,'scanned')
  assert.equal(reads,4)
  assert.equal(JSON.parse(db.server.snapshot_json).screening.signals.length,2)
  assert.equal(JSON.parse(db.server.snapshot_json).scanProgress,undefined)
  assert.equal(db.server.last_error,null)
  assert.ok(JSON.parse(db.server.snapshot_json).screening.checkedAt)
})

test('a quote watch 522 does not delay the next scheduled full scan',async()=>{
  const db=makeDb()
  await serverPaperApi(db,'migrate','0::0:')
  await serverPaperApi(db,'start')
  const stock={code:'100000',name:'Test',price:5000}
  const snapshot=JSON.parse(db.server.snapshot_json)
  snapshot.account.pending=[stock]
  db.server.snapshot_json=JSON.stringify(snapshot)
  const calls=[]
  const post=async path=>{
    calls.push(path)
    if(path==='/api/kb/quotes')return {success:true,results:[{price:null,upstream_status:522}]}
    if(path==='/api/market/discover')return {success:true,candidates:[stock]}
    if(path==='/api/market/investor-flow')return {success:true,results:[stock]}
    if(path==='/api/market/disclosures')return {success:true,complete:true,disclosures:[]}
    if(path==='/api/market/research')return {success:true,diagnostics:[{status:200,count:1}],articles:[]}
    throw Error('unexpected provider call '+path)
  }
  const tick=minute=>serverPaperTick(db,post,new Date('2026-11-06T01:'+minute+':00Z'))
  assert.match((await tick(22)).message,/현재가 HTTP 522/)
  assert.equal((await tick(23)).result,'kb_cooldown')
  assert.match((await tick(24)).message,/현재가 HTTP 522/)
  assert.equal((await tick(25)).result,'scanned')
  assert.deepEqual(calls.slice(0,4),['/api/kb/quotes','/api/kb/quotes','/api/market/discover','/api/market/investor-flow'])
  assert.equal(db.server.last_error,null)
})

test('held-position sale commits before a failed scan and is emitted once',async ctx=>{
  const date=new Date('2026-11-06T01:20:00Z')
  ctx.mock.timers.enable({apis:['Date'],now:date})
  const db=makeDb()
  await serverPaperApi(db,'migrate','0::0:')
  await serverPaperApi(db,'start')
  const held={code:'100000',name:'Held',quantity:1,entry:5000,stop:4500,buyCost:0,openedAt:date.toISOString()}
  const snapshot=JSON.parse(db.server.snapshot_json)
  snapshot.account.positions=[held]
  snapshot.ledger.positions=[held]
  db.server.snapshot_json=JSON.stringify(snapshot)
  const calls=[]
  const post=async (path,body)=>{
    calls.push(path)
    if(path==='/api/kb/quotes')return {success:true,results:[{...held,price:4400,checked_at:date.toISOString()}]}
    if(path==='/api/market/discover')return {success:true,candidates:[{code:'100001',name:'Candidate'}]}
    if(path==='/api/market/investor-flow'){
      assert.equal(JSON.parse(db.server.snapshot_json).account.positions.length,0)
      throw new KbWatchUnavailable('KB 수급 타임아웃')
    }
    throw Error('unexpected '+path)
  }
  const outcome=await serverPaperTick(db,post,date)
  assert.equal(outcome.result,'error')
  assert.equal(outcome.filled,1)
  assert.equal(outcome.fills[0].side,'SELL')
  assert.equal(JSON.parse(db.server.snapshot_json).account.fills.length,1)
  assert.equal((await serverPaperTick(db,post,date)).result,'duplicate')
  assert.deepEqual(calls,['/api/kb/quotes','/api/market/discover','/api/market/investor-flow'])
})

test('the next minute can sell while the earlier market scan is waiting',async ctx=>{
  const date=new Date('2026-11-06T01:20:00Z')
  ctx.mock.timers.enable({apis:['Date'],now:date})
  const db=makeDb()
  await serverPaperApi(db,'migrate','0::0:')
  await serverPaperApi(db,'start')
  const held={code:'100000',name:'Held',quantity:1,entry:5000,stop:4500,buyCost:0,openedAt:date.toISOString()}
  const snapshot=JSON.parse(db.server.snapshot_json)
  snapshot.account.positions=[held]
  snapshot.ledger.positions=[held]
  db.server.snapshot_json=JSON.stringify(snapshot)
  let finishScan, signalScan
  const scanStarted=new Promise(resolve=>{signalScan=resolve})
  const pendingScan=new Promise(resolve=>{finishScan=resolve})
  const post=async path=>{
    if(path==='/api/kb/quotes')return {success:true,results:[{...held,price:Date.now()>date.getTime()?4400:4900,checked_at:new Date().toISOString()}]}
    if(path==='/api/market/discover')return {success:true,candidates:[{code:'100001',name:'Candidate'}]}
    if(path==='/api/market/investor-flow'){signalScan();return pendingScan}
    if(path==='/api/market/disclosures')return {success:true,complete:true,disclosures:[]}
    if(path==='/api/market/research')return {success:true,diagnostics:[{status:200,count:1}],articles:[]}
    throw Error('unexpected '+path)
  }
  const scan=serverPaperTick(db,post,date)
  await scanStarted
  ctx.mock.timers.setTime(date.getTime()+60_000)
  const watch=await serverPaperTick(db,post,new Date())
  assert.equal(watch.result,'watched')
  assert.equal(watch.filled,1)
  finishScan({success:true,results:[{code:'100001',name:'Candidate',price:5100}]})
  const result=await scan
  assert.equal(result.result,'scanned')
  assert.equal(result.filled,0)
  const saved=JSON.parse(db.server.snapshot_json)
  assert.equal(saved.account.fills.length,1)
  assert.equal(saved.account.positions.length,0)
  assert.equal(saved.scanLease,undefined)
})

test('scan can commit while the next watcher waits, then watcher uses latest ledger',async ctx=>{
  const date=new Date('2026-11-06T01:20:00Z')
  ctx.mock.timers.enable({apis:['Date'],now:date})
  const db=makeDb()
  await serverPaperApi(db,'migrate','0::0:')
  await serverPaperApi(db,'start')
  const held={code:'100000',name:'Held',quantity:1,entry:5000,stop:4500,buyCost:0,openedAt:date.toISOString()}
  const snapshot=JSON.parse(db.server.snapshot_json)
  snapshot.account.positions=[held]
  snapshot.ledger.positions=[held]
  db.server.snapshot_json=JSON.stringify(snapshot)
  let finishScan, signalScan
  const scanStarted=new Promise(resolve=>{signalScan=resolve})
  const pendingScan=new Promise(resolve=>{finishScan=resolve})
  const post=async path=>{
    if(path==='/api/kb/quotes')return {success:true,results:[{...held,price:Date.now()>date.getTime()?4400:4900,checked_at:new Date().toISOString()}]}
    if(path==='/api/market/discover')return {success:true,candidates:[{code:'100001',name:'Candidate'}]}
    if(path==='/api/market/investor-flow'){signalScan();return pendingScan}
    if(path==='/api/market/disclosures')return {success:true,complete:true,disclosures:[]}
    if(path==='/api/market/research')return {success:true,diagnostics:[{status:200,count:1}],articles:[]}
    throw Error('unexpected '+path)
  }
  const scan=serverPaperTick(db,post,date)
  await scanStarted
  ctx.mock.timers.setTime(date.getTime()+60_000)
  let startedWatch,finishWatch
  const watchStarted=new Promise(resolve=>{startedWatch=resolve})
  const watchQuote=new Promise(resolve=>{finishWatch=resolve})
  const watch=serverPaperTick(db,async path=>{
    assert.equal(path,'/api/kb/quotes')
    startedWatch()
    return watchQuote
  },new Date())
  await watchStarted
  finishScan({success:true,results:[{code:'100001',name:'Candidate',price:5100}]})
  const result=await scan
  assert.equal(result.result,'scanned')
  assert.equal(result.filled,0)
  ctx.mock.timers.setTime(date.getTime()+60_001)
  finishWatch({success:true,results:[{...held,price:4400,checked_at:new Date().toISOString()}]})
  const watched=await watch
  assert.equal(watched.result,'watched')
  assert.equal(watched.filled,1)
  const saved=JSON.parse(db.server.snapshot_json)
  assert.equal(saved.account.fills.length,1)
  assert.equal(saved.account.positions.length,0)
  assert.equal(saved.scanLease,undefined)
})

test('a resumed scan preserves the successful half of each stock read',async ctx=>{
  const date=new Date('2026-11-06T01:20:00Z')
  ctx.mock.timers.enable({apis:['Date'],now:date})
  const db=makeDb()
  await serverPaperApi(db,'migrate','0::0:')
  await serverPaperApi(db,'start')
  const a={code:'100000',name:'Quote succeeded'}
  const b={code:'100001',name:'Flow succeeded'}
  let reads=0
  const post=async (path,body)=>{
    if(path==='/api/market/discover')return {success:true,candidates:[a,b]}
    if(path==='/api/market/investor-flow'){
      if(++reads===1)return {success:true,partial:true,results:[
        {...a,price:5000,quote:{cur_prc:'5000'},quoteReceivedAt:date.getTime(),investorError:'timeout'},
        {...b,price:null,investor:{out:[]},investorReceivedAt:date.getTime(),quoteError:'timeout'},
      ]}
      const prior=new Map(body.stocks.map(stock=>[stock.code,stock.prior]))
      assert.equal(prior.get(a.code).quoteReceivedAt,date.getTime())
      assert.equal(prior.get(b.code).investorReceivedAt,date.getTime())
      return {success:true,results:[
        {...prior.get(a.code),investorError:'',investor:{out:[]},investorReceivedAt:Date.now()},
        {...prior.get(b.code),quoteError:'',price:5100,quote:{cur_prc:'5100'},quoteReceivedAt:Date.now()},
      ]}
    }
    if(path==='/api/market/disclosures')return {success:true,complete:true,disclosures:[]}
    if(path==='/api/market/research')return {success:true,diagnostics:[{status:200,count:1}],articles:[]}
    throw Error('unexpected provider call '+path)
  }
  assert.equal((await serverPaperTick(db,post,date)).partial,true)
  const resume=new Date(date.getTime()+120_000)
  ctx.mock.timers.setTime(resume.getTime())
  const outcome=await serverPaperTick(db,post,resume)
  assert.equal(outcome.result,'scanned')
  assert.equal(outcome.partial,false)
  assert.equal(JSON.parse(db.server.snapshot_json).screening.signals.length,2)
})
