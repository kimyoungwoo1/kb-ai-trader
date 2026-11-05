#!/usr/bin/env node
// Read-only: compare binding *names and types* for known-good and broken Worker versions.
// Never displays Cloudflare tokens or values.
import { execFileSync } from 'node:child_process'

const workerName = 'kb-ai-trader'
const config = 'worker/wrangler.jsonc'
const versions = [
  ['정상 롤백 버전', 'dafe0360-d736-4bf2-8a82-eb4ed03e48a4'],
  ['오류 발생 버전', 'eadbd3fd-bbe8-4b1b-8e7a-f875bc0b9acf'],
]
const required = ['DASHBOARD_API_KEY', 'KB_APP_KEY', 'KB_APP_SECRET']
function loadVersion(id) {
  const output = execFileSync('npx', [
    'wrangler', 'versions', 'view', id, '--name', workerName, '--config', config, '--json',
  ], {encoding: 'utf8', cwd: process.cwd(), timeout: 60_000, stdio: ['ignore','pipe','pipe']})
  return JSON.parse(output)
}
function findBindings(value) {
  if (!value || typeof value !== 'object') return []
  if (Array.isArray(value)) return []
  // Do not print payloads. Only explore the known metadata paths.
  const candidates = [
    value.bindings,
    value.resources?.bindings,
    value.metadata?.bindings,
    value.version?.bindings,
    value.version?.resources?.bindings,
    value.result?.bindings,
    value.result?.resources?.bindings,
    value.result?.metadata?.bindings,
  ]
  for (const candidate of candidates) {
    if (Array.isArray(candidate)) {
      return candidate.filter(item => item && typeof item.name === 'string')
        .map(item => ({ name: item.name, type: String(item.type ?? 'unknown') }))
    }
    if (candidate && typeof candidate === 'object') {
      return Object.entries(candidate).filter(([name]) => /^[A-Z][A-Z0-9_]+$/.test(name))
        .map(([name, entry]) => ({ name, type: String(entry?.type ?? 'unknown') }))
    }
  }
  return []
}
let failed = false
for (const [label, id] of versions) {
  try {
    const data = loadVersion(id)
    const bindings = findBindings(data)
    console.log('\n' + label + ' (' + id.slice(0, 8) + ')')
    if (!bindings.length) {
      console.log('바인딩 정보를 자동으로 읽지 못했습니다. 해당 버전의 Cloudflare 바인딩 탭에서 확인이 필요합니다.')
      failed = true
      continue
    }
    console.log('바인딩 종류 및 이름:', bindings.map(({name,type}) => name + ' (' + type + ')').join(', '))
    for (const name of required) {
      const binding = bindings.find(x => x.name === name)
      console.log(name + ': ' + (binding ? binding.type : '없음'))
      if (!binding) failed = true
    }
  } catch {
    console.error(label + ': 버전 조회 실패 (Secret이나 토큰 정보는 출력하지 않음)')
    failed = true
  }
}
console.log('\n이 스크립트는 조회 전용이며 Secret 값과 배포를 변경하지 않습니다.')
if (failed) {
  console.error('정상 버전과 신규 버전의 바인딩이 확인되지 않았습니다. 재배포하지 마세요.')
  process.exitCode = 1
}
