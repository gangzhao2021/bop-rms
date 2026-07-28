-- bop-rms-migration: 1
-- owner: @bop/tenant
-- schema: bop_tenant
-- phase: expand
-- risk: medium
-- transaction: required
-- lock-timeout-ms: 5000
-- statement-timeout-ms: 60000
-- recovery: forward-fix
CREATE SCHEMA bop_tenant;
REVOKE ALL ON SCHEMA bop_tenant FROM PUBLIC;

CREATE TABLE bop_tenant.brand (
  brand_id platform_helpers.uuid_v7 PRIMARY KEY,
  code text NOT NULL UNIQUE CHECK (code ~ '^[A-Z][A-Z0-9_-]{0,62}$'),
  display_name text NOT NULL CHECK (char_length(display_name) BETWEEN 1 AND 160),
  default_locale text NOT NULL CHECK (char_length(default_locale) BETWEEN 2 AND 35),
  currency_code text NOT NULL CHECK (currency_code = 'CAD'),
  lifecycle text NOT NULL CHECK (lifecycle IN ('Draft', 'Active', 'Suspended', 'Archived')),
  version integer NOT NULL CHECK (version > 0),
  created_at timestamp with time zone NOT NULL,
  updated_at timestamp with time zone NOT NULL,
  CONSTRAINT brand_time_order_check CHECK (updated_at >= created_at)
);

CREATE TABLE bop_tenant.store (
  store_id platform_helpers.uuid_v7 PRIMARY KEY,
  brand_id platform_helpers.uuid_v7 NOT NULL REFERENCES bop_tenant.brand (brand_id),
  code text NOT NULL CHECK (code ~ '^[A-Z][A-Z0-9_-]{0,62}$'),
  display_name text NOT NULL CHECK (char_length(display_name) BETWEEN 1 AND 160),
  time_zone text NOT NULL CHECK (
    char_length(time_zone) BETWEEN 3 AND 64
    AND time_zone ~ '^[A-Za-z][A-Za-z0-9_+-]*(/[A-Za-z][A-Za-z0-9_+-]*)+$'
  ),
  locale text NOT NULL CHECK (char_length(locale) BETWEEN 2 AND 35),
  currency_code text NOT NULL CHECK (currency_code = 'CAD'),
  lifecycle text NOT NULL CHECK (lifecycle IN ('Draft', 'Active', 'Suspended', 'Archived')),
  version integer NOT NULL CHECK (version > 0),
  created_at timestamp with time zone NOT NULL,
  updated_at timestamp with time zone NOT NULL,
  CONSTRAINT store_time_order_check CHECK (updated_at >= created_at),
  CONSTRAINT store_brand_code_unique UNIQUE (brand_id, code),
  CONSTRAINT store_brand_identity_unique UNIQUE (store_id, brand_id)
);

ALTER TABLE bop_tenant.brand ENABLE ROW LEVEL SECURITY;
ALTER TABLE bop_tenant.brand FORCE ROW LEVEL SECURITY;
CREATE POLICY brand_scope_policy ON bop_tenant.brand
  USING (
    brand_id = platform_helpers.current_brand_id()
    AND platform_helpers.current_store_id() IS NULL
  )
  WITH CHECK (
    brand_id = platform_helpers.current_brand_id()
    AND platform_helpers.current_store_id() IS NULL
  );

ALTER TABLE bop_tenant.store ENABLE ROW LEVEL SECURITY;
ALTER TABLE bop_tenant.store FORCE ROW LEVEL SECURITY;
CREATE POLICY store_scope_policy ON bop_tenant.store
  USING (
    brand_id = platform_helpers.current_brand_id()
    AND store_id = platform_helpers.current_store_id()
  )
  WITH CHECK (
    brand_id = platform_helpers.current_brand_id()
    AND store_id = platform_helpers.current_store_id()
  );

REVOKE ALL ON TABLE bop_tenant.brand FROM PUBLIC;
REVOKE ALL ON TABLE bop_tenant.store FROM PUBLIC;
