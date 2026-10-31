-- bop-rms-migration: 1
-- owner: @rms/store
-- schema: rms_store
-- phase: expand
-- risk: medium
-- transaction: required
-- lock-timeout-ms: 5000
-- statement-timeout-ms: 60000
-- recovery: forward-fix
-- WP-2423 Q9-G1 (DEC-OUTAGE-ACCEPTANCE-HOLD): whether the Store's staff are online. Signed-in staff
-- screens (Orders page, kitchen board, counter order) report activity; one row is one continuous
-- online period. A period is extended (last_seen_at moves forward, at most once a minute) while
-- activity continues; a gap of more than five minutes means the Store was offline and the next
-- activity starts a new row. Rows are never deleted, so the gaps between them are the Store's
-- outage history. No person, device or request detail is stored.
CREATE TABLE rms_store.store_presence_session (
 brand_id platform_helpers.uuid_v7 NOT NULL,
 store_id platform_helpers.uuid_v7 NOT NULL,
 session_id platform_helpers.uuid_v7 NOT NULL,
 started_at timestamptz NOT NULL CHECK (isfinite(started_at) AND started_at=date_trunc('milliseconds',started_at)),
 last_seen_at timestamptz NOT NULL CHECK (isfinite(last_seen_at) AND last_seen_at=date_trunc('milliseconds',last_seen_at)),
 CONSTRAINT store_presence_session_pk PRIMARY KEY (brand_id,store_id,session_id),
 CONSTRAINT store_presence_session_start UNIQUE (brand_id,store_id,started_at),
 CONSTRAINT store_presence_session_order CHECK (last_seen_at >= started_at)
);
CREATE INDEX store_presence_session_seen_idx
 ON rms_store.store_presence_session (brand_id,store_id,last_seen_at DESC);

-- Writers serialize per Store. A new period may start only after a gap of more than five minutes
-- since the latest activity; an update only moves last_seen_at forward within a live period.
CREATE FUNCTION rms_store.check_store_presence_session() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
BEGIN
 PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
  'StorePresence:' || NEW.brand_id::text || ':' || NEW.store_id::text, 0));
 IF TG_OP = 'INSERT' THEN
  IF NEW.last_seen_at <> NEW.started_at THEN
   RAISE EXCEPTION 'store presence period starts at its first activity' USING ERRCODE='23514';
  END IF;
  IF EXISTS (
   SELECT 1 FROM rms_store.store_presence_session s
   WHERE s.brand_id=NEW.brand_id AND s.store_id=NEW.store_id
    AND s.last_seen_at >= NEW.started_at - interval '5 minutes'
  ) THEN
   RAISE EXCEPTION 'store presence period overlaps a live period' USING ERRCODE='23505';
  END IF;
  RETURN NEW;
 END IF;
 IF NEW.brand_id IS DISTINCT FROM OLD.brand_id OR NEW.store_id IS DISTINCT FROM OLD.store_id
  OR NEW.session_id IS DISTINCT FROM OLD.session_id OR NEW.started_at IS DISTINCT FROM OLD.started_at
  OR NEW.last_seen_at <= OLD.last_seen_at
  OR NEW.last_seen_at > OLD.last_seen_at + interval '5 minutes'
  OR EXISTS (
   SELECT 1 FROM rms_store.store_presence_session s
   WHERE s.brand_id=OLD.brand_id AND s.store_id=OLD.store_id AND s.started_at > OLD.started_at
  ) THEN
  RAISE EXCEPTION 'store presence only extends the latest live period' USING ERRCODE='55000';
 END IF;
 RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION rms_store.check_store_presence_session() FROM PUBLIC;
CREATE TRIGGER store_presence_session_check BEFORE INSERT OR UPDATE ON rms_store.store_presence_session
 FOR EACH ROW EXECUTE FUNCTION rms_store.check_store_presence_session();

CREATE FUNCTION rms_store.reject_store_presence_session_delete() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
BEGIN
 RAISE EXCEPTION 'store presence history is kept' USING ERRCODE='55000';
END;
$$;
REVOKE ALL ON FUNCTION rms_store.reject_store_presence_session_delete() FROM PUBLIC;
CREATE TRIGGER store_presence_session_no_delete BEFORE DELETE ON rms_store.store_presence_session
 FOR EACH ROW EXECUTE FUNCTION rms_store.reject_store_presence_session_delete();

ALTER TABLE rms_store.store_presence_session ENABLE ROW LEVEL SECURITY;
ALTER TABLE rms_store.store_presence_session FORCE ROW LEVEL SECURITY;
CREATE POLICY store_presence_session_scope ON rms_store.store_presence_session
 USING (brand_id = platform_helpers.current_brand_id() AND store_id = platform_helpers.current_store_id())
 WITH CHECK (brand_id = platform_helpers.current_brand_id() AND store_id = platform_helpers.current_store_id());
REVOKE ALL ON TABLE rms_store.store_presence_session FROM PUBLIC;
