/**
 * Server Cron observability; independent from the paper trading ledger.
 * Failures in monitoring do not alter simulation state or trigger orders.
 */
import { serverPaperTick, type TickOutcome } from './serverPaper'

type Db = any
type Post = (path: string, data: unknown) => Promise<any>
type MonitorRow = { slot: number; started_at: string; finished_at: string; result: string; message: string; scanned: number; filled: number }
const iso = (d: Date) => d.toISOString()
const known = new Set(['market_closed','stopped','duplicate','busy','scanned','watched','no_symbols','error'])
export const isCronHealthy = (last: string | null, now = Date.now()) => {
  const time = Date.parse(last || '')
  return Number.isFinite(time) && now - time >= 0 && now - time <= 3 * 60_000
}
export async function readServerCronMonitor(db: Db): Promise<{
  last_tick: MonitorRow | null; recent: MonitorRow[]; last_success: MonitorRow | null;
  today: { total: number; completed: number; errors: number; skipped: number };
}> {
  const recentQuery = await db.prepare(
    'SELECT slot,started_at,finished_at,result,message,scanned,filled FROM server_paper_cron_runs ORDER BY slot DESC LIMIT 12'
  ).all()
  const recent = (recentQuery.results || []) as MonitorRow[]
  const lastGood = await db.prepare(
    "SELECT slot,started_at,finished_at,result,message,scanned,filled FROM server_paper_cron_runs WHERE result IN ('scanned','watched') ORDER BY slot DESC LIMIT 1"
  ).first<MonitorRow>()
  const kst = new Date(Date.now() + 9 * 3600_000).toISOString().slice(0,10)
  const from = Date.parse(kst+'T00:00:00+09:00')
  const daily = await db.prepare(
    "SELECT COUNT(*) AS total, SUM(CASE WHEN result IN ('scanned','watched') THEN 1 ELSE 0 END) AS completed, SUM(CASE WHEN result='error' THEN 1 ELSE 0 END) AS errors, SUM(CASE WHEN result IN ('market_closed','stopped','busy','duplicate','no_symbols') THEN 1 ELSE 0 END) AS skipped FROM server_paper_cron_runs WHERE slot >= ?"
  ).bind(Math.floor(from/60000)).first<Record<string,number|null>>()
  return {last_tick:recent[0] || null,recent,last_success:lastGood || null,
    today: {total:Number(daily?.total)||0,completed:Number(daily?.completed)||0,errors:Number(daily?.errors)||0,skipped:Number(daily?.skipped)||0}}
}
export async function runMonitoredPaperCron(db: Db | undefined, post: Post, date = new Date()): Promise<TickOutcome> {
  const slot = Math.floor(date.getTime()/60_000)
  const started = iso(date)
  let outcome: TickOutcome
  try {
    outcome = await serverPaperTick(db,post,date)
  } catch (error) {
    outcome = {result:'error',message:error instanceof Error ? error.message.slice(0,180) : '서버 Cron 처리 오류',scanned:0,filled:0}
  }
  if (!db) return outcome
  try {
    if (!known.has(outcome.result)) throw Error('알 수 없는 Cron 결과')
    await db.prepare(
      'INSERT INTO server_paper_cron_runs(slot,started_at,finished_at,result,message,scanned,filled) ' +
      'VALUES(?,?,?,?,?,?,?) ON CONFLICT(slot) DO UPDATE SET ' +
      'finished_at=excluded.finished_at, result=excluded.result, message=excluded.message, scanned=excluded.scanned, filled=excluded.filled ' +
      "WHERE server_paper_cron_runs.result IN ('duplicate','busy','error') AND excluded.result NOT IN ('duplicate','busy')"
    ).bind(slot,started,new Date().toISOString(),outcome.result,outcome.message.slice(0,180),outcome.scanned,outcome.filled).run()
    // Daily pruning; retain 14 days of execution history without growing D1 indefinitely.
    const kstHour = new Date(date.getTime()+9*3600_000).getUTCHours()
    const kstMinute = new Date(date.getTime()+9*3600_000).getUTCMinutes()
    if (kstHour===0 && kstMinute===0) await db.prepare('DELETE FROM server_paper_cron_runs WHERE slot < ?')
      .bind(slot-14*24*60).run()
  } catch (error) {
    // The core simulation result should survive an observability outage.
    console.error('Cron monitor D1 write failed',error instanceof Error ? error.name : 'unknown')
  }
  return outcome
}
