import test from 'node:test'
import assert from 'node:assert/strict'
import {build} from 'esbuild'

const artifact=await build({entryPoints:['worker/src/kbToken.ts'],bundle:true,platform:'node',format:'esm',write:false})
const source=Buffer.from(artifact.outputFiles[0].contents).toString('base64')
const load=(id)=>import('data:text/javascript;base64,'+source+'#'+id)
const config={KB_APP_KEY:'shared-test-app',KB_APP_SECRET:'shared-test-secret'}
const db=()=>{
 let row=null
 return {get row(){return row},prepare(sql){
  return {
   first:async()=>{assert.match(sql,/SELECT key_fingerprint/);return row},
   bind(...args){
    assert.match(sql,/INSERT INTO kb_oauth_token_cache/)
    return {run:async()=>{row={key_fingerprint:args[0],nonce_b64:args[1],token_b64:args[2],expires_at:args[3]};return {meta:{changes:1}}}}
   }
  }
 }}
}

test('fresh isolates reuse an encrypted server-only KB token without issuing a second OAuth request',async()=>{
 const store=db(),env={...config,PAPER_DB:store}
 const previous=globalThis.fetch
 let issued=0
 globalThis.fetch=async(uri)=>{
  assert.match(String(uri),/\/oauth2\/token$/)
  issued++
  return Response.json({dataBody:{access_token:'mock-secret-access-token',expires_in:3600}})
 }
 try{
  const a=await load('isolate-a')
  assert.equal(await a.getKbAccessToken(env),'mock-secret-access-token')
  assert.equal(issued,1)
  assert.ok(store.row)
  assert.ok(!JSON.stringify(store.row).includes('mock-secret-access-token'))
  assert.ok(!JSON.stringify(store.row).includes(config.KB_APP_SECRET))
  const b=await load('isolate-b')
  assert.equal(await b.getKbAccessToken(env),'mock-secret-access-token')
  assert.equal(issued,1)
 }finally{globalThis.fetch=previous}
})

test('a changed KB app secret cannot decrypt or reuse old token',async()=>{
 const store=db(),env={...config,KB_APP_KEY:'rotating-test-key',PAPER_DB:store}
 const previous=globalThis.fetch
 let count=0
 globalThis.fetch=async()=>{
  count++
  return Response.json({dataBody:{access_token:'token-'+count,expires_in:3600}})
 }
 try{
  assert.equal(await (await load('rotate-a')).getKbAccessToken(env),'token-1')
  assert.equal(await (await load('rotate-b')).getKbAccessToken({...env,KB_APP_SECRET:'new-secret'}),'token-2')
  assert.equal(count,2)
 }finally{globalThis.fetch=previous}
})

test('failed D1 read/write degrades to normal KB authentication without leaking or failing',async()=>{
 const env={...config,KB_APP_KEY:'db-error-key',PAPER_DB:{prepare(){throw Error('D1 unavailable')}}}
 const original=globalThis.fetch
 let count=0
 globalThis.fetch=async()=>{count++;return Response.json({dataBody:{access_token:'fallback-token',expires_in:3600}})}
 try{
  assert.equal(await (await load('fallback')).getKbAccessToken(env),'fallback-token')
  assert.equal(count,1)
 }finally{globalThis.fetch=original}
})
