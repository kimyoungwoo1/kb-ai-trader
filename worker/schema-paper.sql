-- Independent, explicit-only PAPER trading backups. No real securities data/orders.
CREATE TABLE IF NOT EXISTS paper_backup_head (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  revision INTEGER NOT NULL CHECK (revision > 0),
  updated_at TEXT NOT NULL,
  snapshot_json TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS paper_backup_history (
  revision INTEGER PRIMARY KEY,
  updated_at TEXT NOT NULL,
  snapshot_json TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_paper_backup_updated ON paper_backup_history(updated_at);

-- One active browser/device executes the automatic paper trading loop at a time.
CREATE TABLE IF NOT EXISTS paper_trade_lease (
 id INTEGER PRIMARY KEY CHECK (id = 1),
 owner TEXT NOT NULL,
 lease_until INTEGER NOT NULL
);

-- Server-owned paper account. The browser backup is not modified during migration.
CREATE TABLE IF NOT EXISTS server_paper_state (
  id INTEGER PRIMARY KEY CHECK(id=1),
  revision INTEGER NOT NULL,
  mode TEXT NOT NULL CHECK(mode IN ('running','stopped')),
  cycle_slot INTEGER NOT NULL DEFAULT -1,
  busy_until INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL,
  snapshot_json TEXT NOT NULL,
  last_error TEXT
);

-- Cron invocation audit only; it never changes the trading ledger.
CREATE TABLE IF NOT EXISTS server_paper_cron_runs (
 slot INTEGER PRIMARY KEY,
 started_at TEXT NOT NULL,
 finished_at TEXT NOT NULL,
 result TEXT NOT NULL,
 message TEXT NOT NULL,
 scanned INTEGER NOT NULL DEFAULT 0,
 filled INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_server_paper_cron_result_slot ON server_paper_cron_runs(result,slot DESC);

-- User-owned notification inbox; independent of trading account writes.
CREATE TABLE IF NOT EXISTS paper_notifications (
 id INTEGER PRIMARY KEY AUTOINCREMENT,
 event_key TEXT NOT NULL UNIQUE,
 kind TEXT NOT NULL,
 title TEXT NOT NULL,
 body TEXT NOT NULL,
 created_at TEXT NOT NULL,
 read_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_paper_notifications_created ON paper_notifications(id DESC);
CREATE TABLE IF NOT EXISTS paper_push_subscriptions (
 endpoint TEXT PRIMARY KEY,
 subscription_json TEXT NOT NULL,
 created_at TEXT NOT NULL,
 updated_at TEXT NOT NULL
);

-- Global push preferences for this single-user private dashboard.
CREATE TABLE IF NOT EXISTS paper_notification_settings (
 id INTEGER PRIMARY KEY CHECK(id=1),
 settings_json TEXT NOT NULL,
 updated_at TEXT NOT NULL
);

-- Separate real-money trial readiness log; does NOT place brokerage orders.
CREATE TABLE IF NOT EXISTS live_trial_settings (
 id INTEGER PRIMARY KEY CHECK(id=1),
 enabled INTEGER NOT NULL DEFAULT 0 CHECK(enabled=0),
 updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS live_trial_candidates (
 id INTEGER PRIMARY KEY AUTOINCREMENT,
 trading_day TEXT NOT NULL UNIQUE,
 event_id TEXT NOT NULL UNIQUE,
 code TEXT NOT NULL,
 name TEXT NOT NULL,
 side TEXT NOT NULL CHECK(side='BUY'),
 quantity INTEGER NOT NULL CHECK(quantity>0),
 limit_price INTEGER NOT NULL CHECK(limit_price>0),
 notional INTEGER NOT NULL CHECK(notional<=50000),
 reason TEXT NOT NULL,
 status TEXT NOT NULL CHECK(status='DRY_RUN_ONLY'),
 created_at TEXT NOT NULL
);
