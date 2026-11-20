import test from 'node:test'
import assert from 'node:assert/strict'
import {build} from 'esbuild'

const bundle=await build({entryPoints:['worker/src/index.ts'],bundle:true,platform:'node',format:'esm',write:false})
const worker=(await import('data:text/javascript;base64,'+Buffer.from(bundle.outputFiles[0].contents).toString('base64'))).default

test('Korean weekday pre-open Cron warms OAuth once and writes only the encrypted cache',async ctx=>{
  const monday=new Date('2026-11-22T23:55:00Z')
  ctx.mock.timers.enable({apis:['Date'],now:monday})
  const original=globalThis.fetch
  let grants=0
  let stored
  const running=[]
  const env={KB_APP_KEY:'opening-test',KB_APP_SECRET:'test-only',PAPER_DB:{prepare(sql){
    assert.match(sql,/kb_oauth_token_cache/)
    return {async first(){return null},bind(...fields){return {async run(){stored=fields}}}}
  }}}
  globalThis.fetch=async url=>{
    assert.match(String(url),/\/oauth2\/token$/)
    grants++
    return Response.json({dataBody:{access_token:'mock-open-secret',expires_in:86400}})
  }
  try{
    const invoke=async iso=>{
      const scheduledTime=Date.parse(iso)
      ctx.mock.timers.setTime(scheduledTime)
      await worker.scheduled({scheduledTime},env,{waitUntil:promise=>running.push(promise)})
      await Promise.all(running.splice(0))
    }
    await invoke('2026-11-21T23:55:00Z') // Sunday KST
    assert.equal(grants,0)
    await invoke(monday.toISOString())
    assert.equal(grants,1)
    assert.ok(stored)
    assert.ok(!stored.includes('mock-open-secret'))
    await invoke('2026-11-22T23:57:00Z')
    await invoke('2026-11-22T23:59:00Z')
    assert.equal(grants,1)
  }finally{globalThis.fetch=original}
})
