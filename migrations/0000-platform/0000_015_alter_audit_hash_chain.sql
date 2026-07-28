-- bop-rms-migration: 1
-- owner: shared-infrastructure/audit
-- schema: platform_audit
-- phase: expand
-- risk: high
-- transaction: required
-- lock-timeout-ms: 5000
-- statement-timeout-ms: 60000
-- recovery: forward-fix
-- Activation requires an empty audit_record table. The required columns below intentionally have
-- no default, so PostgreSQL rejects this ALTER instead of fabricating hashes for any existing row.

ALTER TABLE platform_audit.audit_record
  ALTER COLUMN recorded_at DROP DEFAULT,
  ADD COLUMN chain_version text NOT NULL,
  ADD COLUMN chain_sequence bigint NOT NULL,
  ADD COLUMN previous_record_hash bytea,
  ADD COLUMN record_hash bytea NOT NULL,
  ADD CONSTRAINT audit_record_chain_version_check
    CHECK (chain_version = 'AUDIT_CHAIN_V1'),
  ADD CONSTRAINT audit_record_chain_sequence_check
    CHECK (chain_sequence > 0),
  ADD CONSTRAINT audit_record_previous_hash_length_check
    CHECK (previous_record_hash IS NULL OR octet_length(previous_record_hash) = 32),
  ADD CONSTRAINT audit_record_hash_length_check
    CHECK (octet_length(record_hash) = 32),
  ADD CONSTRAINT audit_record_chain_genesis_check
    CHECK (
      (chain_sequence = 1 AND previous_record_hash IS NULL)
      OR (chain_sequence > 1 AND previous_record_hash IS NOT NULL)
    ),
  ADD CONSTRAINT audit_record_chain_sequence_unique
    UNIQUE (brand_id, scope_store_key, chain_sequence);

CREATE INDEX audit_record_chain_recorded_idx
  ON platform_audit.audit_record (
    brand_id,
    scope_store_key,
    recorded_at,
    chain_sequence
  );

CREATE TABLE platform_audit.audit_chain_head (
  brand_id platform_helpers.uuid_v7 NOT NULL,
  store_id platform_helpers.uuid_v7,
  scope_store_key text GENERATED ALWAYS AS (COALESCE(store_id::text, 'brand')) STORED,
  next_sequence bigint NOT NULL,
  last_record_hash bytea,
  CONSTRAINT audit_chain_head_primary_key PRIMARY KEY (brand_id, scope_store_key),
  CONSTRAINT audit_chain_head_next_sequence_check CHECK (next_sequence > 0),
  CONSTRAINT audit_chain_head_hash_length_check
    CHECK (last_record_hash IS NULL OR octet_length(last_record_hash) = 32),
  CONSTRAINT audit_chain_head_shape_check
    CHECK (
      (next_sequence = 1 AND last_record_hash IS NULL)
      OR (next_sequence > 1 AND last_record_hash IS NOT NULL)
    )
);

ALTER TABLE platform_audit.audit_chain_head ENABLE ROW LEVEL SECURITY;
ALTER TABLE platform_audit.audit_chain_head FORCE ROW LEVEL SECURITY;
CREATE POLICY audit_chain_head_tenant_scope ON platform_audit.audit_chain_head
  USING (
    brand_id = platform_helpers.current_brand_id()
    AND ((store_id IS NULL AND platform_helpers.current_store_id() IS NULL)
      OR store_id = platform_helpers.current_store_id())
  )
  WITH CHECK (
    brand_id = platform_helpers.current_brand_id()
    AND ((store_id IS NULL AND platform_helpers.current_store_id() IS NULL)
      OR store_id = platform_helpers.current_store_id())
  );
REVOKE ALL ON TABLE platform_audit.audit_chain_head FROM PUBLIC;
