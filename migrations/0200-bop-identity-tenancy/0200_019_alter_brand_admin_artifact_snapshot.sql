-- bop-rms-migration: 1
-- owner: @bop/tenant
-- schema: bop_tenant
-- phase: expand
-- risk: medium
-- transaction: required
-- lock-timeout-ms: 5000
-- statement-timeout-ms: 60000
-- recovery: forward-fix
-- Original operation results must survive subsequent mutable Brand revisions.
-- NULL preserves historical rows without fabricating unavailable result evidence.
ALTER TABLE bop_tenant.brand_admin_operation
  ADD COLUMN artifact_snapshot_json jsonb,
  ADD CONSTRAINT brand_admin_artifact_snapshot_brand CHECK (
    artifact_snapshot_json IS NULL OR (
      jsonb_typeof(artifact_snapshot_json) = 'object'
      AND artifact_snapshot_json ? 'brandReference'
      AND artifact_snapshot_json ->> 'brandReference' IS NOT NULL
      AND artifact_snapshot_json ->> 'brandReference' = brand_id::text
    )
  );
