import test from 'node:test'
import assert from 'node:assert/strict'
import {readFileSync} from 'node:fs'
import {build} from 'esbuild'
const b=await build({entryPoints:['worker/src/kbHttpWire.ts'],bundle:true,platform:'node',format:'esm',write:false})
const {decodeKbHttpResponse,decodeKbJson}=await import('data:text/javascript;base64,'+
 Buffer.from(b.outputFiles[0].contents).toString('base64'))
const enc=new TextEncoder()
const wire=(text)=>enc.encode(text)
test('full KB JSON response is parsed with exact content length, no secrets leaked',()=>{
 const payload='{"dataHeader":{"resultCode":"200"},"dataBody":{"Record1":[]}}'
 const bytes=wire('HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: '+
  enc.encode(payload).length+'\r\n\r\n'+payload)
 const full=decodeKbHttpResponse(bytes)
 assert.equal(full.status,200)
 assert.deepEqual(decodeKbJson(full.body),JSON.parse(payload))
 assert.equal(decodeKbHttpResponse(bytes.subarray(0,bytes.length-2)),null)
})
test('chunked KB JSON response is parsed without waiting for socket close',()=>{
 const parts=['{"dataBody":','{"Record1":[]}}']
 const chunks=parts.map(p=>p.length.toString(16)+'\r\n'+p+'\r\n').join('')
 const reply=decodeKbHttpResponse(wire('HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n'+chunks+'0\r\n\r\n'))
 assert.deepEqual(decodeKbJson(reply.body),{dataBody:{Record1:[]}})
})
test('socket close without content length is interpreted only at EOF',()=>{
 const response=wire('HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n{"error":"not found"}')
 assert.equal(decodeKbHttpResponse(response),null)
 assert.equal(decodeKbHttpResponse(response,true).status,404)
})
test('truncated content-length response fails closed',()=>{
 const reply=wire('HTTP/1.1 200 OK\r\nContent-Length: 99\r\n\r\n{"x":1}')
 assert.equal(decodeKbHttpResponse(reply),null)
 assert.throws(()=>decodeKbHttpResponse(reply,true),/KB_WIRE_TRUNCATED/)
})
test('conflicting content-length and chunked is rejected',()=>{
 const reply=wire('HTTP/1.1 200 OK\r\nContent-Length: 8\r\nTransfer-Encoding: chunked\r\n\r\n0\r\n\r\n')
 assert.throws(()=>decodeKbHttpResponse(reply),/KB_WIRE_ENCODING_UNSUPPORTED/)
})
test('conflicting duplicate length is rejected',()=>{
 const reply=wire('HTTP/1.1 200 OK\r\nContent-Length: 1\r\nContent-Length: 2\r\n\r\n{}')
 assert.throws(()=>decodeKbHttpResponse(reply),/KB_WIRE_LENGTH_CONFLICT/)
})
test('malformed status line and response-size limit fail closed',()=>{
 assert.throws(()=>decodeKbHttpResponse(wire('NOT HTTP\r\nContent-Length: 0\r\n\r\n')),/KB_WIRE_STATUS_INVALID/)
 assert.throws(()=>decodeKbHttpResponse(new Uint8Array(1024*1024+1)),/KB_WIRE_LIMIT/)
})
test('JSON parser never substitutes a success for an invalid JSON body',()=>{
 assert.throws(()=>decodeKbJson(wire('{invalid json}')),/KB_WIRE_JSON_INVALID/)
})
test('experimental socket transport remains read-only, isolated and explicitly rejects order paths',async()=>{
 const path='worker/src/kbSocketReadOnly.ts'
 const source=readFileSync(path,'utf8')
 assert.match(source,/new Set\(\[/)
 for(const allowed of ['/oauth2/token','/api/v1/ssqm1801','/api/v1/ssqm2952','/api/v1/ssqm2341'])
  assert.ok(source.includes("'"+allowed+"'"))
 assert.doesNotMatch(source,/ssam180[126]|\/api\/v1\/ssam|LIVE_TRADING_HARD_ENABLE/)
 assert.match(source,/KB_SOCKET_READ_ONLY_PATH_REQUIRED/)
 const live=readFileSync('worker/src/liveExecution.ts','utf8')
 const index=readFileSync('worker/src/index.ts','utf8')
 const token=readFileSync('worker/src/kbToken.ts','utf8')
 for(const production of [live,index,token])assert.ok(!production.includes('kbSocketReadOnly'))
 const output=await build({entryPoints:[path],bundle:true,platform:'browser',target:'es2022',
  format:'esm',write:false,external:['cloudflare:sockets']})
 assert.match(output.outputFiles[0].text,/cloudflare:sockets/)
})
