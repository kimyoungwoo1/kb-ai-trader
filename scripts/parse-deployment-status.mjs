// Wrangler CLI prints text, not JSON. Parse only an explicitly 100%-active
// deployment. Never guess a version from a stale history entry.
export function parseActiveVersion(output){
  const text=String(output||'').replace(/\u001b\[[0-9;]*m/g,'')
  const versions=[...text.matchAll(/Version\(s\):\s*\(100%\)\s*([a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12})/gi)]
    .map(match=>match[1].toLowerCase())
  if(versions.length!==1)throw Error('Wrangler 현재 운영 버전 확인 실패 · 정확히 한 개의 100% 버전 필요')
  return versions[0]
}
