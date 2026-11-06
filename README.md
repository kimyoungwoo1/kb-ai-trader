# kb-ai-trader
KB Securities AI Swing Trading

## Paper trading: Cloudflare D1 backups

The app stores paper fills, positions, scan decisions, and account history in
**browser localStorage** for live, paper-only execution. Cloudflare D1 adds a
**manual, opt-in backup/restore** capability without changing the trading engine.

### One-time setup and production deploy

From GitHub Codespaces with an authenticated Wrangler session:

```bash
cd /workspaces/kb-ai-trader
node scripts/setup-paper-cloud.mjs
```

The setup script finds or creates the dedicated D1 database
`kb-ai-trader-paper`, initializes the idempotent
`paper_backup_head` and `paper_backup_history` schema, and then runs the
existing **Secret-preserving** Cloudflare production deployment pipeline.
It never resets your browser paper cash, positions, or fills.

All subsequent deployments use:

```bash
node scripts/deploy-verified-production.mjs
```

The deployment pipeline automatically reuses the existing D1 binding (or
finds the dedicated database by name), checks all five existing Secrets,
and validates the new D1 binding before switching production traffic.
**Do not replace this pipeline with raw `wrangler deploy`**: it may remove
the inherited Secret bindings in this project's immutable Worker versions.

### User-facing workflow

Open the **매매 분석** menu and find **가상매매 기록 클라우드 백업**.
Use **현재 기록 서버에 백업** for the first server snapshot and subsequent
updates. Backups are revisioned; the API refuses stale writes with HTTP 409,
so competing browser versions do not silently overwrite one another.
The server retains an append-only revision audit in D1.

To move to a different PC, **stop automated paper trading on the old PC**,
save a new server backup, then on the new PC leave automatic trading
stopped and select **서버 기록 이 브라우저에 복원**. The restore saves
a local rollback copy and always restarts with automatic trading disabled.
Explicitly restart paper trading only on the one active PC.

This release is **manual backup**, not multi-device live account
synchronization or distributed trade execution. Do not run the browser
trading loop concurrently on multiple PCs. It never sends real
securities orders. No background cloud backup runs when the browser closes.

### API access and safety

`POST /api/paper/backup` is accessible only with the existing dashboard
Bearer token. Actions: `status`, `load`, `save`. Snapshot size capped
at 1.7 MB; writes use optimistic revision locking. The server does not
accept broker API credentials in backup snapshots. If D1 has not been
provisioned, the trading engine continues as before; backup API returns 503.

Run `npm run build` and `node --experimental-strip-types --test tests/paperCloudBackup.test.mjs`
for local validation. Cloudflare D1 availability, API quotas, and billing
depend on your Cloudflare account.
