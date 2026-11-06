import test from 'node:test'
import assert from 'node:assert/strict'
import { build } from 'esbuild'

const built = await build({ entryPoints: ['src/cloudAutoSync.ts'],
  bundle: true, platform: 'node', format: 'esm', write: false })
const driver = await import('data:text/javascript;base64,'
  + Buffer.from(built.outputFiles[0].contents).toString('base64'))
const memory = new Map()
const listeners = new Map()
const intervals = new Map()
const timeouts = new Map()
let index = 0
const ticker = (store, cb) => { const id=++index; store.set(id,cb); return id }
const subscribe=(store,type,cb)=>{
  if(!store.has(type))store.set(type,new Set())
  store.get(type).add(cb)
}
const unsubscribe=(store,type,cb)=>store.get(type)?.delete(cb)
globalThis.localStorage = {
  getItem: key => memory.get(key) || null,
  setItem: (key, value) => memory.set(key, value),
  removeItem: key => memory.delete(key),
}
globalThis.window = {
  setTimeout: cb => ticker(timeouts, cb),
  clearTimeout: id => timeouts.delete(id),
  setInterval: cb => ticker(intervals, cb),
  clearInterval: id => intervals.delete(id),
  addEventListener: (type, cb) => subscribe(listeners,type,cb),
  removeEventListener: (type, cb) => unsubscribe(listeners,type,cb),
  dispatchEvent: event => { for(const cb of listeners.get(event.type)||[]) cb(event) },
}
globalThis.document = { visibilityState:'visible',
  addEventListener:()=>{},removeEventListener:()=>{} }
globalThis.CustomEvent = class CustomEvent { constructor(type) { this.type=type } }
globalThis.crypto ??= (await import('node:crypto')).webcrypto

const tick = async () => {
  await new Promise(resolve => setImmediate(resolve))
  await new Promise(resolve => setImmediate(resolve))
}
const flushTimeouts = async () => {
  const tasks = [...timeouts.values()]
  timeouts.clear()
  for(const cb of tasks) cb()
  await tick()
}
const ledger = () => ({
  cash: 990000, positions: [{ code:'005930', name:'삼성전자', quantity:1,
    averagePrice:10000,lastPrice:10000 }],
  trades: [{ id:'buy-1', time:'2026-11-06T01:00:00Z',
    code:'005930',name:'삼성전자',side:'BUY',quantity:1,price:10000,amount:10000,
    source:'auto' }],
})
const values = []
let revision = 1
let lockedOwner = ''
const originalFetch = globalThis.fetch
globalThis.fetch = async (_url, settings) => {
  const body = JSON.parse(settings.body)
  values.push(body)
  if(body.action === 'status') return Response.json({success:true,configured:true,
    revision,updated_at:'2026-11-06T01:00:00Z',has_backup:true})
  if(body.action === 'load') return Response.json({success:true,revision,
    snapshot:{format:1,savedAt:'2026-11-06T01:00:00Z',
      ledger: {cash:1000000,positions:[],trades:[]},
      account:{enabled:false,cash:1000000,positions:[],pending:[],fills:[],
        runs:[],equityHistory:[],lastCycle:'',lastMessage:''},screening:null}})
  if(body.action === 'claim' || body.action === 'renew') {
    if(lockedOwner && lockedOwner !== body.owner)
      return Response.json({success:false,conflict:true,message:'lease held'},{status:409})
    lockedOwner = body.owner
    return Response.json({success:true,active:true,revision,lease_until:Date.now()+90000})
  }
  if(body.action === 'save') {
    if(body.expectedRevision !== revision)
      return Response.json({success:false,conflict:true,message:'outdated'},{status:409})
    if(lockedOwner && lockedOwner !== body.owner)
      return Response.json({success:false,conflict:true,message:'not owner'},{status:409})
    revision++
    return Response.json({success:true,revision,updated_at:new Date().toISOString(),
      checkpoint_only:body.checkpointOnly === true})
  }
  if(body.action === 'release') { lockedOwner = ''; return Response.json({success:true}) }
  throw Error('unknown action '+body.action)
}

test('a new paper fill triggers cloud backup, later periodic checkpoint does not append full history', async () => {
  const cleanup = driver.startCloudAutoSync('test-dashboard-token')
  try {
    await tick()
    assert.equal(driver.getCloudSyncState().phase,'ready')
    assert.equal(driver.getCloudSyncState().revision,1)
    memory.set('kb-ai-trader-paper-v1',JSON.stringify(ledger()))
    window.dispatchEvent(new CustomEvent('kb-paper-ledger-changed'))
    assert.equal(timeouts.size,1)
    await flushTimeouts()
    assert.equal(driver.getCloudSyncState().revision,2)
    const backed=values.filter(item=>item.action==='save')
    assert.equal(backed.length,1)
    assert.equal(backed[0].checkpointOnly,false)
    assert.equal(backed[0].snapshot.ledger.trades[0].id,'buy-1')
    assert.equal(driver.getCloudSyncState().lastError,'')
    const periodic=[...intervals.values()]
    assert.equal(periodic.length,2)
    // Simulate the 2-minute checkpoint timer becoming due.
    const originalNow = Date.now
    Date.now = () => originalNow() + 121_000
    try {
      for(const task of periodic) task()
      await tick()
    } finally { Date.now = originalNow }
    assert.equal(driver.getCloudSyncState().revision,3)
    assert.equal(values.filter(item=>item.action==='save').at(-1).checkpointOnly,true)
  } finally {
    cleanup()
    globalThis.fetch = originalFetch
  }
})
