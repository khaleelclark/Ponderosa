-- Compact metadata only; payload bytes live in an issued held sparse pool.
CREATE TABLE package_export_pool (
 singleton INTEGER PRIMARY KEY CHECK(singleton=1),
 state TEXT NOT NULL CHECK(state IN ('intent','ready')),
 receipt TEXT,
 high_water INTEGER NOT NULL DEFAULT 0 CHECK(high_water>=0)
);
CREATE TABLE package_export_claims (
  request_key TEXT PRIMARY KEY,
  selection_hash TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('preparing','completed','expired')),
  response_kind TEXT CHECK(response_kind IN ('json','download')),
  ticket_token TEXT
);
CREATE TABLE package_export_tickets (
  token TEXT PRIMARY KEY,
  claim_key TEXT,
  filename TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('writing','verifying','completed','removing')),
  bytes INTEGER NOT NULL DEFAULT 0 CHECK(bytes>=0),
  chunk_count INTEGER NOT NULL DEFAULT 0 CHECK(chunk_count>=0),
  sha256 TEXT,
  FOREIGN KEY(claim_key) REFERENCES package_export_claims(request_key)
);
CREATE TABLE package_export_chunks (
  token TEXT NOT NULL REFERENCES package_export_tickets(token) ON DELETE CASCADE,
  ordinal INTEGER NOT NULL CHECK(ordinal>=0),
  slot INTEGER NOT NULL UNIQUE CHECK(slot>=0),
  length INTEGER NOT NULL CHECK(length>0 AND length<=1048576),
  sha256 TEXT NOT NULL,
  PRIMARY KEY(token,ordinal)
);
CREATE TABLE package_export_readers (
  reader_id TEXT PRIMARY KEY,
  token TEXT NOT NULL REFERENCES package_export_tickets(token),
  started_at INTEGER NOT NULL
);
CREATE INDEX idx_package_export_expiry ON package_export_tickets(status,expires_at);
CREATE INDEX idx_package_export_readers_token ON package_export_readers(token);

-- Completed bytes are immutable. Cleanup changes status inside the same
-- transaction only after checking that no durable reader holds the ticket.
CREATE TRIGGER package_export_chunks_no_update BEFORE UPDATE ON package_export_chunks
WHEN (SELECT status FROM package_export_tickets WHERE token=OLD.token) IN ('verifying','completed')
BEGIN SELECT RAISE(ABORT,'completed export bytes are immutable'); END;
CREATE TRIGGER package_export_chunks_no_delete BEFORE DELETE ON package_export_chunks
WHEN (SELECT status FROM package_export_tickets WHERE token=OLD.token) IN ('verifying','completed')
BEGIN SELECT RAISE(ABORT,'completed export bytes are immutable'); END;
CREATE TRIGGER package_export_tickets_no_update BEFORE UPDATE ON package_export_tickets
WHEN (OLD.status='verifying' AND (
 NEW.status!='completed' OR NEW.token!=OLD.token OR NEW.claim_key IS NOT OLD.claim_key OR NEW.filename!=OLD.filename OR
 NEW.created_at!=OLD.created_at OR NEW.bytes!=OLD.bytes OR NEW.chunk_count!=OLD.chunk_count
)) OR (OLD.status='completed' AND (
 NEW.status!='removing' OR NEW.token!=OLD.token OR NEW.claim_key IS NOT OLD.claim_key OR NEW.filename!=OLD.filename OR
 NEW.created_at!=OLD.created_at OR NEW.expires_at!=OLD.expires_at OR NEW.bytes!=OLD.bytes OR
 NEW.chunk_count!=OLD.chunk_count OR NEW.sha256 IS NOT OLD.sha256 OR
 EXISTS(SELECT 1 FROM package_export_readers WHERE token=OLD.token)
))
BEGIN SELECT RAISE(ABORT,'completed export is held or immutable'); END;
CREATE TRIGGER package_export_tickets_no_delete BEFORE DELETE ON package_export_tickets
WHEN OLD.status!='removing'
BEGIN SELECT RAISE(ABORT,'unconfirmed or completed export cannot be deleted'); END;
CREATE TRIGGER package_export_chunks_no_insert BEFORE INSERT ON package_export_chunks
WHEN (SELECT status FROM package_export_tickets WHERE token=NEW.token)!='writing'
BEGIN SELECT RAISE(ABORT,'completed export bytes are immutable'); END;
