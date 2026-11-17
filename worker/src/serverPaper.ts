import {isKrxRegularSession as marketOpen} from '../../src/marketSession'
export {isKrxRegularSession as marketOpen} from '../../src/marketSession'
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
type ScanSymbol = {code:string;name:string};
type ScanProgress = {startedAt:number;symbols:ScanSymbol[];quotes:any[]};
type Snapshot = { format: number; savedAt: string; account: AutoAccount; ledger: PaperLedger; screening?: unknown; catalyst?: CatalystSnapshot; scanProgress?: ScanProgress; scanRetryAfterSlot?:number; scanLease?:{slot:number; expiresAt:number}; modeEpoch?:number };
type StateRow = { busy_until:number; revision: number; mode: string; cycle_slot: number; updated_at: string; snapshot_json: string; last_error: string | null };
type Post = (path: string, data: unknown) => Promise<any>;
export type TickOutcome = { result:'market_closed'|'stopped'|'duplicate'|'busy'|'scanned'|'watched'|'no_symbols'|'kb_cooldown'|'error'; message:string; filled:number; scanned:number; fills?: AutoFill[]; partial?: boolean };
// Reserve Free-plan subrequests for full DART pagination, news and retries.
const scanSymbolLimit = 7;
const candidatePoolLimit = 50;
const kbFailurePrefix = 'KB 조회 실패 · ';
const kbQuoteFailurePrefix = kbFailurePrefix + '현재가 감시 · ';
const kbScanFailurePrefix = kbFailurePrefix + '정밀검사 재시도 · ';
export class KbWatchUnavailable extends Error {}
class KbQuoteUnavailable extends KbWatchUnavailable {}
const ok = (data: unknown, status = 200) => Response.json(data, { status, headers: { 'Cache-Control': 'no-store' } });
const state = (db: Db) => db.prepare('SELECT revision, mode, cycle_slot, updated_at, snapshot_json, last_error, busy_until FROM server_paper_state WHERE id=1').first<StateRow>();
const valid = (s: any): s is Snapshot => !!s && typeof s === 'object' && s.ledger &&
  Number.isFinite(s.ledger.cash) && Array.isArray(s.ledger.positions) && Array.isArray(s.ledger.trades) &&
  s.account && Array.isArray(s.account.fills) && Array.isArray(s.account.positions) && Array.isArray(s.account.pending);
function summarize(row: StateRow | null) {
  if (!row) return { success: true, migrated: false, mode: 'not_migrated' };
  const snapshot = JSON.parse(row.snapshot_json) as Snapshot;
  return { success: true, migrated: true, mode: row.mode, revision: row.revision,
    updated_at: row.updated_at, last_error: row.last_error, snapshot };
}
export async function serverPaperApi(db: Db | undefined, action: string, expectedSignature = '', knownRevision = -1): Promise<Response> {
  if (!db) return ok({ success: false, message: 'PAPER_DB 연결이 필요합니다.' }, 503);
  try {
    if (action === 'status' || action === 'heartbeat') {
      // Heartbeat is intentionally metadata-only: no large D1 journal fetch,
      // parse, serialization, or broker calls on the frequent UI poll.
      // Full status remains available for the initial load and periodic sync.
      const meta = await db.prepare(
        'SELECT revision, mode, updated_at, last_error FROM server_paper_state WHERE id=1'
      ).first<{ revision:number; mode:string; updated_at:string; last_error:string|null }>();
      if (!meta) return ok({ success:true, migrated:false, mode:'not_migrated' });
      const common = { success:true, migrated:true, mode:meta.mode,
        revision:meta.revision, updated_at:meta.updated_at, last_error:meta.last_error };
      if (action === 'heartbeat') return ok({ ...common, heartbeat:true });
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
      if(row.mode!==nextMode) snapshot.modeEpoch=(snapshot.modeEpoch??0)+1;
      snapshot.account.enabled = nextMode === 'running';
      delete snapshot.scanLease;
      delete snapshot.scanProgress;
      delete snapshot.scanRetryAfterSlot;
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
  const scheduledScan = slot % 5 === 0;
  const quoteFailed = row.last_error?.startsWith(kbQuoteFailurePrefix);
  const scanFailed = row.last_error?.startsWith(kbScanFailurePrefix) === true;
  let savedSnapshot:Snapshot|undefined;
  try { savedSnapshot=JSON.parse(row.snapshot_json) as Snapshot; }
  catch { /* Invalid snapshots are handled below. */ }
  const scanInProgress = (savedSnapshot?.scanLease?.expiresAt ?? 0)>date.getTime();
  const scanCoolingDown = scanFailed && slot < (savedSnapshot?.scanRetryAfterSlot ?? row.cycle_slot+2);
  const watchDuringCooldown = (scanCoolingDown || scanInProgress) && !!savedSnapshot?.account?.positions?.length;
  if (scanInProgress && !watchDuringCooldown)
    return {result:'no_symbols',message:'정밀검사 진행 중 · 보유 감시 대상 없음',filled:0,scanned:0};
  // A quote-watch failure does not consume the next scheduled scan.
  // Scan and shared authentication/rate-limit failures still back off.
  if (!watchDuringCooldown && (scanCoolingDown || (!scanFailed && row.last_error?.startsWith(kbFailurePrefix) && slot-row.cycle_slot<2 && !(scheduledScan && quoteFailed))))
    return {result:'kb_cooldown',message:'KB 재조회 대기 · '+row.last_error,filled:0,scanned:0};
  // A single conditional write reserves this minute across all Worker instances.
  const reserved = await db.prepare('UPDATE server_paper_state SET revision=revision+1, cycle_slot=?, busy_until=? WHERE id=1 AND revision=? AND mode=\'running\' AND cycle_slot < ? AND busy_until < ?')
    .bind(slot,date.getTime()+180_000,row.revision,slot,date.getTime()).run();
  if ((reserved.meta?.changes ?? 0) !== 1) return {result:'busy',message:'다른 서버 실행이 처리 중',filled:0,scanned:0};
  let writeRevision = row.revision+1;
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
  const retryScan = row.last_error?.startsWith(kbScanFailurePrefix) ||
    (!quoteFailed && row.last_error?.startsWith(kbFailurePrefix) && row.cycle_slot % 5 === 0);
  const doScan = !scanInProgress && !scanCoolingDown && (scheduledScan || retryScan);
  if (scanCoolingDown && watchDuringCooldown) snapshot.scanRetryAfterSlot ??= row.cycle_slot+2;
  let message = '';
  let scanError: string | null = watchDuringCooldown ? row.last_error : null;
  let watchFills:AutoFill[] = [];
  let watchCount = 0;
  let watchIncomplete = false;
  let watchDetail = '';
  let retryProgress: ScanProgress | undefined;
  let detachedScan = false;
  let commitSlot = slot;
  // Reload current holdings after the independent watcher has had a chance to commit.
  const rebaseScan = async () => {
    const current = await state(db);
    if (!current || current.mode!=='running' || current.busy_until>0) return false;
    const latest = JSON.parse(current.snapshot_json) as Snapshot;
    if (!valid(latest) || !latest.account.enabled || latest.scanLease?.slot!==slot ||
        latest.scanLease.expiresAt<=Date.now()) return false;
    delete latest.scanLease;
    snapshot=latest;
    writeRevision=current.revision;
    commitSlot=current.cycle_slot;
    return true;
  };
  const scanConflict = ():TickOutcome => ({result:'busy',
    message:'원장 변경 경합 · 정밀검사 반영 보류',filled:watchFills.length,scanned:watchCount,fills:watchFills});
  try {
    const watched = [...snapshot.account.positions,...snapshot.account.pending]
      .filter(x => /^\d{6}$/.test(x.code)).filter((x,i,a)=>a.findIndex(t=>t.code===x.code)===i)
      .slice(0,5).map(x=>({code:x.code,name:x.name}));
    if (doScan && snapshot.account.positions.length) {
      const held = watched.filter(symbol=>snapshot.account.positions.some(position=>position.code===symbol.code));
      if (held.length) {
        let watchedSnapshot: Snapshot | undefined;
        try {
          const reply = await post('/api/kb/quotes',{stocks:held});
          const now = new Date();
          const nowMs = now.getTime();
          const quotes = reply.success && !reply.rate_limited && !reply.token_expired && Array.isArray(reply.results)
            ? reply.results.filter((quote:any)=>held.some(symbol=>symbol.code===quote.code) && !quote.error &&
              Number.isFinite(quote.price) && quote.price>0 && nowMs-Date.parse(quote.checked_at)>=0 &&
              nowMs-Date.parse(quote.checked_at)<120_000) : [];
          if (quotes.length) {
            let ledger = snapshot.ledger;
            const account = runAutoWatchCycle({...snapshot.account,pending:[]},quotes,now.toISOString(),now,
              {read:()=>ledger,write:value=>{ledger=value}},held.length);
            watchedSnapshot={...snapshot,account:{...account,pending:snapshot.account.pending},ledger,savedAt:now.toISOString()};
            watchCount=quotes.length;
            watchDetail='보유 감시 '+watchCount+'/'+held.length+'건';
          } else watchDetail='보유 감시 시세 미확인';
        } catch {
          watchDetail='보유 감시 조회 실패';
        }
        watchIncomplete=watchCount<held.length;
        if (watchedSnapshot) {
          const saved = await db.prepare('UPDATE server_paper_state SET snapshot_json=?, revision=revision+1, updated_at=?, last_error=? WHERE id=1 AND revision=? AND mode=\'running\' AND cycle_slot=?')
            .bind(JSON.stringify(watchedSnapshot),watchedSnapshot.savedAt,row.last_error,writeRevision,slot).run();
          if ((saved.meta?.changes ?? 0)!==1) return {result:'busy',message:'원장 변경 경합 · 보유 감시 반영 안 함',filled:0,scanned:0};
          const oldIds=new Set(snapshot.account.fills.map(fill=>fill.id));
          watchFills=watchedSnapshot.account.fills.filter(fill=>!oldIds.has(fill.id));
          snapshot=watchedSnapshot;
          writeRevision++;
        }
      }
    }
    if (doScan) {
      snapshot.scanLease={slot,expiresAt:Date.now()+180_000};
      const released=await db.prepare('UPDATE server_paper_state SET snapshot_json=?, revision=revision+1, updated_at=?, last_error=?, busy_until=0 WHERE id=1 AND revision=? AND mode=\'running\' AND cycle_slot=?')
        .bind(JSON.stringify(snapshot),new Date().toISOString(),row.last_error,writeRevision,slot).run();
      if ((released.meta?.changes ?? 0)!==1) return scanConflict();
      detachedScan=true;
    }
    const previousProgress = snapshot.scanProgress;
    const progress = retryScan && previousProgress &&
      date.getTime() >= previousProgress.startedAt && date.getTime()-previousProgress.startedAt < 180_000
      ? previousProgress : undefined;
    const symbols = doScan ? progress?.symbols ?? await (async()=>{
      const discover = await post('/api/market/discover',{});
      if (!discover.success || !Array.isArray(discover.candidates)) throw Error('시장 후보 발견 실패');
      const pool = discover.candidates.filter((x:any)=>/^\d{6}$/.test(String(x.code)) && !/ETF|ETN|레버리지|인버스/.test(String(x.name)));
      const held = new Set(snapshot.account.positions.map(position=>position.code));
      const universe = pool.filter((x:any,i:number,a:any[])=>a.findIndex(y=>y.code===x.code)===i)
        .slice(0,candidatePoolLimit).filter((x:any)=>!held.has(x.code));
      const offset = (Math.floor(slot/5)*scanSymbolLimit)%Math.max(universe.length,1);
      return [...universe.slice(offset),...universe.slice(0,offset)].slice(0,scanSymbolLimit);
    })() : watchDuringCooldown ? watched.filter(symbol=>snapshot.account.positions.some(position=>position.code===symbol.code)) : watched;
    if (!symbols.length) {
      if (detachedScan) {
        if (!await rebaseScan()) return scanConflict();
        delete snapshot.scanProgress;
        delete snapshot.scanRetryAfterSlot;
        const saved=await db.prepare('UPDATE server_paper_state SET snapshot_json=?, revision=revision+1, updated_at=?, last_error=?, busy_until=0 WHERE id=1 AND revision=? AND mode=\'running\' AND cycle_slot=?')
          .bind(JSON.stringify(snapshot),new Date().toISOString(),null,writeRevision,commitSlot).run();
        if ((saved.meta?.changes ?? 0)!==1) return scanConflict();
      } else {
        await db.prepare('UPDATE server_paper_state SET busy_until=0, last_error=NULL WHERE id=1 AND revision=? AND cycle_slot=?')
          .bind(writeRevision,slot).run();
      }
      return {result:watchCount?'watched':'no_symbols',message:watchDetail||'빠른 감시 대상 없음 · 다음 전체시장 검사 대기',filled:watchFills.length,scanned:watchCount,fills:watchFills};
    }
    let now = new Date();
    let checkedAt = now.toISOString();
    let nextAccount: AutoAccount;
    let partialRun = false;
    let nextLedger: PaperLedger = snapshot.ledger;
    const store = { read:()=>nextLedger, write:(value:PaperLedger)=>{nextLedger=value} };
    if (doScan) {
      retryProgress = progress ?? {startedAt:date.getTime(),symbols,quotes:[]};
      const remaining = symbols.filter(symbol=>!progress?.quotes.some(quote=>quote.code===symbol.code));
      const reply = await post('/api/market/investor-flow',{stocks:remaining,stopOnUpstream:true});
      if (!reply.success || !Array.isArray(reply.results)) throw Error('KB 정밀 시세 조회 실패');
      const freshQuotes = reply.results;
      const quotes = [...(progress?.quotes ?? []),...freshQuotes];
      if (!quotes.some((item:any)=>Number.isFinite(item.price)&&item.price>0))
        throw new KbWatchUnavailable('정밀 시세에 유효한 가격 없음');
      const completeCodes = new Set(freshQuotes.filter((quote:any)=>!quote.quoteError&&!quote.investorError &&
        Number.isFinite(quote.price)&&quote.price>0).map((quote:any)=>quote.code));
      const partial = reply.partial === true || remaining.some(symbol=>!completeCodes.has(symbol.code));
      let nextProgress:ScanProgress|undefined;
      if (partial) {
        const completed = freshQuotes.filter((quote:any)=>!quote.quoteError&&!quote.investorError &&
          Number.isFinite(quote.price)&&quote.price>0&&remaining.some(symbol=>symbol.code===quote.code));
        nextProgress = {startedAt:progress?.startedAt ?? date.getTime(),symbols,
          quotes:[...(progress?.quotes ?? []),...completed]};
      }
      const [disclosuresResult,newsResult] = partial ? [null,null] : await Promise.all([
        Promise.resolve().then(()=>post('/api/market/disclosures',{complete:true})).catch(()=>null),
        Promise.resolve().then(()=>post('/api/market/research',{skip_ai:true})).catch(()=>null),
      ]);
      if (!await rebaseScan()) return scanConflict();
      snapshot.scanProgress=nextProgress;
      nextLedger=snapshot.ledger;
      now = new Date();
      checkedAt = now.toISOString();
      const disclosures = disclosuresResult || {};
      const news = newsResult || {};
      if (partial) {
        scanError = (kbScanFailurePrefix + (reply.message || '정밀 시세 일부 실패')).slice(0,180);
        snapshot.scanRetryAfterSlot = slot+2;
      } else delete snapshot.scanRetryAfterSlot;
      const incompleteScan = partial || disclosuresResult?.success!==true || disclosuresResult.complete!==true || newsResult?.success!==true;
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
      snapshot.catalyst = catalyst;
      if(incompleteScan){
        partialRun = true;
        // Keep watching existing positions from this scan's usable quotes.
        // A partial scan must not open or replace pending entry orders.
        nextAccount = runAutoWatchCycle({...snapshot.account,pending:[]},
          freshQuotes.filter((item:any)=>!item.quoteError&&Number.isFinite(item.price)&&item.price>0),
          checkedAt,now,store,symbols.length);
        nextAccount.pending = snapshot.account.pending;
        let dartDetail = '';
        if (disclosures.stage === 'missing_key') dartDetail = 'DART 인증키 미설정';
        else if (/^\d{3}$/.test(disclosures.status ?? '')) dartDetail = 'DART 응답 코드 ' + disclosures.status;
        else if (Number.isInteger(disclosures.http_status) && disclosures.http_status >= 100 && disclosures.http_status <= 599)
          dartDetail = 'DART HTTP ' + disclosures.http_status;
        else if (['TimeoutError','AbortError'].includes(disclosures.error_type)) dartDetail = 'DART 요청 시간 초과';
        else if (disclosures.stage === 'api_fetch') dartDetail = 'DART 요청 실패';
        else if (/^DART 추가 페이지 (?:HTTP \d{3}|오류 (?:\d{3}|자료 없음)|연결 실패) \(\d+페이지\)$/.test(disclosures.pagination_error ?? ''))
          dartDetail = disclosures.pagination_error;
        else if (disclosures.success === true && Number.isInteger(disclosures.fetched_count) && Number.isInteger(disclosures.total_count))
          dartDetail = '공시 ' + disclosures.fetched_count + '/' + disclosures.total_count + '건 수집';
        const phaseError = partial ? reply.message || 'KB 시세·수급 일부 미확인' :
          disclosuresResult?.complete!==true || disclosuresResult?.success!==true ? '공시 검증 미완료' + (dartDetail ? ' (' + dartDetail + ')' : '') : '뉴스 검증 미완료';
        message = '정밀검사 일부 실패 · '+phaseError+' · 신규 매수 보류';
      }else{
        const signals = applyCatalystGate(generateTradeSignals(quotes,200_000,now),catalyst,now).signals;
        snapshot.screening = { checkedAt, signals };
        nextAccount = runAutoCycle(snapshot.account,signals,freshQuotes,checkedAt,now,store);
        message = '시장 정밀검사 '+quotes.length+'종목 · '+(catalyst.newsOk && catalyst.dartComplete ? '뉴스·공시 검증':'신규 매수 보류');
      }
    } else {
      // On non-scan minutes, only watch held/pending symbols; old candidate data
      // never justifies a new BUY unless the queued trigger was created by a valid scan.
      if (scanInProgress) {
        // Keep the minute claim, but let the scan commit while this watch waits for KB.
        const released = await db.prepare('UPDATE server_paper_state SET busy_until=0 WHERE id=1 AND revision=? AND cycle_slot=?')
          .bind(writeRevision,slot).run();
        if ((released.meta?.changes ?? 0)!==1)
          return {result:'busy',message:'원장 변경 경합 · 보유 감시 반영 보류',filled:0,scanned:0};
      }
      const reply = await post('/api/kb/quotes',{stocks:symbols});
      if (scanInProgress) {
        const latest=await state(db);
        if (!latest || latest.mode!=='running' || latest.cycle_slot!==slot)
          return {result:'busy',message:'원장 변경 경합 · 보유 감시 반영 보류',filled:0,scanned:0};
        const fresh=JSON.parse(latest.snapshot_json) as Snapshot;
        if(!valid(fresh)||!fresh.account.enabled||fresh.modeEpoch!==snapshot.modeEpoch)
          return {result:'stopped',message:'서버 계좌가 비활성화됨',filled:0,scanned:0};
        snapshot=fresh;
        nextLedger=fresh.ledger;
        writeRevision=latest.revision;
        scanError=latest.last_error;
      }
      now=new Date();
      checkedAt=now.toISOString();
      if (!reply.success || reply.rate_limited || reply.token_expired || !Array.isArray(reply.results))
        throw new KbWatchUnavailable(reply.rate_limited?'호출 제한 (429)':reply.token_expired?'인증 만료':'빠른 현재가 조회 실패');
      const validQuotes = reply.results.filter((x:any)=>!x.error && Number.isFinite(x.price) && x.price>0
        && Number.isFinite(Date.parse(x.checked_at)) && now.getTime()-Date.parse(x.checked_at)>=0 && now.getTime()-Date.parse(x.checked_at)<120_000);
      if (!validQuotes.length) {
        const status = reply.results.find((item:any)=>[502,503,504,522,524].includes(item.upstream_status))?.upstream_status;
        const transport = reply.results.find((item:any)=>item.transport_error)?.transport_error;
        throw new KbQuoteUnavailable(status?'현재가 HTTP '+status:transport==='timeout'?'현재가 타임아웃':
          transport==='network'?'현재가 연결 실패':'유효한 최신 현재가 없음');
      }
      partialRun = validQuotes.length !== symbols.length;
      // Fast path: sell-side risk checks remain active, new entries are gated to
      // the next comprehensive market/news scan.
      const allowed = snapshot.account.pending.filter(item =>
        !watchDuringCooldown &&
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
    const newFills=[...watchFills,...nextAccount.fills.filter(f=>!oldFills.has(f.id))];
    const executedFills = newFills.length;
    snapshot = {...snapshot, account:nextAccount, ledger:nextLedger,savedAt:checkedAt};
    const res = await db.prepare('UPDATE server_paper_state SET snapshot_json=?, revision=revision+1, updated_at=?, last_error=?, busy_until=0 WHERE id=1 AND revision=? AND mode=\'running\' AND cycle_slot=?')
      .bind(JSON.stringify(snapshot),new Date().toISOString(),scanError,writeRevision,commitSlot).run();
    if ((res.meta?.changes ?? 0)!==1) return {result:'busy',message:'원장 변경 경합 · 추가 거래 결과 반영 안 함',filled:watchFills.length,scanned:watchCount,fills:watchFills};
    return {result:doScan ? 'scanned' : 'watched',message:watchDetail ? watchDetail+' · '+message : message,filled:executedFills,scanned:symbols.length,fills:newFills,partial:partialRun||watchIncomplete};
  } catch (error) {
    const detail = error instanceof Error ? error.message : '서버 감시 실패';
    const prefix = error instanceof KbQuoteUnavailable ? kbQuoteFailurePrefix :
      error instanceof KbWatchUnavailable ? (doScan ? kbScanFailurePrefix : kbFailurePrefix) : '';
    const diagnostic = watchDuringCooldown && scanError ? scanError : (prefix+detail).slice(0,180);
    if (detachedScan) {
      if (!await rebaseScan()) return scanConflict();
      if (retryProgress && error instanceof KbWatchUnavailable) {
        snapshot.scanProgress=retryProgress;
        snapshot.scanRetryAfterSlot=slot+2;
      }
      await db.prepare('UPDATE server_paper_state SET snapshot_json=?, revision=revision+1, updated_at=?, last_error=?, busy_until=0 WHERE id=1 AND revision=? AND mode=\'running\' AND cycle_slot=?')
        .bind(JSON.stringify(snapshot),new Date().toISOString(),diagnostic,writeRevision,commitSlot).run().catch(()=>{});
    } else {
      await db.prepare('UPDATE server_paper_state SET last_error=?, busy_until=0 WHERE id=1 AND revision=? AND mode=\'running\' AND cycle_slot=?')
        .bind(diagnostic,writeRevision,slot).run().catch(()=>{});
    }
    return {result:'error',message:watchDetail ? watchDetail+' · '+diagnostic : diagnostic,filled:watchFills.length,scanned:watchCount,fills:watchFills};
  }
}
