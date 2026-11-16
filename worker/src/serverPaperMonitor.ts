/**
 * Server Cron observability; independent from the paper trading ledger.
 * Failures in monitoring do not alter simulation state or trigger orders.
 */
import { marketOpen, serverPaperTick, type TickOutcome } from './serverPaper'

type Db = any
type Post = (path: string, data: unknown) => Promise<any>
type MonitorRow = { slot: number; started_at: string; finished_at: string; result: string; message: string; scanned: number; filled: number }
// Classify rows written by previous versions without rewriting history.
const legacyPartial = "(result='scanned' AND (instr(message,'일부 실패')>0 OR instr(message,'보유 감시 조회 실패')>0 OR instr(message,'보유 감시 시세 미확인')>0)) OR (result='watched' AND message LIKE '보유·감시 종목 %/%건' AND CAST(substr(message,length('보유·감시 종목 ')+1) AS INTEGER)<scanned)"
const completed = "result IN ('scanned','watched') AND NOT ("+legacyPartial+")"
const iso = (d: Date) => d.toISOString()
const known = new Set(['market_closed','stopped','duplicate','busy','scanned','watched','scan_partial','watch_partial','no_symbols','kb_cooldown','error'])
export const isCronHealthy = (last: string | null, now = Date.now()) => {
  const time = Date.parse(last || '')
  return Number.isFinite(time) && now - time >= 0 && now - time <= 3 * 60_000
}
export function paperCronPhase(scheduledAt:Date,now:Date):'market'|'close'|'off'{
  if (marketOpen(scheduledAt) && marketOpen(now)) return 'market'
  const kst=new Date(scheduledAt.getTime()+9*3600_000)
  const currentKst=new Date(now.getTime()+9*3600_000)
  const day=kst.getUTCDay()
  if(day<1||day>5||kst.getUTCHours()!==15||kst.getUTCMinutes()!==35)return 'off'
  return now>=scheduledAt&&currentKst.toISOString().slice(0,10)===kst.toISOString().slice(0,10)?'close':'off'
}

export async function readServerCronMonitor(db: Db): Promise<{
  last_tick: MonitorRow | null; recent: MonitorRow[]; last_success: MonitorRow | null;
  today: { total: number; completed: number; partial: number; errors: number; skipped: number };
}> {
  const kst = new Date(Date.now() + 9 * 3600_000).toISOString().slice(0,10)
  const from = Date.parse(kst+'T00:00:00+09:00')
  // Independent D1 reads run concurrently. The common 30-second heartbeat
  // does not invoke this function at all.
  const [recentQuery,lastGood,daily] = await Promise.all([
    db.prepare('SELECT slot,started_at,finished_at,result,message,scanned,filled FROM server_paper_cron_runs ORDER BY slot DESC LIMIT 12').all(),
    db.prepare("SELECT slot,started_at,finished_at,result,message,scanned,filled FROM server_paper_cron_runs WHERE "+completed+" ORDER BY slot DESC LIMIT 1").first<MonitorRow>(),
    db.prepare("SELECT COUNT(*) AS total, SUM(CASE WHEN "+completed+" THEN 1 ELSE 0 END) AS completed, SUM(CASE WHEN result IN ('scan_partial','watch_partial') OR ("+legacyPartial+") THEN 1 ELSE 0 END) AS partial, SUM(CASE WHEN result='error' THEN 1 ELSE 0 END) AS errors, SUM(CASE WHEN result IN ('market_closed','stopped','busy','duplicate','no_symbols','kb_cooldown') THEN 1 ELSE 0 END) AS skipped FROM server_paper_cron_runs WHERE slot >= ?")
      .bind(Math.floor(from/60000)).first<Record<string,number|null>>()
  ])
  const recent = ((recentQuery.results || []) as MonitorRow[]).map(row=>{
    if (row.result==='scanned' && /일부 실패|보유 감시 (조회 실패|시세 미확인)/.test(row.message))
      return {...row,result:'scan_partial'};
    const watched = /^보유·감시 종목 (\d+)\/(\d+)건$/.exec(row.message);
    if (row.result==='watched' && watched && Number(watched[1])<Number(watched[2]))
      return {...row,result:'watch_partial'};
    return row;
  })
  return {last_tick:recent[0] || null,recent,last_success:lastGood || null,
    today: {total:Number(daily?.total)||0,completed:Number(daily?.completed)||0,partial:Number(daily?.partial)||0,errors:Number(daily?.errors)||0,skipped:Number(daily?.skipped)||0}}
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
    const recordedResult=outcome.partial && outcome.result==='scanned' ? 'scan_partial' :
      outcome.partial && outcome.result==='watched' ? 'watch_partial' : outcome.result;
    if (!known.has(recordedResult)) throw Error('알 수 없는 Cron 결과')
    await db.prepare(
      'INSERT INTO server_paper_cron_runs(slot,started_at,finished_at,result,message,scanned,filled) ' +
      'VALUES(?,?,?,?,?,?,?) ON CONFLICT(slot) DO UPDATE SET ' +
      'finished_at=excluded.finished_at, result=excluded.result, message=excluded.message, scanned=excluded.scanned, filled=excluded.filled ' +
      "WHERE server_paper_cron_runs.result IN ('duplicate','busy','error') AND excluded.result NOT IN ('duplicate','busy')"
    ).bind(slot,started,new Date().toISOString(),recordedResult,outcome.message.slice(0,180),outcome.scanned,outcome.filled).run()
  } catch (error) {
    // The core simulation result should survive an observability outage.
    console.error('Cron monitor D1 write failed',error instanceof Error ? error.name : 'unknown')
  }
  return outcome
}
