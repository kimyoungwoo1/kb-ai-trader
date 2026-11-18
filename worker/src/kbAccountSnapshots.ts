import type {AccountBatchResult} from './kbAccountBatch'
import {kbBaseUrl, type KbCredentials} from './kbToken'

type Snapshot = {data: {dataBody: Record<string, unknown>}; checked_at: string}

const fields = (source: any, keys: string) => Object.fromEntries(
 keys.split(' ').flatMap(key => {
  const value = source?.[key]
  return typeof value === 'string' || (typeof value === 'number' && Number.isFinite(value)) ? [[key,value]] : []
 }),
)

function displayData(item: string, data: any): Snapshot['data'] | null {
 const body = data?.dataBody
 if (item === 'holdings') {
  return Array.isArray(body?.Record1) ? {
   dataBody: {Record1: body.Record1.map((row: unknown) => fields(row,'is_nm is_no gnrl_q ordr_psbl_q'))},
  } : null
 }
 const summary = item === 'valuation'
  ? fields({...data?.dataHeader,...body},'byng_amt_sum val_amt_sum val_pl_sum val_yld_sum')
  : fields(body,'ordr_psbl_csh')
 return Object.keys(summary).length ? {dataBody: summary} : null
}

const encode = (value: Uint8Array) => btoa(Array.from(value, byte => String.fromCharCode(byte)).join(''))
const decode = (value: string) => Uint8Array.from(atob(value), char => char.charCodeAt(0))
const utf8 = new TextEncoder()

export async function accountSnapshots(env: KbCredentials, batch: AccountBatchResult): Promise<Record<string, Snapshot>> {
 const db = env.PAPER_DB
 if (!db || !env.KB_APP_KEY || !env.KB_APP_SECRET) return {}
 let timer: ReturnType<typeof setTimeout> | undefined
 const deadline = new Promise<Record<string, Snapshot>>(resolve => { timer = setTimeout(() => resolve({}), 2_000) })
 const readAndWrite = async () => {
  const identity = JSON.stringify([env.KB_APP_KEY,kbBaseUrl(env)])
  const scope = encode(new Uint8Array(await crypto.subtle.digest('SHA-256',utf8.encode(identity))))
  const material = await crypto.subtle.digest('SHA-256',utf8.encode(JSON.stringify(['kb-account-display-v1',identity,env.KB_APP_SECRET])))
  const key = await crypto.subtle.importKey('raw',material,'AES-GCM',false,['encrypt','decrypt'])
  const snapshots: Record<string, Snapshot> = {}
  await Promise.all(Object.entries(batch.results).map(async ([item,entry]) => {
   const aad = utf8.encode(JSON.stringify([scope,item]))
   try {
    if (entry.success) {
     const data = displayData(item,entry.data)
     if (!data || typeof entry.checked_at !== 'string') return
     const iv = crypto.getRandomValues(new Uint8Array(12))
     const payload: Snapshot = {data,checked_at:entry.checked_at}
     const encrypted = await crypto.subtle.encrypt({name:'AES-GCM',iv,additionalData:aad},key,utf8.encode(JSON.stringify(payload)))
     await db.prepare(`INSERT INTO kb_account_display_snapshot(scope,item,checked_at,nonce,payload)
      VALUES(?,?,?,?,?) ON CONFLICT(scope,item) DO UPDATE SET checked_at=excluded.checked_at,
      nonce=excluded.nonce,payload=excluded.payload WHERE excluded.checked_at > kb_account_display_snapshot.checked_at`)
      .bind(scope,item,entry.checked_at,encode(iv),encode(new Uint8Array(encrypted))).run()
     return
    }
    const row = await db.prepare('SELECT nonce,payload FROM kb_account_display_snapshot WHERE scope=? AND item=?')
     .bind(scope,item).first()
    if (!row) return
    const plain = await crypto.subtle.decrypt({name:'AES-GCM',iv:decode(row.nonce),additionalData:aad},key,decode(row.payload))
    snapshots[item] = JSON.parse(new TextDecoder().decode(plain)) as Snapshot
   } catch { /* Optional display snapshots cannot fail a live account read. */ }
  }))
  return snapshots
 }
 try { return await Promise.race([readAndWrite(), deadline]) }
 catch { return {} }
 finally { clearTimeout(timer) }
}
