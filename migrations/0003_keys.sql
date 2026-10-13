-- D6: EdDSA signing keys (rotation with a one-key overlap) and audited token grants.
-- Keys live in D1 rather than KV: verification must see a rotation immediately (KV is eventually consistent).
-- The private JWK is sealed (AES-GCM, key derived from JWT_SIGNING_SECRET) and never leaves the Worker.
CREATE TABLE IF NOT EXISTS signing_keys (
  kid TEXT PRIMARY KEY,
  state TEXT NOT NULL CHECK (state IN ('current', 'previous', 'retired')),
  created_at INTEGER NOT NULL,
  public_jwk TEXT NOT NULL,
  sealed_private TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS signing_keys_one_current ON signing_keys(state) WHERE state = 'current';
CREATE TABLE IF NOT EXISTS settings (k TEXT PRIMARY KEY, v TEXT NOT NULL);
-- Every agent token minted: who granted it, for how long. Long-lived (> 1 h) grants are explicit and visible.
CREATE TABLE IF NOT EXISTS token_grants (
  jti TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL,
  ttl_s INTEGER NOT NULL,
  long_lived INTEGER NOT NULL DEFAULT 0,
  kid TEXT,
  granted_by TEXT NOT NULL,
  via TEXT NOT NULL,
  at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS token_grants_agent ON token_grants(agent_id, at);
