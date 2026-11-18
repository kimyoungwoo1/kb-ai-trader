import test from 'node:test'
import assert from 'node:assert/strict'
import {build} from 'esbuild'

const bundle=await build({entryPoints:['worker/src/dartScan.ts'],bundle:true,platform:'node',format:'esm',write:false})
const {fetchDartScan}=await import('data:text/javascript;base64,'+Buffer.from(bundle.outputFiles[0].contents).toString('base64'))

test('trade checks always refresh today while reusing only completed prior dates', async()=>{
 const requests=[]
 const fetchPage=async url=>{
  const params=new URL(url).searchParams
  const date=params.get('end_de')
  const page=Number(params.get('page_no'))
  requests.push([params.get('bgn_de'),date,page])
  const total=date==='20261118'?101:2
  return Response.json({status:'000',total_count:total,list:Array.from(
   {length:Math.min(total-(page-1)*100,100)},(_,i)=>({rcept_no:date+':'+page+':'+i}))})
 }
 const first=await fetchDartScan('coverage','20261116','20261118',fetchPage)
 assert.equal(first.paginationError,null)
 assert.equal(first.combined.length,103)
 assert.deepEqual(requests.sort(),[
  ['20261116','20261117',1],['20261118','20261118',1],['20261118','20261118',2],
 ])
 requests.length=0
 const second=await fetchDartScan('coverage','20261116','20261118',fetchPage)
 assert.equal(second.combined.length,103)
 assert.deepEqual(requests,[['20261118','20261118',1],['20261118','20261118',2]])
})

test('duplicated or drifting pages leave validation incomplete, including on successive scans',async()=>{
 let priorReads=0
 const fetchPage=async url=>{
  const params=new URL(url).searchParams
  if(params.get('end_de')==='20261118')return Response.json({status:'013'})
  priorReads++
  const page=Number(params.get('page_no'))
  return Response.json({status:'000',total_count:101,list:Array.from(
   {length:page===1?100:1},(_,i)=>({rcept_no:String(i)}))})
 }
 for(let attempt=0;attempt<2;attempt++){
  const scan=await fetchDartScan('incomplete','20261116','20261118',fetchPage)
  assert.match(scan.paginationError,/20261116:20261117 DART 공시 목록 불일치 \(2페이지\)/)
 }
 assert.equal(priorReads,4)
})

test('continues after a failed page and resumes only the gap after checking page 1',async()=>{
 const rows = new Map()
 const db = {prepare(sql){return {bind(slot,range,startedAt,payload){return {
  async first(){return rows.get(slot)?.range===range ? rows.get(slot) : null},
  async run(){rows.set(slot,{range,startedAt,payload})},
 }}}}}
 let pageTwoFails = true
 const requested = []
 const fetchPage = async url=>{
  const query = new URL(url).searchParams
  if(query.get('end_de')==='20261117') return Response.json({status:'013'})
  const page = Number(query.get('page_no'))
  requested.push(page)
  if(page===2 && pageTwoFails) return new Response(null,{status:503})
  return Response.json({status:'000',total_count:301,list:Array.from(
   {length:page===4?1:100},(_,i)=>({rcept_no:page+':'+i}))})
 }
 const first = await fetchDartScan('resume','20261116','20261118',fetchPage,db)
 assert.match(first.paginationError,/20261118 DART HTTP 503 \(2페이지\)/)
 assert.equal(first.combined.length,201)
 assert.ok(first.combined.some(row=>row.rcept_no==='4:0'))
 assert.deepEqual(requested.sort(),[1,2,2,3,4])

 pageTwoFails = false
 requested.length = 0
 const next = await fetchDartScan('resume','20261116','20261118',fetchPage,db)
 assert.equal(next.paginationError,null)
 assert.equal(next.combined.length,301)
 assert.deepEqual(requested,[1,2])
 assert.equal(rows.get('today').payload,null)
})

test('discards partial pages when the first page changes even at the same total',async()=>{
 let payload
 const db = {prepare(){return {bind(slot,range,startedAt,value){return {
  async first(){return slot==='today' ? {payload} : null},
  async run(){if(slot==='today') payload=value},
 }}}}}
 let version = 1
 const requested = []
 const fetchPage = async url=>{
  const query = new URL(url).searchParams
  if(query.get('end_de')==='20261117') return Response.json({status:'013'})
  const page = Number(query.get('page_no'))
  requested.push(page)
  if(page===2 && version===1) return new Response(null,{status:503})
  return Response.json({status:'000',total_count:201,list:Array.from(
   {length:page===3?1:100},(_,i)=>({rcept_no:version+':'+page+':'+i}))})
 }
 const first = await fetchDartScan('revalidate','20261116','20261118',fetchPage,db)
 assert.match(first.paginationError,/2페이지/)
 version = 2
 requested.length = 0
 const next = await fetchDartScan('revalidate','20261116','20261118',fetchPage,db)
 assert.equal(next.paginationError,null)
 assert.equal(next.combined.length,201)
 assert.ok(next.combined.every(row=>row.rcept_no.startsWith('2:')))
 assert.deepEqual(requested,[1,2,3])
})
