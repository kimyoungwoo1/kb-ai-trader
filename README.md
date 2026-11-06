# kb-ai-trader
KB Securities AI Swing Trading

## Paper trading: Cloudflare D1 backups

The app stores paper fills, positions, scan decisions, and account history in
**browser localStorage** for live, paper-only execution. Cloudflare D1 adds a
**automatic checkpoints and on-fill backups**, plus manual backup/restore, with a D1 exclusive paper-trading lease.

### One-time setup and production deploy

From GitHub Codespaces with an authenticated Wrangler session:

```bash
cd /workspaces/kb-ai-trader
node scripts/setup-paper-cloud.mjs
```

The setup script finds or creates the dedicated D1 database
`kb-ai-trader-paper`, initializes the idempotent
`paper_backup_head`, `paper_backup_history`, and `paper_trade_lease` schema, and then runs the
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
When a paper trade is recorded, the browser schedules a D1 backup after
a short debounce. While the browser stays logged in, it also saves a
no-trade checkpoint about every **2 minutes**. The current backup in
`paper_backup_head` always has a revision number. Trade-triggered and
explicit manual snapshots are appended to `paper_backup_history`; routine
no-trade checkpoints update only the latest version to avoid excessive
storage growth.

The D1 `paper_trade_lease` table grants **one tab/device** at a time the
right to run automatic paper fills. Each browser session uses a new
unshared random lease owner, renews its 90-second lease every 30 seconds,
and verifies ownership again **after network requests and before committing
an automatic fill**. Lease loss, backup errors and version conflicts
block further automatic fills instead of allowing diverging trades.
The browser shows this state prominently.

Use **현재 기록 서버에 백업** for an explicit, archived snapshot at any time.
Backups use optimistic revision checks (HTTP 409 on conflicts).
Manual backups share the same serialization and lease checks as automatic
ones rather than racing for the D1 revision.

To move to a different PC, **stop automated paper trading on the old PC**,
save a new server backup, then on the new PC leave automatic trading
stopped and select **서버 기록 이 브라우저에 복원**. The restore saves
a local rollback copy and always restarts with automatic trading disabled.
Explicitly restart paper trading only on the one active PC.

This release adds an automatic **browser-side** backup, not a
server-hosted trading process. Other tabs/devices cannot commit
automatic mock orders while another owns the current D1 lease, but
the app still does NOT provide shared live-account state or real securities
orders. Reopen/restore the latest backup before changing devices.
An unexpected browser shutdown may still interrupt a pending backup
request: this is best-effort and not an exactly-once server trade journal.

**Important:** after deploying lease protection, close or reload every
old tab running a pre-upgrade version. Older browser code does not know
about the new D1 trade lease, so it cannot participate in the guard.

### API access and safety

`POST /api/paper/backup` is accessible only with the existing dashboard
Bearer token. Actions: `status`, `load`, `save`, `claim`, `renew`, `release`. Snapshot size capped
at 1.7 MB; writes use optimistic revision locking. The server does not
accept broker API credentials in backup snapshots. If D1 has not been provisioned or the backup is unavailable, the new browser
trading engine **blocks new automatic paper fills** until storage is restored.
Existing local cash/positions/trade history are not erased.

Run `npm run build` and `node --experimental-strip-types --test tests/paperCloudBackup.test.mjs`
for local validation. Cloudflare D1 availability, API quotas, and billing
depend on your Cloudflare account.
