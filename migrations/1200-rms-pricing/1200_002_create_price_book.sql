-- bop-rms-migration: 1
-- owner: @rms/pricing
-- schema: rms_pricing
-- phase: expand
-- risk: medium
-- transaction: required
-- lock-timeout-ms: 5000
-- statement-timeout-ms: 60000
-- recovery: forward-fix
CREATE TABLE rms_pricing.price_book (
  price_book_id platform_helpers.uuid_v7 PRIMARY KEY,
  brand_id platform_helpers.uuid_v7 NOT NULL,
  stable_code text NOT NULL CHECK (stable_code ~ '^[A-Z][A-Z0-9_-]{0,63}$'),
  aggregate_version integer NOT NULL CHECK (aggregate_version > 0),
  current_version_id platform_helpers.uuid_v7,
  created_at timestamp with time zone NOT NULL,
  created_by_actor_id platform_helpers.uuid_v7 NOT NULL,
  updated_at timestamp with time zone NOT NULL,
  CONSTRAINT price_book_brand_code_unique UNIQUE (brand_id, stable_code),
  CONSTRAINT price_book_scope_identity_unique UNIQUE (price_book_id, brand_id),
  CONSTRAINT price_book_time_order_check CHECK (updated_at >= created_at)
);

CREATE TABLE rms_pricing.price_book_version (
  price_book_version_id platform_helpers.uuid_v7 PRIMARY KEY,
  price_book_id platform_helpers.uuid_v7 NOT NULL,
  brand_id platform_helpers.uuid_v7 NOT NULL,
  version_number integer NOT NULL CHECK (version_number > 0),
  snapshot_digest text NOT NULL CHECK (snapshot_digest ~ '^sha256:[0-9a-f]{64}$'),
  lifecycle text NOT NULL CHECK (lifecycle IN ('Draft', 'Published', 'Archived')),
  currency_code text NOT NULL CHECK (currency_code ~ '^[A-Z]{3}$'),
  currency_metadata_version integer NOT NULL CHECK (currency_metadata_version > 0),
  currency_metadata_version_id platform_helpers.uuid_v7 NOT NULL,
  currency_metadata_digest text NOT NULL CHECK (currency_metadata_digest ~ '^sha256:[0-9a-f]{64}$'),
  created_at timestamp with time zone NOT NULL,
  CONSTRAINT price_book_version_book_fk FOREIGN KEY (price_book_id, brand_id)
    REFERENCES rms_pricing.price_book (price_book_id, brand_id),
  CONSTRAINT price_book_version_scope_identity_unique
    UNIQUE (price_book_version_id, price_book_id, brand_id),
  CONSTRAINT price_book_version_number_unique UNIQUE (price_book_id, version_number)
);

ALTER TABLE rms_pricing.price_book
  ADD CONSTRAINT price_book_current_version_fk
  FOREIGN KEY (current_version_id, price_book_id, brand_id)
  REFERENCES rms_pricing.price_book_version (price_book_version_id, price_book_id, brand_id);

CREATE TABLE rms_pricing.price_entry (
  price_entry_id platform_helpers.uuid_v7 PRIMARY KEY,
  price_book_version_id platform_helpers.uuid_v7 NOT NULL,
  price_book_id platform_helpers.uuid_v7 NOT NULL,
  brand_id platform_helpers.uuid_v7 NOT NULL,
  sellable_id platform_helpers.uuid_v7 NOT NULL,
  scope_kind text NOT NULL CHECK (scope_kind IN ('Brand', 'Region', 'StoreGroup', 'Store')),
  scope_id platform_helpers.uuid_v7,
  channel_code text CHECK (channel_code IS NULL OR channel_code ~ '^[A-Z][A-Z0-9_-]{0,63}$'),
  order_type text CHECK (order_type IS NULL OR order_type IN ('DineIn', 'Pickup')),
  amount_minor bigint NOT NULL CHECK (amount_minor >= 0),
  currency_code text NOT NULL CHECK (currency_code ~ '^[A-Z]{3}$'),
  effective_from timestamp with time zone NOT NULL,
  effective_until timestamp with time zone,
  effective_time_zone text NOT NULL CHECK (effective_time_zone = 'America/Toronto'),
  reason_code text NOT NULL CHECK (reason_code ~ '^[A-Z][A-Z0-9_-]{0,63}$'),
  CONSTRAINT price_entry_version_fk
    FOREIGN KEY (price_book_version_id, price_book_id, brand_id)
    REFERENCES rms_pricing.price_book_version (price_book_version_id, price_book_id, brand_id),
  CONSTRAINT price_entry_scope_check CHECK (
    (scope_kind = 'Brand' AND scope_id IS NULL)
    OR (scope_kind <> 'Brand' AND scope_id IS NOT NULL)
  ),
  CONSTRAINT price_entry_effective_period_check
    CHECK (effective_until IS NULL OR effective_until > effective_from),
  CONSTRAINT price_entry_identity_unique UNIQUE (
    price_book_version_id, sellable_id, scope_kind, scope_id,
    channel_code, order_type, effective_from
  )
);

CREATE TABLE rms_pricing.price_book_operation_record (
  operation_id platform_helpers.uuid_v7 PRIMARY KEY,
  price_book_id platform_helpers.uuid_v7 NOT NULL,
  brand_id platform_helpers.uuid_v7 NOT NULL,
  action_code text NOT NULL CHECK (action_code IN ('CreateDraft', 'ReplaceDraft', 'Publish', 'Archive')),
  intent_digest text NOT NULL CHECK (intent_digest ~ '^sha256:[0-9a-f]{64}$'),
  result_aggregate_version integer NOT NULL CHECK (result_aggregate_version > 0),
  result_version_id platform_helpers.uuid_v7 NOT NULL,
  occurred_at timestamp with time zone NOT NULL,
  CONSTRAINT price_book_operation_book_fk FOREIGN KEY (price_book_id, brand_id)
    REFERENCES rms_pricing.price_book (price_book_id, brand_id),
  CONSTRAINT price_book_operation_version_fk
    FOREIGN KEY (result_version_id, price_book_id, brand_id)
    REFERENCES rms_pricing.price_book_version (price_book_version_id, price_book_id, brand_id)
);

CREATE RULE price_book_version_no_update AS
  ON UPDATE TO rms_pricing.price_book_version DO INSTEAD NOTHING;
CREATE RULE price_book_version_no_delete AS
  ON DELETE TO rms_pricing.price_book_version DO INSTEAD NOTHING;
CREATE RULE price_entry_no_update AS
  ON UPDATE TO rms_pricing.price_entry DO INSTEAD NOTHING;
CREATE RULE price_entry_no_delete AS
  ON DELETE TO rms_pricing.price_entry DO INSTEAD NOTHING;
CREATE RULE price_book_operation_no_update AS
  ON UPDATE TO rms_pricing.price_book_operation_record DO INSTEAD NOTHING;
CREATE RULE price_book_operation_no_delete AS
  ON DELETE TO rms_pricing.price_book_operation_record DO INSTEAD NOTHING;

CREATE INDEX price_entry_resolution_idx ON rms_pricing.price_entry (
  brand_id, sellable_id, scope_kind, scope_id, channel_code, order_type,
  effective_from, effective_until
);

ALTER TABLE rms_pricing.price_book ENABLE ROW LEVEL SECURITY;
ALTER TABLE rms_pricing.price_book FORCE ROW LEVEL SECURITY;
ALTER TABLE rms_pricing.price_book_version ENABLE ROW LEVEL SECURITY;
ALTER TABLE rms_pricing.price_book_version FORCE ROW LEVEL SECURITY;
ALTER TABLE rms_pricing.price_entry ENABLE ROW LEVEL SECURITY;
ALTER TABLE rms_pricing.price_entry FORCE ROW LEVEL SECURITY;
ALTER TABLE rms_pricing.price_book_operation_record ENABLE ROW LEVEL SECURITY;
ALTER TABLE rms_pricing.price_book_operation_record FORCE ROW LEVEL SECURITY;

CREATE POLICY price_book_brand_scope_policy ON rms_pricing.price_book
  USING (brand_id = platform_helpers.current_brand_id())
  WITH CHECK (brand_id = platform_helpers.current_brand_id());
CREATE POLICY price_book_version_brand_scope_policy ON rms_pricing.price_book_version
  USING (brand_id = platform_helpers.current_brand_id())
  WITH CHECK (brand_id = platform_helpers.current_brand_id());
CREATE POLICY price_entry_brand_scope_policy ON rms_pricing.price_entry
  USING (brand_id = platform_helpers.current_brand_id())
  WITH CHECK (brand_id = platform_helpers.current_brand_id());
CREATE POLICY price_book_operation_brand_scope_policy ON rms_pricing.price_book_operation_record
  USING (brand_id = platform_helpers.current_brand_id())
  WITH CHECK (brand_id = platform_helpers.current_brand_id());

REVOKE ALL ON TABLE rms_pricing.price_book FROM PUBLIC;
REVOKE ALL ON TABLE rms_pricing.price_book_version FROM PUBLIC;
REVOKE ALL ON TABLE rms_pricing.price_entry FROM PUBLIC;
REVOKE ALL ON TABLE rms_pricing.price_book_operation_record FROM PUBLIC;
