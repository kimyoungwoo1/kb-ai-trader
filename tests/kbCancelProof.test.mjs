import test from 'node:test'
import assert from 'node:assert/strict'
import {build} from 'esbuild'
const out=await build({entryPoints:['worker/src/kbOrderContract.ts'],bundle:true,platform:'node',format:'esm',write:false})
const {parseOrderLines,confirmKbCancelLines,lookupKbCancelEvidence}=
 await import('data:text/javascript;base64,'+Buffer.from(out.outputFiles[0].contents).toString('base64'))
const O='0060000705',C='0060000712',D='20261109'
const header={resultCode:'200',processFlag:'A',processCode:'0015'}
const rawCancel=(q='3',label=q+'주취완',origin=O)=>({
 ordr_no:C,orgn_ordr_no:origin,stnd_is_no:'A005930',trd_dl_ccd_nm:'매수',
 ordr_q:q,tl_ccls_q:'0',nccls_q:'0',ordr_uprc:'0',crct_cncl_ccd:label
})
const rawOriginal=(filled='2',remaining='0')=>({
 ordr_no:O,orgn_ordr_no:'0000000000',stnd_is_no:'A005930',trd_dl_ccd_nm:'매수',
 ordr_q:'5',tl_ccls_q:filled,nccls_q:remaining,ordr_uprc:'9000'
})
const parsed=(rows)=>parseOrderLines({dataHeader:header,dataBody:{Record1:rows,nxt_key:''}}).lines

test('KB V2 sample: linked 3-share cancellation completes the 2-filled / 3-canceled original',()=>{
 const proof=confirmKbCancelLines(parsed([rawOriginal(),rawCancel()]),O,C,'005930','BUY',5,2)
 assert.equal(proof.confirmed,true)
 assert.equal(proof.filledQuantity,2)
 assert.equal(proof.reason,'증권사 미체결 취소 완료 확인')
})
test('same original order number but an unrelated cancel order does not confirm',()=>{
 const proof=confirmKbCancelLines(parsed([rawCancel('5','5주취완','0060000999')]),O,C,'005930','BUY',5,0)
 assert.equal(proof.confirmed,false)
})
test('request receipt, correction, canceled quantity mismatch, and missing row never claim final',()=>{
 for(const rows of [
  [rawCancel('5','취소접수')],
  [rawCancel('5','5주정완')],
  [rawCancel('4','4주취완')],
  [rawCancel('3','3주취완')]
 ]){
  const proof=confirmKbCancelLines(parsed(rows),O,C,'005930','BUY',5,0)
  assert.equal(proof.confirmed,false)
 }
})
test('fully filled original wins over pending cancellation and preserves all shares',()=>{
 const proof=confirmKbCancelLines(parsed([rawOriginal('5','0')]),O,C,'005930','BUY',5,2)
 assert.equal(proof.fullyFilled,true)
 assert.equal(proof.confirmed,false)
 assert.equal(proof.filledQuantity,5)
})
test('cancel evidence loads all pages before completing, without any broker order writes',async()=>{
 const restore=globalThis.fetch
 const paths=[]
 globalThis.fetch=async(url,opts)=>{
  const endpoint=String(url);paths.push(endpoint)
  if(endpoint.endsWith('/oauth2/token'))return Response.json({dataBody:{access_token:'test-only',expires_in:3600}})
  if(endpoint.endsWith('/api/v1/ssqm2341')){
   const {nxt_key}=JSON.parse(opts.body).dataBody
   return Response.json({dataHeader:header,dataBody:{Record1:nxt_key?[rawCancel()]:[rawOriginal()],nxt_key:nxt_key?'':'NEXT'}})
  }
  throw Error('Unexpected broker endpoint: '+endpoint)
 }
 try{
  const result=await lookupKbCancelEvidence({KB_APP_KEY:'kb-proof-read-only',KB_APP_SECRET:'mock'},D,O,C,'005930','BUY',5,2)
  assert.equal(result.confirmed,true)
  assert.equal(result.verifiedPages,2)
  assert.equal(paths.filter(x=>x.endsWith('/api/v1/ssqm2341')).length,2)
  assert.equal(paths.filter(x=>x.includes('/ssam')).length,0)
 }finally{globalThis.fetch=restore}
})
test('incomplete paginated query must never promote canceled orders',async()=>{
 const restore=globalThis.fetch
 globalThis.fetch=async(url)=>{
  if(String(url).endsWith('/oauth2/token'))return Response.json({dataBody:{access_token:'test-only',expires_in:3600}})
  return Response.json({dataHeader:header,dataBody:{Record1:[rawCancel('5','5주취완')],nxt_key:'SAME'}})
 }
 try{
  await assert.rejects(()=>lookupKbCancelEvidence({KB_APP_KEY:'kb-proof-loop',KB_APP_SECRET:'mock'},D,O,C,'005930','BUY',5,0),/다음키 반복/)
 }finally{globalThis.fetch=restore}
})
