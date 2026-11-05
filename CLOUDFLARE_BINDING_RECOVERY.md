# Cloudflare 운영 배포 중단 원인 및 복구 기준

## 확인된 사실 (2026-11-05)
- 현재 운영은 롤백 버전 `dafe0360-d736-4bf2-8a82-eb4ed03e48a4`로 정상 동작한다.
- 해당 버전에는 `AI`, `ASSETS`, `DASHBOARD_API_KEY`, `KB_APP_KEY`, `KB_APP_SECRET`, `GEMINI_API_KEY`, `DART_API_KEY` 바인딩이 있다.
- 오류 버전 `eadbd3fd-bbe8-4b1b-8e7a-f875bc0b9acf`에는 `AI`, `ASSETS`만 있다.
- 따라서 **Secret 값 자체가 영구 삭제된 증거는 없으며**, 업로드 버전의 바인딩이 누락된 것이 확인됐다.
- 기존 Codespaces 루트의 로컬 `package.json` / `vite.config.ts`에는 Cloudflare Vite 플러그인이 추가되어 있으며, 빌드는 `dist/wrangler.json`과 `.wrangler/deploy/config.json`을 만든다. `.wrangler/deploy/config.json`은 `../../dist/wrangler.json`을 가리킨다.
- 현재 `wrangler secret list`는 `[]`를 출력한다. Cloudflare 콘솔에서 롤백 버전이 정상 동작해도 이 결과가 `[]`인 상태로 다시 배포하면 안 된다.

## Cloudflare 공식 사양
- `secrets.required`: 필수 Secret이 현재 배포 대상에 없는 경우 `wrangler deploy` 및 `wrangler versions upload`를 중단한다.
- 일반 Wrangler 업로드의 바인딩 상속 대상은 **마지막으로 업로드한 버전**일 수 있다. 롤백으로 현재 서비스 중인 버전과 다를 수 있다.
- **특정** 버전 ID를 지정한 `inherit` 바인딩은 Workers Version API의 `POST /accounts/{account_id}/workers/workers/{worker_id}/versions`에서 지원한다.
- Worker Scripts Versions API 등 다른 엔드포인트는 특정 `version_id` 상속을 지원하지 않으며, 이를 잘못 사용하면 오류 10057이 발생한다.
- 공식 문서: https://developers.cloudflare.com/api/resources/workers/subresources/beta/subresources/workers/subresources/versions/methods/create/
- 공식 문서: https://developers.cloudflare.com/workers/wrangler/configuration/#secrets

## 안전 절차
1. 정상 버전 `dafe0360` 유지. 기존 Secret 다섯 개의 값은 노출하거나 재발급하지 않는다.
2. `node scripts/check-cloudflare-secrets.mjs` 실행. 현재는 실패하도록 설계된 안전 장치다. 이 실패를 무시하고 배포하지 않는다.
3. 새 코드 업로드 시 **정상 버전 ID에 대한 명시적 상속**을 사용하는 Cloudflare Workers Version API 업로드를 개발 및 검증한다. 이 API 요청에는 빌드된 Worker 모듈 및 Assets 업로드 JWT가 필요하다. 단순 JSON 메타데이터 업로드만으로 프런트엔드 파일을 교체했다고 판단하지 않는다.
4. 새 버전을 프로덕션에 활성화하기 **전에**, 새 버전의 바인딩이 `AI`, `ASSETS`, 필수 다섯 Secret 모두를 포함하는지 읽기 전용으로 확인한다. 하나라도 누락되면 활성화를 중단한다.
5. 새 버전의 프리뷰/테스트를 거쳐 프로덕션 트래픽을 전환하고 로그인·계좌 조회·최대 30종목 검사·가상매매를 확인한다.
6. 위 API 경로가 검증되지 않으면 **운영 배포 보류**가 유일한 안전한 선택이다.

## 하지 말 것
- 기존에 안내한 `npx wrangler deploy --config worker/wrangler.jsonc --keep-vars`로 재시도하지 않는다. `--keep-vars`만으로 정상 롤백 버전에서 Secret을 상속하지 못할 수 있다.
- `wrangler secret put`는 Secret 값을 재입력해야 하므로 기존 키 재등록이 불필요한 상황에서 사용하지 않는다.
- `main` 브랜치에 또 다시 코드를 병합해 Cloudflare 자동 배포를 일으키지 않는다.

## 변경 이력
현재 `main`에는 이미 30종목 검사 코드가 있으며, **Cloudflare 프로덕션에는 아직 해당 기능이 적용되었다고 확인되지 않았다**.
