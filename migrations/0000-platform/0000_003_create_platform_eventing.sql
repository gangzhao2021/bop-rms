-- bop-rms-migration: 1
-- owner: shared-infrastructure/eventing
-- schema: platform_eventing
-- phase: expand
-- risk: low
-- transaction: required
-- lock-timeout-ms: 5000
-- statement-timeout-ms: 60000
-- recovery: forward-fix
CREATE SCHEMA platform_eventing AUTHORIZATION CURRENT_USER;

REVOKE ALL ON SCHEMA platform_eventing FROM PUBLIC;

ALTER DEFAULT PRIVILEGES IN SCHEMA platform_eventing REVOKE ALL ON TABLES FROM PUBLIC;
ALTER DEFAULT PRIVILEGES IN SCHEMA platform_eventing REVOKE ALL ON SEQUENCES FROM PUBLIC;
ALTER DEFAULT PRIVILEGES IN SCHEMA platform_eventing REVOKE ALL ON FUNCTIONS FROM PUBLIC;
ALTER DEFAULT PRIVILEGES IN SCHEMA platform_eventing REVOKE ALL ON TYPES FROM PUBLIC;
