-- bop-rms-migration: 1
-- owner: @rms/catalog
-- schema: rms_catalog
-- phase: expand
-- risk: medium
-- transaction: required
-- lock-timeout-ms: 5000
-- statement-timeout-ms: 60000
-- recovery: forward-fix
CREATE TABLE rms_catalog.option_set (
  option_set_id platform_helpers.uuid_v7 PRIMARY KEY,
  brand_id platform_helpers.uuid_v7 NOT NULL,
  internal_code text NOT NULL CHECK (internal_code ~ '^[A-Z][A-Z0-9_-]{0,63}$'),
  lifecycle text NOT NULL CHECK (lifecycle IN ('Draft', 'Archived')),
  aggregate_version integer NOT NULL CHECK (aggregate_version > 0),
  created_at timestamp with time zone NOT NULL,
  created_by_actor_id platform_helpers.uuid_v7 NOT NULL,
  updated_at timestamp with time zone NOT NULL,
  CONSTRAINT option_set_brand_code_unique UNIQUE (brand_id, internal_code),
  CONSTRAINT option_set_brand_identity_unique UNIQUE (option_set_id, brand_id),
  CONSTRAINT option_set_time_order_check CHECK (updated_at >= created_at)
);

CREATE TABLE rms_catalog.option_set_version (
  option_set_version_id platform_helpers.uuid_v7 PRIMARY KEY,
  option_set_id platform_helpers.uuid_v7 NOT NULL,
  brand_id platform_helpers.uuid_v7 NOT NULL,
  status text NOT NULL CHECK (status = 'Draft'),
  default_locale text NOT NULL CHECK (char_length(default_locale) BETWEEN 2 AND 35),
  localized_names_json jsonb NOT NULL CHECK (jsonb_typeof(localized_names_json) = 'object'),
  localized_descriptions_json jsonb NOT NULL CHECK (jsonb_typeof(localized_descriptions_json) = 'object'),
  display_style text NOT NULL CHECK (display_style IN ('SingleChoice', 'MultiChoice', 'Quantity')),
  minimum_selection integer NOT NULL CHECK (minimum_selection >= 0),
  maximum_selection integer CHECK (maximum_selection >= minimum_selection),
  allow_repeated_option boolean NOT NULL,
  per_option_maximum_quantity integer NOT NULL CHECK (per_option_maximum_quantity > 0),
  maximum_total_quantity integer CHECK (maximum_total_quantity >= minimum_selection),
  created_at timestamp with time zone NOT NULL,
  updated_at timestamp with time zone NOT NULL,
  CONSTRAINT option_set_version_set_fk FOREIGN KEY (option_set_id, brand_id)
    REFERENCES rms_catalog.option_set (option_set_id, brand_id),
  CONSTRAINT option_set_version_identity_unique UNIQUE (option_set_version_id, option_set_id, brand_id),
  CONSTRAINT option_set_one_draft_unique UNIQUE (option_set_id, status),
  CONSTRAINT option_set_repeat_quantity_check CHECK (allow_repeated_option OR per_option_maximum_quantity = 1),
  CONSTRAINT option_set_total_quantity_check CHECK (maximum_total_quantity IS NULL OR per_option_maximum_quantity <= maximum_total_quantity),
  CONSTRAINT option_set_version_time_check CHECK (updated_at >= created_at)
);

CREATE TABLE rms_catalog.option (
  option_id platform_helpers.uuid_v7 PRIMARY KEY,
  option_set_version_id platform_helpers.uuid_v7 NOT NULL,
  option_set_id platform_helpers.uuid_v7 NOT NULL,
  brand_id platform_helpers.uuid_v7 NOT NULL,
  stable_code text NOT NULL CHECK (stable_code ~ '^[A-Z][A-Z0-9_-]{0,63}$'),
  lifecycle text NOT NULL CHECK (lifecycle IN ('Draft', 'Active', 'Inactive', 'Archived')),
  localized_names_json jsonb NOT NULL CHECK (jsonb_typeof(localized_names_json) = 'object'),
  localized_descriptions_json jsonb NOT NULL CHECK (jsonb_typeof(localized_descriptions_json) = 'object'),
  sort_order integer NOT NULL CHECK (sort_order >= 0),
  default_eligible boolean NOT NULL,
  triggered_option_set_id platform_helpers.uuid_v7,
  created_at timestamp with time zone NOT NULL,
  created_by_actor_id platform_helpers.uuid_v7 NOT NULL,
  CONSTRAINT option_version_fk FOREIGN KEY (option_set_version_id, option_set_id, brand_id)
    REFERENCES rms_catalog.option_set_version (option_set_version_id, option_set_id, brand_id),
  CONSTRAINT option_trigger_fk FOREIGN KEY (triggered_option_set_id, brand_id)
    REFERENCES rms_catalog.option_set (option_set_id, brand_id),
  CONSTRAINT option_not_self_trigger CHECK (triggered_option_set_id IS NULL OR triggered_option_set_id <> option_set_id),
  CONSTRAINT option_version_code_unique UNIQUE (option_set_version_id, stable_code),
  CONSTRAINT option_version_order_unique UNIQUE (option_set_version_id, sort_order),
  CONSTRAINT option_set_identity_unique UNIQUE (option_id, option_set_id, brand_id)
);

CREATE TABLE rms_catalog.option_conflict (
  option_id platform_helpers.uuid_v7 NOT NULL,
  conflict_option_id platform_helpers.uuid_v7 NOT NULL,
  option_set_id platform_helpers.uuid_v7 NOT NULL,
  brand_id platform_helpers.uuid_v7 NOT NULL,
  PRIMARY KEY (option_id, conflict_option_id),
  CONSTRAINT option_conflict_left_fk FOREIGN KEY (option_id, option_set_id, brand_id)
    REFERENCES rms_catalog.option (option_id, option_set_id, brand_id),
  CONSTRAINT option_conflict_right_fk FOREIGN KEY (conflict_option_id, option_set_id, brand_id)
    REFERENCES rms_catalog.option (option_id, option_set_id, brand_id),
  CONSTRAINT option_conflict_not_self CHECK (option_id <> conflict_option_id)
);

CREATE TABLE rms_catalog.product_option_binding (
  binding_id platform_helpers.uuid_v7 PRIMARY KEY,
  product_version_id platform_helpers.uuid_v7 NOT NULL,
  product_id platform_helpers.uuid_v7 NOT NULL,
  brand_id platform_helpers.uuid_v7 NOT NULL,
  option_set_id platform_helpers.uuid_v7 NOT NULL,
  option_set_version_id platform_helpers.uuid_v7 NOT NULL,
  purpose text NOT NULL CHECK (purpose ~ '^[A-Z][A-Z0-9_-]{0,63}$'),
  sort_order integer NOT NULL CHECK (sort_order >= 0),
  minimum_selection_override integer CHECK (minimum_selection_override >= 0),
  maximum_selection_override integer CHECK (maximum_selection_override >= minimum_selection_override),
  store_override_allowed boolean NOT NULL,
  CONSTRAINT product_option_binding_product_fk FOREIGN KEY (product_version_id, product_id, brand_id)
    REFERENCES rms_catalog.product_version (product_version_id, product_id, brand_id),
  CONSTRAINT product_option_binding_set_fk FOREIGN KEY (option_set_version_id, option_set_id, brand_id)
    REFERENCES rms_catalog.option_set_version (option_set_version_id, option_set_id, brand_id),
  CONSTRAINT product_option_binding_purpose_unique UNIQUE (product_version_id, option_set_id, purpose),
  CONSTRAINT product_option_binding_order_unique UNIQUE (product_version_id, sort_order),
  CONSTRAINT product_option_binding_identity_unique UNIQUE (binding_id, product_id, brand_id)
);

CREATE TABLE rms_catalog.product_option_binding_option (
  binding_id platform_helpers.uuid_v7 NOT NULL,
  product_id platform_helpers.uuid_v7 NOT NULL,
  brand_id platform_helpers.uuid_v7 NOT NULL,
  option_id platform_helpers.uuid_v7 NOT NULL,
  option_set_id platform_helpers.uuid_v7 NOT NULL,
  default_quantity integer CHECK (default_quantity > 0),
  PRIMARY KEY (binding_id, option_id),
  CONSTRAINT product_option_binding_option_binding_fk FOREIGN KEY (binding_id, product_id, brand_id)
    REFERENCES rms_catalog.product_option_binding (binding_id, product_id, brand_id),
  CONSTRAINT product_option_binding_option_option_fk FOREIGN KEY (option_id, option_set_id, brand_id)
    REFERENCES rms_catalog.option (option_id, option_set_id, brand_id)
);

CREATE TABLE rms_catalog.product_option_binding_sku_scope (
  binding_id platform_helpers.uuid_v7 NOT NULL,
  product_id platform_helpers.uuid_v7 NOT NULL,
  brand_id platform_helpers.uuid_v7 NOT NULL,
  sku_id platform_helpers.uuid_v7 NOT NULL,
  scope_kind text NOT NULL CHECK (scope_kind IN ('Include', 'Exclude')),
  PRIMARY KEY (binding_id, sku_id),
  CONSTRAINT product_option_binding_sku_binding_fk FOREIGN KEY (binding_id, product_id, brand_id)
    REFERENCES rms_catalog.product_option_binding (binding_id, product_id, brand_id),
  CONSTRAINT product_option_binding_sku_fk FOREIGN KEY (sku_id, product_id, brand_id)
    REFERENCES rms_catalog.sku (sku_id, product_id, brand_id)
);

CREATE TABLE rms_catalog.product_option_binding_channel (
  binding_id platform_helpers.uuid_v7 NOT NULL,
  product_id platform_helpers.uuid_v7 NOT NULL,
  brand_id platform_helpers.uuid_v7 NOT NULL,
  channel_code text NOT NULL CHECK (channel_code ~ '^[A-Z][A-Z0-9_-]{0,63}$'),
  PRIMARY KEY (binding_id, channel_code),
  CONSTRAINT product_option_binding_channel_fk FOREIGN KEY (binding_id, product_id, brand_id)
    REFERENCES rms_catalog.product_option_binding (binding_id, product_id, brand_id)
);

CREATE TABLE rms_catalog.option_set_operation_record (
  operation_id platform_helpers.uuid_v7 PRIMARY KEY,
  brand_id platform_helpers.uuid_v7 NOT NULL,
  option_set_id platform_helpers.uuid_v7 NOT NULL,
  action_code text NOT NULL CHECK (action_code IN ('Create', 'ReplaceDraft', 'Archive')),
  intent_digest text NOT NULL CHECK (intent_digest ~ '^sha256:[0-9a-f]{64}$'),
  result_aggregate_version integer NOT NULL CHECK (result_aggregate_version > 0),
  occurred_at timestamp with time zone NOT NULL,
  CONSTRAINT option_set_operation_set_fk FOREIGN KEY (option_set_id, brand_id)
    REFERENCES rms_catalog.option_set (option_set_id, brand_id)
);

CREATE RULE option_set_operation_no_update AS ON UPDATE TO rms_catalog.option_set_operation_record DO INSTEAD NOTHING;
CREATE RULE option_set_operation_no_delete AS ON DELETE TO rms_catalog.option_set_operation_record DO INSTEAD NOTHING;
CREATE RULE option_set_identity_no_update AS ON UPDATE TO rms_catalog.option_set
  WHERE (OLD.option_set_id IS DISTINCT FROM NEW.option_set_id OR OLD.brand_id IS DISTINCT FROM NEW.brand_id OR OLD.internal_code IS DISTINCT FROM NEW.internal_code OR OLD.created_at IS DISTINCT FROM NEW.created_at OR OLD.created_by_actor_id IS DISTINCT FROM NEW.created_by_actor_id)
  DO INSTEAD NOTHING;
CREATE RULE option_identity_no_update AS ON UPDATE TO rms_catalog.option
  WHERE (OLD.option_id IS DISTINCT FROM NEW.option_id OR OLD.option_set_id IS DISTINCT FROM NEW.option_set_id OR OLD.brand_id IS DISTINCT FROM NEW.brand_id OR OLD.stable_code IS DISTINCT FROM NEW.stable_code OR OLD.created_at IS DISTINCT FROM NEW.created_at OR OLD.created_by_actor_id IS DISTINCT FROM NEW.created_by_actor_id)
  DO INSTEAD NOTHING;
CREATE RULE product_option_binding_identity_no_update AS ON UPDATE TO rms_catalog.product_option_binding
  WHERE (OLD.binding_id IS DISTINCT FROM NEW.binding_id OR OLD.product_id IS DISTINCT FROM NEW.product_id OR OLD.brand_id IS DISTINCT FROM NEW.brand_id OR OLD.option_set_id IS DISTINCT FROM NEW.option_set_id OR OLD.option_set_version_id IS DISTINCT FROM NEW.option_set_version_id OR OLD.purpose IS DISTINCT FROM NEW.purpose)
  DO INSTEAD NOTHING;

ALTER TABLE rms_catalog.option_set ENABLE ROW LEVEL SECURITY;
ALTER TABLE rms_catalog.option_set FORCE ROW LEVEL SECURITY;
ALTER TABLE rms_catalog.option_set_version ENABLE ROW LEVEL SECURITY;
ALTER TABLE rms_catalog.option_set_version FORCE ROW LEVEL SECURITY;
ALTER TABLE rms_catalog.option ENABLE ROW LEVEL SECURITY;
ALTER TABLE rms_catalog.option FORCE ROW LEVEL SECURITY;
ALTER TABLE rms_catalog.option_conflict ENABLE ROW LEVEL SECURITY;
ALTER TABLE rms_catalog.option_conflict FORCE ROW LEVEL SECURITY;
ALTER TABLE rms_catalog.product_option_binding ENABLE ROW LEVEL SECURITY;
ALTER TABLE rms_catalog.product_option_binding FORCE ROW LEVEL SECURITY;
ALTER TABLE rms_catalog.product_option_binding_option ENABLE ROW LEVEL SECURITY;
ALTER TABLE rms_catalog.product_option_binding_option FORCE ROW LEVEL SECURITY;
ALTER TABLE rms_catalog.product_option_binding_sku_scope ENABLE ROW LEVEL SECURITY;
ALTER TABLE rms_catalog.product_option_binding_sku_scope FORCE ROW LEVEL SECURITY;
ALTER TABLE rms_catalog.product_option_binding_channel ENABLE ROW LEVEL SECURITY;
ALTER TABLE rms_catalog.product_option_binding_channel FORCE ROW LEVEL SECURITY;
ALTER TABLE rms_catalog.option_set_operation_record ENABLE ROW LEVEL SECURITY;
ALTER TABLE rms_catalog.option_set_operation_record FORCE ROW LEVEL SECURITY;

CREATE POLICY option_set_brand_scope_policy ON rms_catalog.option_set USING (brand_id = platform_helpers.current_brand_id() AND platform_helpers.current_store_id() IS NULL) WITH CHECK (brand_id = platform_helpers.current_brand_id() AND platform_helpers.current_store_id() IS NULL);
CREATE POLICY option_set_version_brand_scope_policy ON rms_catalog.option_set_version USING (brand_id = platform_helpers.current_brand_id() AND platform_helpers.current_store_id() IS NULL) WITH CHECK (brand_id = platform_helpers.current_brand_id() AND platform_helpers.current_store_id() IS NULL);
CREATE POLICY option_brand_scope_policy ON rms_catalog.option USING (brand_id = platform_helpers.current_brand_id() AND platform_helpers.current_store_id() IS NULL) WITH CHECK (brand_id = platform_helpers.current_brand_id() AND platform_helpers.current_store_id() IS NULL);
CREATE POLICY option_conflict_brand_scope_policy ON rms_catalog.option_conflict USING (brand_id = platform_helpers.current_brand_id() AND platform_helpers.current_store_id() IS NULL) WITH CHECK (brand_id = platform_helpers.current_brand_id() AND platform_helpers.current_store_id() IS NULL);
CREATE POLICY product_option_binding_brand_scope_policy ON rms_catalog.product_option_binding USING (brand_id = platform_helpers.current_brand_id() AND platform_helpers.current_store_id() IS NULL) WITH CHECK (brand_id = platform_helpers.current_brand_id() AND platform_helpers.current_store_id() IS NULL);
CREATE POLICY product_option_binding_option_brand_scope_policy ON rms_catalog.product_option_binding_option USING (brand_id = platform_helpers.current_brand_id() AND platform_helpers.current_store_id() IS NULL) WITH CHECK (brand_id = platform_helpers.current_brand_id() AND platform_helpers.current_store_id() IS NULL);
CREATE POLICY product_option_binding_sku_brand_scope_policy ON rms_catalog.product_option_binding_sku_scope USING (brand_id = platform_helpers.current_brand_id() AND platform_helpers.current_store_id() IS NULL) WITH CHECK (brand_id = platform_helpers.current_brand_id() AND platform_helpers.current_store_id() IS NULL);
CREATE POLICY product_option_binding_channel_brand_scope_policy ON rms_catalog.product_option_binding_channel USING (brand_id = platform_helpers.current_brand_id() AND platform_helpers.current_store_id() IS NULL) WITH CHECK (brand_id = platform_helpers.current_brand_id() AND platform_helpers.current_store_id() IS NULL);
CREATE POLICY option_set_operation_brand_scope_policy ON rms_catalog.option_set_operation_record USING (brand_id = platform_helpers.current_brand_id() AND platform_helpers.current_store_id() IS NULL) WITH CHECK (brand_id = platform_helpers.current_brand_id() AND platform_helpers.current_store_id() IS NULL);

REVOKE ALL ON TABLE rms_catalog.option_set, rms_catalog.option_set_version, rms_catalog.option, rms_catalog.option_conflict, rms_catalog.product_option_binding, rms_catalog.product_option_binding_option, rms_catalog.product_option_binding_sku_scope, rms_catalog.product_option_binding_channel, rms_catalog.option_set_operation_record FROM PUBLIC;
