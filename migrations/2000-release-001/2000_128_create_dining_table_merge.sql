-- bop-rms-migration: 1
-- owner: @rms/dining
-- schema: rms_dining
-- phase: expand
-- risk: medium
-- transaction: required
-- lock-timeout-ms: 5000
-- statement-timeout-ms: 60000
-- recovery: forward-fix
-- WP-2423 item 8 ⑨ (Owner decision 3, coordinator 2026-10-30; DEC-DINING-TABLE-MERGE): staff merge
-- the party at one table (the source) into the party seated at another (the target). One record
-- per merge, append-only: the operation, who and when, both sessions and tables with the versions
-- staff saw, and the party sizes before and after. The source session ends here (Closed) and its
-- table is released; a session is merged once. Its order joins the target's bill (Ordering and
-- Payment record their own side in the same transaction).
-- Grants: api SELECT/INSERT (Owner standing approval 2026-10-14, WP-2423).
CREATE TABLE rms_dining.dining_session_merge_operation (
  operation_id platform_helpers.uuid_v7 NOT NULL,
  tenant_id platform_helpers.uuid_v7 NOT NULL,
  brand_id platform_helpers.uuid_v7 NOT NULL,
  store_id platform_helpers.uuid_v7 NOT NULL,
  source_session_id platform_helpers.uuid_v7 NOT NULL,
  target_session_id platform_helpers.uuid_v7 NOT NULL CHECK (target_session_id<>source_session_id),
  source_table_id platform_helpers.uuid_v7 NOT NULL,
  target_table_id platform_helpers.uuid_v7 NOT NULL CHECK (target_table_id<>source_table_id),
  expected_source_session_version integer NOT NULL CHECK (expected_source_session_version >= 1),
  expected_target_session_version integer NOT NULL CHECK (expected_target_session_version >= 1),
  expected_source_table_version integer NOT NULL CHECK (expected_source_table_version >= 1),
  expected_target_table_version integer NOT NULL CHECK (expected_target_table_version >= 1),
  source_party_size integer NOT NULL CHECK (source_party_size BETWEEN 1 AND 99),
  target_party_size integer NOT NULL CHECK (target_party_size BETWEEN 1 AND 99),
  merged_party_size integer NOT NULL CHECK (merged_party_size BETWEEN 2 AND 99),
  intent_digest text NOT NULL CHECK (intent_digest ~ '^sha256:[0-9a-f]{64}$'),
  actor_id platform_helpers.uuid_v7 NOT NULL,
  occurred_at timestamptz NOT NULL CHECK (isfinite(occurred_at) AND occurred_at=date_trunc('milliseconds',occurred_at)),
  record_json jsonb NOT NULL,
  CONSTRAINT dining_session_merge_operation_pk PRIMARY KEY (brand_id,store_id,operation_id),
  -- A session is merged away once.
  CONSTRAINT dining_session_merge_operation_source UNIQUE (brand_id,store_id,source_session_id),
  CONSTRAINT dining_session_merge_operation_party CHECK (merged_party_size = source_party_size + target_party_size),
  CONSTRAINT dining_session_merge_operation_source_fk FOREIGN KEY (tenant_id,brand_id,store_id,source_session_id)
    REFERENCES rms_dining.dining_session(tenant_id,brand_id,store_id,session_id),
  CONSTRAINT dining_session_merge_operation_target_fk FOREIGN KEY (tenant_id,brand_id,store_id,target_session_id)
    REFERENCES rms_dining.dining_session(tenant_id,brand_id,store_id,session_id),
  CONSTRAINT dining_session_merge_operation_source_table_fk FOREIGN KEY (tenant_id,brand_id,store_id,source_table_id)
    REFERENCES rms_dining.dining_table(tenant_id,brand_id,store_id,table_id),
  CONSTRAINT dining_session_merge_operation_target_table_fk FOREIGN KEY (tenant_id,brand_id,store_id,target_table_id)
    REFERENCES rms_dining.dining_table(tenant_id,brand_id,store_id,table_id),
  CONSTRAINT dining_session_merge_operation_shape CHECK ((
    jsonb_typeof(record_json)='object' AND octet_length(record_json::text)<=262144
    AND record_json ?& ARRAY['sourceSession','targetSession','sourceTable','audit']
    AND record_json - ARRAY['sourceSession','targetSession','sourceTable','audit']='{}'::jsonb
    AND record_json->'sourceSession'->>'diningSessionReference'=source_session_id::text
    AND record_json->'sourceSession'->>'phase'='Closed'
    AND (record_json->'sourceSession'->>'version')::numeric=expected_source_session_version+1
    AND record_json->'targetSession'->>'diningSessionReference'=target_session_id::text
    AND record_json->'targetSession'->>'phase'='Active'
    AND record_json->'targetSession'->>'tableReference'=target_table_id::text
    AND (record_json->'targetSession'->>'version')::numeric=expected_target_session_version+1
    AND record_json->'sourceTable'->>'tableReference'=source_table_id::text
    AND record_json->'sourceTable'->'activeDiningSessionReference'='null'::jsonb
    AND (record_json->'sourceTable'->>'aggregateVersion')::numeric=expected_source_table_version+1
    AND record_json->'audit'->>'actionCode'='DINING_SESSION_MERGE_TABLE'
    AND record_json->'audit'->>'targetId'=source_session_id::text
    AND record_json->'audit'->>'correlationId'=operation_id::text
    AND record_json->'audit'->'actor'->>'type'='User'
    AND record_json->'audit'->'actor'->>'reference'=actor_id::text
  ) IS TRUE)
);
CREATE INDEX dining_session_merge_operation_target_idx
  ON rms_dining.dining_session_merge_operation (brand_id,store_id,target_session_id);
CREATE RULE dining_session_merge_operation_no_update AS ON UPDATE TO rms_dining.dining_session_merge_operation DO INSTEAD NOTHING;
CREATE RULE dining_session_merge_operation_no_delete AS ON DELETE TO rms_dining.dining_session_merge_operation DO INSTEAD NOTHING;
ALTER TABLE rms_dining.dining_session_merge_operation ENABLE ROW LEVEL SECURITY;
ALTER TABLE rms_dining.dining_session_merge_operation FORCE ROW LEVEL SECURITY;
CREATE POLICY dining_session_merge_operation_scope_policy ON rms_dining.dining_session_merge_operation
  USING (brand_id=platform_helpers.current_brand_id() AND store_id=platform_helpers.current_store_id())
  WITH CHECK (brand_id=platform_helpers.current_brand_id() AND store_id=platform_helpers.current_store_id());
REVOKE ALL ON TABLE rms_dining.dining_session_merge_operation FROM PUBLIC;
