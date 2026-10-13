-- FR-40: per-agent budgets and the kill switch (D1 is read on every agent request: consistent, unlike KV).
ALTER TABLE agents ADD COLUMN budget_json TEXT;
ALTER TABLE agents ADD COLUMN killed_at INTEGER;
ALTER TABLE agents ADD COLUMN killed_by TEXT;
-- Daily usage counters, updated atomically at submit time (UPDATE … WHERE under-limit … RETURNING).
CREATE TABLE IF NOT EXISTS agent_usage (
  agent_id TEXT NOT NULL,
  day TEXT NOT NULL,
  changesets INTEGER NOT NULL DEFAULT 0,
  cost_usd REAL NOT NULL DEFAULT 0,
  PRIMARY KEY (agent_id, day)
);
