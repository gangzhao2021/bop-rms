-- bop-rms-migration: 1
-- owner: @rms/inventory
-- schema: rms_inventory
-- phase: expand
-- risk: high
-- transaction: required
-- lock-timeout-ms: 5000
-- statement-timeout-ms: 60000
-- recovery: forward-fix
-- WP-2423 store stock operations: Adjustment, CountAdjustment, Waste and Correction movements on the
-- same append-only ledger. Each keeps reserved stock intact and on_hand non-negative (Block policy);
-- a Correction must reference an earlier correctable movement of the same account.
LOCK TABLE rms_inventory.stock_movement,rms_inventory.stock_balance IN SHARE ROW EXCLUSIVE MODE;
ALTER TABLE rms_inventory.stock_movement DROP CONSTRAINT stock_movement_movement_type_check;
ALTER TABLE rms_inventory.stock_movement ADD CONSTRAINT stock_movement_movement_type_check CHECK (
  movement_type IN ('Receive','Reserve','Release','Consume','Adjustment','CountAdjustment','Waste','Correction')
);
ALTER TABLE rms_inventory.stock_movement ADD CONSTRAINT stock_movement_correction_reference_check CHECK (
  (movement_type='Correction') = (record_json->'correctsMovementReference' IS NOT NULL
    AND jsonb_typeof(record_json->'correctsMovementReference')='string')
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
    OR (NEW.movement_type='Correction' AND after_on_hand=balance.on_hand+delta
      AND after_reserved=balance.reserved
      AND EXISTS (SELECT 1 FROM rms_inventory.stock_movement corrected
        WHERE corrected.tenant_id=NEW.tenant_id AND corrected.brand_id=NEW.brand_id
          AND corrected.store_id=NEW.store_id AND corrected.account_id=NEW.account_id
          AND corrected.movement_id::text=NEW.record_json->>'correctsMovementReference'
          AND corrected.movement_type IN ('Receive','Adjustment','CountAdjustment','Waste')))
  ) IS NOT TRUE OR ((NEW.record_json->'after'->>'available')::numeric=after_on_hand-after_reserved) IS NOT TRUE THEN
    RAISE EXCEPTION 'stock movement arithmetic mismatch' USING ERRCODE='23514';
  END IF;
  UPDATE rms_inventory.stock_balance SET ledger_version=NEW.ledger_version,on_hand=after_on_hand,reserved=after_reserved
    WHERE tenant_id=NEW.tenant_id AND brand_id=NEW.brand_id AND store_id=NEW.store_id AND account_id=NEW.account_id;
  RETURN NEW;
END;
$$;
