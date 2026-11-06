import test from 'node:test'
import assert from 'node:assert/strict'
import {readFileSync} from 'node:fs'

const code=readFileSync('scripts/deploy-verified-production.mjs','utf8')

test('isolated Worker version must pass real KB holdings and valuation before traffic switch',()=>{
 const before=code.indexOf("await probeVersion(previewOrigin,probeKey,'신규 버전 사전 검사')")
 const switching=code.indexOf("switched=true")
 assert.ok(before>=0,'Missing KB pre-deploy validation')
 assert.ok(switching>before,'Production traffic switched before KB validation')
 assert.match(code,/body\?\.checks\?\.holdings\?\.success===true\s*&&\s*body\?\.checks\?\.valuation\?\.success===true/)
})
test('production verification is structural; no second KB OAuth probe after traffic switch',()=>{
 assert.ok(code.includes("await probeVersion(domain,probeKey,'운영 전환 후 구조 재검사',{checkAccount:false})"))
 assert.ok(code.includes("if(!checkAccount){"))
 const first=code.indexOf("if(!checkAccount){")
 const kbCall=code.indexOf("origin+'/api/deploy/verify'",first)
 assert.ok(kbCall>first)
 assert.ok(code.indexOf('return',first)<kbCall,'Structural verification must return before the KB account call')
})
test('post-deploy version identity and automatic rollback verification remain enabled',()=>{
 assert.match(code,/ensure\(activeAfter===createdId/)
 assert.match(code,/ensure\(restored===rollbackVersion/)
})
