import test from 'node:test'
import assert from 'node:assert/strict'
import { build } from 'esbuild'
const out=await build({entryPoints:['worker/src/liveOrderJournal.ts'],bundle:true,platform:'node',format:'esm',write:false})
const {validateOrderIntent,transitionOrder,canSendBrokerOrder,mustReconcileBeforeNextOrder,LIVE_ORDER_API_CONTRACT}=
 await import('data:text/javascript;base64,'+Buffer.from(out.outputFiles[0].contents).toString('base64'))
const base={id:'trial:2026-11-09:buy:1',tradingDay:'2026-11-09',side:'BUY',code:'005930',quantity:1,limitPrice:49000,reservedWon:49000}
const reserved={...base,state:'RESERVED',brokerOrderId:null,filledQuantity:0,updatedAt:'2026-11-09T00:01:00Z'}
test('rejects budget exceed and mismatched reservation, and allows only safe intent',()=>{
 assert.equal(validateOrderIntent(base),null)
 assert.match(validateOrderIntent({...base,quantity:2,reservedWon:98000}),/5만 원/)
 assert.match(validateOrderIntent({...base,reservedWon:48000}),/예약 금액/)
 assert.match(validateOrderIntent({...base,limitPrice:49000.1}),/지정가/)
 assert.equal(canSendBrokerOrder(reserved),true)
})
test('unknown transport outcome is never re-sent or mistaken for rejection',()=>{
 const sending=transitionOrder(reserved,'SENDING')
 const unknown=transitionOrder(sending,'UNKNOWN')
 assert.equal(canSendBrokerOrder(sending),false)
 assert.equal(canSendBrokerOrder(unknown),false)
 assert.equal(mustReconcileBeforeNextOrder(unknown),true)
 assert.throws(()=>transitionOrder(unknown,'SENDING'),/허용되지/)
 assert.throws(()=>transitionOrder(unknown,'FILLED',1),/주문번호/)
})
test('broker order id is mandatory, immutable and fills cannot exceed qty',()=>{
 const sending=transitionOrder(reserved,'SENDING')
 const accepted=transitionOrder(sending,'ACCEPTED',0,'broker-123')
 assert.equal(accepted.state,'ACCEPTED')
 assert.throws(()=>transitionOrder(accepted,'FILLED',1,'broker-456'),/변경 불가/)
 assert.throws(()=>transitionOrder(accepted,'FILLED',2),/체결수량/)
 const filled=transitionOrder(accepted,'FILLED',1)
 assert.equal(filled.filledQuantity,1)
 assert.equal(mustReconcileBeforeNextOrder(filled),false)
 assert.throws(()=>transitionOrder(filled,'SENDING'),/허용되지/)
})
test('broker endpoints are reference-only, order execution contract remains locked',()=>{
 assert.equal(LIVE_ORDER_API_CONTRACT.buy.tr,'SSAM1802')
 assert.equal(LIVE_ORDER_API_CONTRACT.sell.tr,'SSAM1801')
 assert.equal(LIVE_ORDER_API_CONTRACT.fills.tr,'SSQM2341')
 assert.equal(LIVE_ORDER_API_CONTRACT.verified,false)
})
