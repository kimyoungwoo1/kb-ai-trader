import test from 'node:test'
import assert from 'node:assert/strict'
import { build } from 'esbuild'

const built=await build({entryPoints:['worker/src/notifications.ts'],bundle:true,platform:'node',format:'esm',write:false})
const {handleNotifications,publishNotification,isValidPushSubscription}=await import('data:text/javascript;base64,'+
  Buffer.from(built.outputFiles[0].contents).toString('base64'))
const mockDb=()=>{
  const inbox=[],subs=[]
  return {inbox,subs,
    prepare(sql){
      return {
        bind(...args){return {
          async run(){
            if(sql.startsWith('INSERT OR IGNORE INTO paper_notifications')){
              if(inbox.some(item=>item.event_key===args[0]))return {success:true,meta:{changes:0}}
              inbox.push({id:inbox.length+1,event_key:args[0],kind:args[1],title:args[2],body:args[3],created_at:args[4],read_at:null})
              return {success:true,meta:{changes:1}}
            }
            if(sql.startsWith('UPDATE paper_notifications SET read_at')){
              for(const row of inbox)if(row.read_at===null&&(args.length===1||row.id===args[1]))row.read_at=args[0]
              return {success:true}
            }
            throw Error('Unexpected SQL: '+sql)
          },
          async first(){return {n:0}},
        }},
        async all(){return {results:[...inbox].reverse()}},
        async first(){return {n:0}},
      }
    }
  }
}
test('deduplicates the same fill event and does not touch the trading ledger',async()=>{
  const db=mockDb()
  const event={eventKey:'fill:123',kind:'trade',title:'가상매수',body:'테스트 1주'}
  assert.equal(await publishNotification({PAPER_DB:db},event),true)
  assert.equal(await publishNotification({PAPER_DB:db},event),false)
  assert.equal(db.inbox.length,1)
})
test('notification API refuses unsupported actions and untrusted push endpoints',async()=>{
  const db=mockDb()
  const result=await handleNotifications({PAPER_DB:db},{action:'something'})
  assert.equal(result.status,400)
  assert.equal(isValidPushSubscription({endpoint:'http://127.0.0.1/push',keys:{auth:'1234567890123456',p256dh:'x'.repeat(80)}}),false)
  assert.equal(isValidPushSubscription({endpoint:'https://evil.example/push',keys:{auth:'1234567890123456',p256dh:'x'.repeat(80)}}),false)
})
test('mark all read never deletes the inbox',async()=>{
  const db=mockDb()
  await publishNotification({PAPER_DB:db},{eventKey:'test:1',kind:'test',title:'알림 테스트',body:'본문'})
  const response=await handleNotifications({PAPER_DB:db},{action:'read',id:0})
  assert.equal(response.status,200)
  assert.equal(db.inbox.length,1)
  assert.ok(db.inbox[0].read_at)
})
