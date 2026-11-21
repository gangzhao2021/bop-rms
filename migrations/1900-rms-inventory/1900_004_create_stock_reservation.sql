-- bop-rms-migration: 1
-- owner: @rms/inventory
-- schema: rms_inventory
-- phase: expand
-- risk: medium
-- transaction: required
-- lock-timeout-ms: 5000
-- statement-timeout-ms: 60000
-- recovery: forward-fix
CREATE TABLE rms_inventory.stock_reservation_version (
 tenant_id platform_helpers.uuid_v7 NOT NULL,
 brand_id platform_helpers.uuid_v7 NOT NULL,
 store_id platform_helpers.uuid_v7 NOT NULL,
 account_id platform_helpers.uuid_v7 NOT NULL,
 reservation_id platform_helpers.uuid_v7 NOT NULL,
 version bigint NOT NULL CHECK (version BETWEEN 1 AND 9007199254740991),
 operation_id platform_helpers.uuid_v7 NOT NULL,
 intent_hash text NOT NULL CHECK (intent_hash ~ '^sha256:[0-9a-f]{64}$'),
 action text NOT NULL CHECK (action IN ('Reserve','Release','Consume','StartProduction')),
 submission_id platform_helpers.uuid_v7 NOT NULL,
 demand_id platform_helpers.uuid_v7 NOT NULL,
 movement_id platform_helpers.uuid_v7,
 audit_id platform_helpers.uuid_v7 NOT NULL,
 snapshot_json jsonb NOT NULL CHECK (jsonb_typeof(snapshot_json)='object'),
 occurred_at timestamptz NOT NULL,
 PRIMARY KEY (tenant_id,brand_id,store_id,reservation_id,version),
 UNIQUE (tenant_id,brand_id,store_id,operation_id),
 UNIQUE (tenant_id,brand_id,store_id,movement_id),
 FOREIGN KEY (tenant_id,brand_id,store_id,account_id)
  REFERENCES rms_inventory.stock_account (tenant_id,brand_id,store_id,account_id),
 FOREIGN KEY (tenant_id,brand_id,store_id,movement_id)
  REFERENCES rms_inventory.stock_movement (tenant_id,brand_id,store_id,movement_id),
 CHECK ((action='StartProduction')=(movement_id IS NULL)),
 CHECK ((action='Reserve')=(version=1)),
 CHECK (isfinite(occurred_at) AND date_trunc('milliseconds',occurred_at)=occurred_at),
 CHECK ((
  snapshot_json->>'schemaVersion'='1'
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
 ) IS TRUE)
);
CREATE UNIQUE INDEX stock_reservation_demand_once ON rms_inventory.stock_reservation_version
 (tenant_id,brand_id,store_id,account_id,submission_id,demand_id) WHERE version=1;
CREATE FUNCTION rms_inventory.enforce_stock_reservation() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
DECLARE account rms_inventory.stock_account%ROWTYPE;
DECLARE previous rms_inventory.stock_reservation_version%ROWTYPE;
DECLARE movement rms_inventory.stock_movement%ROWTYPE;
DECLARE delta numeric;
BEGIN
 IF current_setting('transaction_isolation')<>'read committed' THEN
  RAISE EXCEPTION 'reservation writes require read committed' USING ERRCODE='25000';
 END IF;
 SELECT * INTO STRICT account FROM rms_inventory.stock_account
  WHERE tenant_id=NEW.tenant_id AND brand_id=NEW.brand_id AND store_id=NEW.store_id AND account_id=NEW.account_id FOR UPDATE;
 IF (NEW.snapshot_json->'binding'->>'itemReference'=account.item_id::text
   AND NEW.snapshot_json->'binding'->>'stockSiteReference'=account.stock_site_id::text
   AND NEW.snapshot_json->'binding'->>'locationReference'=account.location_id::text
   AND (NEW.snapshot_json->'binding'->>'lotReference') IS NOT DISTINCT FROM account.lot_id::text
   AND NEW.snapshot_json->'unit'->>'unitCode'=account.unit_code
   AND (NEW.snapshot_json->'unit'->>'ledgerPrecision')::integer=account.ledger_precision
   AND (NEW.snapshot_json->>'originalQuantity')::numeric=trunc((NEW.snapshot_json->>'originalQuantity')::numeric,account.ledger_precision)
   AND (NEW.snapshot_json->>'remainingQuantity')::numeric=trunc((NEW.snapshot_json->>'remainingQuantity')::numeric,account.ledger_precision)
   AND (NEW.snapshot_json->>'releasedQuantity')::numeric=trunc((NEW.snapshot_json->>'releasedQuantity')::numeric,account.ledger_precision)
   AND (NEW.snapshot_json->>'consumedQuantity')::numeric=trunc((NEW.snapshot_json->>'consumedQuantity')::numeric,account.ledger_precision)
   AND NEW.occurred_at>=account.created_at) IS NOT TRUE THEN
  RAISE EXCEPTION 'reservation account binding mismatch' USING ERRCODE='23514';
 END IF;
 SELECT * INTO previous FROM rms_inventory.stock_reservation_version
  WHERE tenant_id=NEW.tenant_id AND brand_id=NEW.brand_id AND store_id=NEW.store_id AND reservation_id=NEW.reservation_id
  ORDER BY version DESC LIMIT 1;
 IF FOUND THEN
  IF (NEW.version=previous.version+1 AND NEW.account_id=previous.account_id
    AND NEW.snapshot_json->'binding'=previous.snapshot_json->'binding'
    AND NEW.snapshot_json->'unit'=previous.snapshot_json->'unit'
    AND NEW.snapshot_json->>'createdAt'=previous.snapshot_json->>'createdAt'
    AND NEW.snapshot_json->>'originalQuantity'=previous.snapshot_json->>'originalQuantity'
    AND NEW.occurred_at>=previous.occurred_at
    AND (previous.snapshot_json->>'remainingQuantity')::numeric>0) IS NOT TRUE THEN
   RAISE EXCEPTION 'reservation version or binding conflict' USING ERRCODE='23514';
  END IF;
  delta:=(previous.snapshot_json->>'remainingQuantity')::numeric-(NEW.snapshot_json->>'remainingQuantity')::numeric;
  IF NEW.action='StartProduction' THEN
   IF (delta=0 AND previous.snapshot_json->'productionStartedAt'='null'::jsonb
     AND NEW.snapshot_json->>'productionStartedAt'=NEW.snapshot_json->>'updatedAt'
     AND NEW.snapshot_json->>'releasedQuantity'=previous.snapshot_json->>'releasedQuantity'
     AND NEW.snapshot_json->>'consumedQuantity'=previous.snapshot_json->>'consumedQuantity') IS NOT TRUE THEN
    RAISE EXCEPTION 'reservation production conflict' USING ERRCODE='23514';
   END IF;
  ELSIF ((NEW.snapshot_json->'productionStartedAt'=previous.snapshot_json->'productionStartedAt')
    AND delta>0
    AND ((NEW.action='Release' AND previous.snapshot_json->'productionStartedAt'='null'::jsonb
       AND (NEW.snapshot_json->>'releasedQuantity')::numeric=(previous.snapshot_json->>'releasedQuantity')::numeric+delta
       AND NEW.snapshot_json->>'consumedQuantity'=previous.snapshot_json->>'consumedQuantity')
      OR (NEW.action='Consume'
       AND (NEW.snapshot_json->>'consumedQuantity')::numeric=(previous.snapshot_json->>'consumedQuantity')::numeric+delta
       AND NEW.snapshot_json->>'releasedQuantity'=previous.snapshot_json->>'releasedQuantity'))) IS NOT TRUE THEN
   RAISE EXCEPTION 'reservation quantity or release conflict' USING ERRCODE='23514';
  END IF;
 ELSE
  delta:=(NEW.snapshot_json->>'originalQuantity')::numeric;
  IF (NEW.version=1 AND NEW.action='Reserve'
    AND (NEW.snapshot_json->>'remainingQuantity')::numeric=delta
    AND (NEW.snapshot_json->>'releasedQuantity')::numeric=0
    AND (NEW.snapshot_json->>'consumedQuantity')::numeric=0
    AND NEW.snapshot_json->'productionStartedAt'='null'::jsonb
    AND NEW.snapshot_json->>'createdAt'=NEW.snapshot_json->>'updatedAt') IS NOT TRUE THEN
   RAISE EXCEPTION 'initial reservation invalid' USING ERRCODE='23514';
  END IF;
 END IF;
 IF NEW.movement_id IS NOT NULL THEN
  SELECT * INTO STRICT movement FROM rms_inventory.stock_movement
   WHERE tenant_id=NEW.tenant_id AND brand_id=NEW.brand_id AND store_id=NEW.store_id AND movement_id=NEW.movement_id;
  IF (movement.account_id=NEW.account_id AND movement.movement_type=NEW.action
    AND movement.audit_id=NEW.audit_id AND movement.occurred_at=NEW.occurred_at
    AND movement.record_json->>'businessSourceType'='INVENTORY_RESERVATION'
    AND movement.record_json->>'businessSourceReference'=NEW.reservation_id::text
    AND movement.base_quantity_delta=CASE WHEN NEW.action='Reserve' THEN delta ELSE -delta END
    AND (NEW.action<>'Consume' OR
     (movement.record_json->'after'->>'reserved')::numeric=(movement.record_json->'before'->>'reserved')::numeric-delta)) IS NOT TRUE THEN
   RAISE EXCEPTION 'reservation movement ownership mismatch' USING ERRCODE='23514';
  END IF;
 END IF;
 RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION rms_inventory.enforce_stock_reservation() FROM PUBLIC;
CREATE TRIGGER stock_reservation_sequence BEFORE INSERT ON rms_inventory.stock_reservation_version
FOR EACH ROW EXECUTE FUNCTION rms_inventory.enforce_stock_reservation();
CREATE TRIGGER stock_reservation_immutable BEFORE UPDATE OR DELETE ON rms_inventory.stock_reservation_version
FOR EACH ROW EXECUTE FUNCTION rms_inventory.reject_item_history_mutation();
CREATE TRIGGER stock_reservation_no_truncate BEFORE TRUNCATE ON rms_inventory.stock_reservation_version
FOR EACH STATEMENT EXECUTE FUNCTION rms_inventory.reject_item_history_mutation();
ALTER TABLE rms_inventory.stock_reservation_version ENABLE ROW LEVEL SECURITY;
ALTER TABLE rms_inventory.stock_reservation_version FORCE ROW LEVEL SECURITY;
CREATE POLICY stock_reservation_scope ON rms_inventory.stock_reservation_version
USING ((tenant_id::text=current_setting('bop.tenant_id',true) AND brand_id=platform_helpers.current_brand_id()
 AND store_id=platform_helpers.current_store_id()) IS TRUE)
WITH CHECK ((tenant_id::text=current_setting('bop.tenant_id',true) AND brand_id=platform_helpers.current_brand_id()
 AND store_id=platform_helpers.current_store_id()) IS TRUE);
REVOKE ALL ON TABLE rms_inventory.stock_reservation_version FROM PUBLIC;
