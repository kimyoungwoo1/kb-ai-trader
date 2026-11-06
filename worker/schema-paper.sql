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
