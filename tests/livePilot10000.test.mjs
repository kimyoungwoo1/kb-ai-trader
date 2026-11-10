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
 assert.match(execution,/실주문 시작/)
 assert.match(deploy,/LIVE_TRADING_HARD_ENABLE is deliberately never inherited/)
 assert.doesNotMatch(deploy,/\{name:'LIVE_TRADING_HARD_ENABLE',type:'secret_text'/)
})

test('live pilot preserves existing approval only for the same active pilot and D1',()=>{
 assert.match(deploy,/livePilot10000 = process\.argv\.includes\('--live-pilot-10000'\)/)
 assert.match(deploy,/KB_LIVE_PILOT_CONFIRM!=='실계좌 1만원 시험배포 승인'/)
 assert.match(deploy,/livePilot10000\?\[\{name:'LIVE_TRADING_HARD_ENABLE',type:'plain_text'/)
 assert.match(deploy,/paperDbId===activePaperDbId/)
 assert.match(deploy,/activePilotBinding\.text===livePilotFlag/)
 const preserve=deploy.indexOf('if(preserveLiveApproval){')
 const firstOptIn=deploy.indexOf('}else if(livePilot10000){',preserve)
 const switchAt=deploy.indexOf('switched=true',firstOptIn)
 assert.ok(preserve>=0&&firstOptIn>preserve&&switchAt>firstOptIn)
 assert.doesNotMatch(deploy.slice(preserve,firstOptIn),/d1\/database|UPDATE SET/)
 assert.match(deploy.slice(firstOptIn,switchAt),/UPDATE SET enabled=0,trading_day=NULL/)
 assert.match(deploy,/newBindings\.get\('LIVE_TRADING_HARD_ENABLE'\)==='plain_text'/)
})
