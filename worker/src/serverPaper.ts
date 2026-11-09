/**
 * Server-owned paper account. D1 is authoritative; browsers are read-only mirrors.
 * No real securities orders are issued. Scheduler is idempotent per UTC minute.
 */
import { generateTradeSignals } from '../../src/tradeSignals';
import { runAutoCycle, runAutoWatchCycle } from '../../src/autoPaper';
import { applyCatalystGate, catalystAllowsPending, type CatalystSnapshot } from '../../src/marketCatalysts';
import type { AutoAccount, AutoFill } from '../../src/autoPaper';
import type { PaperLedger } from '../../src/paperLedger';

type Db = any;
type Snapshot = { format: number; savedAt: string; account: AutoAccount; ledger: PaperLedger; screening?: unknown; catalyst?: CatalystSnapshot };
type StateRow = { revision: number; mode: string; cycle_slot: number; updated_at: string; snapshot_json: string; last_error: string | null };
type Post = (path: string, data: unknown) => Promise<any>;
export type TickOutcome = { result:'market_closed'|'stopped'|'duplicate'|'busy'|'scanned'|'watched'|'no_symbols'|'error'; message:string; filled:number; scanned:number; fills?: AutoFill[] };
const ok = (data: unknown, status = 200) => Response.json(data, { status, headers: { 'Cache-Control': 'no-store' } });
const state = (db: Db) => db.prepare('SELECT revision, mode, cycle_slot, updated_at, snapshot_json, last_error FROM server_paper_state WHERE id=1').first<StateRow>();
const valid = (s: any): s is Snapshot => !!s && typeof s === 'object' && s.ledger &&
  Number.isFinite(s.ledger.cash) && Array.isArray(s.ledger.positions) && Array.isArray(s.ledger.trades) &&
  s.account && Array.isArray(s.account.fills) && Array.isArray(s.account.positions) && Array.isArray(s.account.pending);
const marketOpen = (d = new Date()) => {
  const date = new Date(d.getTime() + 9 * 3600_000);
  const min = date.getUTCHours() * 60 + date.getUTCMinutes();
  return date.getUTCDay() >= 1 && date.getUTCDay() <= 5 && min >= 540 && min < 930;
};
function summarize(row: StateRow | null) {
  if (!row) return { success: true, migrated: false, mode: 'not_migrated' };
  const snapshot = JSON.parse(row.snapshot_json) as Snapshot;
  return { success: true, migrated: true, mode: row.mode, revision: row.revision,
    updated_at: row.updated_at, last_error: row.last_error, snapshot };
}
export async function serverPaperApi(db: Db | undefined, action: string, expectedSignature = '', knownRevision = -1): Promise<Response> {
  if (!db) return ok({ success: false, message: 'PAPER_DB 연결이 필요합니다.' }, 503);
  try {
    if (action === 'status') {
      // A 15-second browser poll must not repeatedly retrieve, parse, and
      // serialize the potentially large D1 paper journal when unchanged.
      const meta = await db.prepare(
        'SELECT revision, mode, updated_at, last_error FROM server_paper_state WHERE id=1'
      ).first<{ revision:number; mode:string; updated_at:string; last_error:string|null }>();
      if (!meta) return ok({ success:true, migrated:false, mode:'not_migrated' });
      const common = { success:true, migrated:true, mode:meta.mode,
        revision:meta.revision, updated_at:meta.updated_at, last_error:meta.last_error };
      if (knownRevision === meta.revision) return ok({ ...common, unchanged:true });
      const current = await state(db);
      if (!current) return ok({ success:true, migrated:false, mode:'not_migrated' });
      // snapshot_json already contains validated persisted JSON. Embed it as
      // raw JSON to avoid materializing and reserializing a 600KB+ object.
      const prefix = JSON.stringify({ success:true, migrated:true, mode:current.mode,
        revision:current.revision, updated_at:current.updated_at, last_error:current.last_error });
      return new Response(prefix.slice(0,-1)+',"snapshot":'+current.snapshot_json+'}', {
        headers:{ 'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store' }
      });
    }
    const row = await state(db);
    if (action === 'migrate') {
      if (row) return ok(summarize(row)); // Never overwrite existing server trades.
      const current = await db.prepare('SELECT revision, snapshot_json FROM paper_backup_head WHERE id=1').first<{revision:number;snapshot_json:string}>();
      if (!current) return ok({ success:false, message:'D1에 기존 가상매매 백업이 없습니다. 먼저 현재 기록을 백업하세요.' }, 409);
      const snapshot = JSON.parse(current.snapshot_json);
      if (!valid(snapshot)) return ok({ success:false, message:'기존 D1 백업 형식을 검증할 수 없습니다.' }, 409);
      const serverSignature = [snapshot.ledger.trades.length,snapshot.ledger.trades.slice(0,4).map((x:any)=>x.id).join('|'),snapshot.account.fills.length,snapshot.account.fills.slice(0,4).map((x:any)=>x.id).join('|')].join(':');
      if (!expectedSignature || expectedSignature !== serverSignature) return ok({success:false, message:'현재 브라우저 거래 기록과 D1 백업이 다릅니다. 최신 기록을 먼저 백업·복원하고 다시 시도하세요.'},409);
      const now = Date.now();
      // Atomic check: a still-running browser trader must not be migrated.
      const imported = { ...snapshot, savedAt: new Date(now).toISOString(),
        account: { ...snapshot.account, enabled: false, lastMessage:'서버 전환 완료 · 서버에서 시작 버튼을 누르면 실행합니다.' } };
      const result = await db.prepare(
        'INSERT OR IGNORE INTO server_paper_state(id,revision,mode,cycle_slot,updated_at,snapshot_json,last_error) ' +
        'SELECT 1,1,\'stopped\',-1,?,?,NULL WHERE NOT EXISTS ' +
        '(SELECT 1 FROM paper_trade_lease WHERE id=1 AND lease_until > ?) AND (SELECT revision FROM paper_backup_head WHERE id=1)=?'
      ).bind(new Date(now).toISOString(), JSON.stringify(imported), now, current.revision).run();
      if ((result.meta?.changes ?? 0) !== 1) return ok({success:false,
        message:'기존 브라우저 자동매매 실행권이 남아 있습니다. 모든 탭에서 중지하고 90초 후 다시 시도하세요.'},409);
      return ok(summarize(await state(db)));
    }
    if (!row) return ok({ success:false, message:'D1 백업에서 서버로 먼저 이전해야 합니다.' },409);
    if (action === 'start' || action === 'stop') {
      const nextMode = action === 'start' ? 'running' : 'stopped';
      const snapshot = JSON.parse(row.snapshot_json) as Snapshot;
      if (!valid(snapshot)) return ok({ success:false, message:'서버 계좌 검증 실패' }, 409);
      snapshot.account.enabled = nextMode === 'running';
      snapshot.account.lastMessage = nextMode === 'running' ? '서버 자동 가상매매 실행 중' : '서버 자동 가상매매 중지';
      const next = await db.prepare('UPDATE server_paper_state SET revision=revision+1, mode=?, updated_at=?, snapshot_json=?, last_error=NULL WHERE id=1 AND revision=?')
        .bind(nextMode,new Date().toISOString(),JSON.stringify(snapshot),row.revision).run();
      if ((next.meta?.changes ?? 0) !== 1) return ok({success:false,message:'동시 변경 발생 · 상태를 새로 조회하세요.'},409);
      return ok(summarize(await state(db)));
    }
    return ok({ success:false,message:'지원하지 않는 서버 가상매매 명령입니다.' },400);
  } catch (error) {
    return ok({ success:false,message:'D1 서버 가상매매 오류: '+(error instanceof Error ? error.message.slice(0,180) : '알 수 없는 오류') },503);
  }
}
export async function serverPaperTick(db: Db | undefined, post: Post, date = new Date()): Promise<TickOutcome> {
  if (!db) return {result:'error',message:'D1 데이터베이스 연결 없음',filled:0,scanned:0};
  if (!marketOpen(date)) return {result:'market_closed',message:'정규장 외 · 매매 검사 없음',filled:0,scanned:0};
  const row = await state(db);
  if (!row || row.mode !== 'running') return {result:'stopped',message:'서버 자동매매 중지 상태',filled:0,scanned:0};
  const slot = Math.floor(date.getTime() / 60_000);
  if (row.cycle_slot >= slot) return {result:'duplicate',message:'이미 처리된 1분 구간',filled:0,scanned:0};
  // A single conditional write reserves this minute across all Worker instances.
  const reserved = await db.prepare('UPDATE server_paper_state SET revision=revision+1, cycle_slot=?, busy_until=? WHERE id=1 AND revision=? AND mode=\'running\' AND cycle_slot < ? AND busy_until < ?')
    .bind(slot,date.getTime()+180_000,row.revision,slot,date.getTime()).run();
  if ((reserved.meta?.changes ?? 0) !== 1) return {result:'busy',message:'다른 서버 실행이 처리 중',filled:0,scanned:0};
  const writeRevision = row.revision+1;
  let snapshot: Snapshot;
  try { snapshot = JSON.parse(row.snapshot_json); if (!valid(snapshot)) throw Error('서버 원장 형식 오류'); }
  catch {
    await db.prepare('UPDATE server_paper_state SET last_error=?, busy_until=0 WHERE id=1 AND revision=? AND cycle_slot=?')
      .bind('서버 원장 형식 오류',writeRevision,slot).run().catch(()=>{});
    return {result:'error',message:'서버 원장 형식 오류',filled:0,scanned:0};
  }
  if (!snapshot.account.enabled) {
    await db.prepare('UPDATE server_paper_state SET busy_until=0 WHERE id=1 AND revision=? AND cycle_slot=?').bind(writeRevision,slot).run().catch(()=>{});
    return {result:'stopped',message:'서버 계좌가 비활성화됨',filled:0,scanned:0};
  }
  let message = '';
  try {
    const watched = [...snapshot.account.positions,...snapshot.account.pending]
      .filter(x => /^\d{6}$/.test(x.code)).filter((x,i,a)=>a.findIndex(t=>t.code===x.code)===i)
      .slice(0,5).map(x=>({code:x.code,name:x.name}));
    const doScan = slot % 5 === 0;
    const symbols = doScan ? await (async()=>{
      const discover = await post('/api/market/discover',{});
      if (!discover.success || !Array.isArray(discover.candidates)) throw Error('시장 후보 발견 실패');
      const pool = discover.candidates.filter((x:any)=>/^\d{6}$/.test(String(x.code)) && !/ETF|ETN|레버리지|인버스/.test(String(x.name)));
      const rotated = pool.slice(((Math.floor(slot/5)*15)%Math.max(pool.length,1)));
      const selected = [...watched,...rotated,...pool].filter((x:any,i:number,a:any[])=>a.findIndex(y=>y.code===x.code)===i);
      return selected.slice(0,25);
    })() : watched;
    if (!symbols.length) {
      await db.prepare('UPDATE server_paper_state SET busy_until=0, last_error=NULL WHERE id=1 AND revision=? AND cycle_slot=?')
        .bind(writeRevision,slot).run();
      return {result:'no_symbols',message:'빠른 감시 대상 없음 · 다음 전체시장 검사 대기',filled:0,scanned:0};
    }
    const now = new Date();
    const checkedAt = now.toISOString();
    let nextAccount: AutoAccount;
    let nextLedger: PaperLedger = snapshot.ledger;
    const store = { read:()=>nextLedger, write:(value:PaperLedger)=>{nextLedger=value} };
    if (doScan) {
      const [flow,disclosures,news] = await Promise.all([
        Promise.all(Array.from({length:Math.ceil(symbols.length/10)},(_,i)=>symbols.slice(i*10,i*10+10))
          .map(chunk=>post('/api/market/investor-flow',{stocks:chunk}))),
        post('/api/market/disclosures',{complete:true}),
        post('/api/market/research',{skip_ai:true}),
      ]);
      const quotes:any[] = [];
      for (const f of flow) {
        if (!f.success || !Array.isArray(f.results)) throw Error('KB 정밀 시세 조회 실패');
        quotes.push(...f.results);
      }
      const checks = Array.isArray(news.diagnostics) ? news.diagnostics : [];
      const newsSources = checks.filter((x:any)=>x.status===200 && x.count>0).length;
      const catalyst: CatalystSnapshot = {
        checkedAt, newsOk: news.success===true && newsSources>0,
        dartOk: disclosures.success===true,
        dartComplete: disclosures.complete===true,
        articles: Array.isArray(news.articles)?news.articles:[],
        disclosures: Array.isArray(disclosures.disclosures)?disclosures.disclosures:[],
        newsSources, dartReported:Number(disclosures.total_count)||0, message:'서버 뉴스·공시 확인',
      };
      const signals = applyCatalystGate(generateTradeSignals(quotes,200_000,now),catalyst,now).signals;
      snapshot.catalyst = catalyst;
      snapshot.screening = { checkedAt, signals };
      nextAccount = runAutoCycle(snapshot.account,signals,quotes,checkedAt,now,store);
      message = '시장 정밀검사 '+quotes.length+'종목 · '+(catalyst.newsOk && catalyst.dartComplete ? '뉴스·공시 검증':'신규 매수 보류');
    } else {
      // On non-scan minutes, only watch held/pending symbols; old candidate data
      // never justifies a new BUY unless the queued trigger was created by a valid scan.
      const reply = await post('/api/kb/quotes',{stocks:symbols});
      if (!reply.success || reply.rate_limited || reply.token_expired || !Array.isArray(reply.results))
        throw Error('KB 빠른 현재가 조회 보류');
      const validQuotes = reply.results.filter((x:any)=>!x.error && Number.isFinite(x.price) && x.price>0
        && Number.isFinite(Date.parse(x.checked_at)) && Date.now()-Date.parse(x.checked_at)<120_000);
      if (!validQuotes.length) throw Error('유효한 최신 현재가 없음');
      // Fast path: sell-side risk checks remain active, new entries are gated to
      // the next comprehensive market/news scan.
      const allowed = snapshot.account.pending.filter(item =>
        catalystAllowsPending(item.code,item.name,snapshot.catalyst || null,now));
      const paused = snapshot.account.pending.filter(item =>
        !allowed.some(valid=>valid.code===item.code));
      const guardedAccount = { ...snapshot.account, pending:allowed };
      nextAccount = runAutoWatchCycle(guardedAccount,validQuotes.map((x:any)=>({
        code:x.code,name:x.name,price:x.price,
      })),checkedAt,now,store,symbols.length);
      nextAccount.pending = [...nextAccount.pending,...paused];
      message = '보유·감시 종목 '+validQuotes.length+'/'+symbols.length+'건';
    }
    const oldFills = new Set(snapshot.account.fills.map(f=>f.id));
    const newFills=nextAccount.fills.filter(f=>!oldFills.has(f.id));
    const executedFills = newFills.length;
    snapshot = {...snapshot, account:nextAccount, ledger:nextLedger,savedAt:checkedAt};
    const res = await db.prepare('UPDATE server_paper_state SET snapshot_json=?, revision=revision+1, updated_at=?, last_error=NULL, busy_until=0 WHERE id=1 AND revision=? AND mode=\'running\' AND cycle_slot=?')
      .bind(JSON.stringify(snapshot),new Date().toISOString(),writeRevision,slot).run();
    if ((res.meta?.changes ?? 0)!==1) return {result:'busy',message:'원장 변경 경합 · 거래 결과 반영 안 함',filled:0,scanned:0};
    return {result:doScan ? 'scanned' : 'watched',message,filled:executedFills,scanned:symbols.length,fills:newFills};
  } catch (error) {
    const diagnostic = error instanceof Error ? error.message.slice(0,180) : '서버 감시 실패';
    await db.prepare('UPDATE server_paper_state SET last_error=?, busy_until=0 WHERE id=1 AND revision=? AND mode=\'running\' AND cycle_slot=?')
      .bind(diagnostic,writeRevision,slot).run().catch(()=>{});
    return {result:'error',message:diagnostic,filled:0,scanned:0};
  }
}
