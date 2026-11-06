import test from 'node:test'
import assert from 'node:assert/strict'
import { build } from 'esbuild'
const load=async(entry)=>{const result=await build({entryPoints:[entry],bundle:true,platform:'node',format:'esm',write:false});return import('data:text/javascript;base64,'+Buffer.from(result.outputFiles[0].contents).toString('base64'))}
const {formatPaperFillNotification}=await load('worker/src/paperFillNotice.ts')
const {handleNotifications,readPushPreferences,publishNotification}=await load('worker/src/notifications.ts')
function fakeDB(){
 let settings=null
 const notices=[]
 return {notices,prepare(sql){
   return {
     bind(...args){return {
       async run(){
         if(sql.startsWith('INSERT INTO paper_notification_settings')){settings=args[0];return {meta:{changes:1}}}
         if(sql.startsWith('INSERT OR IGNORE INTO paper_notifications')){
           if(notices.find(n=>n.key===args[0]))return {meta:{changes:0}}
           notices.push({key:args[0],kind:args[1],body:args[3]});return {meta:{changes:1}}
         }
         throw Error('Unsupported SQL '+sql)
       },
       async first(){return null}
     }},
     async first(){if(sql.includes('settings_json'))return settings?{settings_json:settings}:null;return null},
     async all(){return {results:[]}}
   }
 }}
}
test('push settings default on and persist category switches without changing inbox history',async()=>{
 const db=fakeDB()
 assert.deepEqual(await readPushPreferences(db),{trade:true,error:true,recovery:true,daily:true,test:true})
 const saved=await handleNotifications({PAPER_DB:db},{action:'preferences',preferences:{trade:false,error:true,recovery:false,daily:true}})
 assert.equal(saved.status,200)
 const prefs=await readPushPreferences(db)
 assert.equal(prefs.trade,false)
 assert.equal(prefs.recovery,false)
 assert.equal(prefs.test,true)
 assert.equal(await publishNotification({PAPER_DB:db},{eventKey:'fill:custom1',kind:'trade',title:'Buy',body:'test'}),true)
 assert.equal(db.notices.length,1)
})
test('rejects malformed settings and ignores any attempt to disable connection test',async()=>{
 const db=fakeDB()
 assert.equal((await handleNotifications({PAPER_DB:db},{action:'preferences',preferences:{trade:'false',error:true,recovery:true,daily:true}})).status,400)
 assert.equal((await handleNotifications({PAPER_DB:db},{action:'preferences',preferences:{trade:true,error:true,recovery:true,daily:true,test:false}})).status,200)
 assert.equal((await readPushPreferences(db)).test,true)
})
test('virtual buy alert includes amount, cost, time and exact entry reason',()=>{
 const result=formatPaperFillNotification({id:'a',at:'2026-11-09T00:30:00.000Z',code:'005930',name:'삼성전자',side:'BUY',quantity:2,price:85000,costs:26,pnl:null,reason:'다음 시세에서 진입 참고값 돌파'})
 assert.match(result.title,/가상매수/)
 for(const value of ['005930','2주','85,000원','170,000원','다음 시세에서 진입 참고값 돌파','2026','실제 증권 주문 아님'])assert.ok(result.body.includes(value),value)
 assert.doesNotMatch(result.body,/실현손익/)
})
test('virtual sell alert includes signed realized P&L and exit reason',()=>{
 const result=formatPaperFillNotification({id:'b',at:'2026-11-09T01:00:00.000Z',code:'005930',name:'삼성전자',side:'SELL',quantity:2,price:87000,costs:340,pnl:3660,reason:'목표가 도달'})
 assert.match(result.title,/가상매도/)
 assert.match(result.body,/실현손익: \+3,660원/)
 assert.match(result.body,/목표가 도달/)
})
