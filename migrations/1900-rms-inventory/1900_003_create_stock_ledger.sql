-- bop-rms-migration: 1
-- owner: @rms/inventory
-- schema: rms_inventory
-- phase: expand
-- risk: medium
-- transaction: required
-- lock-timeout-ms: 5000
-- statement-timeout-ms: 60000
-- recovery: forward-fix
CREATE TABLE rms_inventory.stock_account (
  tenant_id platform_helpers.uuid_v7 NOT NULL,
  brand_id platform_helpers.uuid_v7 NOT NULL,
  store_id platform_helpers.uuid_v7 NOT NULL,
  stock_site_id platform_helpers.uuid_v7 NOT NULL,
  location_id platform_helpers.uuid_v7 NOT NULL,
  account_id platform_helpers.uuid_v7 NOT NULL,
  item_id platform_helpers.uuid_v7 NOT NULL,
  item_version bigint NOT NULL,
  lot_id platform_helpers.uuid_v7,
  expiry_date date,
  unit_code text NOT NULL CHECK (unit_code ~ '^[A-Z0-9][A-Z0-9_-]{0,31}$'),
  ledger_precision smallint NOT NULL CHECK (ledger_precision BETWEEN 0 AND 6),
  created_at timestamptz NOT NULL,
  PRIMARY KEY (tenant_id,brand_id,store_id,account_id),
  FOREIGN KEY (tenant_id,brand_id,item_id,item_version)
    REFERENCES rms_inventory.inventory_item_version (tenant_id,brand_id,item_id,version),
  CHECK (expiry_date IS NULL OR (lot_id IS NOT NULL AND isfinite(expiry_date))),
  CHECK (isfinite(created_at) AND date_trunc('milliseconds',created_at)=created_at)
);
CREATE UNIQUE INDEX stock_account_identity ON rms_inventory.stock_account
(tenant_id,brand_id,store_id,stock_site_id,location_id,item_id,
 COALESCE(lot_id,'00000000-0000-0000-0000-000000000000'::uuid));
CREATE TABLE rms_inventory.stock_balance (
  tenant_id platform_helpers.uuid_v7 NOT NULL,
  brand_id platform_helpers.uuid_v7 NOT NULL,
  store_id platform_helpers.uuid_v7 NOT NULL,
  account_id platform_helpers.uuid_v7 NOT NULL,
  ledger_version bigint NOT NULL CHECK (ledger_version BETWEEN 1 AND 9007199254740991),
  on_hand numeric NOT NULL CHECK (on_hand>=0 AND scale(on_hand)<=6 AND on_hand<>'NaN'::numeric AND on_hand<>'Infinity'::numeric),
  reserved numeric NOT NULL CHECK (reserved>=0 AND scale(reserved)<=6 AND reserved<>'NaN'::numeric AND reserved<>'Infinity'::numeric),
  in_transit numeric NOT NULL CHECK (in_transit>=0 AND scale(in_transit)<=6 AND in_transit<>'NaN'::numeric AND in_transit<>'Infinity'::numeric),
  available numeric GENERATED ALWAYS AS (on_hand-reserved) STORED,
  PRIMARY KEY (tenant_id,brand_id,store_id,account_id),
  FOREIGN KEY (tenant_id,brand_id,store_id,account_id)
    REFERENCES rms_inventory.stock_account (tenant_id,brand_id,store_id,account_id),
  CHECK (reserved<=on_hand)
);
CREATE TABLE rms_inventory.stock_movement (
  tenant_id platform_helpers.uuid_v7 NOT NULL,
  brand_id platform_helpers.uuid_v7 NOT NULL,
  store_id platform_helpers.uuid_v7 NOT NULL,
  account_id platform_helpers.uuid_v7 NOT NULL,
  movement_id platform_helpers.uuid_v7 NOT NULL,
  ledger_version bigint NOT NULL CHECK (ledger_version BETWEEN 2 AND 9007199254740991),
  movement_type text NOT NULL CHECK (movement_type IN ('Receive','Reserve','Release','Consume')),
  base_quantity_delta numeric NOT NULL CHECK (base_quantity_delta<>0 AND scale(base_quantity_delta)<=6
    AND base_quantity_delta NOT IN ('NaN'::numeric,'Infinity'::numeric,'-Infinity'::numeric)),
  record_json jsonb NOT NULL CHECK (jsonb_typeof(record_json)='object'),
  audit_id platform_helpers.uuid_v7 NOT NULL,
  occurred_at timestamptz NOT NULL,
  PRIMARY KEY (tenant_id,brand_id,store_id,movement_id),
  UNIQUE (tenant_id,brand_id,store_id,account_id,ledger_version),
  FOREIGN KEY (tenant_id,brand_id,store_id,account_id)
    REFERENCES rms_inventory.stock_account (tenant_id,brand_id,store_id,account_id),
  CHECK (isfinite(occurred_at) AND date_trunc('milliseconds',occurred_at)=occurred_at),
  CHECK ((
    record_json->>'tenantReference'=tenant_id::text
    AND record_json->>'brandReference'=brand_id::text
    AND record_json->>'movementReference'=movement_id::text
    AND record_json->>'movementType'=movement_type
    AND (record_json->>'baseQuantityDelta')::numeric=base_quantity_delta
    AND record_json->>'auditReference'=audit_id::text
    AND record_json->>'occurredAt'=to_char(occurred_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
  ) IS TRUE)
);
CREATE FUNCTION rms_inventory.apply_stock_movement() RETURNS trigger
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
  ) IS NOT TRUE OR ((NEW.record_json->'after'->>'available')::numeric=after_on_hand-after_reserved) IS NOT TRUE THEN
    RAISE EXCEPTION 'stock movement arithmetic mismatch' USING ERRCODE='23514';
  END IF;
  UPDATE rms_inventory.stock_balance SET ledger_version=NEW.ledger_version,on_hand=after_on_hand,reserved=after_reserved
    WHERE tenant_id=NEW.tenant_id AND brand_id=NEW.brand_id AND store_id=NEW.store_id AND account_id=NEW.account_id;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION rms_inventory.apply_stock_movement() FROM PUBLIC;
CREATE TRIGGER stock_movement_apply BEFORE INSERT ON rms_inventory.stock_movement
FOR EACH ROW EXECUTE FUNCTION rms_inventory.apply_stock_movement();

CREATE TRIGGER stock_account_immutable BEFORE UPDATE OR DELETE ON rms_inventory.stock_account
FOR EACH ROW EXECUTE FUNCTION rms_inventory.reject_item_history_mutation();
CREATE TRIGGER stock_account_no_truncate BEFORE TRUNCATE ON rms_inventory.stock_account
FOR EACH STATEMENT EXECUTE FUNCTION rms_inventory.reject_item_history_mutation();

ALTER TABLE rms_inventory.stock_account ENABLE ROW LEVEL SECURITY;
ALTER TABLE rms_inventory.stock_account FORCE ROW LEVEL SECURITY;
CREATE POLICY stock_account_scope ON rms_inventory.stock_account
USING ((tenant_id::text=current_setting('bop.tenant_id',true) AND brand_id=platform_helpers.current_brand_id()
 AND store_id=platform_helpers.current_store_id()) IS TRUE)
WITH CHECK ((tenant_id::text=current_setting('bop.tenant_id',true) AND brand_id=platform_helpers.current_brand_id()
 AND store_id=platform_helpers.current_store_id()) IS TRUE);
REVOKE ALL ON TABLE rms_inventory.stock_account FROM PUBLIC;

ALTER TABLE rms_inventory.stock_balance ENABLE ROW LEVEL SECURITY;
ALTER TABLE rms_inventory.stock_balance FORCE ROW LEVEL SECURITY;
CREATE POLICY stock_balance_scope ON rms_inventory.stock_balance
USING ((tenant_id::text=current_setting('bop.tenant_id',true) AND brand_id=platform_helpers.current_brand_id()
 AND store_id=platform_helpers.current_store_id()) IS TRUE)
WITH CHECK ((tenant_id::text=current_setting('bop.tenant_id',true) AND brand_id=platform_helpers.current_brand_id()
 AND store_id=platform_helpers.current_store_id()) IS TRUE);
REVOKE ALL ON TABLE rms_inventory.stock_balance FROM PUBLIC;

CREATE TRIGGER stock_movement_immutable BEFORE UPDATE OR DELETE ON rms_inventory.stock_movement
FOR EACH ROW EXECUTE FUNCTION rms_inventory.reject_item_history_mutation();
CREATE TRIGGER stock_movement_no_truncate BEFORE TRUNCATE ON rms_inventory.stock_movement
FOR EACH STATEMENT EXECUTE FUNCTION rms_inventory.reject_item_history_mutation();

ALTER TABLE rms_inventory.stock_movement ENABLE ROW LEVEL SECURITY;
ALTER TABLE rms_inventory.stock_movement FORCE ROW LEVEL SECURITY;
CREATE POLICY stock_movement_scope ON rms_inventory.stock_movement
USING ((tenant_id::text=current_setting('bop.tenant_id',true) AND brand_id=platform_helpers.current_brand_id()
 AND store_id=platform_helpers.current_store_id()) IS TRUE)
WITH CHECK ((tenant_id::text=current_setting('bop.tenant_id',true) AND brand_id=platform_helpers.current_brand_id()
 AND store_id=platform_helpers.current_store_id()) IS TRUE);
REVOKE ALL ON TABLE rms_inventory.stock_movement FROM PUBLIC;

CREATE FUNCTION rms_inventory.protect_stock_balance() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
BEGIN
  IF TG_OP='INSERT' THEN
    IF NEW.ledger_version<>1 OR NEW.on_hand<>0 OR NEW.reserved<>0 OR NEW.in_transit<>0 THEN
      RAISE EXCEPTION 'stock opening balance must be zero' USING ERRCODE='23514';
    END IF;
  ELSIF pg_trigger_depth()<>2 THEN
    RAISE EXCEPTION 'stock balance changes require a movement' USING ERRCODE='55000';
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION rms_inventory.protect_stock_balance() FROM PUBLIC;
CREATE TRIGGER stock_balance_write_guard BEFORE INSERT OR UPDATE ON rms_inventory.stock_balance
FOR EACH ROW EXECUTE FUNCTION rms_inventory.protect_stock_balance();
CREATE TRIGGER stock_balance_no_delete BEFORE DELETE ON rms_inventory.stock_balance
FOR EACH ROW EXECUTE FUNCTION rms_inventory.reject_item_history_mutation();
CREATE TRIGGER stock_balance_no_truncate BEFORE TRUNCATE ON rms_inventory.stock_balance
FOR EACH STATEMENT EXECUTE FUNCTION rms_inventory.reject_item_history_mutation();
