-- bop-rms-migration: 1
-- owner: @rms/inventory
-- schema: rms_inventory
-- phase: expand
-- risk: medium
-- transaction: required
-- lock-timeout-ms: 5000
-- statement-timeout-ms: 60000
-- recovery: forward-fix
-- WP-2423 / DEC-INV-STOCK-COUNT and DEC-INV-WASTE: Store stock counts (versioned count document with
-- its operation history; approved variances post CountAdjustment movements) and Store waste records
-- (posted as Waste movements at once; a high-value record gets an independent review that accepts it or
-- voids it with Correction movements). Versions, operations, records and reviews are append-only.
CREATE TABLE rms_inventory.stock_count (
  tenant_id platform_helpers.uuid_v7 NOT NULL,
  brand_id platform_helpers.uuid_v7 NOT NULL,
  store_id platform_helpers.uuid_v7 NOT NULL,
  count_id platform_helpers.uuid_v7 NOT NULL,
  location_id platform_helpers.uuid_v7 NOT NULL,
  current_version integer NOT NULL CHECK (current_version > 0),
  created_at timestamp with time zone NOT NULL,
  created_by_actor_id platform_helpers.uuid_v7 NOT NULL,
  PRIMARY KEY (tenant_id, brand_id, store_id, count_id)
);
CREATE TABLE rms_inventory.stock_count_version (
  tenant_id platform_helpers.uuid_v7 NOT NULL,
  brand_id platform_helpers.uuid_v7 NOT NULL,
  store_id platform_helpers.uuid_v7 NOT NULL,
  count_id platform_helpers.uuid_v7 NOT NULL,
  version integer NOT NULL CHECK (version > 0),
  status text NOT NULL CHECK (status IN ('Draft','Assigned','InProgress','Submitted','Approved','Cancelled','Posted')),
  count_json jsonb NOT NULL CHECK (jsonb_typeof(count_json) = 'object'),
  recorded_at timestamp with time zone NOT NULL,
  PRIMARY KEY (tenant_id, brand_id, store_id, count_id, version),
  FOREIGN KEY (tenant_id, brand_id, store_id, count_id)
    REFERENCES rms_inventory.stock_count (tenant_id, brand_id, store_id, count_id)
);
CREATE TABLE rms_inventory.stock_count_operation (
  tenant_id platform_helpers.uuid_v7 NOT NULL,
  brand_id platform_helpers.uuid_v7 NOT NULL,
  store_id platform_helpers.uuid_v7 NOT NULL,
  operation_id platform_helpers.uuid_v7 NOT NULL,
  count_id platform_helpers.uuid_v7 NOT NULL,
  version integer NOT NULL CHECK (version > 0),
  action text NOT NULL,
  intent_hash text NOT NULL CHECK (intent_hash ~ '^sha256:[0-9a-f]{64}$'),
  record_json jsonb NOT NULL CHECK (jsonb_typeof(record_json) = 'object'),
  audit_id platform_helpers.uuid_v7 NOT NULL,
  recorded_at timestamp with time zone NOT NULL,
  PRIMARY KEY (tenant_id, brand_id, store_id, operation_id),
  FOREIGN KEY (tenant_id, brand_id, store_id, count_id, version)
    REFERENCES rms_inventory.stock_count_version (tenant_id, brand_id, store_id, count_id, version)
);
CREATE INDEX stock_count_created_idx ON rms_inventory.stock_count (tenant_id, brand_id, store_id, created_at DESC);

CREATE TABLE rms_inventory.store_waste (
  tenant_id platform_helpers.uuid_v7 NOT NULL,
  brand_id platform_helpers.uuid_v7 NOT NULL,
  store_id platform_helpers.uuid_v7 NOT NULL,
  waste_id platform_helpers.uuid_v7 NOT NULL,
  operation_id platform_helpers.uuid_v7 NOT NULL,
  record_json jsonb NOT NULL CHECK (jsonb_typeof(record_json) = 'object'),
  value_minor bigint NOT NULL CHECK (value_minor >= 0),
  needs_review boolean NOT NULL,
  recorded_by_actor_id platform_helpers.uuid_v7 NOT NULL,
  recorded_at timestamp with time zone NOT NULL,
  audit_id platform_helpers.uuid_v7 NOT NULL,
  PRIMARY KEY (tenant_id, brand_id, store_id, waste_id),
  UNIQUE (tenant_id, brand_id, store_id, operation_id)
);
CREATE INDEX store_waste_recorded_idx ON rms_inventory.store_waste (tenant_id, brand_id, store_id, recorded_at DESC);
CREATE TABLE rms_inventory.store_waste_review (
  tenant_id platform_helpers.uuid_v7 NOT NULL,
  brand_id platform_helpers.uuid_v7 NOT NULL,
  store_id platform_helpers.uuid_v7 NOT NULL,
  waste_id platform_helpers.uuid_v7 NOT NULL,
  operation_id platform_helpers.uuid_v7 NOT NULL,
  decision text NOT NULL CHECK (decision IN ('Accepted', 'Voided')),
  reason_code text NOT NULL CHECK (reason_code ~ '^[A-Z][A-Z0-9_]{2,63}$'),
  reviewed_by_actor_id platform_helpers.uuid_v7 NOT NULL,
  recorded_by_actor_id platform_helpers.uuid_v7 NOT NULL,
  reviewed_at timestamp with time zone NOT NULL,
  audit_id platform_helpers.uuid_v7 NOT NULL,
  PRIMARY KEY (tenant_id, brand_id, store_id, waste_id),
  FOREIGN KEY (tenant_id, brand_id, store_id, waste_id)
    REFERENCES rms_inventory.store_waste (tenant_id, brand_id, store_id, waste_id),
  CONSTRAINT store_waste_review_independent CHECK (reviewed_by_actor_id <> recorded_by_actor_id)
);

CREATE FUNCTION rms_inventory.reject_stock_document_history_change()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
BEGIN
  RAISE EXCEPTION 'Stock document history is append-only' USING ERRCODE = '55000';
END;
$$;
REVOKE ALL ON FUNCTION rms_inventory.reject_stock_document_history_change() FROM PUBLIC;
CREATE TRIGGER stock_count_version_append_only BEFORE UPDATE OR DELETE ON rms_inventory.stock_count_version
  FOR EACH ROW EXECUTE FUNCTION rms_inventory.reject_stock_document_history_change();
CREATE TRIGGER stock_count_operation_append_only BEFORE UPDATE OR DELETE ON rms_inventory.stock_count_operation
  FOR EACH ROW EXECUTE FUNCTION rms_inventory.reject_stock_document_history_change();
CREATE TRIGGER store_waste_append_only BEFORE UPDATE OR DELETE ON rms_inventory.store_waste
  FOR EACH ROW EXECUTE FUNCTION rms_inventory.reject_stock_document_history_change();
CREATE TRIGGER store_waste_review_append_only BEFORE UPDATE OR DELETE ON rms_inventory.store_waste_review
  FOR EACH ROW EXECUTE FUNCTION rms_inventory.reject_stock_document_history_change();
-- The count head only moves its current version forward.
CREATE FUNCTION rms_inventory.guard_stock_count_head()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
BEGIN
  IF TG_OP = 'DELETE' OR NEW.count_id <> OLD.count_id OR NEW.location_id <> OLD.location_id
     OR NEW.current_version <> OLD.current_version + 1 THEN
    RAISE EXCEPTION 'Stock count head moves forward one version at a time' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION rms_inventory.guard_stock_count_head() FROM PUBLIC;
CREATE TRIGGER stock_count_head_forward BEFORE UPDATE OR DELETE ON rms_inventory.stock_count
  FOR EACH ROW EXECUTE FUNCTION rms_inventory.guard_stock_count_head();

ALTER TABLE rms_inventory.stock_count ENABLE ROW LEVEL SECURITY;
ALTER TABLE rms_inventory.stock_count FORCE ROW LEVEL SECURITY;
ALTER TABLE rms_inventory.stock_count_version ENABLE ROW LEVEL SECURITY;
ALTER TABLE rms_inventory.stock_count_version FORCE ROW LEVEL SECURITY;
ALTER TABLE rms_inventory.stock_count_operation ENABLE ROW LEVEL SECURITY;
ALTER TABLE rms_inventory.stock_count_operation FORCE ROW LEVEL SECURITY;
ALTER TABLE rms_inventory.store_waste ENABLE ROW LEVEL SECURITY;
ALTER TABLE rms_inventory.store_waste FORCE ROW LEVEL SECURITY;
ALTER TABLE rms_inventory.store_waste_review ENABLE ROW LEVEL SECURITY;
ALTER TABLE rms_inventory.store_waste_review FORCE ROW LEVEL SECURITY;
CREATE POLICY stock_count_scope ON rms_inventory.stock_count
  USING (tenant_id::text = current_setting('bop.tenant_id', true) AND brand_id = platform_helpers.current_brand_id()
    AND store_id = platform_helpers.current_store_id())
  WITH CHECK (tenant_id::text = current_setting('bop.tenant_id', true) AND brand_id = platform_helpers.current_brand_id()
    AND store_id = platform_helpers.current_store_id());
CREATE POLICY stock_count_version_scope ON rms_inventory.stock_count_version
  USING (tenant_id::text = current_setting('bop.tenant_id', true) AND brand_id = platform_helpers.current_brand_id()
    AND store_id = platform_helpers.current_store_id())
  WITH CHECK (tenant_id::text = current_setting('bop.tenant_id', true) AND brand_id = platform_helpers.current_brand_id()
    AND store_id = platform_helpers.current_store_id());
CREATE POLICY stock_count_operation_scope ON rms_inventory.stock_count_operation
  USING (tenant_id::text = current_setting('bop.tenant_id', true) AND brand_id = platform_helpers.current_brand_id()
    AND store_id = platform_helpers.current_store_id())
  WITH CHECK (tenant_id::text = current_setting('bop.tenant_id', true) AND brand_id = platform_helpers.current_brand_id()
    AND store_id = platform_helpers.current_store_id());
CREATE POLICY store_waste_scope ON rms_inventory.store_waste
  USING (tenant_id::text = current_setting('bop.tenant_id', true) AND brand_id = platform_helpers.current_brand_id()
    AND store_id = platform_helpers.current_store_id())
  WITH CHECK (tenant_id::text = current_setting('bop.tenant_id', true) AND brand_id = platform_helpers.current_brand_id()
    AND store_id = platform_helpers.current_store_id());
CREATE POLICY store_waste_review_scope ON rms_inventory.store_waste_review
  USING (tenant_id::text = current_setting('bop.tenant_id', true) AND brand_id = platform_helpers.current_brand_id()
    AND store_id = platform_helpers.current_store_id())
  WITH CHECK (tenant_id::text = current_setting('bop.tenant_id', true) AND brand_id = platform_helpers.current_brand_id()
    AND store_id = platform_helpers.current_store_id());
REVOKE ALL ON TABLE rms_inventory.stock_count, rms_inventory.stock_count_version, rms_inventory.stock_count_operation,
  rms_inventory.store_waste, rms_inventory.store_waste_review FROM PUBLIC;
