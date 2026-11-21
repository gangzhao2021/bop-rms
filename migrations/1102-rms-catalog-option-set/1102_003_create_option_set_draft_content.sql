-- bop-rms-migration: 1
-- owner: @rms/catalog
-- schema: rms_catalog
-- phase: expand
-- risk: medium
-- transaction: required
-- lock-timeout-ms: 5000
-- statement-timeout-ms: 60000
-- recovery: forward-fix
-- Legacy absence is not complete empty content. Publication remains separately gated.
ALTER TABLE rms_catalog.option_set_version ADD COLUMN editor_content_json jsonb;
ALTER TABLE rms_catalog.option_set_version ADD CONSTRAINT option_set_editor_content_check
CHECK(editor_content_json IS NULL OR (
 jsonb_typeof(editor_content_json)='object'
 AND (editor_content_json->>'profile') IS NOT DISTINCT FROM 'CatalogOptionSetEditorContentV1'
 AND octet_length(editor_content_json::text)<=1048576
));

-- An exact operation tuple, never today's root or an unrelated operation result.
ALTER TABLE rms_catalog.option_set_operation_record
ADD CONSTRAINT option_set_operation_result_tuple_unique
UNIQUE(operation_id,brand_id,option_set_id,action_code,intent_digest,result_aggregate_version,occurred_at);

CREATE TABLE rms_catalog.option_set_draft_content_snapshot (
 operation_id platform_helpers.uuid_v7 PRIMARY KEY,
 tenant_id platform_helpers.uuid_v7 NOT NULL,
 brand_id platform_helpers.uuid_v7 NOT NULL,
 option_set_id platform_helpers.uuid_v7 NOT NULL,
 option_set_version_id platform_helpers.uuid_v7 NOT NULL,
 action_code text NOT NULL CHECK(action_code IN ('Create','ReplaceDraft')),
 intent_digest text NOT NULL CHECK(intent_digest ~ '^sha256:[0-9a-f]{64}$'),
 result_aggregate_version integer NOT NULL CHECK(result_aggregate_version>0),
 occurred_at timestamp with time zone NOT NULL CHECK(date_trunc('milliseconds',occurred_at)=occurred_at),
 source_digest text NOT NULL CHECK(source_digest ~ '^sha256:[0-9a-f]{64}$'),
 content_digest text NOT NULL CHECK(content_digest ~ '^sha256:[0-9a-f]{64}$'),
 configuration_digest text NOT NULL CHECK(configuration_digest ~ '^sha256:[0-9a-f]{64}$'),
 snapshot_json jsonb NOT NULL,
 data_classification text NOT NULL DEFAULT 'ConfigurationMetadata'
  CHECK(data_classification='ConfigurationMetadata'),
 CONSTRAINT option_set_snapshot_operation_fk
  FOREIGN KEY(operation_id,brand_id,option_set_id,action_code,intent_digest,result_aggregate_version,occurred_at)
  REFERENCES rms_catalog.option_set_operation_record
   (operation_id,brand_id,option_set_id,action_code,intent_digest,result_aggregate_version,occurred_at),
 CONSTRAINT option_set_snapshot_version_fk
  FOREIGN KEY(option_set_version_id,option_set_id,brand_id)
  REFERENCES rms_catalog.option_set_version(option_set_version_id,option_set_id,brand_id),
 UNIQUE(brand_id,option_set_id,result_aggregate_version),
 CHECK((jsonb_typeof(snapshot_json)='object'
  AND snapshot_json->>'profile'='CatalogOptionSetEditorContentV1'
  AND jsonb_typeof(snapshot_json->'sourceAggregate')='object'
  AND snapshot_json#>>'{sourceAggregate,brandReference}'=brand_id::text
  AND snapshot_json#>>'{sourceAggregate,optionSetReference}'=option_set_id::text
  AND snapshot_json#>'{sourceAggregate,aggregateVersion}'=to_jsonb(result_aggregate_version)
  AND snapshot_json#>>'{sourceAggregate,lifecycle}'='Draft'
  AND snapshot_json#>>'{sourceAggregate,draft,versionReference}'=option_set_version_id::text
  AND snapshot_json#>>'{sourceAggregate,draft,status}'='Draft'
  AND snapshot_json#>>'{sourceAggregate,updatedAt}'=to_char(occurred_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
  AND octet_length(snapshot_json::text)<=1048576) IS TRUE)
);
CREATE RULE option_set_draft_snapshot_no_update AS
 ON UPDATE TO rms_catalog.option_set_draft_content_snapshot DO INSTEAD NOTHING;
CREATE RULE option_set_draft_snapshot_no_delete AS
 ON DELETE TO rms_catalog.option_set_draft_content_snapshot DO INSTEAD NOTHING;
ALTER TABLE rms_catalog.option_set_draft_content_snapshot ENABLE ROW LEVEL SECURITY;
ALTER TABLE rms_catalog.option_set_draft_content_snapshot FORCE ROW LEVEL SECURITY;
CREATE POLICY option_set_draft_snapshot_scope ON rms_catalog.option_set_draft_content_snapshot
 USING ((tenant_id::text=current_setting('bop.tenant_id',true)
  AND brand_id=platform_helpers.current_brand_id()
  AND platform_helpers.current_store_id() IS NULL) IS TRUE)
 WITH CHECK ((tenant_id::text=current_setting('bop.tenant_id',true)
  AND brand_id=platform_helpers.current_brand_id()
  AND platform_helpers.current_store_id() IS NULL) IS TRUE);
REVOKE ALL ON TABLE rms_catalog.option_set_draft_content_snapshot FROM PUBLIC;
