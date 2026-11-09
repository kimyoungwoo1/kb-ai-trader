/**
 * KB OAuth token cache: a token is reused for up to eight hours or its shorter reported lifetime by requests
 * routed to the same Cloudflare Worker isolate. It is NEVER returned to browsers,
 * written to assets, or stored in localStorage. Isolate restarts obtain a new token.
 */
export type KbCredentials = {
  KB_APP_KEY?: string
  KB_APP_SECRET?: string
  KB_BASE_URL?: string
  PAPER_DB?: any // optional shared encrypted OAuth token cache
}

type CachedToken = { token: string; key: string; expiresAt: number }
let cached: CachedToken | null = null
let inflight: Promise<string> | null = null
let inflightKey = ''
let rejectedToken: string | null = null

// A fresh Cloudflare isolate used to contact KB OAuth for every first request.
// Store only AES-GCM encrypted access tokens in the existing server-side D1.
// Encryption uses the KB app secret already held by Workers; D1 alone cannot
// decrypt or expose the token. A failed/unavailable D1 never disables OAuth.
const bytesToB64=(bytes:Uint8Array)=>btoa(String.fromCharCode(...bytes))
const b64ToBytes=(value:string)=>Uint8Array.from(atob(value),char=>char.charCodeAt(0))
async function sharedCrypto(env:KbCredentials){
 const material=new TextEncoder().encode('kb-ai-trader:oauth:v1\n'+env.KB_APP_KEY+'\n'+env.KB_APP_SECRET+'\n'+kbBaseUrl(env))
 const digest=new Uint8Array(await crypto.subtle.digest('SHA-256',material))
 const aes=await crypto.subtle.importKey('raw',digest,'AES-GCM',false,['encrypt','decrypt'])
 return {aes,fingerprint:bytesToB64(digest)}
}
async function loadSharedToken(env:KbCredentials,key:string):Promise<string|null>{
 if(!env.PAPER_DB)return null
 try{
  const row=await env.PAPER_DB.prepare('SELECT key_fingerprint,nonce_b64,token_b64,expires_at FROM kb_oauth_token_cache WHERE id=1').first()
  if(!row||typeof row.expires_at!=='number'||row.expires_at<=Date.now()+30_000||
     typeof row.key_fingerprint!=='string'||typeof row.nonce_b64!=='string'||typeof row.token_b64!=='string')return null
  const {aes,fingerprint}=await sharedCrypto(env)
  if(row.key_fingerprint!==fingerprint)return null
  const plain=await crypto.subtle.decrypt({name:'AES-GCM',iv:b64ToBytes(row.nonce_b64)},aes,b64ToBytes(row.token_b64))
  const token=new TextDecoder().decode(plain)
  if(!token||token===rejectedToken)return null
  cached={key,token,expiresAt:row.expires_at}
  return token
 }catch{return null}
}
async function saveSharedToken(env:KbCredentials,token:string,expiresAt:number):Promise<void>{
 if(!env.PAPER_DB)return
 try{
  const {aes,fingerprint}=await sharedCrypto(env)
  const nonce=crypto.getRandomValues(new Uint8Array(12))
  const payload=new Uint8Array(await crypto.subtle.encrypt({name:'AES-GCM',iv:nonce},aes,new TextEncoder().encode(token)))
  await env.PAPER_DB.prepare(`INSERT INTO kb_oauth_token_cache(id,key_fingerprint,nonce_b64,token_b64,expires_at)
    VALUES(1,?,?,?,?) ON CONFLICT(id) DO UPDATE SET
    key_fingerprint=excluded.key_fingerprint,nonce_b64=excluded.nonce_b64,
    token_b64=excluded.token_b64,expires_at=excluded.expires_at`)
    .bind(fingerprint,bytesToB64(nonce),bytesToB64(payload),expiresAt).run()
 }catch{/* Never fail a successful KB authentication due to D1. */}
}


export class KbAuthError extends Error {
  constructor(message: string, readonly httpStatus: number, readonly rateLimited = false) {
    super(message)
    this.name = 'KbAuthError'
  }
}

export const kbBaseUrl = (env: KbCredentials): string =>
  (env.KB_BASE_URL || 'https://developer.kbsec.com:32484').replace(/\/$/, '')

export function clearKbAccessToken(): void {
  rejectedToken = cached?.token ?? rejectedToken
  cached = null
}

export async function getKbAccessToken(env: KbCredentials): Promise<string> {
  if (!env.KB_APP_KEY || !env.KB_APP_SECRET) throw new KbAuthError('KB 인증키가 없습니다.', 503)
  const key = env.KB_APP_KEY + '\n' + kbBaseUrl(env)
  if (cached?.key === key && Date.now() < cached.expiresAt) return cached.token
  if (inflight?.then && inflightKey === key) return inflight
  const load = async (): Promise<string> => {
    const shared=await loadSharedToken(env,key)
    if(shared)return shared
    let response: Response | undefined
    // Retry only transient transport failures, never KB-issued HTTP errors or
    // a rejected token. All concurrent requests share this one in-flight promise.
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        response = await fetch(kbBaseUrl(env) + '/oauth2/token', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            dataHeader: { ipAddr: '127.0.0.1', macAddr: '00:00:00:00:00:00' },
            dataBody: { appKey: env.KB_APP_KEY, appSecret: env.KB_APP_SECRET, grantType: 'client_credentials' },
          }),
          signal: AbortSignal.timeout(12_000),
        })
        break
      } catch (error) {
        if (attempt === 0) {
          await new Promise(resolve => setTimeout(resolve, 400))
          continue
        }
        const reason = error instanceof Error && error.name === 'TimeoutError' ? '응답 시간 초과' : '네트워크 연결 실패'
        throw new KbAuthError('KB 인증 서버 '+reason+' (재시도 2회 실패)', 502)
      }
    }
    if (!response) throw new KbAuthError('KB 인증 서버 응답 없음', 502)
    let data: any
    try { data = await response.json() } catch { throw new KbAuthError('KB 인증 응답 형식 오류', 502) }
    const token = data?.dataBody?.access_token
    if (!response.ok || typeof token !== 'string' || token.length === 0)
      throw new KbAuthError('KB 토큰 발급 실패 (HTTP ' + response.status + ')',
        response.status === 429 ? 429 : 502, response.status === 429)
    const reported = Number(data?.dataBody?.expires_in ?? data?.expires_in)
    // Honor explicit expiry. If absent, conservatively reuse for only 5 minutes.
    const lifetime = Number.isFinite(reported) && reported > 0 ? Math.min(reported, 8 * 60 * 60) : 300
    const expiresAt=Date.now() + Math.max(1, lifetime - 60) * 1000
    cached = { token, key, expiresAt }
    rejectedToken=null
    await saveSharedToken(env,token,expiresAt)
    return token
  }
  const promise = load()
  inflight = promise
  inflightKey = key
  try {
    return await promise
  } finally {
    if (inflight === promise) { inflight = null; inflightKey = '' }
  }
}
