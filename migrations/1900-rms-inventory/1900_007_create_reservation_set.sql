-- bop-rms-migration: 1
-- owner: @rms/inventory
-- schema: rms_inventory
-- phase: expand
-- risk: medium
-- transaction: required
-- lock-timeout-ms: 5000
-- statement-timeout-ms: 60000
-- recovery: forward-fix
CREATE TABLE rms_inventory.stock_reservation_set (
 tenant_id platform_helpers.uuid_v7 NOT NULL,
 brand_id platform_helpers.uuid_v7 NOT NULL,
 store_id platform_helpers.uuid_v7 NOT NULL,
 set_id platform_helpers.uuid_v7 NOT NULL,
 operation_id platform_helpers.uuid_v7 NOT NULL,
 actor_id platform_helpers.uuid_v7 NOT NULL,
 audit_id platform_helpers.uuid_v7 NOT NULL,
 workflow_id platform_helpers.uuid_v7 NOT NULL,
 workflow_version bigint NOT NULL CHECK (workflow_version BETWEEN 1 AND 9007199254740991),
 request_digest text NOT NULL CHECK (request_digest ~ '^sha256:[0-9a-f]{64}$'),
 submission_id platform_helpers.uuid_v7 NOT NULL,
 cart_id platform_helpers.uuid_v7 NOT NULL,
 cart_version bigint NOT NULL CHECK (cart_version BETWEEN 1 AND 9007199254740991),
 quote_id platform_helpers.uuid_v7 NOT NULL,
 demand_id platform_helpers.uuid_v7 NOT NULL,
 demand_digest text NOT NULL CHECK (demand_digest ~ '^sha256:[0-9a-f]{64}$'),
 created_at timestamptz NOT NULL,
 record_json jsonb NOT NULL,
 PRIMARY KEY (tenant_id,brand_id,store_id,set_id),
 UNIQUE (tenant_id,brand_id,store_id,operation_id),
 UNIQUE (tenant_id,brand_id,store_id,submission_id,demand_id),
 CHECK (isfinite(created_at) AND date_trunc('milliseconds',created_at)=created_at),
 CHECK (jsonb_typeof(record_json)='object' AND jsonb_typeof(record_json->'entries')='array'),
 CHECK (jsonb_array_length(record_json->'entries') BETWEEN 1 AND 1000),
 CHECK ((
   record_json->>'schemaVersion'='1'
   AND record_json->>'setReference'=set_id::text
   AND record_json->>'operationReference'=operation_id::text
   AND record_json->>'actorReference'=actor_id::text
   AND record_json->>'auditReference'=audit_id::text
   AND record_json->>'workflowReference'=workflow_id::text
   AND record_json->>'workflowVersion'=workflow_version::text
   AND record_json->>'requestDigest'=request_digest
 ) IS TRUE)
);
CREATE FUNCTION rms_inventory.verify_reservation_set_children() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
DECLARE child jsonb;
DECLARE stored rms_inventory.stock_reservation_version%ROWTYPE;
DECLARE count_children integer;
BEGIN
 count_children := jsonb_array_length(NEW.record_json->'entries');
 IF count_children IS NULL OR count_children<1 OR count_children>1000 THEN
  RAISE EXCEPTION 'Invalid reservation set children' USING ERRCODE='23514';
 END IF;
 IF EXISTS (
  SELECT 1 FROM (VALUES ('accountReference'),('operationReference'),('movementReference'),('auditReference')) fields(name)
  WHERE (SELECT count(DISTINCT e->>fields.name) FROM jsonb_array_elements(NEW.record_json->'entries') e)<>count_children
 ) THEN
  RAISE EXCEPTION 'Duplicate reservation set child' USING ERRCODE='23514';
 END IF;
 FOR child IN SELECT value FROM jsonb_array_elements(NEW.record_json->'entries') LOOP
  SELECT * INTO stored FROM rms_inventory.stock_reservation_version
  WHERE tenant_id=NEW.tenant_id AND brand_id=NEW.brand_id AND store_id=NEW.store_id
   AND operation_id=(child->>'operationReference')::uuid AND version=1 AND action='Reserve';
  IF NOT FOUND OR stored.account_id::text IS DISTINCT FROM child->>'accountReference'
   OR stored.movement_id::text IS DISTINCT FROM child->>'movementReference'
   OR stored.audit_id::text IS DISTINCT FROM child->>'auditReference'
   OR stored.snapshot_json IS DISTINCT FROM child->'reservation'
   OR stored.submission_id<>NEW.submission_id OR stored.demand_id<>NEW.demand_id
   OR stored.occurred_at<>NEW.created_at
   OR (stored.snapshot_json->'binding'->>'cartReference') IS DISTINCT FROM NEW.cart_id::text
   OR (stored.snapshot_json->'binding'->>'cartVersion') IS DISTINCT FROM NEW.cart_version::text
   OR (stored.snapshot_json->'binding'->>'quoteReference') IS DISTINCT FROM NEW.quote_id::text
   OR (stored.snapshot_json->'binding'->>'demandDigest') IS DISTINCT FROM NEW.demand_digest
  THEN
   RAISE EXCEPTION 'Reservation set child mismatch' USING ERRCODE='23514';
  END IF;
 END LOOP;
 RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION rms_inventory.verify_reservation_set_children() FROM PUBLIC;
CREATE TRIGGER reservation_set_children BEFORE INSERT ON rms_inventory.stock_reservation_set
FOR EACH ROW EXECUTE FUNCTION rms_inventory.verify_reservation_set_children();
CREATE FUNCTION rms_inventory.reject_reservation_set_mutation() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
BEGIN
 RAISE EXCEPTION 'Reservation set history is immutable' USING ERRCODE='55000';
END;
$$;
REVOKE ALL ON FUNCTION rms_inventory.reject_reservation_set_mutation() FROM PUBLIC;
CREATE TRIGGER reservation_set_immutable BEFORE UPDATE OR DELETE ON rms_inventory.stock_reservation_set
FOR EACH ROW EXECUTE FUNCTION rms_inventory.reject_reservation_set_mutation();
CREATE TRIGGER reservation_set_no_truncate BEFORE TRUNCATE ON rms_inventory.stock_reservation_set
FOR EACH STATEMENT EXECUTE FUNCTION rms_inventory.reject_reservation_set_mutation();
ALTER TABLE rms_inventory.stock_reservation_set ENABLE ROW LEVEL SECURITY;
ALTER TABLE rms_inventory.stock_reservation_set FORCE ROW LEVEL SECURITY;
CREATE POLICY reservation_set_scope ON rms_inventory.stock_reservation_set
USING ((brand_id=platform_helpers.current_brand_id() AND store_id=platform_helpers.current_store_id()
 AND tenant_id::text=current_setting('bop.tenant_id',true)) IS TRUE)
WITH CHECK ((brand_id=platform_helpers.current_brand_id() AND store_id=platform_helpers.current_store_id()
 AND tenant_id::text=current_setting('bop.tenant_id',true)) IS TRUE);
REVOKE ALL ON TABLE rms_inventory.stock_reservation_set FROM PUBLIC;
