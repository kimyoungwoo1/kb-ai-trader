import test from 'node:test'
import assert from 'node:assert/strict'
import {build} from 'esbuild'
import {readFileSync} from 'node:fs'
const output=await build({entryPoints:['worker/src/index.ts'],bundle:true,platform:'node',format:'esm',write:false})
const worker=(await import('data:text/javascript;base64,'+Buffer.from(output.outputFiles[0].contents).toString('base64'))).default
const stocks=Array.from({length:10},(_,i)=>({code:String(100001+i),name:'Test'+i}))
const url='https://kb-ai-trader.ksmsy1.workers.dev/api/market/investor-flow'
test('precision scan stops KB flow calls after two consecutive quote failures',async()=>{
 const previous=globalThis.fetch
 let quotes=0,flows=0
 globalThis.fetch=async target=>{
  const path=String(target)
  if(path.endsWith('/oauth2/token'))return Response.json({dataBody:{access_token:'flow-test-token',expires_in:3600}})
  if(path.endsWith('/api/v1/ivu10140')){quotes++;return new Response('gateway 522',{status:522})}
  if(path.endsWith('/api/v1/ivu10430')){flows++;throw Error('flow should be skipped without quote')}
  throw Error('unexpected path')
 }
 try{
  const response=await worker.fetch(new Request(url,{method:'POST',
   headers:{Authorization:'Bearer dashboard-pass','Content-Type':'application/json'},
   body:JSON.stringify({stocks})}),
   {DASHBOARD_API_KEY:'dashboard-pass',KB_APP_KEY:'cron-flow-fail-fast',KB_APP_SECRET:'secret',KB_BASE_URL:'https://developer.kbsec.com:32484'})
  const data=await response.json()
  assert.equal(response.status,200)
  assert.equal(data.results.length,10)
  assert.equal(quotes,2)
  assert.equal(flows,0)
  assert.ok(data.results.every(x=>x.price===null))
  assert.ok(data.results.every(x=>x.quoteError))
 }finally{globalThis.fetch=previous}
})
test('Cron limits market precision to ten candidates and blocks incomplete scans',()=>{
 const source=readFileSync('worker/src/serverPaper.ts','utf8')
 assert.match(source,/return selected\.slice\(0,10\)/)
 assert.match(source,/quotes\.some\(\(quote:any\)=>/)
 assert.match(source,/KB 정밀 시세·수급 일부 실패 · 신규 매수 보류/)
 const priceFailure=source.indexOf("throw Error('KB 정밀 시세·수급 일부 실패 · 신규 매수 보류')")
 const extra=source.indexOf("post('/api/market/disclosures',{complete:true})")
 assert.ok(priceFailure>=0&&extra>priceFailure,
   'Failed KB price validation must abort before fetching external news/DART')

})
