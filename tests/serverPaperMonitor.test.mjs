import test from 'node:test'
import assert from 'node:assert/strict'
import { build } from 'esbuild'
import {readFileSync} from 'node:fs'

const bundled = await build({entryPoints:['worker/src/serverPaperMonitor.ts'],bundle:true,platform:'node',format:'esm',write:false})
const { isCronHealthy, paperCronPhase, runMonitoredPaperCron, readServerCronMonitor } = await import('data:text/javascript;base64,'+
  Buffer.from(bundled.outputFiles[0].contents).toString('base64'))

const createDb = () => {
  const runs = []
  return {
    runs,
    prepare(sql) {
      return {
        bind(...args) {
          return {
            async run() {
              if(sql.startsWith('INSERT INTO server_paper_cron_runs')) {
                runs.push({slot:args[0],started_at:args[1],finished_at:args[2],
                  result:args[3],message:args[4],scanned:args[5],filled:args[6]})
                return {success:true,meta:{changes:1}}
              }
              if(sql.startsWith('DELETE FROM server_paper_cron_runs'))return {success:true}
              throw Error('unexpected mutation: '+sql)
            },
            async first(){return {total:runs.length,completed:0,errors:0,skipped:runs.length}},
          }
        },
        async all(){return {results:[...runs].reverse()}},
        async first(){return null},
      }
    },
  }
}
test('Cron records a market-closed invocation without querying a brokerage provider',async()=>{
  const db = createDb()
  const date = new Date('2026-11-06T08:17:00.000Z') // Friday 17:17 KST
  let called=0
  const result = await runMonitoredPaperCron(db,async()=>{called++;throw Error('should not call')},date)
  assert.equal(result.result,'market_closed')
  assert.equal(called,0)
  assert.equal(db.runs.length,1)
  assert.equal(db.runs[0].result,'market_closed')
  const monitor=await readServerCronMonitor(db)
  assert.equal(monitor.last_tick.result,'market_closed')
  assert.equal(monitor.today.skipped,1)
})
test('Cron freshness check distinguishes recent successful heartbeat from stale or future timestamps',()=>{
  assert.equal(isCronHealthy('2026-11-06T08:16:00.000Z',Date.parse('2026-11-06T08:17:00.000Z')),true)
  assert.equal(isCronHealthy('2026-11-06T08:12:00.000Z',Date.parse('2026-11-06T08:17:00.000Z')),false)
  assert.equal(isCronHealthy('2026-11-06T08:18:00.000Z',Date.parse('2026-11-06T08:17:00.000Z')),false)
  assert.equal(isCronHealthy(null),false)
})

test('high-frequency heartbeat bypasses Cron monitor and full snapshot assembly',()=>{
 const worker=readFileSync('worker/src/index.ts','utf8')
 const paper=readFileSync('worker/src/serverPaper.ts','utf8')
 const client=readFileSync('src/App.tsx','utf8')
 const start=worker.indexOf('if (url.pathname === "/api/paper/server"')
 const finish=worker.indexOf('if (url.pathname === "/api/paper/backup"',start)
 assert.ok(start>=0&&finish>start)
 const route=worker.slice(start,finish)
 assert.match(route,/if \(action === 'status' && response\.ok && env\.PAPER_DB\)/)
 assert.doesNotMatch(route,/action === 'status' \|\| action === 'heartbeat'/)
 assert.match(paper,/if \(action === 'heartbeat'\) return ok\(\{ \.\.\.common, heartbeat:true \}\)/)
 assert.match(client,/\+\+polls % 4 === 0 \? 'status' : 'heartbeat'/)
})

test('Cron only monitors weekday sessions and runs a single scheduled close job',()=>{
 const check=(scheduled,actual=scheduled)=>paperCronPhase(new Date(scheduled),new Date(actual))
 assert.equal(check('2026-11-08T23:59:00Z'),'off')
 assert.equal(check('2026-11-09T00:00:00Z'),'market')
 assert.equal(check('2026-11-09T06:29:00Z'),'market')
 assert.equal(check('2026-11-09T06:29:00Z','2026-11-09T06:30:00Z'),'off')
 assert.equal(check('2026-11-09T06:30:00Z'),'off')
 assert.equal(check('2026-11-09T06:35:00Z','2026-11-09T06:36:00Z'),'close')
 assert.equal(check('2026-11-09T06:35:00Z','2026-11-10T06:36:00Z'),'off')
 assert.equal(check('2026-11-09T06:36:00Z'),'off')
 assert.equal(check('2026-11-14T06:35:00Z'),'off')
 assert.deepEqual(JSON.parse(readFileSync('worker/wrangler.jsonc','utf8')).triggers.crons,
  ['* 0-6 * * MON-FRI'])
})
