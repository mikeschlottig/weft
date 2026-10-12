-- weft-index: cross-repo projections rebuilt from RepoCoordinator events (spec §4.3).
CREATE TABLE IF NOT EXISTS agents (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  model TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  disabled INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS repos (
  id TEXT PRIMARY KEY,
  created_at INTEGER NOT NULL,
  config TEXT NOT NULL
);
-- One row per scored changeset: the rubric history agents and models are ranked on.
-- `outcome` is the lagging label (e.g. 'reverted') used to calibrate thresholds.
CREATE TABLE IF NOT EXISTS scorecards (
  repo TEXT NOT NULL,
  cs_id TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  agent_name TEXT NOT NULL,
  model TEXT NOT NULL,
  status TEXT NOT NULL,
  wqs INTEGER,
  intent_alignment REAL,
  test_adequacy REAL,
  security_concern REAL,
  hold TEXT,
  outcome TEXT,
  data TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (repo, cs_id)
);
CREATE INDEX IF NOT EXISTS scorecards_agent ON scorecards(agent_name, model);
