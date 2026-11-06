/**
 * Private paper-trading notification inbox and opt-in Web Push.
 * All routes require the existing authenticated dashboard session.
 * No brokerage credentials or raw PushSubscription keys are exposed to readers.
 */
import { buildPushPayload } from '@block65/webcrypto-web-push';

type Db = any;
type PushEnv = { PAPER_DB?: Db; VAPID_PUBLIC_KEY?: string; VAPID_PRIVATE_KEY?: string; VAPID_SUBJECT?: string };
type Subscription = {
  endpoint:string; expirationTime?:number|null;
  keys:{p256dh:string;auth:string};
};
export type NotificationInput = { eventKey:string; kind:'trade'|'error'|'recovery'|'daily'|'test'; title:string; body:string };
type Notice = {id:number;kind:string;title:string;body:string;created_at:string;read_at:string|null};
const respond = (data:unknown,status=200)=>Response.json(data,{status,headers:{'Cache-Control':'no-store'}});
const MAX_SUBSCRIPTIONS=8;
const endpointAllowed=(raw:string):boolean=>{
  try{
    const url=new URL(raw);
    if(url.protocol!=='https:'||url.username||url.password||url.port) return false;
    const host=url.hostname.toLowerCase();
    return host==='fcm.googleapis.com'||host==='updates.push.services.mozilla.com'
      ||host==='push.services.mozilla.com'||host==='web.push.apple.com'
      ||host.endsWith('.push.apple.com')||host==='wns.notify.windows.com'
      ||host.endsWith('.notify.windows.com')||host.endsWith('.push.services.mozilla.com');
  } catch {return false;}
};
const validSubscription=(v:any):v is Subscription=>!!v&&typeof v==='object'
  &&typeof v.endpoint==='string'&&v.endpoint.length<2048&&endpointAllowed(v.endpoint)
  &&v.keys&&typeof v.keys.auth==='string'&&v.keys.auth.length<=100
  &&typeof v.keys.p256dh==='string'&&v.keys.p256dh.length<=200
  &&v.keys.auth.length>10&&v.keys.p256dh.length>40;
export const isValidPushSubscription=validSubscription;
export async function handleNotifications(env:PushEnv,body:unknown):Promise<Response>{
  const db=env.PAPER_DB;
  if(!db) return respond({success:false,message:'D1 연결이 없습니다.'},503);
  const input=body && typeof body==='object' ? body as Record<string,any> : {};
  const action=String(input.action||'');
  try{
    if(action==='list'){
      const rows=await db.prepare('SELECT id,kind,title,body,created_at,read_at FROM paper_notifications ORDER BY id DESC LIMIT 80').all();
      const unread=await db.prepare('SELECT COUNT(*) AS n FROM paper_notifications WHERE read_at IS NULL').first<{n:number}>();
      const devices=await db.prepare('SELECT COUNT(*) AS n FROM paper_push_subscriptions').first<{n:number}>();
      return respond({success:true,notifications:rows.results||[],unread:Number(unread?.n)||0,devices:Number(devices?.n)||0,
        vapidPublicKey:env.VAPID_PUBLIC_KEY||'',pushAvailable:!!(env.VAPID_PUBLIC_KEY&&env.VAPID_PRIVATE_KEY&&env.VAPID_SUBJECT)});
    }
    if(action==='subscribe'){
      if(!env.VAPID_PUBLIC_KEY||!env.VAPID_PRIVATE_KEY) return respond({success:false,message:'서버 웹 푸시 키가 아직 설정되지 않았습니다.'},503);
      if(!validSubscription(input.subscription))return respond({success:false,message:'지원하지 않는 웹 푸시 구독 정보입니다.'},400);
      const sub=input.subscription as Subscription;
      const count=await db.prepare('SELECT COUNT(*) AS n FROM paper_push_subscriptions').first<{n:number}>();
      const exists=await db.prepare('SELECT endpoint FROM paper_push_subscriptions WHERE endpoint=?').bind(sub.endpoint).first();
      if(!exists&&Number(count?.n)>=MAX_SUBSCRIPTIONS)return respond({success:false,message:'등록 기기 8개 제한입니다. 다른 기기의 알림을 먼저 해제해 주세요.'},409);
      await db.prepare('INSERT INTO paper_push_subscriptions(endpoint,subscription_json,created_at,updated_at) VALUES(?,?,?,?) ON CONFLICT(endpoint) DO UPDATE SET subscription_json=excluded.subscription_json, updated_at=excluded.updated_at')
        .bind(sub.endpoint,JSON.stringify(sub),new Date().toISOString(),new Date().toISOString()).run();
      return respond({success:true,message:'이 기기의 웹 푸시 알림이 등록되었습니다.'});
    }
    if(action==='unsubscribe'){
      const endpoint=String(input.endpoint||'');
      if(!endpointAllowed(endpoint))return respond({success:false,message:'구독 주소 오류'},400);
      await db.prepare('DELETE FROM paper_push_subscriptions WHERE endpoint=?').bind(endpoint).run();
      return respond({success:true});
    }
    if(action==='read'){
      const id=Number(input.id);
      if(!Number.isSafeInteger(id)||id<0)return respond({success:false,message:'알림 식별자 오류'},400);
      if(id===0) await db.prepare('UPDATE paper_notifications SET read_at=? WHERE read_at IS NULL').bind(new Date().toISOString()).run();
      else await db.prepare('UPDATE paper_notifications SET read_at=? WHERE id=? AND read_at IS NULL').bind(new Date().toISOString(),id).run();
      return respond({success:true});
    }
    if(action==='test'){
      const key='test:'+crypto.randomUUID();
      await publishNotification(env,{eventKey:key,kind:'test',title:'KB AI TRADER · 테스트 알림',body:'전용 알림함과 웹 푸시 연결 테스트입니다. 실제 주문이 아닙니다.'});
      return respond({success:true,message:'테스트 알림을 저장하고 등록된 기기로 전송을 시도했습니다.'});
    }
    return respond({success:false,message:'알 수 없는 알림 명령입니다.'},400);
  } catch {
    return respond({success:false,message:'알림 D1 처리에 실패했습니다.'},503);
  }
}
export async function publishNotification(env:PushEnv,notice:NotificationInput):Promise<boolean>{
  const db=env.PAPER_DB;
  if(!db)return false;
  if(!notice.eventKey||notice.eventKey.length>180)return false;
  const insert=await db.prepare('INSERT OR IGNORE INTO paper_notifications(event_key,kind,title,body,created_at) VALUES(?,?,?,?,?)')
    .bind(notice.eventKey,notice.kind,notice.title.slice(0,130),notice.body.slice(0,1400),new Date().toISOString()).run();
  if((insert.meta?.changes||0)!==1)return false; // D1 deduplicates event and delivery.
  if(!env.VAPID_PRIVATE_KEY||!env.VAPID_PUBLIC_KEY||!env.VAPID_SUBJECT)return true;
  try{
    const rows=await db.prepare('SELECT endpoint,subscription_json FROM paper_push_subscriptions ORDER BY updated_at DESC LIMIT 8').all();
    await Promise.all((rows.results||[]).map(async(row:{endpoint:string;subscription_json:string})=>{
      try {
        const sub=JSON.parse(row.subscription_json) as Subscription;
        if(!validSubscription(sub))return;
        const message=JSON.stringify({title:notice.title,body:notice.body,url:'/?page=notifications',tag:notice.eventKey});
        const payload=await buildPushPayload({data:message,options:{ttl:3600}},sub,{
          publicKey:env.VAPID_PUBLIC_KEY!,privateKey:env.VAPID_PRIVATE_KEY!,subject:env.VAPID_SUBJECT!
        });
        const response=await fetch(sub.endpoint,{...payload,signal:AbortSignal.timeout(10000)});
        if(response.status===404||response.status===410)
          await db.prepare('DELETE FROM paper_push_subscriptions WHERE endpoint=?').bind(sub.endpoint).run();
        else if(!response.ok)console.warn('Push delivery HTTP',response.status);
      } catch {console.warn('Push delivery failure'); }
    }));
  }catch{console.warn('Push subscription lookup failure')}
  return true;
}
