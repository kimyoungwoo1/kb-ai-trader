# Deployment safety — KB AI Trader

## Current production
Cloudflare production was restored by rollback after a manual Wrangler deployment appeared to lose essential Secret bindings. Treat the restored production version as the recovery point. GitHub `main` is not necessarily the same as the deployed Worker version.

## Important
- Do not run `wrangler deploy` or merge this feature PR without reviewing the live environment and getting a known-good snapshot.
- Do not put Secret values in `wrangler.jsonc`, GitHub, terminal logs, or chat.
- Never reset local files (including locally edited `package.json`, `vite.config.ts` or `.gitignore`) without reviewing their diff.
- Check the correct Cloudflare account, environment, Worker name and production URL.
- Read-only preflight: from repository root run `node scripts/check-cloudflare-secrets.mjs`. Failure means **do not deploy**.
- The preflight checks only that selected Secret names exist; it cannot guarantee that Wrangler will retain bindings during a deploy. Confirm current production bindings and a rollback version before deployment.
- Build from repository root with `npm run build`; validate frontend changes and unit tests before preview.
- Prefer a preview/staging Worker with separate non-production secrets and API limits for feature verification.
- After any approved production deployment, verify login, holdings, deposit, market data and manual/auto paper trading before considering it complete.

## Market scan feature
Only research/paper trading. Discover a broad market universe, rotate through up to 30 candidates per scan and call the existing KB API in batches of 10. The first successful batch's timestamp is intentionally used for paper-trading freshness checks; prolonged scans do not count as fresh quotes. Partial failures are surfaced in the UI. No live orders are enabled.
