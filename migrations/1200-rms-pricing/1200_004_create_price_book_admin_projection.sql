-- bop-rms-migration: 1
-- owner: @rms/pricing
-- schema: rms_pricing
-- phase: expand
-- risk: medium
-- transaction: required
-- lock-timeout-ms: 5000
-- statement-timeout-ms: 60000
-- recovery: forward-fix
ALTER TABLE rms_pricing.price_book_operation_record
  ADD COLUMN outbox_event_id platform_helpers.uuid_v7,
  ADD CONSTRAINT price_book_operation_outbox_unique UNIQUE (outbox_event_id);

CREATE TABLE rms_pricing.price_book_admin_projection_generation (
  generation_id platform_helpers.uuid_v7 PRIMARY KEY,
  brand_id platform_helpers.uuid_v7 NOT NULL,
  projection_version integer NOT NULL CHECK (projection_version > 0),
  source_event_sequence bigint NOT NULL CHECK (source_event_sequence >= 0),
  built_at timestamp with time zone NOT NULL,
  CONSTRAINT price_book_admin_generation_brand_unique UNIQUE (generation_id, brand_id)
);

CREATE TABLE rms_pricing.price_book_admin_projection (
  generation_id platform_helpers.uuid_v7 NOT NULL,
  brand_id platform_helpers.uuid_v7 NOT NULL,
  price_book_id platform_helpers.uuid_v7 NOT NULL,
  price_book_version_id platform_helpers.uuid_v7 NOT NULL,
  stable_code text NOT NULL CHECK (stable_code ~ '^[A-Z][A-Z0-9_-]{0,63}$'),
  lifecycle text NOT NULL CHECK (lifecycle IN ('Draft', 'Published', 'Archived')),
  currency_code text NOT NULL CHECK (currency_code ~ '^[A-Z]{3}$'),
  aggregate_version integer NOT NULL CHECK (aggregate_version > 0),
  version_number integer NOT NULL CHECK (version_number > 0),
  entry_count integer NOT NULL CHECK (entry_count >= 0),
  covered_scenario_count integer NOT NULL CHECK (covered_scenario_count >= 0),
  missing_scenario_count integer NOT NULL CHECK (missing_scenario_count >= 0),
  conflict_scenario_count integer NOT NULL CHECK (conflict_scenario_count >= 0),
  effective_from timestamp with time zone,
  effective_until timestamp with time zone,
  snapshot_digest text NOT NULL CHECK (snapshot_digest ~ '^sha256:[0-9a-f]{64}$'),
  projected_at timestamp with time zone NOT NULL,
  PRIMARY KEY (generation_id, price_book_id),
  CONSTRAINT price_book_admin_projection_generation_fk FOREIGN KEY (generation_id, brand_id)
    REFERENCES rms_pricing.price_book_admin_projection_generation (generation_id, brand_id),
  CONSTRAINT price_book_admin_projection_period_check CHECK (effective_until IS NULL OR effective_from IS NULL OR effective_until > effective_from)
);

CREATE TABLE rms_pricing.price_book_entry_projection (
  generation_id platform_helpers.uuid_v7 NOT NULL,
  brand_id platform_helpers.uuid_v7 NOT NULL,
  price_book_id platform_helpers.uuid_v7 NOT NULL,
  price_entry_id platform_helpers.uuid_v7 NOT NULL,
  sellable_id platform_helpers.uuid_v7 NOT NULL,
  sellable_code text NOT NULL CHECK (sellable_code ~ '^[A-Z][A-Z0-9_-]{0,63}$'),
  scope_kind text NOT NULL CHECK (scope_kind IN ('Brand', 'Region', 'StoreGroup', 'Store')),
  scope_id platform_helpers.uuid_v7,
  channel_code text,
  order_type text,
  amount_minor numeric NOT NULL,
  currency_code text NOT NULL CHECK (currency_code ~ '^[A-Z]{3}$'),
  effective_from timestamp with time zone NOT NULL,
  effective_until timestamp with time zone,
  coverage_status text NOT NULL CHECK (coverage_status IN ('Covered', 'Missing', 'Conflict')),
  reason_code text NOT NULL CHECK (reason_code ~ '^[A-Z][A-Z0-9_-]{0,63}$'),
  PRIMARY KEY (generation_id, price_entry_id),
  CONSTRAINT price_book_entry_projection_amount_minor_check CHECK (
    amount_minor >= 0 AND amount_minor < 1e30 AND amount_minor = trunc(amount_minor)
  ),
  CONSTRAINT price_book_entry_projection_generation_fk FOREIGN KEY (generation_id, brand_id)
    REFERENCES rms_pricing.price_book_admin_projection_generation (generation_id, brand_id),
  CONSTRAINT price_book_entry_projection_period_check CHECK (effective_until IS NULL OR effective_until > effective_from)
);

CREATE TABLE rms_pricing.price_book_admin_projection_checkpoint (
  brand_id platform_helpers.uuid_v7 PRIMARY KEY,
  active_generation_id platform_helpers.uuid_v7 NOT NULL,
  projection_version integer NOT NULL CHECK (projection_version > 0),
  source_event_sequence bigint NOT NULL CHECK (source_event_sequence >= 0),
  updated_at timestamp with time zone NOT NULL,
  CONSTRAINT price_book_admin_checkpoint_generation_fk FOREIGN KEY (active_generation_id, brand_id)
    REFERENCES rms_pricing.price_book_admin_projection_generation (generation_id, brand_id)
);

CREATE RULE price_book_admin_generation_no_update AS ON UPDATE TO rms_pricing.price_book_admin_projection_generation DO INSTEAD NOTHING;
CREATE RULE price_book_admin_generation_no_delete AS ON DELETE TO rms_pricing.price_book_admin_projection_generation DO INSTEAD NOTHING;

ALTER TABLE rms_pricing.price_book_admin_projection_generation ENABLE ROW LEVEL SECURITY;
ALTER TABLE rms_pricing.price_book_admin_projection_generation FORCE ROW LEVEL SECURITY;
ALTER TABLE rms_pricing.price_book_admin_projection ENABLE ROW LEVEL SECURITY;
ALTER TABLE rms_pricing.price_book_admin_projection FORCE ROW LEVEL SECURITY;
ALTER TABLE rms_pricing.price_book_entry_projection ENABLE ROW LEVEL SECURITY;
ALTER TABLE rms_pricing.price_book_entry_projection FORCE ROW LEVEL SECURITY;
ALTER TABLE rms_pricing.price_book_admin_projection_checkpoint ENABLE ROW LEVEL SECURITY;
ALTER TABLE rms_pricing.price_book_admin_projection_checkpoint FORCE ROW LEVEL SECURITY;

CREATE POLICY price_book_admin_generation_brand_scope_policy ON rms_pricing.price_book_admin_projection_generation USING (brand_id = platform_helpers.current_brand_id()) WITH CHECK (brand_id = platform_helpers.current_brand_id());
CREATE POLICY price_book_admin_projection_brand_scope_policy ON rms_pricing.price_book_admin_projection USING (brand_id = platform_helpers.current_brand_id()) WITH CHECK (brand_id = platform_helpers.current_brand_id());
CREATE POLICY price_book_entry_projection_brand_scope_policy ON rms_pricing.price_book_entry_projection USING (brand_id = platform_helpers.current_brand_id()) WITH CHECK (brand_id = platform_helpers.current_brand_id());
CREATE POLICY price_book_admin_checkpoint_brand_scope_policy ON rms_pricing.price_book_admin_projection_checkpoint USING (brand_id = platform_helpers.current_brand_id()) WITH CHECK (brand_id = platform_helpers.current_brand_id());

REVOKE ALL ON TABLE rms_pricing.price_book_admin_projection_generation,
  rms_pricing.price_book_admin_projection,
  rms_pricing.price_book_entry_projection,
  rms_pricing.price_book_admin_projection_checkpoint FROM PUBLIC;
