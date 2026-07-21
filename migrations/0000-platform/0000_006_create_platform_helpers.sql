-- bop-rms-migration: 1
-- owner: shared-infrastructure/helpers
-- schema: platform_helpers
-- phase: expand
-- risk: low
-- transaction: required
-- lock-timeout-ms: 5000
-- statement-timeout-ms: 60000
-- recovery: forward-fix
CREATE SCHEMA platform_helpers AUTHORIZATION CURRENT_USER;

REVOKE ALL ON SCHEMA platform_helpers FROM PUBLIC;

ALTER DEFAULT PRIVILEGES IN SCHEMA platform_helpers REVOKE ALL ON TABLES FROM PUBLIC;
ALTER DEFAULT PRIVILEGES IN SCHEMA platform_helpers REVOKE ALL ON SEQUENCES FROM PUBLIC;
ALTER DEFAULT PRIVILEGES IN SCHEMA platform_helpers REVOKE ALL ON FUNCTIONS FROM PUBLIC;
ALTER DEFAULT PRIVILEGES IN SCHEMA platform_helpers REVOKE ALL ON TYPES FROM PUBLIC;
