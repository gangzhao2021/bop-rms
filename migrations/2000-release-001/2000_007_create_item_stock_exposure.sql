-- bop-rms-migration: 1
-- owner: @rms/inventory
-- schema: rms_inventory
-- phase: expand
-- risk: medium
-- transaction: required
-- lock-timeout-ms: 5000
-- statement-timeout-ms: 60000
-- recovery: forward-fix
-- WP-2423: Brand-wide answer to "does any Store still hold, reserve or expect this Inventory Item?"
-- Stock balances are Store-scoped (row security), but archiving a Brand Inventory Item must consider
-- every Store. Each stock account keeps one exposure flag, maintained by the ledger itself; the row
-- carries no Store identity, only whether some account of the item is exposed.
CREATE TABLE rms_inventory.item_stock_exposure (
  tenant_id platform_helpers.uuid_v7 NOT NULL,
  brand_id platform_helpers.uuid_v7 NOT NULL,
  account_id platform_helpers.uuid_v7 NOT NULL,
  item_id platform_helpers.uuid_v7 NOT NULL,
  exposed boolean NOT NULL,
  updated_at timestamp with time zone NOT NULL,
  CONSTRAINT item_stock_exposure_pkey PRIMARY KEY (tenant_id, brand_id, account_id)
);
CREATE INDEX item_stock_exposure_item_idx
  ON rms_inventory.item_stock_exposure (tenant_id, brand_id, item_id) WHERE exposed;
ALTER TABLE rms_inventory.item_stock_exposure ENABLE ROW LEVEL SECURITY;
ALTER TABLE rms_inventory.item_stock_exposure FORCE ROW LEVEL SECURITY;
CREATE POLICY item_stock_exposure_brand_scope ON rms_inventory.item_stock_exposure
  USING ((tenant_id::text = current_setting('bop.tenant_id', true)
    AND brand_id = platform_helpers.current_brand_id()) IS TRUE)
  WITH CHECK ((tenant_id::text = current_setting('bop.tenant_id', true)
    AND brand_id = platform_helpers.current_brand_id()) IS TRUE);
REVOKE ALL ON TABLE rms_inventory.item_stock_exposure FROM PUBLIC;

-- Runs as the schema owner so ledger writers need no privilege on this table; it only mirrors the
-- balance row that the writer just changed within its own Tenant, Brand and Store scope.
CREATE FUNCTION rms_inventory.record_item_stock_exposure()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
  item platform_helpers.uuid_v7;
BEGIN
  SELECT a.item_id INTO item FROM rms_inventory.stock_account a
    WHERE a.tenant_id = NEW.tenant_id AND a.brand_id = NEW.brand_id AND a.store_id = NEW.store_id
      AND a.account_id = NEW.account_id;
  IF item IS NULL THEN
    RAISE EXCEPTION 'Stock balance without its account' USING ERRCODE = '23503';
  END IF;
  INSERT INTO rms_inventory.item_stock_exposure (tenant_id, brand_id, account_id, item_id, exposed, updated_at)
    VALUES (NEW.tenant_id, NEW.brand_id, NEW.account_id, item,
      NEW.on_hand <> 0 OR NEW.reserved <> 0 OR NEW.in_transit <> 0, pg_catalog.now())
    ON CONFLICT (tenant_id, brand_id, account_id)
    DO UPDATE SET exposed = EXCLUDED.exposed, updated_at = EXCLUDED.updated_at;
  RETURN NULL;
END;
$$;
REVOKE ALL ON FUNCTION rms_inventory.record_item_stock_exposure() FROM PUBLIC;
CREATE TRIGGER stock_balance_item_exposure
  AFTER INSERT OR UPDATE ON rms_inventory.stock_balance
  FOR EACH ROW EXECUTE FUNCTION rms_inventory.record_item_stock_exposure();

SET LOCAL row_security = off;
INSERT INTO rms_inventory.item_stock_exposure (tenant_id, brand_id, account_id, item_id, exposed, updated_at)
  SELECT b.tenant_id, b.brand_id, b.account_id, a.item_id,
    b.on_hand <> 0 OR b.reserved <> 0 OR b.in_transit <> 0, now()
  FROM rms_inventory.stock_balance b
  JOIN rms_inventory.stock_account a
    ON a.tenant_id = b.tenant_id AND a.brand_id = b.brand_id AND a.store_id = b.store_id
   AND a.account_id = b.account_id;
