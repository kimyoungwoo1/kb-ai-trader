import test from 'node:test'
import assert from 'node:assert/strict'
import {readFileSync} from 'node:fs'

const execution=readFileSync('worker/src/liveExecution.ts','utf8')
const trial=readFileSync('worker/src/liveTrial.ts','utf8')
const risk=readFileSync('worker/src/liveRiskPreflight.ts','utf8')
const contract=readFileSync('worker/src/kbOrderContract.ts','utf8')
const ui=readFileSync('src/liveBuyValidation.ts','utf8')
const deploy=readFileSync('scripts/deploy-verified-production.mjs','utf8')

test('10,000 KRW pilot cap is enforced at every independent buy boundary',()=>{
 assert.match(execution,/export const MAX_PILOT_WON=10_000/)
 assert.match(execution,/Math\.floor\(9_900\/fill\.price\)/)
 assert.match(trial,/export const LIVE_TRIAL_BUDGET=10_000/)
 assert.match(risk,/export const PILOT_LIMIT_WON = 10_000/)
 assert.match(contract,/input\.quantity\*input\.price>10_000/)
 assert.match(ui,/total>10_000/)
})
test('ordinary production deployment remains hard-locked against real orders',()=>{
 assert.match(execution,/ALLOW_REAL_10000_TRIAL_2026/)
 assert.match(execution,/실계좌 1만원 자동매매 실행/)
 assert.match(deploy,/LIVE_TRADING_HARD_ENABLE is deliberately never inherited/)
 assert.doesNotMatch(deploy,/\{name:'LIVE_TRADING_HARD_ENABLE',type:'secret_text'/)
})
