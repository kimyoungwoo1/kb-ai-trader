# 운영 복구: 정상 버전과 오류 버전의 바인딩 비교

**운영 버전은 복구된 `dafe0360-d736-4bf2-8a82-eb4ed03e48a4`를 유지. 이 문서는 배포 명령이 아니다.**

확인된 Codespaces 상태:
- `package.json`의 로컬 수정은 `@cloudflare/vite-plugin`과 루트 `deploy`/ `preview` 명령을 추가한다.
- `vite.config.ts`의 로컬 수정은 `cloudflare()` 플러그인을 추가한다.
- `npm run build`가 `dist/wrangler.json`과 `.wrangler/deploy/config.json`을 생성한다.
- `.wrangler/deploy/config.json`은 `../../dist/wrangler.json`을 가리킨다.
- Wrangler가 보는 Secret 목록은 `[]`이지만, 이전 버전으로 롤백하면 로그인과 계좌 조회가 정상이다. 이는 **버전별 바인딩 차이**가 있다는 의심과 일치하며, 현재 비밀 값 자체가 삭제됐다는 증거는 아니다.
- 클라우드플레어 문서에 따르면 **Worker 버전은 코드와 바인딩을 함께 저장**한다. 또한 Worker Version API의 일반 업로드에서 `inherit`는 최신 *업로드* 버전을 참조하며, 현재 활성 롤백 버전을 참조한다고 보장되지 않는다. 지정 버전 바인딩을 상속하려면 별도의 버전 API가 필요하다.

## 지금 실행 가능한 읽기 전용 진단

Codespaces 루트에서:

```bash
cd /workspaces/kb-ai-trader
node scripts/inspect-cloudflare-versions.mjs
```

이 명령은 **버전별 Secret 이름/유형만 출력**하며, 값은 표시하거나 변경하지 않는다. 결과에서 정상 버전에는 Secret이 있고 최근 오류 버전에는 없다면 바인딩 불일치가 확인된다.

검사가 끝나기 전까지 `wrangler deploy`, `wrangler versions deploy`, `git merge`를 통한 자동 배포를 하지 말 것. 현재 정상 배포의 설정을 훼손하지 말 것.

## 배포 재개 조건

1. 운영 Cloudflare 빌드/배포 Root directory 및 생성된 Wrangler 설정 경로를 한 가지로 고정.
2. 현재 정상 버전에서 Secret 바인딩이 실제 존재함을 확인.
3. Cloudflare 공식 API의 **특정 버전 바인딩 상속**을 이용하는 검증된 업로드 경로를 구성하거나, 안전한 새 배포를 위한 Secret 등록 경로를 마련.
4. 우선 배포 없는 버전 업로드와 프리뷰 테스트를 수행한 뒤 바인딩과 로그인 API 검증.
5. 30종목 확대 기능 확인 후 운영 트래픽 전환.

Secret 값을 ChatGPT, 코드, 로그 등에 노출하지 말 것.
