-- bop-rms-migration: 1
-- owner: @rms/kitchen
-- schema: rms_kitchen
-- phase: expand
-- risk: medium
-- transaction: required
-- lock-timeout-ms: 5000
-- statement-timeout-ms: 60000
-- recovery: forward-fix
CREATE TABLE rms_kitchen.kitchen_routing_configuration (
  brand_id platform_helpers.uuid_v7 NOT NULL,
  store_id platform_helpers.uuid_v7 NOT NULL,
  version_id platform_helpers.uuid_v7 NOT NULL,
  version_number integer NOT NULL CHECK (version_number>0),
  operation_id platform_helpers.uuid_v7 NOT NULL,
  actor_id platform_helpers.uuid_v7 NOT NULL,
  audit_id platform_helpers.uuid_v7 NOT NULL,
  effective_from timestamptz NOT NULL,
  recorded_at timestamptz NOT NULL,
  record_json jsonb NOT NULL,
  PRIMARY KEY (brand_id,store_id,version_id),
  UNIQUE (brand_id,store_id,version_number),
  UNIQUE (brand_id,store_id,operation_id),
  UNIQUE (brand_id,store_id,effective_from),
  UNIQUE (brand_id,store_id,audit_id),
  CHECK (isfinite(effective_from) AND effective_from=date_trunc('milliseconds',effective_from)
    AND isfinite(recorded_at) AND recorded_at=date_trunc('milliseconds',recorded_at)
    AND effective_from>=recorded_at),
  CHECK ((
    jsonb_typeof(record_json)='object'
    AND record_json->>'operationReference'=operation_id::text
    AND record_json->>'actorReference'=actor_id::text
    AND (record_json->>'expectedVersion')::integer=version_number-1
    AND (record_json->>'recordedAt')::timestamptz=recorded_at
    AND record_json #>> '{configuration,brandReference}'=brand_id::text
    AND record_json #>> '{configuration,storeReference}'=store_id::text
    AND record_json #>> '{configuration,evidenceReference}'=version_id::text
    AND (record_json #>> '{configuration,evidenceVersion}')::integer=version_number
    AND (record_json #>> '{configuration,effectiveAt}')::timestamptz=effective_from
    AND jsonb_typeof(record_json #> '{configuration,candidates}')='array'
    AND jsonb_array_length(record_json #> '{configuration,candidates}')<=1
  ) IS TRUE)
);
CREATE RULE kitchen_routing_configuration_no_update AS
  ON UPDATE TO rms_kitchen.kitchen_routing_configuration DO INSTEAD NOTHING;
CREATE RULE kitchen_routing_configuration_no_delete AS
  ON DELETE TO rms_kitchen.kitchen_routing_configuration DO INSTEAD NOTHING;
ALTER TABLE rms_kitchen.kitchen_routing_configuration ENABLE ROW LEVEL SECURITY;
ALTER TABLE rms_kitchen.kitchen_routing_configuration FORCE ROW LEVEL SECURITY;
CREATE POLICY kitchen_routing_configuration_scope ON rms_kitchen.kitchen_routing_configuration
  USING (brand_id=platform_helpers.current_brand_id() AND store_id=platform_helpers.current_store_id())
  WITH CHECK (brand_id=platform_helpers.current_brand_id() AND store_id=platform_helpers.current_store_id());
REVOKE ALL ON TABLE rms_kitchen.kitchen_routing_configuration FROM PUBLIC;
