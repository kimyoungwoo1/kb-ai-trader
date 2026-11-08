import test from 'node:test'
import assert from 'node:assert/strict'
import {readFileSync} from 'node:fs'
import {build} from 'esbuild'

const entry='worker/src/kbTlsProofWorker.ts'
const source=readFileSync(entry,'utf8')
const deployment=readFileSync('scripts/deploy-verified-production.mjs','utf8')
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
  for(const key of ['holdings','valuation','orderInquiry']){
   assert.deepEqual(result.checks[key],{status:'SKIPPED',detail:'KB_OAUTH_NOT_READY'})
  }
  assert.equal(calls,0)
 }finally{globalThis.__kbConnectMock=previous}
})
test('isolated test does actual token, holdings, valuation and order query via four socket requests only',async()=>{
 const mock=brokerSocket()
 try{
  const result=await runKbTlsProof(key,new Date('2026-11-07T10:00:00Z'))
  assert.equal(result.ready,true)
  assert.equal(result.realOrderSent,false)
  assert.deepEqual(mock.calls.map(c=>c.path),[
   '/oauth2/token','/api/v1/ssqm1801','/api/v1/ssqm2952','/api/v1/ssqm2341'
  ])
  assert.equal(JSON.parse(mock.calls[3].body).dataBody.ordr_dt,'20261106')
  assert.equal(result.checks.orderInquiry.status,'PASS')
  assert.equal(result.checks.oauth.status,'PASS')
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
 assert.match(deployment.slice(proof,change),/return\n  }/)
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
  for(const child of ['holdings','valuation','orderInquiry']){
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
