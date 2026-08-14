-- bop-rms-migration: 1
-- owner: @rms/catalog
-- schema: rms_catalog
-- phase: expand
-- risk: medium
-- transaction: required
-- lock-timeout-ms: 5000
-- statement-timeout-ms: 60000
-- recovery: forward-fix
CREATE TABLE rms_catalog.bundle (
  bundle_id platform_helpers.uuid_v7 PRIMARY KEY,
  brand_id platform_helpers.uuid_v7 NOT NULL,
  internal_code text NOT NULL CHECK (internal_code ~ '^[A-Z][A-Z0-9_-]{0,63}$'),
  lifecycle text NOT NULL CHECK (lifecycle IN ('Draft', 'Published', 'Suspended', 'Discontinued', 'Archived')),
  aggregate_version integer NOT NULL CHECK (aggregate_version > 0),
  current_version_id platform_helpers.uuid_v7 NOT NULL,
  created_at timestamp with time zone NOT NULL,
  created_by_actor_id platform_helpers.uuid_v7 NOT NULL,
  updated_at timestamp with time zone NOT NULL,
  CONSTRAINT bundle_brand_code_unique UNIQUE (brand_id, internal_code),
  CONSTRAINT bundle_brand_identity_unique UNIQUE (bundle_id, brand_id),
  CONSTRAINT bundle_version_pointer_unique UNIQUE (current_version_id, bundle_id, brand_id),
  CONSTRAINT bundle_time_order_check CHECK (updated_at >= created_at)
);

CREATE TABLE rms_catalog.bundle_version (
  bundle_version_id platform_helpers.uuid_v7 PRIMARY KEY,
  bundle_id platform_helpers.uuid_v7 NOT NULL,
  brand_id platform_helpers.uuid_v7 NOT NULL,
  status text NOT NULL CHECK (status IN ('Draft', 'Published')),
  default_locale text NOT NULL CHECK (char_length(default_locale) BETWEEN 2 AND 35),
  localized_names_json jsonb NOT NULL CHECK (jsonb_typeof(localized_names_json) = 'object'),
  localized_descriptions_json jsonb NOT NULL CHECK (jsonb_typeof(localized_descriptions_json) = 'object'),
  price_mode text NOT NULL CHECK (price_mode IN ('Fixed', 'Computed')),
  currency_code text CHECK (currency_code ~ '^[A-Z]{3}$'),
  fixed_amount_minor numeric(30,0) CHECK (fixed_amount_minor >= 0),
  validation_digest text CHECK (validation_digest ~ '^sha256:[0-9a-f]{64}$'),
  created_at timestamp with time zone NOT NULL,
  updated_at timestamp with time zone NOT NULL,
  published_at timestamp with time zone,
  CONSTRAINT bundle_version_bundle_fk FOREIGN KEY (bundle_id, brand_id)
    REFERENCES rms_catalog.bundle (bundle_id, brand_id) DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT bundle_version_identity_unique UNIQUE (bundle_version_id, bundle_id, brand_id),
  CONSTRAINT bundle_version_price_shape CHECK (
    (price_mode = 'Fixed' AND currency_code IS NOT NULL AND fixed_amount_minor IS NOT NULL)
    OR (price_mode = 'Computed' AND currency_code IS NULL AND fixed_amount_minor IS NULL)
  ),
  CONSTRAINT bundle_version_publish_shape CHECK (
    (status = 'Draft' AND validation_digest IS NULL AND published_at IS NULL)
    OR (status = 'Published' AND validation_digest IS NOT NULL AND published_at IS NOT NULL)
  ),
  CONSTRAINT bundle_version_time_check CHECK (
    updated_at >= created_at AND (published_at IS NULL OR published_at >= created_at)
  )
);

ALTER TABLE rms_catalog.bundle ADD CONSTRAINT bundle_current_version_fk
  FOREIGN KEY (current_version_id, bundle_id, brand_id)
  REFERENCES rms_catalog.bundle_version (bundle_version_id, bundle_id, brand_id)
  DEFERRABLE INITIALLY DEFERRED;

CREATE TABLE rms_catalog.bundle_component_group (
  group_id platform_helpers.uuid_v7 PRIMARY KEY,
  bundle_version_id platform_helpers.uuid_v7 NOT NULL,
  bundle_id platform_helpers.uuid_v7 NOT NULL,
  brand_id platform_helpers.uuid_v7 NOT NULL,
  stable_code text NOT NULL CHECK (stable_code ~ '^[A-Z][A-Z0-9_-]{0,63}$'),
  localized_names_json jsonb NOT NULL CHECK (jsonb_typeof(localized_names_json) = 'object'),
  minimum_selection integer NOT NULL CHECK (minimum_selection >= 0),
  maximum_selection integer NOT NULL CHECK (maximum_selection > 0 AND maximum_selection >= minimum_selection),
  option_set_version_id platform_helpers.uuid_v7,
  sort_order integer NOT NULL CHECK (sort_order >= 0),
  CONSTRAINT bundle_group_version_fk FOREIGN KEY (bundle_version_id, bundle_id, brand_id)
    REFERENCES rms_catalog.bundle_version (bundle_version_id, bundle_id, brand_id),
  CONSTRAINT bundle_group_code_unique UNIQUE (bundle_version_id, stable_code),
  CONSTRAINT bundle_group_order_unique UNIQUE (bundle_version_id, sort_order),
  CONSTRAINT bundle_group_identity_unique UNIQUE (group_id, bundle_version_id, bundle_id, brand_id)
);

CREATE TABLE rms_catalog.bundle_component_sellable (
  group_id platform_helpers.uuid_v7 NOT NULL,
  bundle_version_id platform_helpers.uuid_v7 NOT NULL,
  bundle_id platform_helpers.uuid_v7 NOT NULL,
  brand_id platform_helpers.uuid_v7 NOT NULL,
  sellable_id platform_helpers.uuid_v7 NOT NULL,
  sellable_type text NOT NULL CHECK (sellable_type IN ('Product', 'Sku')),
  upgrade_currency_code text CHECK (upgrade_currency_code ~ '^[A-Z]{3}$'),
  upgrade_amount_minor numeric(30,0) CHECK (upgrade_amount_minor >= 0),
  PRIMARY KEY (group_id, sellable_id),
  CONSTRAINT bundle_sellable_group_fk FOREIGN KEY (group_id, bundle_version_id, bundle_id, brand_id)
    REFERENCES rms_catalog.bundle_component_group (group_id, bundle_version_id, bundle_id, brand_id),
  CONSTRAINT bundle_sellable_upgrade_shape CHECK (
    (upgrade_currency_code IS NULL AND upgrade_amount_minor IS NULL)
    OR (upgrade_currency_code IS NOT NULL AND upgrade_amount_minor IS NOT NULL)
  )
);

CREATE TABLE rms_catalog.bundle_availability_rule (
  bundle_version_id platform_helpers.uuid_v7 NOT NULL,
  bundle_id platform_helpers.uuid_v7 NOT NULL,
  brand_id platform_helpers.uuid_v7 NOT NULL,
  availability_rule_id platform_helpers.uuid_v7 NOT NULL,
  PRIMARY KEY (bundle_version_id, availability_rule_id),
  CONSTRAINT bundle_availability_version_fk FOREIGN KEY (bundle_version_id, bundle_id, brand_id)
    REFERENCES rms_catalog.bundle_version (bundle_version_id, bundle_id, brand_id)
);

CREATE TABLE rms_catalog.bundle_operation_record (
  operation_id platform_helpers.uuid_v7 PRIMARY KEY,
  brand_id platform_helpers.uuid_v7 NOT NULL,
  bundle_id platform_helpers.uuid_v7 NOT NULL,
  action_code text NOT NULL CHECK (action_code IN ('Create', 'ReplaceDraft', 'Publish', 'ChangeLifecycle')),
  intent_digest text NOT NULL CHECK (intent_digest ~ '^sha256:[0-9a-f]{64}$'),
  result_aggregate_version integer NOT NULL CHECK (result_aggregate_version > 0),
  outbox_event_id platform_helpers.uuid_v7 NOT NULL,
  occurred_at timestamp with time zone NOT NULL,
  CONSTRAINT bundle_operation_bundle_fk FOREIGN KEY (bundle_id, brand_id)
    REFERENCES rms_catalog.bundle (bundle_id, brand_id)
);

CREATE RULE bundle_version_no_update AS ON UPDATE TO rms_catalog.bundle_version DO INSTEAD NOTHING;
CREATE RULE bundle_version_no_delete AS ON DELETE TO rms_catalog.bundle_version DO INSTEAD NOTHING;
CREATE RULE bundle_group_no_update AS ON UPDATE TO rms_catalog.bundle_component_group DO INSTEAD NOTHING;
CREATE RULE bundle_group_no_delete AS ON DELETE TO rms_catalog.bundle_component_group DO INSTEAD NOTHING;
CREATE RULE bundle_sellable_no_update AS ON UPDATE TO rms_catalog.bundle_component_sellable DO INSTEAD NOTHING;
CREATE RULE bundle_sellable_no_delete AS ON DELETE TO rms_catalog.bundle_component_sellable DO INSTEAD NOTHING;
CREATE RULE bundle_availability_no_update AS ON UPDATE TO rms_catalog.bundle_availability_rule DO INSTEAD NOTHING;
CREATE RULE bundle_availability_no_delete AS ON DELETE TO rms_catalog.bundle_availability_rule DO INSTEAD NOTHING;
CREATE RULE bundle_operation_no_update AS ON UPDATE TO rms_catalog.bundle_operation_record DO INSTEAD NOTHING;
CREATE RULE bundle_operation_no_delete AS ON DELETE TO rms_catalog.bundle_operation_record DO INSTEAD NOTHING;
CREATE RULE bundle_identity_no_update AS ON UPDATE TO rms_catalog.bundle
  WHERE (OLD.bundle_id IS DISTINCT FROM NEW.bundle_id OR OLD.brand_id IS DISTINCT FROM NEW.brand_id OR OLD.internal_code IS DISTINCT FROM NEW.internal_code OR OLD.created_at IS DISTINCT FROM NEW.created_at OR OLD.created_by_actor_id IS DISTINCT FROM NEW.created_by_actor_id)
  DO INSTEAD NOTHING;

ALTER TABLE rms_catalog.bundle ENABLE ROW LEVEL SECURITY;
ALTER TABLE rms_catalog.bundle FORCE ROW LEVEL SECURITY;
ALTER TABLE rms_catalog.bundle_version ENABLE ROW LEVEL SECURITY;
ALTER TABLE rms_catalog.bundle_version FORCE ROW LEVEL SECURITY;
ALTER TABLE rms_catalog.bundle_component_group ENABLE ROW LEVEL SECURITY;
ALTER TABLE rms_catalog.bundle_component_group FORCE ROW LEVEL SECURITY;
ALTER TABLE rms_catalog.bundle_component_sellable ENABLE ROW LEVEL SECURITY;
ALTER TABLE rms_catalog.bundle_component_sellable FORCE ROW LEVEL SECURITY;
ALTER TABLE rms_catalog.bundle_availability_rule ENABLE ROW LEVEL SECURITY;
ALTER TABLE rms_catalog.bundle_availability_rule FORCE ROW LEVEL SECURITY;
ALTER TABLE rms_catalog.bundle_operation_record ENABLE ROW LEVEL SECURITY;
ALTER TABLE rms_catalog.bundle_operation_record FORCE ROW LEVEL SECURITY;

CREATE POLICY bundle_brand_scope_policy ON rms_catalog.bundle USING (brand_id = platform_helpers.current_brand_id() AND platform_helpers.current_store_id() IS NULL) WITH CHECK (brand_id = platform_helpers.current_brand_id() AND platform_helpers.current_store_id() IS NULL);
CREATE POLICY bundle_version_brand_scope_policy ON rms_catalog.bundle_version USING (brand_id = platform_helpers.current_brand_id() AND platform_helpers.current_store_id() IS NULL) WITH CHECK (brand_id = platform_helpers.current_brand_id() AND platform_helpers.current_store_id() IS NULL);
CREATE POLICY bundle_group_brand_scope_policy ON rms_catalog.bundle_component_group USING (brand_id = platform_helpers.current_brand_id() AND platform_helpers.current_store_id() IS NULL) WITH CHECK (brand_id = platform_helpers.current_brand_id() AND platform_helpers.current_store_id() IS NULL);
CREATE POLICY bundle_sellable_brand_scope_policy ON rms_catalog.bundle_component_sellable USING (brand_id = platform_helpers.current_brand_id() AND platform_helpers.current_store_id() IS NULL) WITH CHECK (brand_id = platform_helpers.current_brand_id() AND platform_helpers.current_store_id() IS NULL);
CREATE POLICY bundle_availability_brand_scope_policy ON rms_catalog.bundle_availability_rule USING (brand_id = platform_helpers.current_brand_id() AND platform_helpers.current_store_id() IS NULL) WITH CHECK (brand_id = platform_helpers.current_brand_id() AND platform_helpers.current_store_id() IS NULL);
CREATE POLICY bundle_operation_brand_scope_policy ON rms_catalog.bundle_operation_record USING (brand_id = platform_helpers.current_brand_id() AND platform_helpers.current_store_id() IS NULL) WITH CHECK (brand_id = platform_helpers.current_brand_id() AND platform_helpers.current_store_id() IS NULL);

REVOKE ALL ON TABLE rms_catalog.bundle, rms_catalog.bundle_version, rms_catalog.bundle_component_group, rms_catalog.bundle_component_sellable, rms_catalog.bundle_availability_rule, rms_catalog.bundle_operation_record FROM PUBLIC;
