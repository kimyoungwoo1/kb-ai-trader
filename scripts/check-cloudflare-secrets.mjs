#!/usr/bin/env node
// Read-only deployment preflight. Never prints secret values.
import { execFileSync } from 'node:child_process'
const required = ['DASHBOARD_API_KEY', 'KB_APP_KEY', 'KB_APP_SECRET']
let result
try {
  result = execFileSync('npx', ['wrangler', 'secret', 'list', '--config', 'worker/wrangler.jsonc'], {
    cwd: process.cwd(), encoding: 'utf8', timeout: 30000, stdio: ['ignore', 'pipe', 'pipe'],
  })
} catch (error) {
  console.error('Secret 목록 조회에 실패했습니다. 배포를 중단하세요.')
  process.exit(1)
}
let names
try {
  const data = JSON.parse(result.slice(result.indexOf('[')))
  names = new Set(data.map(item => item.name))
} catch {
  console.error('Secret 목록을 해석할 수 없습니다. 배포를 중단하세요.')
  process.exit(1)
}
const missing = required.filter(name => !names.has(name))
if (missing.length) {
  console.error('필수 Secret 누락: ' + missing.join(', ') + ' — 배포 금지')
  process.exit(1)
}
console.log('필수 Secret 이름 확인 완료. 다만 실제 배포 후 Secret 유지까지 보장하지 않습니다.')
