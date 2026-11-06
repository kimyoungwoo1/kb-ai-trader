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
