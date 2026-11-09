#!/usr/bin/env node
// Read-only deployment gate: only show secret NAMES, never values.
// A rollback can run with secrets from its version even when the latest upload has none.
import { execFileSync } from 'node:child_process'

const required = ['DASHBOARD_API_KEY', 'KB_APP_KEY', 'KB_APP_SECRET', 'GEMINI_API_KEY', 'DART_API_KEY']
const knownGoodId = 'dafe0360-d736-4bf2-8a82-eb4ed03e48a4'
function run(args) {
  return execFileSync('npx', ['wrangler', ...args, '--config', 'worker/wrangler.jsonc'], {
    cwd: process.cwd(), encoding: 'utf8', timeout: 60000, stdio: ['ignore', 'pipe', 'pipe'],
  })
}
function namesFromVersion(value) {
  const bindings = [
    value?.bindings,
    value?.resources?.bindings,
    value?.version?.bindings,
    value?.result?.resources?.bindings,
    value?.result?.bindings,
  ].find(Array.isArray)
  return new Set((bindings ?? []).filter(b => b?.type === 'secret_text').map(b => b.name))
}
let goodNames
try {
  const output = run(['versions', 'view', knownGoodId, '--name', 'kb-ai-trader', '--json'])
  goodNames = namesFromVersion(JSON.parse(output))
} catch {
  console.error('복구된 정상 버전의 바인딩 정보를 읽을 수 없습니다. 배포 금지.')
  process.exit(1)
}
const goodMissing = required.filter(name => !goodNames.has(name))
if (goodMissing.length) {
  console.error('정상 버전 바인딩 정보 불일치: ' + goodMissing.join(', ') + '. 배포 금지.')
  process.exit(1)
}
console.log('정상 롤백 버전에는 필수 Secret 5개의 바인딩이 존재합니다.')
let currentNames
try {
  const output = run(['secret', 'list'])
  const arrayStart = output.indexOf('[')
  const items = JSON.parse(output.slice(arrayStart))
  currentNames = new Set(items.map(item => item.name))
} catch {
  console.error('현재 Wrangler 배포 대상의 Secret 목록을 읽을 수 없습니다. 배포 금지.')
  process.exit(1)
}
const missing = required.filter(name => !currentNames.has(name))
if (missing.length) {
  console.error('현재 Wrangler 업로드 대상에는 Secret이 누락되어 있습니다: ' + missing.join(', '))
  console.error('정상 버전의 Secret이 존재해도 일반 Wrangler 배포가 이를 자동 상속한다는 보장은 없습니다.')
  console.error('배포 금지. 특정 정상 버전의 바인딩을 상속하는 Cloudflare Workers Version API 경로를 먼저 검증하세요.')
  process.exit(1)
}
console.log('현재 조회된 Secret 이름 5개 존재. 배포 전 새 버전에서 실제 바인딩 승계 여부를 별도로 확인하세요.')
