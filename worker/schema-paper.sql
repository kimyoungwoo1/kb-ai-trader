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
