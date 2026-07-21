-- bop-rms-migration: 1
-- owner: shared-infrastructure/helpers
-- schema: platform_helpers
-- phase: expand
-- risk: low
-- transaction: required
-- lock-timeout-ms: 5000
-- statement-timeout-ms: 60000
-- recovery: forward-fix
CREATE FUNCTION platform_helpers.is_uuid_v7(value uuid)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
STRICT
PARALLEL SAFE
SECURITY INVOKER
SET search_path = pg_catalog
RETURN (pg_catalog.get_byte(pg_catalog.uuid_send(value), 6) >> 4) = 7;

REVOKE ALL ON FUNCTION platform_helpers.is_uuid_v7(uuid) FROM PUBLIC;

CREATE DOMAIN platform_helpers.uuid_v7 AS uuid
  CONSTRAINT uuid_v7_version_check CHECK (platform_helpers.is_uuid_v7(VALUE));

CREATE DOMAIN platform_helpers.amount_minor AS bigint;

CREATE DOMAIN platform_helpers.currency_code AS character(3)
  CONSTRAINT currency_code_shape_check CHECK (VALUE::text ~ '^[A-Z]{3}$');

REVOKE ALL ON TYPE platform_helpers.uuid_v7 FROM PUBLIC;
REVOKE ALL ON TYPE platform_helpers.amount_minor FROM PUBLIC;
REVOKE ALL ON TYPE platform_helpers.currency_code FROM PUBLIC;
