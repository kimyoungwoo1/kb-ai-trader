import { useCallback, useEffect, useState } from 'react'
import { Bell, BellRing, CheckCheck, RefreshCw, Smartphone, Send, ShieldAlert } from 'lucide-react'
import './styles.css'
const API='https://kb-ai-trader.ksmsy1.workers.dev/api/notifications'
type Notice={id:number;kind:string;title:string;body:string;created_at:string;read_at:string|null}
type Inbox={notifications:Notice[];unread:number;devices:number;vapidPublicKey:string;pushAvailable:boolean}
const format=(raw:string)=>new Date(raw).toLocaleString('ko-KR')
function fromBase64Url(value:string):Uint8Array{
  const padding='='.repeat((4-value.length%4)%4)
  const bytes=atob((value+padding).replace(/-/g,'+').replace(/_/g,'/'))
  const buffer=new ArrayBuffer(bytes.length);const output=new Uint8Array(buffer)
  for(let i=0;i<bytes.length;i++)output[i]=bytes.charCodeAt(i)
  return output
}
async function call(token:string,action:string,extra:Record<string,unknown>={}){
  const response=await fetch(API,{method:'POST',cache:'no-store',
    headers:{'Content-Type':'application/json',Authorization:'Bearer '+token},
    body:JSON.stringify({action,...extra}),signal:AbortSignal.timeout(30000)})
  const data=await response.json()
  if(!response.ok||!data.success)throw Error(data.message||'알림 서버 오류')
  return data
}
export default function NotificationCenter({token}:{token:string}){
  const [inbox,setInbox]=useState<Inbox|null>(null)
  const [permission,setPermission]=useState(typeof Notification==='undefined'?'unsupported':Notification.permission)
  const [subscribed,setSubscribed]=useState(false)
  const [busy,setBusy]=useState(false)
  const [message,setMessage]=useState('')
  const load=useCallback(async()=>{
    if(!token)return
    try{
      const data=await call(token,'list') as Inbox
      setInbox(data)
      if('serviceWorker' in navigator){
        const registration=await navigator.serviceWorker.getRegistration('/')
        const sub=await registration?.pushManager?.getSubscription()
        setSubscribed(!!sub)
      }
    }catch(error){setMessage('알림 조회 실패 · '+(error instanceof Error?error.message:'네트워크 오류'))}
  },[token])
  useEffect(()=>{
    void load()
    const id=window.setInterval(()=>void load(),30000)
    return()=>window.clearInterval(id)
  },[load])
  const act=async(action:string,extra:Record<string,unknown>={})=>{
    setBusy(true);setMessage('')
    try{const result=await call(token,action,extra);setMessage(result.message||'처리되었습니다.');await load()}
    catch(error){setMessage(error instanceof Error?error.message:'알림 처리 실패')}
    finally{setBusy(false)}
  }
  const subscribe=async()=>{
    if(!inbox?.pushAvailable||!inbox.vapidPublicKey){setMessage('서버 웹 푸시 설정을 확인해 주세요.');return}
    if(!('serviceWorker' in navigator)||!('PushManager' in window)||!('Notification' in window)){
      setMessage('이 브라우저는 웹 푸시를 지원하지 않습니다.');return
    }
    setBusy(true);setMessage('')
    try{
      // Permission request is initiated from the user click, not page load.
      const grant=await Notification.requestPermission()
      setPermission(grant)
      if(grant!=='granted')throw Error('알림 권한이 허용되지 않았습니다. 브라우저 알림 설정을 확인해 주세요.')
      const registration=await navigator.serviceWorker.register('/sw.js',{scope:'/'})
      await navigator.serviceWorker.ready
      let sub=await registration.pushManager.getSubscription()
      if(!sub)sub=await registration.pushManager.subscribe({
        userVisibleOnly:true,applicationServerKey:fromBase64Url(inbox.vapidPublicKey)
      })
      await call(token,'subscribe',{subscription:sub.toJSON()})
      setSubscribed(true);setMessage('이 기기에서 KB AI TRADER 알림을 받을 준비가 됐습니다.')
      await load()
    }catch(error){setMessage(error instanceof Error?error.message:'푸시 등록 실패')}
    finally{setBusy(false)}
  }
  const unsubscribe=async()=>{
    setBusy(true)
    try{
      const registration=await navigator.serviceWorker.getRegistration('/')
      const sub=await registration?.pushManager?.getSubscription()
      if(sub){await call(token,'unsubscribe',{endpoint:sub.endpoint});await sub.unsubscribe()}
      setSubscribed(false);setMessage('이 기기의 푸시 알림을 해제했습니다.');await load()
    }catch(error){setMessage(error instanceof Error?error.message:'푸시 해제 실패')}
    finally{setBusy(false)}
  }
  const kindLabel:Record<string,string>={trade:'가상 체결',error:'서버 장애',recovery:'장애 복구',daily:'일일 요약',test:'테스트'}
  return <section className="notification-page">
    <div className="page-heading"><div><div className="eyebrow">SERVER ALERTS · PUSH NOTIFICATIONS</div>
      <h1>알림 센터</h1><p>가상 체결, 서버 장애, 복구 및 일일 요약을 한곳에서 확인합니다.</p></div>
      <button className="outline-button" disabled={busy} onClick={()=>void load()}><RefreshCw size={14}/> 새로고침</button>
    </div>
    <div className="notification-settings panel">
      <div className="notification-settings-heading"><BellRing size={20}/><div>
        <strong>휴대폰 푸시 알림</strong><p>브라우저를 닫아도 등록한 기기로 알림을 전송합니다. 최초 한 번 권한 허용이 필요합니다.</p>
      </div></div>
      <div className="notification-meta"><span>기기 등록 {inbox?.devices??'-'}개</span>
        <span>이 기기 {subscribed?'알림 등록됨':'미등록'}</span>
        <span>권한 {permission==='granted'?'허용':permission==='denied'?'차단':permission==='default'?'미선택':'미지원'}</span>
      </div>
      <div className="notification-actions">
        {subscribed?<button disabled={busy} className="outline-button" onClick={()=>void unsubscribe()}><Smartphone size={15}/> 이 기기 알림 해제</button>
          :<button disabled={busy||!inbox?.pushAvailable} className="outline-button" onClick={()=>void subscribe()}><BellRing size={15}/> 이 기기 푸시 알림 켜기</button>}
        <button disabled={busy} className="outline-button" onClick={()=>void act('test')}><Send size={15}/> 테스트 알림 발송</button>
      </div>
      {!inbox?.pushAvailable&&<p className="notification-hint"><ShieldAlert size={15}/> 웹 푸시 발송키 확인 전입니다. 알림함 자체는 사용할 수 있습니다.</p>}
      <p className="notification-hint">iPhone은 Safari에서 홈 화면에 추가한 웹 앱을 열어 알림을 켜야 합니다. Android는 Chrome 등 지원 브라우저에서 권한을 허용하세요. 기기별 알림 차단 설정도 적용됩니다.</p>
      {message&&<p className="news-message" role="status">{message}</p>}
    </div>
    <div className="panel notification-list-panel">
      <div className="panel-heading"><div><h3>알림 이력 <span className="notification-count">{inbox?.unread??0} 읽지 않음</span></h3>
        <span>SERVER D1 INBOX · RECENT 80</span></div>
        <button disabled={busy||!inbox?.unread} className="outline-button" onClick={()=>void act('read',{id:0})}><CheckCheck size={14}/> 모두 읽음</button>
      </div>
      {!inbox?.notifications.length?<div className="ai-empty"><Bell size={20}/> 아직 알림이 없습니다. 테스트 발송 버튼으로 확인할 수 있습니다.</div>:
        <div className="notification-list">{inbox.notifications.map(item=><article className={'notification-item '+(item.read_at?'is-read':'is-unread')} key={item.id}>
          <div className="notification-item-heading"><div><span className={'notification-tag notification-kind-'+item.kind}>{kindLabel[item.kind]||item.kind}</span>
            <strong>{item.title}</strong></div><span>{format(item.created_at)}</span></div>
          <p>{item.body}</p>
          {!item.read_at&&<button className="outline-button" disabled={busy} onClick={()=>void act('read',{id:item.id})}>읽음 처리</button>}
        </article>)}</div>}
    </div>
  </section>
}
