import { fetchKbObserved, isKbAccountReadPath } from '../src/kbAccountRead'

const allowedPaths = new Set(['/api/v1/ivu10140', '/api/v1/ivu10430'])

export default {
 async fetch(request: Request): Promise<Response> {
  const path = new URL(request.url).pathname
  if (request.method !== 'POST' || (!allowedPaths.has(path) && !isKbAccountReadPath(path)))
   return new Response(null, { status: 404 })

  const authorization = request.headers.get('Authorization')
  const appKey = request.headers.get('appKey')
  const requestId = request.headers.get('X-KB-Request-ID') || ''
  const attempt = Number(request.headers.get('X-KB-Attempt'))
  const timeout = Number(request.headers.get('X-KB-Timeout'))
  if (!authorization || (!isKbAccountReadPath(path) && !appKey) || !/^[a-f0-9-]{36}$/i.test(requestId) ||
      ![1, 2].includes(attempt) || !Number.isInteger(timeout) || timeout < 1 || timeout > 22000)
   return new Response(null, { status: 400 })

  const placement = request.headers.get('cf-placement') || ''
  console.log(JSON.stringify({
   event:'kb_market_placement', request_id:requestId, attempt,
   placement:/^(?:local|remote)-[A-Z]{3}$/.test(placement)?placement:null,
  }))

  try {
   const response = await fetchKbObserved('https://developer.kbsec.com:32484'+path, {
    method: 'POST',
    headers: { Authorization: authorization, ...(appKey ? {appKey} : {}), 'Content-Type': 'application/json' },
    body: await request.text(), redirect: 'manual',
    signal: AbortSignal.any([request.signal, AbortSignal.timeout(timeout)]),
   }, {requestId,attempt})
   return new Response(response.body, {
    status: response.status,
    headers: { 'Content-Type': response.headers.get('Content-Type') || 'application/octet-stream' },
   })
  } catch (error) {
   const timedOut = error instanceof Error && ['TimeoutError','AbortError'].includes(error.name)
   return new Response(null, {status:502, headers:{'X-KB-Egress-Error':timedOut?'timeout':'transport'}})
  }
 },
}
