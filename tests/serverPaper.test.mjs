import test from 'node:test'
import assert from 'node:assert/strict'
import { build } from 'esbuild'

const built = await build({ entryPoints:['worker/src/serverPaper.ts'], bundle:true, platform:'node', format:'esm',write:false })
const { serverPaperApi, serverPaperTick } = await import('data:text/javascript;base64,'+Buffer.from(built.outputFiles[0].contents).toString('base64'))
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
