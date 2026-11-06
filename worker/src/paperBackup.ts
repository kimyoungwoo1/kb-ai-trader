/**
 * Explicit-only D1 backup of PAPER trading data.
 * This is not a cloud matching engine: no broker orders or implicit auto-restore.
 */
export type PaperBackup = {
  format: 1
  savedAt: string
  ledger: {
    cash: number
    positions: unknown[]
    trades: unknown[]
  }
  account: {
    enabled: boolean
    cash: number
    positions: unknown[]
    pending: unknown[]
    fills: unknown[]
    runs: unknown[]
    equityHistory: unknown[]
    lastCycle: string
    lastMessage: string
  }
  screening: unknown | null
}
type Db = {
  prepare: (sql: string) => {
    bind: (...values: unknown[]) => {
      first: <T = Record<string, unknown>>() => Promise<T | null>
      run: () => Promise<{ success: boolean; meta?: { changes?: number } }>
    }
  }
}
type Head = { revision: number; updated_at: string; snapshot_json: string }
const MAX_BYTES = 1_700_000
const validId = (value: unknown) => typeof value === 'string' && /^\d{6}$/.test(value)
const money = (value: unknown) => typeof value === 'number' && Number.isFinite(value) && value >= 0
const arrayMax = (value: unknown, max: number) => Array.isArray(value) && value.length <= max
export function validatePaperBackup(value: unknown): value is PaperBackup {
  if (!value || typeof value !== 'object') return false
  const item = value as Record<string, any>
  if (item.format !== 1 || !Number.isFinite(Date.parse(item.savedAt))) return false
  const ledger = item.ledger, account = item.account
  if (!ledger || !account || !money(ledger.cash) || !money(account.cash)
    || typeof account.enabled !== 'boolean' || typeof account.lastCycle !== 'string'
    || typeof account.lastMessage !== 'string'
    || !arrayMax(ledger.positions, 50) || !arrayMax(ledger.trades, 10000)
    || !arrayMax(account.positions, 50) || !arrayMax(account.pending, 250)
    || !arrayMax(account.fills, 2000) || !arrayMax(account.runs, 50)
    || !arrayMax(account.equityHistory, 20000)) return false
  for (const p of ledger.positions) {
    if (!p || !validId(p.code) || typeof p.name !== 'string'
      || !Number.isInteger(p.quantity) || p.quantity < 1
      || !money(p.averagePrice) || !money(p.lastPrice)) return false
  }
  for (const trade of ledger.trades) {
    if (!trade || !validId(trade.code) || typeof trade.id !== 'string'
      || !Number.isFinite(Date.parse(trade.time))
      || !['BUY', 'SELL'].includes(trade.side)
      || !money(trade.amount) || !money(trade.price)
      || !Number.isInteger(trade.quantity) || trade.quantity < 1) return false
  }
  for (const fill of account.fills) {
    if (!fill || !validId(fill.code) || !['BUY', 'SELL'].includes(fill.side)
      || typeof fill.id !== 'string' || !Number.isFinite(Date.parse(fill.at))) return false
  }
  for (const p of account.positions) {
    if (!p || !validId(p.code) || !Number.isInteger(p.quantity) || p.quantity < 1) return false
  }
  return true
}
const head = (db: Db) => db.prepare('SELECT revision, updated_at, snapshot_json FROM paper_backup_head WHERE id = 1')
  .bind().first<Head>()
export async function handlePaperBackup(body: unknown, db: Db): Promise<Response> {
  const input = body && typeof body === 'object' ? body as Record<string, unknown> : {}
  const action = input.action
  if (!['status','load','save','claim','renew','release'].includes(String(action))) return Response.json({
    success: false, message: '알 수 없는 백업 명령입니다.',
  }, { status: 400 })
  try {
    if (action === 'claim' || action === 'renew' || action === 'release') {
      const owner = input.owner
      if (typeof owner !== 'string' || !/^[a-zA-Z0-9_-]{20,100}$/.test(owner))
        return Response.json({ success: false, message: '감시 세션 식별자가 올바르지 않습니다.' }, { status: 400 })
      const nowMs = Date.now()
      if (action === 'release') {
        await db.prepare(
          'UPDATE paper_trade_lease SET lease_until = 0 WHERE id = 1 AND owner = ?'
        ).bind(owner).run()
        return Response.json({ success: true, released: true })
      }
      const expected = input.expectedRevision
      if (!Number.isInteger(expected) || (expected as number) < 0)
        return Response.json({ success: false, message: '서버 백업 버전 확인이 필요합니다.' }, { status: 400 })
      // Single-row conditional UPDATE serializes claims across browser tabs and PCs.
      await db.prepare(
        "INSERT OR IGNORE INTO paper_trade_lease (id, owner, lease_until) VALUES (1, '', 0)"
      ).bind().run()
      const ttlMs = 90_000
      const query = action === 'claim'
        ? 'UPDATE paper_trade_lease SET owner = ?, lease_until = ? WHERE id = 1 AND (lease_until <= ? OR owner = ?) AND COALESCE((SELECT revision FROM paper_backup_head WHERE id = 1), 0) = ?'
        : 'UPDATE paper_trade_lease SET owner = ?, lease_until = ? WHERE id = 1 AND owner = ? AND lease_until > ?'
      const result = action === 'claim'
        ? await db.prepare(query).bind(owner, nowMs + ttlMs, nowMs, owner, expected).run()
        : await db.prepare(query).bind(owner, nowMs + ttlMs, owner, nowMs).run()
      if (!result.success) throw Error('lease write failed')
      if ((result.meta?.changes || 0) < 1)
        return Response.json({ success: false, conflict: true,
          message: '다른 기기가 자동매매 중이거나 서버 백업 버전이 변경되었습니다. 자동매매를 중지해 주세요.' }, { status: 409 })
      return Response.json({ success: true, active: true,
        lease_until: nowMs + ttlMs, revision: expected })
    }
    if (action === 'status') {
      const current = await head(db)
      return Response.json({ success: true, configured: true,
        revision: current?.revision || 0, updated_at: current?.updated_at || null,
        has_backup: !!current })
    }
    if (action === 'load') {
      const current = await head(db)
      if (!current) return Response.json({ success: false,
        message: '서버에 저장된 가상매매 백업이 없습니다.' }, { status: 404 })
      const data = JSON.parse(current.snapshot_json)
      if (!validatePaperBackup(data)) return Response.json({
        success: false, message: '서버 백업 구조 검증에 실패했습니다.' }, { status: 500 })
      return Response.json({ success: true, revision: current.revision,
        updated_at: current.updated_at, snapshot: data })
    }
    const expected = input.expectedRevision
    if (!Number.isInteger(expected) || (expected as number) < 0) return Response.json({
      success: false, message: '백업 버전 확인이 필요합니다.' }, { status: 400 })
    const snapshot = input.snapshot
    if (!validatePaperBackup(snapshot)) return Response.json({
      success: false, message: '가상매매 백업의 구조가 올바르지 않습니다.' }, { status: 400 })
    const json = JSON.stringify(snapshot)
    // Reject accidental credential material, including nested extra fields.
    if (/"(?:app[_-]?key|app[_-]?secret|api[_-]?key|secret|password|access[_-]?token|refresh[_-]?token|dashboard[_-]?api[_-]?key)"\s*:/i.test(json))
      return Response.json({ success: false,
        message: '가상매매 백업에는 인증 정보나 API Secret을 포함할 수 없습니다.' }, { status: 400 })
    if (new TextEncoder().encode(json).byteLength > MAX_BYTES) return Response.json({
      success: false, message: '백업 용량 상한(1.7MB)을 초과했습니다.' }, { status: 413 })
    const now = new Date().toISOString()
    let result: { success: boolean; meta?: { changes?: number } }
    const owner = typeof input.owner === 'string' && /^[a-zA-Z0-9_-]{20,100}$/.test(input.owner)
      ? input.owner : ''
    const nowMs = Date.now()
    if (expected === 0) {
      result = await db.prepare(
        "INSERT OR IGNORE INTO paper_backup_head (id, revision, updated_at, snapshot_json) SELECT 1, 1, ?, ? WHERE " +
        "NOT EXISTS (SELECT 1 FROM paper_trade_lease WHERE id = 1 AND lease_until > ? AND owner <> ?)"
      ).bind(now, json, nowMs, owner).run()
    } else {
      result = await db.prepare(
        'UPDATE paper_backup_head SET revision = revision + 1, updated_at = ?, snapshot_json = ? WHERE id = 1 AND revision = ? ' +
        'AND (NOT EXISTS (SELECT 1 FROM paper_trade_lease WHERE id = 1 AND lease_until > ?) ' +
        'OR EXISTS (SELECT 1 FROM paper_trade_lease WHERE id = 1 AND owner = ? AND lease_until > ?))'
      ).bind(now, json, expected, nowMs, owner, nowMs).run()
    }
    if (!result.success) throw Error('database write failed')
    if ((result.meta?.changes || 0) < 1) {
      const current = await head(db)
      return Response.json({ success: false, conflict: true,
        revision: current?.revision || 0, updated_at: current?.updated_at || null,
        message: '다른 기기 또는 탭에서 백업이 변경되었습니다. 자동 덮어쓰기를 차단했습니다.' },
      { status: 409 })
    }
    const revision = (expected as number) + 1
    // A periodic no-trade checkpoint updates HEAD but avoids a full-size
    // history row. Snapshots containing fills and explicit manual saves are archived.
    const checkpointOnly = input.checkpointOnly === true
    let historySaved = checkpointOnly ? false : true
    if (!checkpointOnly) {
      try {
        const audit = await db.prepare(
          'INSERT INTO paper_backup_history (revision, updated_at, snapshot_json) VALUES (?, ?, ?)'
        ).bind(revision, now, json).run()
        historySaved = !!audit.success
      } catch { historySaved = false }
    }
    return Response.json({ success: true, revision, updated_at: now,
      history_saved: historySaved, checkpoint_only: checkpointOnly })
  } catch {
    return Response.json({ success: false,
      message: 'D1 백업 테이블을 확인할 수 없습니다. 데이터베이스 바인딩과 초기화 상태를 확인해 주세요.' }, { status: 503 })
  }
}
