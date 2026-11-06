/**
 * KB OAuth token cache: a token is reused for its reported lifetime by requests
 * routed to the same Cloudflare Worker isolate. It is NEVER returned to browsers,
 * written to assets, or stored in localStorage. Isolate restarts obtain a new token.
 */
export type KbCredentials = {
  KB_APP_KEY?: string
  KB_APP_SECRET?: string
  KB_BASE_URL?: string
}

type CachedToken = { token: string; key: string; expiresAt: number }
let cached: CachedToken | null = null
let inflight: Promise<string> | null = null
let inflightKey = ''

export class KbAuthError extends Error {
  constructor(message: string, readonly httpStatus: number, readonly rateLimited = false) {
    super(message)
    this.name = 'KbAuthError'
  }
}

export const kbBaseUrl = (env: KbCredentials): string =>
  (env.KB_BASE_URL || 'https://developer.kbsec.com:32484').replace(/\/$/, '')

export function clearKbAccessToken(): void {
  cached = null
}

export async function getKbAccessToken(env: KbCredentials): Promise<string> {
  if (!env.KB_APP_KEY || !env.KB_APP_SECRET) throw new KbAuthError('KB 인증키가 없습니다.', 503)
  const key = env.KB_APP_KEY + '\n' + kbBaseUrl(env)
  if (cached?.key === key && Date.now() < cached.expiresAt) return cached.token
  if (inflight?.then && inflightKey === key) return inflight
  const load = async (): Promise<string> => {
    let response: Response
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
    } catch {
      throw new KbAuthError('KB 인증 서버 연결 실패', 502)
    }
    let data: any
    try { data = await response.json() } catch { throw new KbAuthError('KB 인증 응답 형식 오류', 502) }
    const token = data?.dataBody?.access_token
    if (!response.ok || typeof token !== 'string' || token.length === 0)
      throw new KbAuthError('KB 토큰 발급 실패 (HTTP ' + response.status + ')',
        response.status === 429 ? 429 : 502, response.status === 429)
    const reported = Number(data?.dataBody?.expires_in ?? data?.expires_in)
    // Honor explicit expiry. If absent, conservatively reuse for only 5 minutes.
    const lifetime = Number.isFinite(reported) && reported > 0 ? Math.min(reported, 86400) : 300
    cached = { token, key, expiresAt: Date.now() + Math.max(1, lifetime - 60) * 1000 }
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
