-- bop-rms-migration: 1
-- owner: @rms/inventory
-- schema: rms_inventory
-- phase: expand
-- risk: high
-- transaction: required
-- lock-timeout-ms: 5000
-- statement-timeout-ms: 60000
-- recovery: forward-fix
-- WP-2423: per-Order-line reservations. Schema 2 snapshots carry binding.cartItemReference so each
-- Order line is reserved, started, consumed or released on its own. Schema 1 history stays valid.
LOCK TABLE rms_inventory.stock_reservation_version,rms_inventory.stock_reservation_set IN SHARE ROW EXCLUSIVE MODE;
ALTER TABLE rms_inventory.stock_reservation_version DROP CONSTRAINT stock_reservation_version_check2;
ALTER TABLE rms_inventory.stock_reservation_version ADD CONSTRAINT stock_reservation_version_snapshot_check CHECK ((
  snapshot_json->>'schemaVersion' IN ('1','2')
  AND (snapshot_json->'binding' ? 'cartItemReference') = (snapshot_json->>'schemaVersion'='2')
  AND (snapshot_json->>'schemaVersion'='1'
    OR snapshot_json->'binding'->>'cartItemReference' ~ '^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$')
  AND snapshot_json->>'reservationReference'=reservation_id::text
  AND snapshot_json->>'version'=version::text
  AND snapshot_json->'binding'->>'tenantReference'=tenant_id::text
  AND snapshot_json->'binding'->>'brandReference'=brand_id::text
  AND snapshot_json->'binding'->>'storeReference'=store_id::text
  AND snapshot_json->'binding'->>'submissionReference'=submission_id::text
  AND snapshot_json->'binding'->>'demandReference'=demand_id::text
  AND snapshot_json->>'updatedAt'=to_char(occurred_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
  AND snapshot_json->>'originalQuantity' ~ '^(0|[1-9][0-9]*)([.][0-9]{1,6})?$'
  AND snapshot_json->>'remainingQuantity' ~ '^(0|[1-9][0-9]*)([.][0-9]{1,6})?$'
  AND snapshot_json->>'releasedQuantity' ~ '^(0|[1-9][0-9]*)([.][0-9]{1,6})?$'
  AND snapshot_json->>'consumedQuantity' ~ '^(0|[1-9][0-9]*)([.][0-9]{1,6})?$'
  AND (snapshot_json->>'originalQuantity')::numeric>0
  AND (snapshot_json->>'originalQuantity')::numeric=
    (snapshot_json->>'remainingQuantity')::numeric+(snapshot_json->>'releasedQuantity')::numeric+(snapshot_json->>'consumedQuantity')::numeric
 ) IS TRUE);
DROP INDEX rms_inventory.stock_reservation_demand_once;
CREATE UNIQUE INDEX stock_reservation_demand_line_once ON rms_inventory.stock_reservation_version
 (tenant_id,brand_id,store_id,account_id,submission_id,demand_id,
  (coalesce(snapshot_json->'binding'->>'cartItemReference','')))
 WHERE version=1;
CREATE OR REPLACE FUNCTION rms_inventory.verify_reservation_set_children() RETURNS trigger
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
  SELECT 1 FROM (VALUES ('operationReference'),('movementReference'),('auditReference')) fields(name)
  WHERE (SELECT count(DISTINCT e->>fields.name) FROM jsonb_array_elements(NEW.record_json->'entries') e)<>count_children
 ) OR (
  SELECT count(DISTINCT (e->>'accountReference')||':'||coalesce(e->'reservation'->'binding'->>'cartItemReference',''))
  FROM jsonb_array_elements(NEW.record_json->'entries') e
 )<>count_children OR (
  SELECT count(DISTINCT e->'reservation'->>'schemaVersion') FROM jsonb_array_elements(NEW.record_json->'entries') e
 )<>1 THEN
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
