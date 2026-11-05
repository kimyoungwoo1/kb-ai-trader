# KB AI Trader — 기존 정상 배포 경로 (2026-11-04 기록 기준)

## 운영 환경 — 변경하지 말 것
- Cloudflare Worker: `kb-ai-trader`; 운영 도메인 `kb-ai-trader.ksmsy1.workers.dev`
- Cloudflare GitHub 빌드 Root directory: `worker`
- Cloudflare Build command: 비움; Deploy command: `npx wrangler deploy`
- Wrangler 구성: `worker/wrangler.jsonc`, Worker 진입점 `worker/src/index.ts`
- 필수 Secret 이름: `DASHBOARD_API_KEY`, `KB_APP_KEY`, `KB_APP_SECRET`
- 정상 작동하는 **롤백 버전을 보호**. GitHub `main`은 운영 배포와 동일하지 않을 수 있음.

## 왜 배포가 중단되었는가
- 이전 대화에서는 루트 Vite 설정이 `@cloudflare/vite-plugin`을 추가하여 `.wrangler/deploy/config.json`을 생성했고, 이 파일이 `dist/wrangler.json`을 가리켜 Worker 자체의 `wrangler.jsonc`와 충돌했다.
- 당시 정상 복구 기록: **worker 디렉터리에서** `rm -rf ../.wrangler`로 생성된 충돌 설정만 제거한 후 `npx wrangler deploy` 실행.
- 그러나 이번에는 `npx wrangler secret list --config worker/wrangler.jsonc`가 `[]`여서 새 버전에 기존 Secret이 붙는다는 보장이 없다. **이 상태에서는 과거 명령을 그대로 재실행하면 안 됨.**
- `scripts/check-cloudflare-secrets.mjs`는 현재 CLI가 조회하는 Secret 목록을 검사하며, 롤백으로 활성화된 과거 버전의 Secret 보유 여부와 다를 수 있다. 체크 실패가 발생하면 배포는 금지한다.
- Cloudflare 문서상 Wrangler의 일반 배포는 기존 Secret을 삭제하지 않는다. 실제 원인은 과거 버전의 Secret과 현재 CLI가 선택하는 Worker/환경/배포 설정의 차이를 조사해야 한다.

## 안전한 확인 순서 (읽기 전용)
1. `cd /workspaces/kb-ai-trader`
2. `git diff -- .gitignore package.json vite.config.ts`로 **로컬에서 실제 사용하던** 수정 부분 확인. 이 세 파일은 무단 초기화/덮어쓰기 금지.
3. `npx wrangler whoami`로 예상 Cloudflare 계정인지 확인.
4. `cd worker && npx wrangler deployments list --config ./wrangler.jsonc`로 현재 배포와 롤백 버전 확인.
5. `npx wrangler secret list --config ./wrangler.jsonc`에서 필수 이름 조회. `[]`면 배포 중단.
6. Cloudflare 대시보드에서 **현재 활성 운영 버전의** Variables/Secrets와 이전 버전 바인딩을 비교. Secret 값은 절대 복사하거나 공개하지 않음.

## 배포 가능 조건
- 필수 Secret 이름이 배포 대상 Worker 환경에서 실제 조회되고, 정상 운영 버전의 구성과 일치.
- 로컬의 생성된 `.wrangler/deploy/config.json`과 Worker 설정 충돌이 해결됨.
- 루트 `npm run build`, `node --experimental-strip-types --test tests/tradeSignals.test.mjs`가 성공함.
- 이전 버전 복구 경로가 확인됨. **이 조건이 충족되기 전에는 어떠한 GitHub 자동 배포/수동 Wrangler 배포도 수행하지 않음.**

## 30종목 검사 기능
기능 코드는 GitHub `main`에 반영됨. 기존 KB API 한 번 최대 10종목 호출을 유지하며, 최대 30종목을 세 배치로 조회함. 일괄 조회 실패를 화면에 노출하며, 가상매매만 지원. 현재 롤백 중인 운영 버전에 적용되었다는 의미는 아님.
