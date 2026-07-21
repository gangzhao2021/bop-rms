-- bop-rms-migration: 1
-- owner: shared-infrastructure/audit
-- schema: platform_audit
-- phase: expand
-- risk: low
-- transaction: required
-- lock-timeout-ms: 5000
-- statement-timeout-ms: 60000
-- recovery: forward-fix
CREATE SCHEMA platform_audit AUTHORIZATION CURRENT_USER;

REVOKE ALL ON SCHEMA platform_audit FROM PUBLIC;

ALTER DEFAULT PRIVILEGES IN SCHEMA platform_audit REVOKE ALL ON TABLES FROM PUBLIC;
ALTER DEFAULT PRIVILEGES IN SCHEMA platform_audit REVOKE ALL ON SEQUENCES FROM PUBLIC;
ALTER DEFAULT PRIVILEGES IN SCHEMA platform_audit REVOKE ALL ON FUNCTIONS FROM PUBLIC;
ALTER DEFAULT PRIVILEGES IN SCHEMA platform_audit REVOKE ALL ON TYPES FROM PUBLIC;
