-- bop-rms-migration: 1
-- owner: @rms/inventory
-- schema: rms_inventory
-- phase: expand
-- risk: high
-- transaction: required
-- lock-timeout-ms: 5000
-- statement-timeout-ms: 60000
-- recovery: forward-fix
-- WP-2423 / DEC-INV-OPENING: Store stock initialization. An opening count document (Draft ->
-- Submitted -> Posted, or Cancelled) is posted once per Store; posting registers lots, opens stock
-- accounts and writes one OpeningBalance movement per line, each an account's first movement.
-- Lots are registered per Store and Item by their printed lot code and expiry date.
LOCK TABLE rms_inventory.stock_movement,rms_inventory.stock_balance IN SHARE ROW EXCLUSIVE MODE;
ALTER TABLE rms_inventory.stock_movement DROP CONSTRAINT stock_movement_movement_type_check;
ALTER TABLE rms_inventory.stock_movement ADD CONSTRAINT stock_movement_movement_type_check CHECK (
  movement_type IN ('Receive','Reserve','Release','Consume','Adjustment','CountAdjustment','Waste','Correction','OpeningBalance')
);
CREATE OR REPLACE FUNCTION rms_inventory.apply_stock_movement() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
DECLARE account rms_inventory.stock_account%ROWTYPE;
DECLARE balance rms_inventory.stock_balance%ROWTYPE;
DECLARE after_on_hand numeric;
DECLARE after_reserved numeric;
DECLARE delta numeric;
BEGIN
  IF current_setting('transaction_isolation')<>'read committed' THEN
    RAISE EXCEPTION 'stock writes require read committed' USING ERRCODE='25000';
  END IF;
  SELECT * INTO STRICT account FROM rms_inventory.stock_account
    WHERE tenant_id=NEW.tenant_id AND brand_id=NEW.brand_id AND store_id=NEW.store_id AND account_id=NEW.account_id;
  SELECT * INTO STRICT balance FROM rms_inventory.stock_balance
    WHERE tenant_id=NEW.tenant_id AND brand_id=NEW.brand_id AND store_id=NEW.store_id AND account_id=NEW.account_id FOR UPDATE;
  IF EXISTS (SELECT 1 FROM rms_inventory.stock_movement
    WHERE tenant_id=NEW.tenant_id AND brand_id=NEW.brand_id AND store_id=NEW.store_id
      AND account_id=NEW.account_id AND ledger_version=balance.ledger_version AND occurred_at>NEW.occurred_at) THEN
    RAISE EXCEPTION 'stock movement clock conflict' USING ERRCODE='23514';
  END IF;
  delta:=NEW.base_quantity_delta;
  IF (NEW.ledger_version=balance.ledger_version+1
    AND NEW.record_json->>'itemReference'=account.item_id::text
    AND (NEW.record_json->>'lotReference') IS NOT DISTINCT FROM account.lot_id::text
    AND (NEW.record_json->>'expiryDate') IS NOT DISTINCT FROM account.expiry_date::text
    AND NEW.record_json->>'baseUnitCode'=account.unit_code
    AND (
      (NEW.record_json->'sourceScope'->>'scopeType'='Location'
       AND NEW.record_json->'sourceScope'->>'scopeReference'=account.location_id::text
       AND NEW.record_json->'destinationScope'='null'::jsonb)
      OR (NEW.record_json->'destinationScope'->>'scopeType'='Location'
       AND NEW.record_json->'destinationScope'->>'scopeReference'=account.location_id::text
       AND NEW.record_json->'sourceScope'='null'::jsonb)
    )
    AND NEW.record_json->'before'->>'unitCode'=account.unit_code
    AND NEW.record_json->'after'->>'unitCode'=account.unit_code
    AND (NEW.record_json->'before'->>'ledgerVersion')::bigint=balance.ledger_version
    AND (NEW.record_json->'after'->>'ledgerVersion')::bigint=NEW.ledger_version
    AND (NEW.record_json->'before'->>'onHand')::numeric=balance.on_hand
    AND (NEW.record_json->'before'->>'reserved')::numeric=balance.reserved
    AND (NEW.record_json->'before'->>'available')::numeric=balance.available
    AND (NEW.record_json->'before'->>'inTransit')::numeric=balance.in_transit
    AND (NEW.record_json->'after'->>'inTransit')::numeric=balance.in_transit
    AND delta=trunc(delta,account.ledger_precision)
    AND NEW.occurred_at>=account.created_at) IS NOT TRUE THEN
    RAISE EXCEPTION 'stock movement binding or version conflict' USING ERRCODE='23514';
  END IF;
  after_on_hand:=(NEW.record_json->'after'->>'onHand')::numeric;
  after_reserved:=(NEW.record_json->'after'->>'reserved')::numeric;
  IF (
    (NEW.movement_type='Receive' AND delta>0 AND after_on_hand=balance.on_hand+delta AND after_reserved=balance.reserved)
    OR (NEW.movement_type='Reserve' AND delta>0 AND after_on_hand=balance.on_hand AND after_reserved=balance.reserved+delta)
    OR (NEW.movement_type='Release' AND delta<0 AND after_on_hand=balance.on_hand AND after_reserved=balance.reserved+delta)
    OR (NEW.movement_type='Consume' AND delta<0 AND after_on_hand=balance.on_hand+delta
      AND (after_reserved=balance.reserved OR after_reserved=balance.reserved+delta))
    -- WP-2423: stock operations. None of them may consume reserved stock (reserved<=on_hand).
    OR (NEW.movement_type IN ('Adjustment','CountAdjustment') AND after_on_hand=balance.on_hand+delta
      AND after_reserved=balance.reserved)
    OR (NEW.movement_type='Waste' AND delta<0 AND after_on_hand=balance.on_hand+delta
      AND after_reserved=balance.reserved)
    -- WP-2423 / DEC-INV-OPENING: the audited opening count is an account's very first movement.
    OR (NEW.movement_type='OpeningBalance' AND delta>0 AND balance.ledger_version=1
      AND balance.on_hand=0 AND balance.reserved=0 AND after_on_hand=delta AND after_reserved=0)
    OR (NEW.movement_type='Correction' AND after_on_hand=balance.on_hand+delta
      AND after_reserved=balance.reserved
      AND EXISTS (SELECT 1 FROM rms_inventory.stock_movement corrected
        WHERE corrected.tenant_id=NEW.tenant_id AND corrected.brand_id=NEW.brand_id
          AND corrected.store_id=NEW.store_id AND corrected.account_id=NEW.account_id
          AND corrected.movement_id::text=NEW.record_json->>'correctsMovementReference'
          AND corrected.movement_type IN ('Receive','Adjustment','CountAdjustment','Waste','OpeningBalance')))
  ) IS NOT TRUE OR ((NEW.record_json->'after'->>'available')::numeric=after_on_hand-after_reserved) IS NOT TRUE THEN
    RAISE EXCEPTION 'stock movement arithmetic mismatch' USING ERRCODE='23514';
  END IF;
  UPDATE rms_inventory.stock_balance SET ledger_version=NEW.ledger_version,on_hand=after_on_hand,reserved=after_reserved
    WHERE tenant_id=NEW.tenant_id AND brand_id=NEW.brand_id AND store_id=NEW.store_id AND account_id=NEW.account_id;
  RETURN NEW;
END;
$$;

CREATE TABLE rms_inventory.stock_lot (
  tenant_id platform_helpers.uuid_v7 NOT NULL,
  brand_id platform_helpers.uuid_v7 NOT NULL,
  store_id platform_helpers.uuid_v7 NOT NULL,
  lot_id platform_helpers.uuid_v7 NOT NULL,
  item_id platform_helpers.uuid_v7 NOT NULL,
  lot_code text NOT NULL CHECK (lot_code ~ '^[A-Za-z0-9][A-Za-z0-9._/-]{0,63}$'),
  expiry_date date CHECK (expiry_date IS NULL OR isfinite(expiry_date)),
  source_type text NOT NULL CHECK (source_type IN ('OpeningCount','GoodsReceipt')),
  source_id platform_helpers.uuid_v7 NOT NULL,
  created_at timestamptz NOT NULL CHECK (isfinite(created_at) AND date_trunc('milliseconds',created_at)=created_at),
  created_by_actor_id platform_helpers.uuid_v7 NOT NULL,
  PRIMARY KEY (tenant_id,brand_id,store_id,lot_id),
  UNIQUE (tenant_id,brand_id,store_id,item_id,lot_code)
);

CREATE TABLE rms_inventory.opening_count (
  tenant_id platform_helpers.uuid_v7 NOT NULL,
  brand_id platform_helpers.uuid_v7 NOT NULL,
  store_id platform_helpers.uuid_v7 NOT NULL,
  count_id platform_helpers.uuid_v7 NOT NULL,
  created_at timestamptz NOT NULL CHECK (isfinite(created_at) AND date_trunc('milliseconds',created_at)=created_at),
  created_by_actor_id platform_helpers.uuid_v7 NOT NULL,
  PRIMARY KEY (tenant_id,brand_id,store_id,count_id)
);
CREATE TABLE rms_inventory.opening_count_version (
  tenant_id platform_helpers.uuid_v7 NOT NULL,
  brand_id platform_helpers.uuid_v7 NOT NULL,
  store_id platform_helpers.uuid_v7 NOT NULL,
  count_id platform_helpers.uuid_v7 NOT NULL,
  version integer NOT NULL CHECK (version BETWEEN 1 AND 100000),
  lifecycle text NOT NULL CHECK (lifecycle IN ('Draft','Submitted','Posted','Cancelled')),
  snapshot_json jsonb NOT NULL CHECK (jsonb_typeof(snapshot_json)='object' AND octet_length(snapshot_json::text)<=1048576),
  operation_id platform_helpers.uuid_v7 NOT NULL,
  intent_hash text NOT NULL CHECK (intent_hash ~ '^sha256:[0-9a-f]{64}$'),
  changed_by_actor_id platform_helpers.uuid_v7 NOT NULL,
  changed_at timestamptz NOT NULL CHECK (isfinite(changed_at) AND date_trunc('milliseconds',changed_at)=changed_at),
  audit_id platform_helpers.uuid_v7 NOT NULL,
  PRIMARY KEY (tenant_id,brand_id,store_id,count_id,version),
  UNIQUE (tenant_id,brand_id,store_id,operation_id),
  FOREIGN KEY (tenant_id,brand_id,store_id,count_id)
    REFERENCES rms_inventory.opening_count (tenant_id,brand_id,store_id,count_id)
);
-- Exactly one opening count is ever posted per Store.
CREATE TABLE rms_inventory.opening_count_posting (
  tenant_id platform_helpers.uuid_v7 NOT NULL,
  brand_id platform_helpers.uuid_v7 NOT NULL,
  store_id platform_helpers.uuid_v7 NOT NULL,
  count_id platform_helpers.uuid_v7 NOT NULL,
  movement_count integer NOT NULL CHECK (movement_count BETWEEN 1 AND 5000),
  posted_by_actor_id platform_helpers.uuid_v7 NOT NULL,
  posted_at timestamptz NOT NULL CHECK (isfinite(posted_at) AND date_trunc('milliseconds',posted_at)=posted_at),
  audit_id platform_helpers.uuid_v7 NOT NULL,
  PRIMARY KEY (tenant_id,brand_id,store_id),
  FOREIGN KEY (tenant_id,brand_id,store_id,count_id)
    REFERENCES rms_inventory.opening_count (tenant_id,brand_id,store_id,count_id)
);

CREATE FUNCTION rms_inventory.enforce_opening_count_version() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
DECLARE previous rms_inventory.opening_count_version%ROWTYPE;
BEGIN
  IF TG_OP<>'INSERT' THEN
    RAISE EXCEPTION 'opening count history is append-only' USING ERRCODE='55000';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('OpeningCount:'||NEW.store_id::text||':'||NEW.count_id::text,0));
  SELECT * INTO previous FROM rms_inventory.opening_count_version
    WHERE tenant_id=NEW.tenant_id AND brand_id=NEW.brand_id AND store_id=NEW.store_id AND count_id=NEW.count_id
    ORDER BY version DESC LIMIT 1;
  IF NOT FOUND THEN
    IF NEW.version<>1 OR NEW.lifecycle<>'Draft' THEN
      RAISE EXCEPTION 'opening count starts as version 1 Draft' USING ERRCODE='23514';
    END IF;
  ELSIF NEW.version<>previous.version+1
    OR NEW.changed_at<previous.changed_at
    OR NOT ((previous.lifecycle='Draft' AND NEW.lifecycle IN ('Draft','Submitted','Cancelled'))
      OR (previous.lifecycle='Submitted' AND NEW.lifecycle IN ('Draft','Posted','Cancelled'))) THEN
    RAISE EXCEPTION 'opening count version conflict' USING ERRCODE='23514';
  END IF;
  IF NEW.lifecycle='Posted' AND NOT EXISTS (SELECT 1 FROM rms_inventory.opening_count_posting p
      WHERE p.tenant_id=NEW.tenant_id AND p.brand_id=NEW.brand_id AND p.store_id=NEW.store_id AND p.count_id=NEW.count_id) THEN
    RAISE EXCEPTION 'opening count posting missing' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION rms_inventory.enforce_opening_count_version() FROM PUBLIC;
CREATE TRIGGER opening_count_version_guard BEFORE INSERT OR UPDATE OR DELETE ON rms_inventory.opening_count_version
  FOR EACH ROW EXECUTE FUNCTION rms_inventory.enforce_opening_count_version();
CREATE FUNCTION rms_inventory.reject_opening_stock_history_change() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
BEGIN
  RAISE EXCEPTION 'opening stock history is append-only' USING ERRCODE='55000';
END;
$$;
REVOKE ALL ON FUNCTION rms_inventory.reject_opening_stock_history_change() FROM PUBLIC;
CREATE TRIGGER opening_count_append_only BEFORE UPDATE OR DELETE ON rms_inventory.opening_count
  FOR EACH ROW EXECUTE FUNCTION rms_inventory.reject_opening_stock_history_change();
CREATE TRIGGER opening_count_posting_append_only BEFORE UPDATE OR DELETE ON rms_inventory.opening_count_posting
  FOR EACH ROW EXECUTE FUNCTION rms_inventory.reject_opening_stock_history_change();
CREATE TRIGGER stock_lot_append_only BEFORE UPDATE OR DELETE ON rms_inventory.stock_lot
  FOR EACH ROW EXECUTE FUNCTION rms_inventory.reject_opening_stock_history_change();

ALTER TABLE rms_inventory.stock_lot ENABLE ROW LEVEL SECURITY;
ALTER TABLE rms_inventory.stock_lot FORCE ROW LEVEL SECURITY;
ALTER TABLE rms_inventory.opening_count ENABLE ROW LEVEL SECURITY;
ALTER TABLE rms_inventory.opening_count FORCE ROW LEVEL SECURITY;
ALTER TABLE rms_inventory.opening_count_version ENABLE ROW LEVEL SECURITY;
ALTER TABLE rms_inventory.opening_count_version FORCE ROW LEVEL SECURITY;
ALTER TABLE rms_inventory.opening_count_posting ENABLE ROW LEVEL SECURITY;
ALTER TABLE rms_inventory.opening_count_posting FORCE ROW LEVEL SECURITY;
CREATE POLICY stock_lot_scope ON rms_inventory.stock_lot
USING ((tenant_id::text=current_setting('bop.tenant_id',true) AND brand_id=platform_helpers.current_brand_id()
 AND store_id=platform_helpers.current_store_id()) IS TRUE)
WITH CHECK ((tenant_id::text=current_setting('bop.tenant_id',true) AND brand_id=platform_helpers.current_brand_id()
 AND store_id=platform_helpers.current_store_id()) IS TRUE);
CREATE POLICY opening_count_scope ON rms_inventory.opening_count
USING ((tenant_id::text=current_setting('bop.tenant_id',true) AND brand_id=platform_helpers.current_brand_id()
 AND store_id=platform_helpers.current_store_id()) IS TRUE)
WITH CHECK ((tenant_id::text=current_setting('bop.tenant_id',true) AND brand_id=platform_helpers.current_brand_id()
 AND store_id=platform_helpers.current_store_id()) IS TRUE);
CREATE POLICY opening_count_version_scope ON rms_inventory.opening_count_version
USING ((tenant_id::text=current_setting('bop.tenant_id',true) AND brand_id=platform_helpers.current_brand_id()
 AND store_id=platform_helpers.current_store_id()) IS TRUE)
WITH CHECK ((tenant_id::text=current_setting('bop.tenant_id',true) AND brand_id=platform_helpers.current_brand_id()
 AND store_id=platform_helpers.current_store_id()) IS TRUE);
CREATE POLICY opening_count_posting_scope ON rms_inventory.opening_count_posting
USING ((tenant_id::text=current_setting('bop.tenant_id',true) AND brand_id=platform_helpers.current_brand_id()
 AND store_id=platform_helpers.current_store_id()) IS TRUE)
WITH CHECK ((tenant_id::text=current_setting('bop.tenant_id',true) AND brand_id=platform_helpers.current_brand_id()
 AND store_id=platform_helpers.current_store_id()) IS TRUE);
REVOKE ALL ON TABLE rms_inventory.stock_lot,rms_inventory.opening_count,rms_inventory.opening_count_version,rms_inventory.opening_count_posting FROM PUBLIC;
