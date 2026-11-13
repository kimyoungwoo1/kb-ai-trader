import { fetchKbObserved } from '../src/kbAccountRead'

const allowedPaths = new Set(['/api/v1/ivu10140', '/api/v1/ivu10430'])

export default {
 async fetch(request: Request): Promise<Response> {
  const path = new URL(request.url).pathname
  if (request.method !== 'POST' || !allowedPaths.has(path))
   return new Response(null, { status: 404 })

  const authorization = request.headers.get('Authorization')
  const appKey = request.headers.get('appKey')
  const requestId = request.headers.get('X-KB-Request-ID') || ''
  const attempt = Number(request.headers.get('X-KB-Attempt'))
  const timeout = Number(request.headers.get('X-KB-Timeout'))
  if (!authorization || !appKey || !/^[a-f0-9-]{36}$/i.test(requestId) ||
      ![1, 2].includes(attempt) || !Number.isInteger(timeout) || timeout < 1 || timeout > 22000)
   return new Response(null, { status: 400 })

  try {
   const response = await fetchKbObserved('https://developer.kbsec.com:32484'+path, {
    method: 'POST',
    headers: { Authorization: authorization, appKey, 'Content-Type': 'application/json' },
    body: await request.text(), redirect: 'manual',
    signal: AbortSignal.any([request.signal, AbortSignal.timeout(timeout)]),
   }, {requestId,attempt})
   return new Response(response.body, {
    status: response.status,
    headers: { 'Content-Type': response.headers.get('Content-Type') || 'application/octet-stream' },
   })
  } catch {
   return new Response(null, {status:502})
  }
 },
}
