// Installed on the same origin as KB AI TRADER, no third-party scripts.
self.addEventListener('push',event=>{
  let payload={title:'KB AI TRADER',body:'새 알림이 도착했습니다.',url:'/?page=notifications',tag:'kb-paper'};
  try { const data=event.data?.json(); if(data&&typeof data==='object')payload={...payload,...data}; }
  catch { /* Display a generic notification rather than silently ignore. */ }
  const url=typeof payload.url==='string'&&payload.url.startsWith('/')&&!payload.url.startsWith('//')
    ?payload.url:'/?page=notifications';
  event.waitUntil(self.registration.showNotification(String(payload.title).slice(0,130),{
    body:String(payload.body).slice(0,1200),tag:String(payload.tag).slice(0,100),
    icon:'/icon-192.svg',badge:'/icon-192.svg',data:{url}
  }));
});
self.addEventListener('notificationclick',event=>{
  event.notification.close();
  const path=event.notification.data?.url||'/?page=notifications';
  const target=new URL(path,self.registration.scope);
  if(target.origin!==self.location.origin)return;
  event.waitUntil((async()=>{
    const clients=await self.clients.matchAll({type:'window',includeUncontrolled:true});
    const existing=clients.find(client=>new URL(client.url).origin===target.origin);
    if(existing){await existing.navigate(target.href);return existing.focus();}
    return self.clients.openWindow(target.href);
  })());
});
