import test from 'node:test'
import assert from 'node:assert/strict'
import {parseActiveVersion} from '../scripts/parse-deployment-status.mjs'

test('Wrangler deployments status parses the real output format',()=>{
 const output=` ⛅️ wrangler 4.158.0
────────────────────
Created:     2026-11-06T12:45:07.310Z
Message:     Restore working version before live trial
Version(s):  (100%) 9245b9ea-dc1f-41e4-a28f-f0577a44a521
                 Created:  2026-11-06T09:17:32.895Z`
 assert.equal(parseActiveVersion(output),'9245b9ea-dc1f-41e4-a28f-f0577a44a521')
})
test('does not mistake partial or absent deployments for safe rollback',()=>{
 assert.throws(()=>parseActiveVersion('Version(s): (20%) 9245b9ea-dc1f-41e4-a28f-f0577a44a521'))
 assert.throws(()=>parseActiveVersion('no healthy upstream'))
 assert.throws(()=>parseActiveVersion('Version(s): (100%) not-a-uuid'))
})
test('rejects ambiguous multiple 100% versions',()=>{
 assert.throws(()=>parseActiveVersion(`Version(s): (100%) 9245b9ea-dc1f-41e4-a28f-f0577a44a521
Version(s): (100%) fff8e992-37d4-457c-b250-7a1d70a84289`))
})
