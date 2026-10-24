-- bop-rms-migration: 1
-- owner: @rms/ordering
-- schema: rms_ordering
-- phase: expand
-- risk: medium
-- transaction: required
-- lock-timeout-ms: 5000
-- statement-timeout-ms: 60000
-- recovery: forward-fix
CREATE TABLE rms_ordering.order_closure_version (
 closure_id platform_helpers.uuid_v7 PRIMARY KEY,
 operation_id platform_helpers.uuid_v7 NOT NULL,
 tenant_id platform_helpers.uuid_v7 NOT NULL,
 brand_id platform_helpers.uuid_v7 NOT NULL,
 store_id platform_helpers.uuid_v7 NOT NULL,
 order_id platform_helpers.uuid_v7 NOT NULL,
 closure_version integer NOT NULL CHECK (closure_version>0),
 order_version integer NOT NULL CHECK (order_version>0),
 previous_closure_id platform_helpers.uuid_v7 REFERENCES rms_ordering.order_closure_version(closure_id),
 status text NOT NULL CHECK (status IN ('Open','Closed')),
 actor_type text NOT NULL CHECK (actor_type IN ('User','System')),
 actor_id platform_helpers.uuid_v7,
 reason_code text NOT NULL CHECK (reason_code ~ '^[A-Z][A-Z0-9_]{0,63}$'),
 financial_finality_id platform_helpers.uuid_v7,
 evidence_digest text NOT NULL CHECK (evidence_digest ~ '^sha256:[0-9a-f]{64}$'),
 occurred_at timestamptz NOT NULL CHECK (isfinite(occurred_at) AND occurred_at=date_trunc('milliseconds',occurred_at)),
 UNIQUE (brand_id,store_id,operation_id),
 UNIQUE (brand_id,store_id,order_id,closure_version),
 FOREIGN KEY (order_id,brand_id,store_id) REFERENCES rms_ordering.order_header(order_id,brand_id,store_id),
 CHECK ((actor_type='System')=(actor_id IS NULL)),
 CHECK (status<>'Open' OR actor_type='User'),
 CHECK ((status='Closed')=(financial_finality_id IS NOT NULL)),
 CHECK ((closure_version=1)=(previous_closure_id IS NULL))
);
CREATE FUNCTION rms_ordering.validate_order_closure_version() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
DECLARE previous rms_ordering.order_closure_version%ROWTYPE;
BEGIN
 PERFORM order_id FROM rms_ordering.order_header WHERE order_id=NEW.order_id AND brand_id=NEW.brand_id
  AND store_id=NEW.store_id AND created_at<=NEW.occurred_at FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'invalid closure order' USING ERRCODE='23514'; END IF;
 IF NEW.order_version IS DISTINCT FROM (SELECT max(version) FROM rms_ordering.order_revision WHERE brand_id=NEW.brand_id AND store_id=NEW.store_id AND order_id=NEW.order_id)
 OR NOT EXISTS (SELECT 1 FROM rms_ordering.order_revision WHERE brand_id=NEW.brand_id AND store_id=NEW.store_id AND order_id=NEW.order_id AND version=NEW.order_version AND occurred_at<=NEW.occurred_at)
 THEN RAISE EXCEPTION 'stale closure order version' USING ERRCODE='23514'; END IF;
 SELECT * INTO previous FROM rms_ordering.order_closure_version WHERE brand_id=NEW.brand_id
  AND store_id=NEW.store_id AND order_id=NEW.order_id ORDER BY closure_version DESC LIMIT 1;
 IF previous.closure_id IS NULL THEN
  IF NEW.closure_version<>1 OR NEW.status<>'Closed' THEN RAISE EXCEPTION 'invalid initial closure' USING ERRCODE='23514'; END IF;
 ELSE
  IF NEW.tenant_id<>previous.tenant_id OR NEW.closure_version<>previous.closure_version+1
    OR NEW.previous_closure_id IS DISTINCT FROM previous.closure_id OR NEW.status=previous.status
    OR NEW.occurred_at<previous.occurred_at OR NEW.order_version<previous.order_version
  THEN RAISE EXCEPTION 'invalid closure transition' USING ERRCODE='23514'; END IF;
 END IF;
 RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION rms_ordering.validate_order_closure_version() FROM PUBLIC;
CREATE TRIGGER order_closure_version_validate BEFORE INSERT ON rms_ordering.order_closure_version
 FOR EACH ROW EXECUTE FUNCTION rms_ordering.validate_order_closure_version();
CREATE FUNCTION rms_ordering.reject_order_closure_version_mutation() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
BEGIN
 RAISE EXCEPTION 'append-only closure history' USING ERRCODE='55000';
END;
$$;
REVOKE ALL ON FUNCTION rms_ordering.reject_order_closure_version_mutation() FROM PUBLIC;
CREATE TRIGGER order_closure_version_no_mutation BEFORE UPDATE OR DELETE ON rms_ordering.order_closure_version
 FOR EACH ROW EXECUTE FUNCTION rms_ordering.reject_order_closure_version_mutation();
CREATE TRIGGER order_closure_version_no_truncate BEFORE TRUNCATE ON rms_ordering.order_closure_version
 FOR EACH STATEMENT EXECUTE FUNCTION rms_ordering.reject_order_closure_version_mutation();
ALTER TABLE rms_ordering.order_closure_version ENABLE ROW LEVEL SECURITY;
ALTER TABLE rms_ordering.order_closure_version FORCE ROW LEVEL SECURITY;
CREATE POLICY order_closure_version_scope ON rms_ordering.order_closure_version
 USING (brand_id=platform_helpers.current_brand_id() AND store_id=platform_helpers.current_store_id())
 WITH CHECK (brand_id=platform_helpers.current_brand_id() AND store_id=platform_helpers.current_store_id());
REVOKE ALL ON TABLE rms_ordering.order_closure_version FROM PUBLIC;
