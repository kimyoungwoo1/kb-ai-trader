import test from 'node:test'
import assert from 'node:assert/strict'
import {build} from 'esbuild'

const bundled=await build({entryPoints:['worker/src/liveExecution.ts'],bundle:true,platform:'node',format:'esm',write:false})
const {readKbHeldQuantity}=await import('data:text/javascript;base64,'+Buffer.from(bundled.outputFiles[0].contents).toString('base64'))

function mock(valuationRows,holdingsRows){
 const old=globalThis.fetch,requested=[]
 globalThis.fetch=async(url)=>{
  const path=String(url);requested.push(path)
  if(path.endsWith('/oauth2/token'))return Response.json({dataBody:{access_token:'test-token',expires_in:1800}})
  if(path.endsWith('/api/v1/ssqm2952'))return Response.json({dataHeader:{resultCode:'200'},dataBody:{Record1:valuationRows}})
  if(path.endsWith('/api/v1/ssqm1801'))return Response.json({dataHeader:{resultCode:'200'},dataBody:{Record1:holdingsRows,nxt_key:''}})
  throw Error('Unexpected network call: '+path)
 }
 return {restore:()=>{globalThis.fetch=old},requested}
}
const valuation=(q)=>[{is_cd:'A005930',hld_q:String(q)}]
const holdings=(q)=>[{is_no:'A005930',gnrl_q:String(q),ordr_psbl_q:String(q)}]
const env=(key)=>({KB_APP_KEY:'live-holdings-cross-'+key,KB_APP_SECRET:'dummy'})

test('matching 5 shares on valuation and holdings confirms actual position',async()=>{
 const net=mock(valuation(5),holdings(5))
 try{
  assert.equal(await readKbHeldQuantity(env('five'),'005930'),5)
  assert.equal(net.requested.filter(x=>x.includes('/ssqm1801')).length,1)
  assert.equal(net.requested.filter(x=>x.includes('/ssqm2952')).length,1)
  assert.equal(net.requested.filter(x=>x.includes('/ssam')).length,0)
 }finally{net.restore()}
})
test('empty valuation and empty holdings confirm zero shares without sending orders',async()=>{
 const net=mock([],[])
 try{assert.equal(await readKbHeldQuantity(env('none'),'263750'),0)}
 finally{net.restore()}
})
test('zero on one source with five actual shares fails closed',async()=>{
 const net=mock([],holdings(5))
 try{await assert.rejects(readKbHeldQuantity(env('disagree'),'005930'),/수량 불일치/)}
 finally{net.restore()}
})
test('missing stock code or missing quantity fails closed, never assumes zero',async()=>{
 const net=mock([{is_cd:'',hld_q:'5'}],[])
 try{await assert.rejects(readKbHeldQuantity(env('no-code'),'005930'),/종목코드 누락/)}
 finally{net.restore()}
 const net2=mock(valuation(5),[{is_no:'A005930'}])
 try{await assert.rejects(readKbHeldQuantity(env('no-quantity'),'005930'),/필수 숫자 필드 누락/)}
 finally{net2.restore()}
})
test('foreign holdings do not prevent domestic quantity checks',async()=>{
 const net=mock([{is_cd:'GME',hld_q:'44'},...valuation(5)],[{is_no:'GME',gnrl_q:'44'},...holdings(5)])
 try{assert.equal(await readKbHeldQuantity(env('foreign'),'005930'),5)}
 finally{net.restore()}
})
