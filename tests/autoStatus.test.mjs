import test from 'node:test'
import assert from 'node:assert/strict'
import { getAutoHealth, todayActivity } from '../src/autoStatus.ts'

const now = new Date('2026-11-05T05:00:00Z') // 14:00 KST
const done = { checkedAt: now.toISOString(), processedAt: now.toISOString(), status: '검사 완료', scanned: 30, candidates: 2, filled: 0, message: '정상', decisions: [] }
const account = { enabled: true, runs: [done], fills: [], dailyStats: { date: '2026-11-05', checked: 47, completed: 46, deferred: 1, filled: 2 } }

test('fresh regular-session scan is reported as running normally', () => {
  const health = getAutoHealth(account, now, false, '')
  assert.equal(health.tone, 'ok')
  assert.equal(health.label, '정상 검사 중')
})

test('enabled switch is not misleadingly presented as a successful scan', () => {
  assert.equal(getAutoHealth({ enabled: true, runs: [] }, now, false, '').label, '첫 검사 대기')
  assert.equal(getAutoHealth({ enabled: false, runs: [done] }, now, false, '').tone, 'off')
})

test('delayed and paused scans are visibly distinguished', () => {
  const late = new Date(now.getTime() + 13 * 60000)
  assert.equal(getAutoHealth(account, late, false, '').label, '검사 지연')
  assert.equal(getAutoHealth({ enabled: true, runs: [{ ...done, status: '실행 보류' }] }, now, false, '').label, '매매 판단 보류')
  assert.equal(getAutoHealth(account, now, true, '').label, '시세 수집 중')
  assert.equal(getAutoHealth(account, now, false, '시세 조회 실패').label, '시장 조회 오류')
})

test('after session, enabled engine reports market closed rather than running', () => {
  const after = new Date('2026-11-05T07:00:00Z')
  assert.equal(getAutoHealth(account, after, false, '').label, '장 마감')
})

test('daily totals are not capped by 30 historical run records', () => {
  const result = todayActivity(account, now)
  assert.deepEqual(result, { checked: 47, completed: 46, deferred: 1, filled: 2, partialHistory: false })
})

test('legacy accounts fall back to available run history without resetting data', () => {
  const result = todayActivity({ runs: [done], fills: [] }, now)
  assert.equal(result.checked, 1)
  assert.equal(result.partialHistory, true)
})
