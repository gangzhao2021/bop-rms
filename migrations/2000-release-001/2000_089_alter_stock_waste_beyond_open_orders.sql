-- bop-rms-migration: 1
-- owner: @rms/inventory
-- schema: rms_inventory
-- phase: expand
-- risk: high
-- transaction: required
-- lock-timeout-ms: 5000
-- statement-timeout-ms: 60000
-- recovery: forward-fix
-- WP-2423 (2026-10-18, DEC-INV-COUNT-SHORT amendment): waste is a physical fact like a count. Stock
-- that was spilled or thrown away is gone even when open Orders hold it, so a Waste movement may
-- now lower availability below zero (deepen or create a shortage against open orders) as long as
-- on_hand stays non-negative (column check) and reservations are unchanged (arithmetic rule). New
-- reservations, adjustments and corrections still cannot take held stock. Only the trigger function
-- changes; every existing row satisfies it. No new table or grant.
LOCK TABLE rms_inventory.stock_movement,rms_inventory.stock_balance IN SHARE ROW EXCLUSIVE MODE;
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
    -- WP-2423: stock operations; the availability rule below keeps them off reserved stock.
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
  -- DEC-INV-COUNT-SHORT: only physical facts may leave stock short against open orders (available
  -- below zero, reservations kept): a posted count, and waste (2026-10-18 amendment: what was
  -- thrown away is gone; on_hand still never goes below zero). No other movement may lower
  -- availability below zero: a new reservation, adjustment or correction never takes stock an Order
  -- already holds, while a release or the consumption of held stock stays possible.
  IF after_on_hand-after_reserved<0 AND after_on_hand-after_reserved<balance.available
    AND NEW.movement_type NOT IN ('CountAdjustment','Waste') THEN
    RAISE EXCEPTION 'stock movement would take reserved stock' USING ERRCODE='23514';
  END IF;
  UPDATE rms_inventory.stock_balance SET ledger_version=NEW.ledger_version,on_hand=after_on_hand,reserved=after_reserved
    WHERE tenant_id=NEW.tenant_id AND brand_id=NEW.brand_id AND store_id=NEW.store_id AND account_id=NEW.account_id;
  RETURN NEW;
END;
$$;
