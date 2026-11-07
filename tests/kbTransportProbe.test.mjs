import test from 'node:test'
import assert from 'node:assert/strict'
import {readFileSync} from 'node:fs'
import {build} from 'esbuild'

const source=readFileSync('worker/diagnostics/kb-connectivity.ts','utf8')
const cfg=JSON.parse(readFileSync('worker/diagnostics/wrangler.jsonc','utf8'))
const prod=JSON.parse(readFileSync('worker/wrangler.jsonc','utf8'))

test('network diagnostic is a separate Worker and never uses live dashboard bindings',()=>{
 assert.equal(prod.name,'kb-ai-trader')
 assert.equal(cfg.name,'kb-ai-trader-network-check')
 assert.notEqual(cfg.name,prod.name)
 assert.equal(cfg.main,'kb-connectivity.ts')
 assert.equal(cfg.workers_dev,true)
 for(const unsafe of ['KB_APP_KEY','KB_APP_SECRET','DASHBOARD_API_KEY','LIVE_TRADING_HARD_ENABLE','PAPER_DB']){
  assert.ok(!source.includes(unsafe),'diagnostic must not reference '+unsafe)
  assert.ok(!JSON.stringify(cfg).includes(unsafe))
 }
})
test('diagnostic only probes KB transport and never sends authenticated or order requests',()=>{
 assert.match(source,/method:'HEAD'/)
 assert.match(source,/developer\.kbsec\.com/)
 assert.match(source,/targetPort=32484/)
 assert.match(source,/secureTransport:'on'/)
 assert.doesNotMatch(source,/\/oauth2\/token|\/api\/v1\/|ssam180[126]|appKey:|appSecret:|Authorization:/)
})
test('diagnostic bundles with the documented Workers socket import',async()=>{
 const bundle=await build({
  entryPoints:['worker/diagnostics/kb-connectivity.ts'],platform:'browser',format:'esm',
  target:'es2022',bundle:true,write:false,external:['cloudflare:sockets']
 })
 assert.ok(bundle.outputFiles[0].text.includes('cloudflare:sockets'))
 assert.ok(bundle.outputFiles[0].text.includes('NETWORK_ONLY_NO_CREDENTIALS_NO_ORDERS'))
})
