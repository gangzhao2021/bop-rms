-- bop-rms-migration: 1
-- owner: shared-infrastructure/platform-core
-- schema: platform_core
-- phase: expand
-- risk: low
-- transaction: required
-- lock-timeout-ms: 5000
-- statement-timeout-ms: 60000
-- recovery: forward-fix
CREATE SCHEMA platform_core AUTHORIZATION CURRENT_USER;

CREATE TABLE platform_core.migration_history (
  migration_id text PRIMARY KEY,
  namespace integer NOT NULL CHECK (namespace BETWEEN 0 AND 9999),
  sequence integer NOT NULL CHECK (sequence BETWEEN 1 AND 999),
  relative_path text NOT NULL UNIQUE,
  owner_id text NOT NULL,
  schema_name text NOT NULL,
  checksum_sha256 character(64) NOT NULL CHECK (checksum_sha256 ~ '^[0-9a-f]{64}$'),
  runner_contract_version integer NOT NULL CHECK (runner_contract_version = 1),
  applied_at timestamp with time zone NOT NULL DEFAULT statement_timestamp(),
  CONSTRAINT migration_history_namespace_sequence_key UNIQUE (namespace, sequence)
);

REVOKE ALL ON TABLE platform_core.migration_history FROM PUBLIC;
