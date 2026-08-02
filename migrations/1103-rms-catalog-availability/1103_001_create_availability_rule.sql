-- bop-rms-migration: 1
-- owner: @rms/catalog
-- schema: rms_catalog
-- phase: expand
-- risk: medium
-- transaction: required
-- lock-timeout-ms: 5000
-- statement-timeout-ms: 60000
-- recovery: forward-fix
CREATE TABLE rms_catalog.availability_rule (
  availability_rule_id platform_helpers.uuid_v7 PRIMARY KEY,
  brand_id platform_helpers.uuid_v7 NOT NULL,
  internal_code text NOT NULL CHECK (internal_code ~ '^[A-Z][A-Z0-9_-]{0,63}$'),
  aggregate_version integer NOT NULL CHECK (aggregate_version > 0),
  lifecycle text NOT NULL CHECK (lifecycle IN ('Draft', 'Active', 'Inactive', 'Archived')),
  sku_id platform_helpers.uuid_v7 NOT NULL,
  store_id platform_helpers.uuid_v7,
  channel_codes_json jsonb NOT NULL CHECK (jsonb_typeof(channel_codes_json) = 'array'),
  order_type_codes_json jsonb NOT NULL CHECK (jsonb_typeof(order_type_codes_json) = 'array'),
  effective_from timestamp with time zone NOT NULL,
  effective_until timestamp with time zone,
  decision text NOT NULL CHECK (decision IN ('Available', 'Unavailable')),
  priority integer NOT NULL CHECK (priority BETWEEN 1 AND 1000),
  reason_code text NOT NULL CHECK (reason_code ~ '^[A-Z][A-Z0-9_-]{0,63}$'),
  created_at timestamp with time zone NOT NULL,
  created_by_actor_id platform_helpers.uuid_v7 NOT NULL,
  updated_at timestamp with time zone NOT NULL,
  CONSTRAINT availability_rule_brand_code_unique UNIQUE (brand_id, internal_code),
  CONSTRAINT availability_rule_sku_fk FOREIGN KEY (sku_id, brand_id)
    REFERENCES rms_catalog.sku (sku_id, brand_id),
  CONSTRAINT availability_rule_period_check CHECK (effective_until IS NULL OR effective_until > effective_from),
  CONSTRAINT availability_rule_time_check CHECK (updated_at >= created_at),
  CONSTRAINT availability_rule_brand_identity_unique UNIQUE (availability_rule_id, brand_id)
);

CREATE TABLE rms_catalog.availability_rule_operation_record (
  operation_id platform_helpers.uuid_v7 PRIMARY KEY,
  brand_id platform_helpers.uuid_v7 NOT NULL,
  availability_rule_id platform_helpers.uuid_v7 NOT NULL,
  action_code text NOT NULL CHECK (action_code IN ('Create', 'Replace', 'ChangeLifecycle')),
  intent_digest text NOT NULL CHECK (intent_digest ~ '^sha256:[0-9a-f]{64}$'),
  result_aggregate_version integer NOT NULL CHECK (result_aggregate_version > 0),
  occurred_at timestamp with time zone NOT NULL,
  CONSTRAINT availability_rule_operation_fk FOREIGN KEY (availability_rule_id, brand_id)
    REFERENCES rms_catalog.availability_rule (availability_rule_id, brand_id)
);

CREATE RULE availability_rule_operation_no_update AS ON UPDATE TO rms_catalog.availability_rule_operation_record DO INSTEAD NOTHING;
CREATE RULE availability_rule_operation_no_delete AS ON DELETE TO rms_catalog.availability_rule_operation_record DO INSTEAD NOTHING;
CREATE RULE availability_rule_identity_no_update AS ON UPDATE TO rms_catalog.availability_rule
  WHERE (OLD.availability_rule_id IS DISTINCT FROM NEW.availability_rule_id OR OLD.brand_id IS DISTINCT FROM NEW.brand_id OR OLD.internal_code IS DISTINCT FROM NEW.internal_code OR OLD.created_at IS DISTINCT FROM NEW.created_at OR OLD.created_by_actor_id IS DISTINCT FROM NEW.created_by_actor_id)
  DO INSTEAD NOTHING;

CREATE INDEX availability_rule_resolution_idx ON rms_catalog.availability_rule
  (brand_id, sku_id, store_id, lifecycle, priority DESC, effective_from, effective_until);

ALTER TABLE rms_catalog.availability_rule ENABLE ROW LEVEL SECURITY;
ALTER TABLE rms_catalog.availability_rule FORCE ROW LEVEL SECURITY;
ALTER TABLE rms_catalog.availability_rule_operation_record ENABLE ROW LEVEL SECURITY;
ALTER TABLE rms_catalog.availability_rule_operation_record FORCE ROW LEVEL SECURITY;

CREATE POLICY availability_rule_brand_scope_policy ON rms_catalog.availability_rule
  USING (brand_id = platform_helpers.current_brand_id() AND platform_helpers.current_store_id() IS NULL)
  WITH CHECK (brand_id = platform_helpers.current_brand_id() AND platform_helpers.current_store_id() IS NULL);
CREATE POLICY availability_rule_operation_brand_scope_policy ON rms_catalog.availability_rule_operation_record
  USING (brand_id = platform_helpers.current_brand_id() AND platform_helpers.current_store_id() IS NULL)
  WITH CHECK (brand_id = platform_helpers.current_brand_id() AND platform_helpers.current_store_id() IS NULL);

REVOKE ALL ON TABLE rms_catalog.availability_rule, rms_catalog.availability_rule_operation_record FROM PUBLIC;
