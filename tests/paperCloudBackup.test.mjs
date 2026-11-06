import test from 'node:test'
import assert from 'node:assert/strict'
import { build } from 'esbuild'

const built = await build({ entryPoints: ['worker/src/paperBackup.ts'],
  bundle: true, platform: 'node', format: 'esm', write: false })
const { handlePaperBackup, validatePaperBackup } = await import(
  'data:text/javascript;base64,' + Buffer.from(built.outputFiles[0].contents).toString('base64'))
const snapshot = () => ({
  format: 1, savedAt: '2026-11-06T08:00:00Z',
  ledger: { cash: 980000,
    positions: [{ code: '005930', name: '삼성전자', quantity: 2,
      averagePrice: 10000, lastPrice: 10100 }],
    trades: [{ id: 'buy-1', time: '2026-11-06T05:00:00Z',
      side: 'BUY', code: '005930', name: '삼성전자',
      quantity: 2, price: 10000, amount: 20000, source: 'auto' }] },
  account: { enabled: true, cash: 980000,
    positions: [{ code: '005930', name: '삼성전자', quantity: 2,
      entry: 10000, last: 10100, stop: 9700, target: 10500 }],
    pending: [], fills: [{ code: '005930', name: '삼성전자',
      id: 'buy-1', at: '2026-11-06T05:00:00Z', side: 'BUY',
      quantity: 2, price: 10000, costs: 2, pnl: null }],
    runs: [], equityHistory: [], lastCycle: '', lastMessage: '기록됨' },
  screening: null,
})
function fakeD1() {
  let current = null
  const history = []
  const prepare = sql => ({
    bind: (...args) => ({
      first: async () => {
        if (!sql.startsWith('SELECT revision')) throw Error('unrecognized SELECT: '+sql)
        return current ? { ...current } : null
      },
      run: async () => {
        if (sql.startsWith('INSERT OR IGNORE')) {
          if (current) return { success: true, meta: { changes: 0 } }
          current = { revision: 1, updated_at: args[0], snapshot_json: args[1] }
          return { success: true, meta: { changes: 1 } }
        }
        if (sql.startsWith('UPDATE paper_backup_head')) {
          if (!current || current.revision !== args[2])
            return { success: true, meta: { changes: 0 } }
          current = { revision: current.revision+1, updated_at: args[0], snapshot_json: args[1] }
          return { success: true, meta: { changes: 1 } }
        }
        if (sql.startsWith('INSERT INTO paper_backup_history')) {
          history.push(args)
          return { success: true, meta: { changes: 1 } }
        }
        throw Error('unknown SQL: '+sql)
      },
    }),
  })
  return { prepare, getHead: () => current, history }
}
test('D1 explicitly saves and restores a paper account without changing local strategy state', async () => {
  const db=fakeD1()
  const status=await (await handlePaperBackup({ action:'status' },db)).json()
  assert.equal(status.revision,0)
  const first=await handlePaperBackup({ action:'save', expectedRevision:0,
    snapshot:snapshot() },db)
  assert.equal(first.status,200)
  assert.equal((await first.json()).revision,1)
  assert.equal(db.history.length,1)
  const loaded=await (await handlePaperBackup({ action:'load' },db)).json()
  assert.equal(loaded.revision,1)
  assert.equal(loaded.snapshot.ledger.cash,980000)
  assert.equal(loaded.snapshot.ledger.trades[0].source,'auto')
  assert.equal(loaded.snapshot.account.enabled,true) // UI explicitly turns it off on restore
})
test('stale or concurrent backup cannot overwrite newer D1 state', async () => {
  const db=fakeD1()
  await handlePaperBackup({ action:'save', expectedRevision:0,snapshot:snapshot() },db)
  const newer={ ...snapshot(), ledger: { ...snapshot().ledger,cash:990000 } }
  assert.equal((await (await handlePaperBackup({
    action:'save',expectedRevision:1,snapshot:newer },db)).json()).revision,2)
  const conflict=await handlePaperBackup({ action:'save',expectedRevision:1,snapshot:snapshot() },db)
  assert.equal(conflict.status,409)
  assert.equal((await conflict.json()).conflict,true)
  assert.equal(JSON.parse(db.getHead().snapshot_json).ledger.cash,990000)
  assert.equal(db.history.length,2)
})
test('old initial backup is also protected against conflicting creation', async () => {
  const db=fakeD1()
  await handlePaperBackup({action:'save',expectedRevision:0,snapshot:snapshot()},db)
  const conflict=await handlePaperBackup({action:'save',expectedRevision:0,snapshot:snapshot()},db)
  assert.equal(conflict.status,409)
  assert.equal(db.history.length,1)
})
test('unsafe or malformed records cannot be persisted', async () => {
  const db=fakeD1()
  assert.equal(validatePaperBackup({ ...snapshot(),ledger: {cash:-1,positions:[],trades:[]} }),false)
  const bad={ ...snapshot(), ledger: { ...snapshot().ledger,
    trades:[{ ...snapshot().ledger.trades[0],code:'abc' }] } }
  const response=await handlePaperBackup({action:'save',expectedRevision:0,snapshot:bad},db)
  assert.equal(response.status,400)
  assert.equal(db.getHead(),null)
  const missing=await handlePaperBackup({action:'load'},db)
  assert.equal(missing.status,404)
})
test('invalid client revision and excessively large backup both fail without writes',async()=>{
  const db=fakeD1()
  assert.equal((await handlePaperBackup({action:'save',expectedRevision:-1,snapshot:snapshot()},db)).status,400)
  const large={...snapshot(),account:{...snapshot().account,lastMessage:'x'.repeat(1_800_000)}}
  assert.equal((await handlePaperBackup({action:'save',expectedRevision:0,snapshot:large},db)).status,413)
  assert.equal(db.getHead(),null)
})

test('nested API credentials are rejected before writing to Cloudflare D1',async()=>{
  const db=fakeD1()
  const withSecret={...snapshot(),account:{...snapshot().account,apiKey:'must-not-back-up'}}
  const response=await handlePaperBackup({action:'save',expectedRevision:0,snapshot:withSecret},db)
  assert.equal(response.status,400)
  assert.equal(db.getHead(),null)
})

test('periodic no-trade checkpoint advances HEAD without multiplying complete history snapshots',async()=>{
  const db=fakeD1()
  await handlePaperBackup({action:'save',expectedRevision:0,snapshot:snapshot()},db)
  const response=await handlePaperBackup({
    action:'save',expectedRevision:1,snapshot:snapshot(),checkpointOnly:true,
  },db)
  assert.equal(response.status,200)
  const data=await response.json()
  assert.equal(data.revision,2)
  assert.equal(data.checkpoint_only,true)
  assert.equal(db.history.length,1)
  assert.equal(db.getHead().revision,2)
  const third=await handlePaperBackup({action:'save',expectedRevision:2,snapshot:snapshot()},db)
  assert.equal(third.status,200)
  assert.equal(db.history.length,2)
})
