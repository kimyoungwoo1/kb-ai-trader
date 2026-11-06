# Trading Engine v2 — rollout and server cutover

## Current safe status
- Real order placement is **disabled**. The existing simulation and localStorage ledger are unchanged.
- Stage 1: KB OAuth is cached only within the lifetime of a Cloudflare Worker isolate, with broker-defined expiry capped at 8 hours and a safety margin. It is **not** a guaranteed eight-hour cache across isolates.
- Stage 2: New virtual entries are suspended after three consecutive losing automated exits. Existing virtual exits remain eligible. Existing daily realized-loss limit, 3-position cap, position sizing, and 5-minute quote freshness checks remain in force.
- Stage 3: Closed-trade metrics now include holding duration for exact code/quantity matches, win/loss payoff ratio, and recent loss streak. Metrics are retrospective and have incomplete matches if older fills were truncated.
- Stage 4: Candidate cohort strength is an **observation**. Candidate symbols are selected, so this is not a market-wide bull/bear regime and is not used to change orders without index-wide evidence.

## Stage 5 — required before unattended simulation
Do **not** activate an unattended server trader using browser localStorage as the source of truth. A Durable Object or D1 transaction-backed ledger is necessary:
1. Create a persistent server-side **separate** virtual account. Migrate historical client-side trades only via explicit, reviewed one-off import; never silently overwrite either account.
2. Keep strategy state, candidate queue, positions, executions, last processed market snapshot and daily risk budget in durable storage.
3. Give each simulated fill an idempotency key (account id + snapshot id + symbol + side). Enforce a uniqueness constraint and atomic cash/position/ledger changes.
4. Schedule scans using Cloudflare Cron at no less than the provider's permitted request cadence. Cloudflare Cron may not provide strict 30-second execution; use an appropriate managed long-running or queue-based component if sub-minute execution is necessary.
5. Implement a server-only API using Cloudflare Secrets, authenticated status endpoints, market-hours and holiday checks, retry/backoff and token expiry retry, explicit fail-closed handling on stale/inconsistent market data, and pause/resume controls.
6. Run shadow mode against production quotes while **executing no orders**, compare resulting server decisions with the browser engine, and monitor skipped/duplicate cycles.
7. Add deterministic unit tests for duplicate scheduler deliveries, concurrent fills, partial fills, quote aging, same-day loss locks, restarts, and ledger migration.
8. Only after verification, cut over the simulation with a manual deployment flag; preserve a rollback path.
9. Actual brokerage orders remain out of scope and must never be enabled as a side effect of this rollout.

## Validation checklist
- Run frontend TypeScript build and tests.
- Validate Worker typechecking and API smoke tests without exposing credentials.
- Confirm API token errors do not leak secrets and do not poison the token cache.
- Test broker expiry, Worker cold starts, and simultaneous quote requests.
- Confirm no unexpected differences in the pre-existing paper ledger on upgrade.
