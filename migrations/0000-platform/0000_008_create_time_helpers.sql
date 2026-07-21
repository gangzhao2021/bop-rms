-- bop-rms-migration: 1
-- owner: shared-infrastructure/helpers
-- schema: platform_helpers
-- phase: expand
-- risk: low
-- transaction: required
-- lock-timeout-ms: 5000
-- statement-timeout-ms: 60000
-- recovery: forward-fix
CREATE FUNCTION platform_helpers.is_iana_time_zone(value text)
RETURNS boolean
LANGUAGE sql
STABLE
STRICT
PARALLEL SAFE
SECURITY INVOKER
SET search_path = pg_catalog
RETURN EXISTS (
  SELECT 1
  FROM pg_catalog.pg_timezone_names AS timezone_name
  WHERE timezone_name.name = value
);

REVOKE ALL ON FUNCTION platform_helpers.is_iana_time_zone(text) FROM PUBLIC;

CREATE DOMAIN platform_helpers.iana_time_zone AS text
  CONSTRAINT iana_time_zone_known_check CHECK (platform_helpers.is_iana_time_zone(VALUE));

CREATE DOMAIN platform_helpers.local_date AS date;
CREATE DOMAIN platform_helpers.local_time AS time without time zone;

REVOKE ALL ON TYPE platform_helpers.iana_time_zone FROM PUBLIC;
REVOKE ALL ON TYPE platform_helpers.local_date FROM PUBLIC;
REVOKE ALL ON TYPE platform_helpers.local_time FROM PUBLIC;
