import test from 'node:test'
import assert from 'node:assert/strict'
import { build } from 'esbuild'

const built = await build({ entryPoints: ['worker/src/paperBackup.ts'],
  bundle: true, platform: 'node', format: 'esm', write: false })
const { handlePaperBackup } = await import('data:text/javascript;base64,'
  + Buffer.from(built.outputFiles[0].contents).toString('base64'))
const userA = 'owner_AAAAAAAAAAAAAAAAAAAAA'
const userB = 'owner_BBBBBBBBBBBBBBBBBBBBB'
const makeSnapshot = () => ({
  format: 1, savedAt: '2026-11-06T01:00:00.000Z',
  ledger: { cash: 1000000, positions: [], trades: [] },
  account: { enabled: true, cash: 1000000, positions: [], pending: [],
    fills: [], runs: [], equityHistory: [], lastCycle: '', lastMessage: '' },
  screening: null,
})
const db = () => {
  let lease = null
  let head = { revision: 1, updated_at: '2026-11-06T01:00:00.000Z',
    snapshot_json: JSON.stringify(makeSnapshot()) }
  const history = []
  return {
    head: () => head,
    lease: () => lease,
    prepare(sql) {
      return {
        bind(...params) {
          return {
            async first() {
              if (sql.startsWith('SELECT revision')) return head
              throw Error('Unexpected SELECT: ' + sql)
            },
            async run() {
              if (sql.startsWith('INSERT OR IGNORE INTO paper_trade_lease')) {
                if (!lease) lease = { owner: '', until: 0 }
                return { success: true, meta: { changes: 1 } }
              }
              if (sql.startsWith('UPDATE paper_trade_lease')) {
                if (sql.includes('lease_until = 0')) {
                  if (lease?.owner === params[0]) lease.until = 0
                  return { success: true, meta: { changes: 1 } }
                }
                const [owner, until, compare, extra, version] = params
                const isClaim = sql.includes('lease_until <=')
                const allowed = isClaim
                  ? (lease.until <= compare || lease.owner === extra) && head.revision === version
                  : lease.owner === compare && lease.until > extra
                if (allowed) lease = { owner, until }
                return { success: true, meta: { changes: allowed ? 1 : 0 } }
              }
              if (sql.startsWith('UPDATE paper_backup_head')) {
                const [updatedAt, snapshot, revision, now, owner] = params
                const authorized = !lease || lease.until <= now ||
                  (lease.owner === owner && lease.until > now)
                if (!head || head.revision !== revision || !authorized) {
                  return { success: true, meta: { changes: 0 } }
                }
                head = { revision: head.revision + 1, updated_at: updatedAt,
                  snapshot_json: snapshot }
                return { success: true, meta: { changes: 1 } }
              }
              if (sql.startsWith('INSERT INTO paper_backup_history')) {
                history.push(params)
                return { success: true, meta: { changes: 1 } }
              }
              if (sql.startsWith('INSERT OR IGNORE INTO paper_backup_head')) {
                return { success: true, meta: { changes: 0 } }
              }
              throw Error('Unexpected query: ' + sql)
            },
          }
        },
      }
    },
  }
}
const invoke = async (database, request) => {
  const response = await handlePaperBackup(request, database)
  return { status: response.status, data: await response.json() }
}

test('only one owner can claim automatic paper trading; other tabs and PCs cannot', async () => {
  const database = db()
  const first = await invoke(database, {
    action: 'claim', owner: userA, expectedRevision: 1,
  })
  assert.equal(first.status, 200)
  assert.equal(first.data.active, true)
  const competing = await invoke(database, {
    action: 'claim', owner: userB, expectedRevision: 1,
  })
  assert.equal(competing.status, 409)
  assert.equal(database.lease().owner, userA)
  assert.equal((await invoke(database, { action: 'renew', owner: userB, expectedRevision: 1 })).status, 409)
  assert.equal((await invoke(database, { action: 'renew', owner: userA, expectedRevision: 1 })).status, 200)
})

test('exclusive owner may save, other owners are refused, and an owned release allows takeover', async () => {
  const database = db()
  await invoke(database, { action: 'claim', owner: userA, expectedRevision: 1 })
  const denied = await invoke(database, {
    action: 'save', expectedRevision: 1, owner: userB, snapshot: makeSnapshot(),
  })
  assert.equal(denied.status, 409)
  const manualOther = await invoke(database, {
    action: 'save', expectedRevision: 1, snapshot: makeSnapshot(),
  })
  assert.equal(manualOther.status, 409)
  assert.equal(database.head().revision, 1)
  const saved = await invoke(database, {
    action: 'save', expectedRevision: 1, owner: userA, snapshot: makeSnapshot(),
  })
  assert.equal(saved.data.revision, 2)
  assert.equal((await invoke(database, {
    action: 'renew', owner: userA, expectedRevision: 1,
  })).status, 200, 'renew must not race a background backup revision increment')
  await invoke(database, { action: 'release', owner: userB })
  assert.equal(database.lease().owner, userA)
  await invoke(database, { action: 'release', owner: userA })
  assert.equal((await invoke(database, {
    action: 'claim', owner: userB, expectedRevision: 1,
  })).status, 409, 'new owner must observe latest cloud version first')
  assert.equal((await invoke(database, {
    action: 'claim', owner: userB, expectedRevision: 2,
  })).status, 200)
})

test('invalid owner IDs or revisions fail closed', async () => {
  const database = db()
  assert.equal((await invoke(database, { action: 'claim',
    owner: 'a', expectedRevision: 1 })).status, 400)
  assert.equal((await invoke(database, { action: 'claim',
    owner: userA, expectedRevision: -2 })).status, 400)
})
