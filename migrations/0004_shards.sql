-- D7: Artifacts namespace shard per repo (0 = the original namespace; repos created before sharding stay there).
ALTER TABLE repos ADD COLUMN shard INTEGER NOT NULL DEFAULT 0;
