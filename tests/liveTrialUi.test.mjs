import test from 'node:test'
import assert from 'node:assert/strict'
import {readFileSync} from 'node:fs'
import {build} from 'esbuild'

const compiled=await build({entryPoints:['src/liveBuyValidation.ts'],bundle:true,platform:'node',format:'esm',write:false})
const {validateLiveBuyInput}=await import('data:text/javascript;base64,'+Buffer.from(compiled.outputFiles[0].contents).toString('base64'))
test('one share fits the fee-inclusive 50k ceiling, two shares are rejected',()=>{
 assert.equal(validateLiveBuyInput('263750','1','9000'),null)
 const error=validateLiveBuyInput('263750','2','9000')
 assert.match(error,/1주/)
 assert.equal(validateLiveBuyInput('263750','1','49500'),null)
 assert.match(validateLiveBuyInput('263750','1','49504'),/50원 호가 단위/)
 assert.match(validateLiveBuyInput('263750','1','49505'),/50,000원/)
})
test('client rejects bad stock, quantity and price values before contacting KB',()=>{
 assert.match(validateLiveBuyInput('26375','1','9000'),/6자리/)
 assert.match(validateLiveBuyInput('263750','0','9000'),/수량/)
 assert.match(validateLiveBuyInput('263750','1','0'),/지정가/)
 assert.match(validateLiveBuyInput('263750','1','9000.5'),/지정가/)
 assert.match(validateLiveBuyInput('263750','99999999999999','100000'),/수량/)
})
test('risk UI never silently disables an over-limit check or retains earlier results',()=>{
 const source=readFileSync('src/LiveRiskPreview.tsx','utf8')
 assert.match(source,/disabled=\{busy\}/)
 assert.doesNotMatch(source,/disabled=\{!valid\|\|busy\}/)
 assert.match(source,/if\(inputIssue\)\{[^}]*setError\(/)
 assert.match(source,/const invalidate=\(\)=>\{[^}]*setReport\(null\)/s)
 assert.match(source,/requestSequence\.current===requestId/)
})
test('server-confirmed lock response is presented with a live status announcement',()=>{
 const source=readFileSync('src/LiveTrial.tsx','utf8')
 assert.match(source,/action:'disable'/)
 assert.match(source,/setFeedback\('✓ '/)
 assert.match(source,/role="status" aria-live="polite"/)
})
