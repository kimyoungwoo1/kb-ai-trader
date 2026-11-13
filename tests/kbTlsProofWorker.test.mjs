import test from 'node:test'
import assert from 'node:assert/strict'
import {readFileSync} from 'node:fs'
import {build} from 'esbuild'

const entry='worker/src/kbTlsProofWorker.ts'
const source=readFileSync(entry,'utf8')
const deployment=readFileSync('scripts/deploy-verified-production.mjs','utf8').replace(/\r\n/g,'\n')
const main=readFileSync('worker/src/index.ts','utf8')
const fakeSocket={
 name:'test-cloudflare-socket',
 setup(buildApi){
  buildApi.onResolve({filter:/^cloudflare:sockets$/},()=>({path:'mock-socket',namespace:'kb-mock'}))
  buildApi.onLoad({filter:/.*/,namespace:'kb-mock'},()=>({
   contents:'export const connect=(...args)=>globalThis.__kbConnectMock(...args)',
   loader:'js'
  }))
 }
}
const bundle=await build({entryPoints:[entry],bundle:true,format:'esm',platform:'node',
 write:false,plugins:[fakeSocket]})
const imported=await import('data:text/javascript;base64,'+
 Buffer.from(bundle.outputFiles[0].contents).toString('base64'))
const {runKbTlsProof}=imported
const key={KB_APP_KEY:'unit-test-key',KB_APP_SECRET:'unit-test-secret'}
const enc=new TextEncoder()
const statuses={
 auth:{dataBody:{access_token:'SUPER_PRIVATE_ACCESS_TOKEN',expires_in:3600}},
 holdings:{dataHeader:{resultCode:'200',processFlag:'A',processCode:'777'},dataBody:{Record1:[]}},
 valuation:{dataHeader:{resultCode:'200',processFlag:'A',processCode:'777'},dataBody:{val_amt_sum:'99999'}},
 order:{dataHeader:{resultCode:'200',processFlag:'A',processCode:'777'},dataBody:{Record1:[]}}
}
function brokerSocket(overrides={}){
 const original=globalThis.__kbConnectMock,calls=[]
 globalThis.__kbConnectMock=()=>{
  let readerController
  const responseStream=new ReadableStream({start(controller){readerController=controller}})
  const writerStream=new WritableStream({write(data){
   const request=new TextDecoder().decode(data)
   const at=request.indexOf('\r\n\r\n')
   assert.ok(at>=0,'HTTP headers and body must be sent in one write')
   const header=request.slice(0,at+4)
   const body=request.slice(at+4)
   assert.equal(Number(header.match(/Content-Length: ([0-9]+)/)?.[1]),enc.encode(body).length)
   const path=header.match(/^POST (\/[^ ]+) HTTP\/1\.1/)?.[1]
   calls.push({path,body,header})
   let payload
   if(path==='/oauth2/token')payload=overrides.auth??statuses.auth
   else if(path==='/api/v1/ivu10140')payload={dataHeader:{resultCode:'0'},dataBody:{now_prc:'22222'}}
   else if(path==='/api/v1/ssqm1801')payload=overrides.holdings??statuses.holdings
   else if(path==='/api/v1/ssqm2952')payload=overrides.valuation??statuses.valuation
   else if(path==='/api/v1/ssqm2341')payload=overrides.order??statuses.order
   else throw Error('Unexpected broker path: '+path)
   const serialized=JSON.stringify(payload)
   const answer='HTTP/1.1 200 OK\r\nContent-Length: '+enc.encode(serialized).length+
     '\r\nConnection: close\r\n\r\n'+serialized
   readerController.enqueue(enc.encode(answer));readerController.close()
  }})
  return {
   opened:Promise.resolve(),closed:Promise.resolve(),
   writable:writerStream,readable:responseStream,close(){}
  }
 }
 return{calls,restore(){globalThis.__kbConnectMock=original}}
}
test('without credentials, isolated Worker never attempts network or displays secrets',async()=>{
 let calls=0
 const previous=globalThis.__kbConnectMock
 globalThis.__kbConnectMock=()=>{calls++;throw Error('network disallowed')}
 try{
  const result=await runKbTlsProof({})
  assert.equal(result.ready,false)
  assert.equal(result.realOrderSent,false)
  assert.equal(result.checks.oauth.detail,'KB_CREDENTIALS_NOT_BOUND')
  for(const key of ['quote','holdings','valuation','orderInquiry']){
   assert.deepEqual(result.checks[key],{status:'SKIPPED',detail:'KB_OAUTH_NOT_READY'})
  }
  assert.equal(calls,0)
 }finally{globalThis.__kbConnectMock=previous}
})
test('isolated test does actual token, quote, holdings, valuation and order queries via five socket requests only',async()=>{
 const mock=brokerSocket()
 try{
  const result=await runKbTlsProof(key,new Date('2026-11-07T10:00:00Z'))
  assert.equal(result.ready,true)
  assert.equal(result.realOrderSent,false)
  assert.deepEqual(mock.calls.map(c=>c.path),[
   '/oauth2/token','/api/v1/ivu10140','/api/v1/ssqm1801','/api/v1/ssqm2952','/api/v1/ssqm2341'
  ])
  assert.equal(JSON.parse(mock.calls[4].body).dataBody.ordr_dt,'20261106')
  assert.equal(result.checks.orderInquiry.status,'PASS')
  assert.equal(result.checks.oauth.status,'PASS')
  assert.equal(result.checks.quote.status,'PASS')
  assert.ok(mock.calls[1].header.includes('appKey: unit-test-key'))
  assert.ok(!JSON.stringify(result).includes('22222'))
  assert.ok(mock.calls[1].header.includes('Authorization: Bearer SUPER_PRIVATE_ACCESS_TOKEN'))
  assert.ok(!JSON.stringify(result).includes('SUPER_PRIVATE_ACCESS_TOKEN'))
  assert.ok(!JSON.stringify(result).includes('unit-test-secret'))
  assert.ok(!JSON.stringify(result).includes('99999'))
  assert.ok(!mock.calls.some(c=>/ssam|1806/.test(c.path)))
 }finally{mock.restore()}
})
test('business refusal fails closed with only safe codes, no account info',async()=>{
 const mock=brokerSocket({order:{
  dataHeader:{resultCode:'5007',processCode:'S401',processFlag:'N',processMessage:'PRIVATE DATA'},
  dataBody:{account:'123-456-789'}
 }})
 try{
  const r=await runKbTlsProof(key,new Date('2026-11-07T10:00:00Z'))
  assert.equal(r.ready,false)
  assert.deepEqual(r.checks.orderInquiry,{
   status:'BLOCKED',httpStatus:200,resultCode:'5007',
   processCode:'S401',processFlag:'N',detail:'KB_BUSINESS_NOT_ACCEPTED'
  })
  assert.ok(!JSON.stringify(r).includes('PRIVATE DATA'))
  assert.ok(!JSON.stringify(r).includes('123-456-789'))
 }finally{mock.restore()}
})
test('isolated diagnostic endpoint requires unguessable probe header',async()=>{
 const previous=globalThis.__kbConnectMock
 let calls=0
 globalThis.__kbConnectMock=()=>{calls++;throw Error('not allowed')}
 try{
  const worker=imported.default
  for(const [path,header] of [['/','secret'],['/api/deploy/tls-proof','wrong']]){
   const response=await worker.fetch(new Request('https://preview.example'+path,{
    method:'POST',headers:{'X-Deploy-Probe':header}
   }),{...key,DEPLOY_PROBE_TOKEN:'secret'})
   assert.equal(response.status,404)
  }
  assert.equal(calls,0)
 }finally{globalThis.__kbConnectMock=previous}
})
test('proof-only deployment cannot promote production, touch D1 SQL or use production main',()=>{
 assert.match(deployment,/tlsProofOnly = process\.argv\.includes\('--tls-proof-only'\)/)
 assert.match(deployment,/if\(paperDbId&&!tlsProofOnly\)/)
 assert.match(deployment,/tlsProofOnly\?'worker\/src\/kbTlsProofWorker\.ts':'worker\/src\/index\.ts'/)
 const proof=deployment.indexOf("if(tlsProofOnly){\n    console.log('○ 운영 전환 없는 격리 TLS 진단")
 const change=deployment.indexOf('switched=true')
 assert.ok(proof>0&&proof<change)
 assert.match(deployment.slice(proof,change),/return\r?\n  }/)
 assert.match(source,/realOrderSent:false/)
 assert.doesNotMatch(source,/ssam180|submitKb|processLiveFill|PAPER_DB/)
 assert.ok(!main.includes('kbTlsProofWorker'))
})

test('OAuth transport failure always produces three SKIPPED rows and no brokerage reads',async()=>{
 const previous=globalThis.__kbConnectMock
 let calls=0
 globalThis.__kbConnectMock=()=>{
  calls++
  throw Error('mock socket unavailable')
 }
 try{
  const result=await runKbTlsProof(key)
  assert.equal(result.ready,false)
  assert.equal(result.realOrderSent,false)
  assert.equal(result.checks.oauth.status,'BLOCKED')
  assert.equal(result.checks.oauth.detail,'KB_SOCKET_TRANSPORT_CONNECT')
  for(const child of ['quote','holdings','valuation','orderInquiry']){
   assert.deepEqual(result.checks[child],{status:'SKIPPED',detail:'KB_OAUTH_NOT_READY'})
  }
  assert.equal(calls,2,'OAuth socket and safe network-only GET are the only attempts')
  assert.deepEqual(result.checks.networkRoot,{status:'BLOCKED',detail:'ROOT_TRANSPORT_CONNECT'})
  assert.ok(!JSON.stringify(result).includes(key.KB_APP_SECRET))
 }finally{globalThis.__kbConnectMock=previous}
})

test('one same-version TCP failure triggers a harmless GET / comparison without credentials',async()=>{
 const original=globalThis.__kbConnectMock
 const calls=[]
 globalThis.__kbConnectMock=()=>{
  calls.push('connect')
  if(calls.length===1)throw Error('first socket path blocked')
  let controller
  const readable=new ReadableStream({start(c){controller=c}})
  const writable=new WritableStream({write(data){
   const req=new TextDecoder().decode(data)
   assert.ok(req.startsWith('GET / HTTP/1.1'))
   assert.ok(!req.includes('unit-test-secret'))
   assert.ok(!req.includes('Authorization'))
   const resp='HTTP/1.1 404 Not Found\\r\\nContent-Length: 0\\r\\n\\r\\n'
   controller.enqueue(new TextEncoder().encode(resp))
   controller.close()
  }})
  return{opened:Promise.resolve(),closed:Promise.resolve(),readable,writable,close(){}}
 }
 try{
  const result=await runKbTlsProof(key)
  assert.equal(result.ready,false)
  assert.equal(result.checks.oauth.detail,'KB_SOCKET_TRANSPORT_CONNECT')
  assert.deepEqual(result.checks.networkRoot,{status:'PASS',httpStatus:404,detail:'ROOT_HTTP_RESPONSE'})
  assert.equal(calls.length,2)
  assert.ok(!JSON.stringify(result).includes(key.KB_APP_SECRET))
 }finally{globalThis.__kbConnectMock=original}
})

test('private Cloudflare Service Binding handles OAuth and read-only KB queries without outbound direct sockets',async()=>{
 const calls=[]
 const previous=globalThis.__kbConnectMock
 globalThis.__kbConnectMock=()=>{throw Error('proof Worker must use binding, not direct KB network')}
 const mockEgress={
  async readOnly(input){
   calls.push(input)
   const obj=input.path==='/oauth2/token'?statuses.auth:
    input.path==='/api/v1/ivu10140'?{dataBody:{now_prc:22222}}:
    input.path==='/api/v1/ssqm1801'?statuses.holdings:
    input.path==='/api/v1/ssqm2952'?statuses.valuation:
    input.path==='/api/v1/ssqm2341'?statuses.order:null
   assert.ok(obj,'Unexpected or unsafe KB service endpoint: '+input.path)
   return {status:200,json:obj,durationMs:250}
  },
  async rootProbe(){throw Error('rootProbe should not run after successful OAuth')}
 }
 try{
  const result=await runKbTlsProof({...key,KB_EGRESS:mockEgress},new Date('2026-11-07T10:00:00Z'))
  assert.equal(result.ready,true)
  assert.equal(result.realOrderSent,false)
  assert.deepEqual(calls.map(x=>x.path),[
   '/oauth2/token','/api/v1/ivu10140','/api/v1/ssqm1801','/api/v1/ssqm2952','/api/v1/ssqm2341'
  ])
  assert.equal(JSON.parse(JSON.stringify(calls[4].body)).dataBody.ordr_dt,'20261106')
  assert.ok(!JSON.stringify(result).includes(key.KB_APP_SECRET))
  assert.ok(!JSON.stringify(result).includes('SUPER_PRIVATE_ACCESS_TOKEN'))
 }finally{globalThis.__kbConnectMock=previous}
})
test('private binding OAuth connect failure reports a sanitized root connectivity comparison without real order writes',async()=>{
 const previous=globalThis.__kbConnectMock
 globalThis.__kbConnectMock=()=>{throw Error('direct socket must not run in private binding mode')}
 let rootCount=0
 const proof=await runKbTlsProof({...key,KB_EGRESS:{
  async readOnly(){throw Error('KB_SOCKET_TIMEOUT_CONNECT')},
  async rootProbe(){rootCount++;return{status:'PASS',httpStatus:404,detail:'ROOT_HTTP_RESPONSE'}}
 }})
 assert.equal(proof.ready,false)
 assert.equal(proof.checks.oauth.detail,'KB_SOCKET_TIMEOUT_CONNECT')
 assert.deepEqual(proof.checks.networkRoot,{status:'PASS',httpStatus:404,detail:'ROOT_HTTP_RESPONSE'})
 assert.equal(rootCount,1)
 assert.equal(proof.checks.orderInquiry.status,'SKIPPED')
 assert.equal(proof.realOrderSent,false)
 globalThis.__kbConnectMock=previous
})
test('private service binding is opted-in only for isolated version URLs and never modifies live order route',()=>{
 assert.match(deployment,/const privateEgress = process\.argv\.includes\('--private-egress'\)/)
 assert.match(deployment,/privateEgress&&!tlsProofOnly/)
 assert.match(deployment,/privateEgress\?\[\{name:'KB_EGRESS',type:'service',service:'kb-ai-trader-egress'\}\]/)
 assert.match(deployment,/if\(privateEgress\)ensure\(newBindings\.get\('KB_EGRESS'\)==='service'/)
 assert.match(source,/env\.KB_EGRESS\?env\.KB_EGRESS\.readOnly/)
 assert.ok(!main.includes('KB_EGRESS'))
})

test('same quote and OAuth token are compared in both orders without exposing the response body',async()=>{
 const original=globalThis.fetch, socket=brokerSocket()
 const calls=[]
 globalThis.fetch=async(url,options)=>{
  calls.push(String(url))
  if(String(url).endsWith('/oauth2/token'))return Response.json(statuses.auth)
  assert.ok(String(url).endsWith('/api/v1/ivu10140'))
  assert.equal(options.headers.Authorization,'bearer SUPER_PRIVATE_ACCESS_TOKEN')
  assert.equal(JSON.parse(options.body).dataBody.shrt_cd,'005930')
  return new Response('gateway body', {status:522})
 }
 try{
  const report=await imported.compareKbQuoteTransports(key)
  assert.equal(report.oauth.status,'PASS')
  assert.deepEqual(report.attempts.map(({transport,httpStatus})=>[transport,httpStatus]),
   [['fetch',522],['tls',200],['tls',200],['fetch',522]])
  assert.equal(calls.filter(url=>url.endsWith('/oauth2/token')).length,1)
  assert.ok(socket.calls.every(call=>call.path==='/api/v1/ivu10140'&&
   call.header.includes('SUPER_PRIVATE_ACCESS_TOKEN')&&JSON.parse(call.body).dataBody.shrt_cd==='005930'))
  assert.doesNotMatch(JSON.stringify(report),/SUPER_PRIVATE_ACCESS_TOKEN|gateway body|22222/)
 }finally{globalThis.fetch=original;socket.restore()}
})

test('isolated HTTP quote proof requires probe authorization and reports only safe status',async()=>{
 const old=globalThis.fetch
 const calls=[]
 const env={...key,KB_APP_KEY:'http-proof-test',DEPLOY_PROBE_TOKEN:'probe-secret'}
 globalThis.fetch=async(url,init)=>{
  calls.push(new URL(url).pathname)
  if(String(url).endsWith('/oauth2/token'))return Response.json(statuses.auth)
  assert.equal(JSON.parse(init.body).dataBody.shrt_cd,'005930')
  return new Response('private upstream body',{status:522})
 }
 const request=token=>new Request('https://preview.example/api/deploy/tls-proof',{
  method:'POST',headers:{'X-Deploy-Probe':token,'X-KB-Diagnostic':'http-quote'}
 })
 try{
  assert.equal((await imported.default.fetch(request('wrong'),env)).status,404)
  assert.deepEqual(calls,[])
  const result=await (await imported.default.fetch(request('probe-secret'),env)).json()
  assert.deepEqual(calls,['/oauth2/token','/api/v1/ivu10140'])
  assert.equal(result.mode,'ISOLATED_KB_HTTP_QUOTE')
  assert.equal(result.realOrderSent,false)
  assert.equal(result.quote.httpStatus,522)
  assert.doesNotMatch(JSON.stringify(result),/private upstream body|SUPER_PRIVATE_ACCESS_TOKEN/)
 }finally{globalThis.fetch=old}
})
