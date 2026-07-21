-- bop-rms-migration: 1
-- owner: shared-infrastructure/jobs
-- schema: platform_jobs
-- phase: expand
-- risk: low
-- transaction: required
-- lock-timeout-ms: 5000
-- statement-timeout-ms: 60000
-- recovery: forward-fix
CREATE SCHEMA platform_jobs AUTHORIZATION CURRENT_USER;

REVOKE ALL ON SCHEMA platform_jobs FROM PUBLIC;

ALTER DEFAULT PRIVILEGES IN SCHEMA platform_jobs REVOKE ALL ON TABLES FROM PUBLIC;
ALTER DEFAULT PRIVILEGES IN SCHEMA platform_jobs REVOKE ALL ON SEQUENCES FROM PUBLIC;
ALTER DEFAULT PRIVILEGES IN SCHEMA platform_jobs REVOKE ALL ON FUNCTIONS FROM PUBLIC;
ALTER DEFAULT PRIVILEGES IN SCHEMA platform_jobs REVOKE ALL ON TYPES FROM PUBLIC;
