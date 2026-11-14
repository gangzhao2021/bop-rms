-- bop-rms-migration: 1
-- owner: @rms/inventory
-- schema: rms_inventory
-- phase: expand
-- risk: high
-- transaction: required
-- lock-timeout-ms: 5000
-- statement-timeout-ms: 60000
-- recovery: forward-fix
-- WP-2423 / DEC-INV-DIRECT-RECEIPT: Store direct receipts (no purchase order). One submission records
-- an immutable receipt fact and Receive movements for the accepted quantities in one transaction;
-- rejected and damaged quantities are recorded with reasons and never enter stock. A receipt is
-- corrected only by an explicit void, which reverses its movements with Correction movements.
CREATE TABLE rms_inventory.store_receipt (
  tenant_id platform_helpers.uuid_v7 NOT NULL,
  brand_id platform_helpers.uuid_v7 NOT NULL,
  store_id platform_helpers.uuid_v7 NOT NULL,
  receipt_id platform_helpers.uuid_v7 NOT NULL,
  operation_id platform_helpers.uuid_v7 NOT NULL,
  intent_hash text NOT NULL CHECK (intent_hash ~ '^sha256:[0-9a-f]{64}$'),
  supplier_name text NOT NULL CHECK (char_length(supplier_name) BETWEEN 1 AND 120 AND supplier_name = btrim(supplier_name)),
  supplier_document text CHECK (supplier_document IS NULL OR (char_length(supplier_document) BETWEEN 1 AND 64 AND supplier_document = btrim(supplier_document))),
  currency_code text NOT NULL CHECK (currency_code = 'CAD'),
  line_count integer NOT NULL CHECK (line_count BETWEEN 1 AND 500),
  snapshot_json jsonb NOT NULL CHECK (jsonb_typeof(snapshot_json)='object' AND octet_length(snapshot_json::text)<=524288),
  received_by_actor_id platform_helpers.uuid_v7 NOT NULL,
  received_at timestamptz NOT NULL CHECK (isfinite(received_at) AND date_trunc('milliseconds',received_at)=received_at),
  audit_id platform_helpers.uuid_v7 NOT NULL,
  PRIMARY KEY (tenant_id,brand_id,store_id,receipt_id),
  UNIQUE (tenant_id,brand_id,store_id,operation_id)
);
CREATE INDEX store_receipt_received_idx ON rms_inventory.store_receipt (tenant_id,brand_id,store_id,received_at DESC);
CREATE TABLE rms_inventory.store_receipt_void (
  tenant_id platform_helpers.uuid_v7 NOT NULL,
  brand_id platform_helpers.uuid_v7 NOT NULL,
  store_id platform_helpers.uuid_v7 NOT NULL,
  receipt_id platform_helpers.uuid_v7 NOT NULL,
  operation_id platform_helpers.uuid_v7 NOT NULL,
  reason_code text NOT NULL CHECK (reason_code ~ '^[A-Z][A-Z0-9_]{2,63}$'),
  voided_by_actor_id platform_helpers.uuid_v7 NOT NULL,
  voided_at timestamptz NOT NULL CHECK (isfinite(voided_at) AND date_trunc('milliseconds',voided_at)=voided_at),
  movement_count integer NOT NULL CHECK (movement_count BETWEEN 0 AND 500),
  audit_id platform_helpers.uuid_v7 NOT NULL,
  PRIMARY KEY (tenant_id,brand_id,store_id,receipt_id),
  UNIQUE (tenant_id,brand_id,store_id,operation_id),
  FOREIGN KEY (tenant_id,brand_id,store_id,receipt_id)
    REFERENCES rms_inventory.store_receipt (tenant_id,brand_id,store_id,receipt_id)
);
CREATE TRIGGER store_receipt_append_only BEFORE UPDATE OR DELETE ON rms_inventory.store_receipt
  FOR EACH ROW EXECUTE FUNCTION rms_inventory.reject_opening_stock_history_change();
CREATE TRIGGER store_receipt_void_append_only BEFORE UPDATE OR DELETE ON rms_inventory.store_receipt_void
  FOR EACH ROW EXECUTE FUNCTION rms_inventory.reject_opening_stock_history_change();
ALTER TABLE rms_inventory.store_receipt ENABLE ROW LEVEL SECURITY;
ALTER TABLE rms_inventory.store_receipt FORCE ROW LEVEL SECURITY;
ALTER TABLE rms_inventory.store_receipt_void ENABLE ROW LEVEL SECURITY;
ALTER TABLE rms_inventory.store_receipt_void FORCE ROW LEVEL SECURITY;
CREATE POLICY store_receipt_scope ON rms_inventory.store_receipt
USING ((tenant_id::text=current_setting('bop.tenant_id',true) AND brand_id=platform_helpers.current_brand_id()
 AND store_id=platform_helpers.current_store_id()) IS TRUE)
WITH CHECK ((tenant_id::text=current_setting('bop.tenant_id',true) AND brand_id=platform_helpers.current_brand_id()
 AND store_id=platform_helpers.current_store_id()) IS TRUE);
CREATE POLICY store_receipt_void_scope ON rms_inventory.store_receipt_void
USING ((tenant_id::text=current_setting('bop.tenant_id',true) AND brand_id=platform_helpers.current_brand_id()
 AND store_id=platform_helpers.current_store_id()) IS TRUE)
WITH CHECK ((tenant_id::text=current_setting('bop.tenant_id',true) AND brand_id=platform_helpers.current_brand_id()
 AND store_id=platform_helpers.current_store_id()) IS TRUE);
REVOKE ALL ON TABLE rms_inventory.store_receipt,rms_inventory.store_receipt_void FROM PUBLIC;
