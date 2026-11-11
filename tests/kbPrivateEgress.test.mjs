import test from 'node:test'
import assert from 'node:assert/strict'
import {readFileSync} from 'node:fs'
import {build} from 'esbuild'

const code=readFileSync('worker/egress/kb-egress.ts','utf8')
const config=JSON.parse(readFileSync('worker/egress/wrangler.jsonc','utf8'))
const prod=JSON.parse(readFileSync('worker/wrangler.jsonc','utf8'))
const deploy=readFileSync('scripts/deploy-verified-production.mjs','utf8').replace(/\r\n/g,'\n')

test('KB private egress has no public route, version URL, tokens, database or output handler',()=>{
 assert.equal(config.name,'kb-ai-trader-egress')
 assert.notEqual(config.name,prod.name)
 assert.equal(config.workers_dev,false)
 assert.equal(config.preview_urls,false)
 assert.ok(!config.routes?.length)
 assert.ok(!config.route)
 assert.ok(!config.secrets)
 assert.ok(!config.d1_databases)
 assert.ok(!config.vars)
 assert.match(code,/extends WorkerEntrypoint/)
 assert.match(code,/async fetch\(\):Promise<Response>\{[\s\S]*?status:404/)
 assert.match(code,/async readOnly\(request:KbSocketReadRequest\)/)
 assert.match(code,/return kbReadOnlyTlsRequest\(request\)/)
 assert.doesNotMatch(code,/ssam180[126]|submitKb|LIVE_TRADING_HARD_ENABLE|PAPER_DB/)
})
test('private egress only exposes internal RPC and bundles with Cloudflare runtime modules',async()=>{
 const result=await build({
  entryPoints:['worker/egress/kb-egress.ts'],format:'esm',platform:'browser',
  target:'es2022',bundle:true,write:false,
  external:['cloudflare:sockets','cloudflare:workers']
 })
 assert.match(result.outputFiles[0].text,/cloudflare:workers/)
 assert.match(result.outputFiles[0].text,/cloudflare:sockets/)
 assert.match(result.outputFiles[0].text,/Not Found/)
})
test('private mode stays off unless expressly selected and never changes production deployment path',()=>{
 assert.match(deploy,/privateEgress&&!tlsProofOnly/)
 assert.match(deploy,/\.\.\.\(privateEgress\?\[\{name:'KB_EGRESS',type:'service'/)
 assert.match(deploy,/if\(tlsProofOnly\)\{[\s\S]*?return\r?\n  \}/)
 const switchAt=deploy.indexOf('switched=true')
 const proofAt=deploy.indexOf("const previewOrigin=versionOrigin(createdId)\n  if(tlsProofOnly)")
 assert.ok(proofAt>=0&&proofAt<switchAt)
 assert.doesNotMatch(readFileSync('worker/src/liveExecution.ts','utf8'),/KB_EGRESS/)
 assert.doesNotMatch(readFileSync('worker/src/index.ts','utf8'),/KB_EGRESS/)
})
