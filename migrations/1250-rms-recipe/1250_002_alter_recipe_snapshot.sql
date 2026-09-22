-- bop-rms-migration: 1
-- owner: @rms/recipe
-- schema: rms_recipe
-- phase: expand
-- risk: medium
-- transaction: required
-- lock-timeout-ms: 5000
-- statement-timeout-ms: 60000
-- recovery: forward-fix
-- Legacy records have no complete serialized recovery evidence.
ALTER TABLE rms_recipe.recipe_version ADD COLUMN snapshot_json jsonb;
ALTER TABLE rms_recipe.recipe_version ADD CONSTRAINT recipe_snapshot_binding CHECK (
 snapshot_json IS NULL OR (
  jsonb_typeof(snapshot_json)='object'
  AND snapshot_json->>'recipeReference'=recipe_id::text
  AND snapshot_json->>'versionReference'=recipe_version_id::text
  AND snapshot_json->>'brandReference'=brand_id::text
  AND snapshot_json->>'versionNumber'=version_number::text
  AND snapshot_json->>'snapshotDigest'=snapshot_digest
  AND snapshot_json->>'lifecycle'=lifecycle
  AND snapshot_json->>'displayNameCode'=display_name_code
  AND (snapshot_json->>'yieldQuantityMicrounits')::numeric=yield_quantity_microunits
  AND snapshot_json->>'yieldUnitCode'=yield_unit_code
  AND snapshot_json->>'yieldDimension'=yield_dimension
  AND snapshot_json->>'preparationVersionReference'=preparation_version_id::text
  AND (snapshot_json->>'substitutionPolicyReference') IS NOT DISTINCT FROM substitution_policy_id::text
  AND (snapshot_json->>'invalidationReasonCode') IS NOT DISTINCT FROM invalidation_reason_code
  AND snapshot_json->>'createdAt'=to_char(created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
  AND snapshot_json->'effectivePeriod'->>'timeZone'=effective_time_zone
  AND (snapshot_json->'effectivePeriod'->'effectiveFrom'->>'instant')::timestamptz=effective_from
  AND (snapshot_json->'effectivePeriod'->'effectiveUntil'->>'instant')::timestamptz IS NOT DISTINCT FROM effective_until
  AND jsonb_typeof(snapshot_json->'ingredients')='array'
  AND jsonb_typeof(snapshot_json->'steps')='array'
 ) IS TRUE
);
ALTER TABLE rms_recipe.recipe_operation_record ADD COLUMN record_json jsonb;
ALTER TABLE rms_recipe.recipe_operation_record ADD CONSTRAINT recipe_operation_snapshot_binding CHECK (
 record_json IS NULL OR (
  jsonb_typeof(record_json)='object'
  AND record_json->>'operationReference'=operation_id::text
  AND record_json->>'operationIntentHash'=intent_digest
  AND record_json->>'action'=action_code
  AND record_json->'aggregate'->>'recipeReference'=recipe_id::text
  AND record_json->'aggregate'->>'brandReference'=brand_id::text
  AND record_json->'aggregate'->>'versionReference'=result_version_id::text
  AND record_json->'aggregate'->>'aggregateVersion'=result_aggregate_version::text
  AND record_json->'event'->>'recipeReference'=recipe_id::text
  AND record_json->'event'->>'brandReference'=brand_id::text
  AND record_json->'event'->>'versionReference'=result_version_id::text
  AND record_json->'event'->>'aggregateVersion'=result_aggregate_version::text
  AND record_json->'event'->>'occurredAt'=to_char(occurred_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
 ) IS TRUE
);
