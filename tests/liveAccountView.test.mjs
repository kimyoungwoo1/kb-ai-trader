import test from 'node:test'
import assert from 'node:assert/strict'
import {readFileSync} from 'node:fs'
import {build} from 'esbuild'

const bundling=await build({entryPoints:['src/liveAccountView.ts'],bundle:true,platform:'node',format:'esm',write:false})
const {safeCash,domesticCode,findAccountHolding,reservedPilotAmount}=
 await import('data:text/javascript;base64,'+Buffer.from(bundling.outputFiles[0].contents).toString('base64'))

test('deposit money renders safely and unknown balances stay unknown, never zero',()=>{
 assert.equal(safeCash('0000000281959'),281959)
 assert.equal(safeCash('281,959'),281959)
 assert.equal(safeCash('0'),0)
 for(const bad of [null,undefined,'','NaN','1.5','-1',{},'9999999999999999999999999999']){
  assert.equal(safeCash(bad),null)
 }
})
test('held stock quantity maps 005930 and A005930 without confusing overseas shares',()=>{
 const holdings=[
  {name:'삼성전자',code:'A005930',quantity:5,orderable:5,valuation:400000},
  {name:'GME',code:'GME',quantity:10,orderable:0,valuation:250000}
 ]
 assert.equal(domesticCode('A005930'),'005930')
 assert.equal(findAccountHolding(holdings,'005930')?.quantity,5)
 assert.equal(findAccountHolding(holdings,'A005930')?.valuation,400000)
 assert.equal(findAccountHolding(holdings,'263750'),null)
 assert.equal(findAccountHolding(holdings,'GME')?.quantity,10)
})
test('50k paper pilot reservation is not confused with real account cash',()=>{
 assert.equal(reservedPilotAmount(undefined),null)
 assert.equal(reservedPilotAmount([]),0)
 assert.equal(reservedPilotAmount([
  {side:'BUY',reserved_won:30300,state:'ACCEPTED'},
  {side:'BUY',reserved_won:1000,state:'REJECTED'},
  {side:'SELL',reserved_won:0,state:'ACCEPTED'},
 ]),30300)
 assert.equal(reservedPilotAmount([{side:'BUY',reserved_won:-10,state:'SENDING'}]),null)
})
test('live trial passes existing account state without rewriting authenticated KB endpoints',()=>{
 const app=readFileSync('src/App.tsx','utf8')
 const trial=readFileSync('src/LiveTrial.tsx','utf8')
 const card=readFileSync('src/LiveAccountHoldings.tsx','utf8')
 const risk=readFileSync('src/LiveRiskPreview.tsx','utf8')
 assert.match(app,/<LiveTrial token=\{token\} holdings=\{holdings\} accountSummary=\{accountSummary\}/)
 assert.match(app,/onRefreshAccount=\{refresh\}/)
 assert.match(trial,/<LiveAccountHoldings /)
 assert.match(card,/주문 가능 현금/)
 assert.match(card,/보유종목별 수량 · 평가금액/)
 assert.match(card,/실계좌 시험매매 한도/)
 assert.match(card,/조회되지 않음/)
 assert.match(risk,/findAccountHolding\(holdings,code\)/)
 assert.match(risk,/기존 보유종목은 실주문 시 별도 확인/)
})

test('partially filled canceled purchase still consumes conservative 50k pilot capacity',()=>{
 assert.equal(reservedPilotAmount([
  {side:'BUY',reserved_won:45000,state:'CANCELED',filled_quantity:2},
  {side:'BUY',reserved_won:1500,state:'CANCELED',filled_quantity:0}
 ]),45000)
})
