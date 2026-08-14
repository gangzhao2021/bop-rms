-- bop-rms-migration: 1
-- owner: @rms/kitchen
-- schema: rms_kitchen
-- phase: expand
-- risk: medium
-- transaction: required
-- lock-timeout-ms: 5000
-- statement-timeout-ms: 60000
-- recovery: forward-fix
CREATE TABLE rms_kitchen.production_batch (
  production_batch_id platform_helpers.uuid_v7 PRIMARY KEY,
  tenant_id platform_helpers.uuid_v7 NOT NULL,
  brand_id platform_helpers.uuid_v7 NOT NULL,
  store_id platform_helpers.uuid_v7 NOT NULL,
  recipe_id platform_helpers.uuid_v7 NOT NULL,
  recipe_version_id platform_helpers.uuid_v7 NOT NULL,
  station_id platform_helpers.uuid_v7 NOT NULL,
  planned_yield_microunits numeric NOT NULL CHECK (planned_yield_microunits>0 AND planned_yield_microunits=trunc(planned_yield_microunits)),
  planned_by_actor_id platform_helpers.uuid_v7 NOT NULL,
  planned_at timestamp with time zone NOT NULL,
  CONSTRAINT production_batch_scope_identity_unique UNIQUE(production_batch_id,brand_id,store_id)
);
CREATE TABLE rms_kitchen.production_batch_ingredient_plan (
  production_ingredient_id platform_helpers.uuid_v7 PRIMARY KEY,
  production_batch_id platform_helpers.uuid_v7 NOT NULL,
  brand_id platform_helpers.uuid_v7 NOT NULL,
  store_id platform_helpers.uuid_v7 NOT NULL,
  inventory_item_id platform_helpers.uuid_v7 NOT NULL,
  lot_id platform_helpers.uuid_v7,
  planned_quantity_microunits numeric NOT NULL CONSTRAINT production_ingredient_quantity_exact CHECK (planned_quantity_microunits>0 AND planned_quantity_microunits=trunc(planned_quantity_microunits)),
  CONSTRAINT production_ingredient_batch_fk FOREIGN KEY(production_batch_id,brand_id,store_id)
    REFERENCES rms_kitchen.production_batch(production_batch_id,brand_id,store_id),
  CONSTRAINT production_ingredient_scope_identity_unique UNIQUE(production_ingredient_id,production_batch_id,brand_id,store_id),
  CONSTRAINT production_ingredient_source_unique UNIQUE NULLS NOT DISTINCT(production_batch_id,inventory_item_id,lot_id)
);
CREATE TABLE rms_kitchen.production_batch_state_record (
  production_state_id platform_helpers.uuid_v7 PRIMARY KEY,
  production_batch_id platform_helpers.uuid_v7 NOT NULL,
  brand_id platform_helpers.uuid_v7 NOT NULL,
  store_id platform_helpers.uuid_v7 NOT NULL,
  aggregate_version integer NOT NULL CHECK (aggregate_version>0),
  status text NOT NULL CHECK (status IN ('Planned','InProgress','Completed','Quarantined')),
  actual_yield_microunits numeric CHECK (actual_yield_microunits>0 AND actual_yield_microunits=trunc(actual_yield_microunits)),
  variance_basis_points integer CHECK (variance_basis_points>=0),
  consumption_snapshot_json jsonb CHECK (consumption_snapshot_json IS NULL OR jsonb_typeof(consumption_snapshot_json)='array'),
  quality_hold boolean NOT NULL,
  quality_exception_reason_code text,
  observed_by_actor_id platform_helpers.uuid_v7 NOT NULL,
  observed_at timestamp with time zone NOT NULL,
  CONSTRAINT production_state_batch_fk FOREIGN KEY(production_batch_id,brand_id,store_id)
    REFERENCES rms_kitchen.production_batch(production_batch_id,brand_id,store_id),
  CONSTRAINT production_state_scope_identity_unique UNIQUE(production_state_id,production_batch_id,brand_id,store_id),
  CONSTRAINT production_state_version_unique UNIQUE(production_batch_id,aggregate_version),
  CONSTRAINT production_state_observation_check CHECK ((actual_yield_microunits IS NULL)=(variance_basis_points IS NULL) AND (actual_yield_microunits IS NULL)=(consumption_snapshot_json IS NULL)),
  CONSTRAINT production_state_hold_check CHECK (quality_hold=(quality_exception_reason_code IS NOT NULL)),
  CONSTRAINT production_state_complete_check CHECK (status<>'Completed' OR (actual_yield_microunits IS NOT NULL AND NOT quality_hold))
);
CREATE TABLE rms_kitchen.production_batch_quality_exception (
  quality_exception_id platform_helpers.uuid_v7 PRIMARY KEY,
  production_batch_id platform_helpers.uuid_v7 NOT NULL,
  brand_id platform_helpers.uuid_v7 NOT NULL,
  store_id platform_helpers.uuid_v7 NOT NULL,
  production_state_id platform_helpers.uuid_v7 NOT NULL,
  reason_code text NOT NULL CHECK (reason_code ~ '^[A-Z][A-Z0-9_-]{0,63}$'),
  containment_code text NOT NULL CHECK (containment_code ~ '^[A-Z][A-Z0-9_-]{0,63}$'),
  recorded_by_actor_id platform_helpers.uuid_v7 NOT NULL,
  recorded_at timestamp with time zone NOT NULL,
  CONSTRAINT production_exception_state_fk FOREIGN KEY(production_state_id,production_batch_id,brand_id,store_id)
    REFERENCES rms_kitchen.production_batch_state_record(production_state_id,production_batch_id,brand_id,store_id)
);
CREATE TABLE rms_kitchen.production_batch_operation_record (
  operation_id platform_helpers.uuid_v7 PRIMARY KEY,
  production_batch_id platform_helpers.uuid_v7 NOT NULL,
  brand_id platform_helpers.uuid_v7 NOT NULL,
  store_id platform_helpers.uuid_v7 NOT NULL,
  action_code text NOT NULL CHECK (action_code IN ('CreatePlan','Start','RecordObservation','Complete','Quarantine')),
  intent_digest text NOT NULL CHECK (intent_digest ~ '^sha256:[0-9a-f]{64}$'),
  result_aggregate_version integer NOT NULL CHECK(result_aggregate_version>0),
  result_state_id platform_helpers.uuid_v7 NOT NULL,
  outbox_event_id platform_helpers.uuid_v7 NOT NULL UNIQUE,
  occurred_at timestamp with time zone NOT NULL,
  CONSTRAINT production_operation_state_fk FOREIGN KEY(result_state_id,production_batch_id,brand_id,store_id)
    REFERENCES rms_kitchen.production_batch_state_record(production_state_id,production_batch_id,brand_id,store_id)
);
CREATE TABLE rms_kitchen.production_batch_projection_generation (
  generation_id platform_helpers.uuid_v7 PRIMARY KEY,
  brand_id platform_helpers.uuid_v7 NOT NULL,
  store_id platform_helpers.uuid_v7 NOT NULL,
  projection_version integer NOT NULL CHECK(projection_version>0),
  source_event_sequence bigint NOT NULL CHECK(source_event_sequence>=0),
  built_at timestamp with time zone NOT NULL,
  CONSTRAINT production_generation_scope_unique UNIQUE(generation_id,brand_id,store_id)
);
CREATE TABLE rms_kitchen.production_batch_projection (
  generation_id platform_helpers.uuid_v7 NOT NULL,
  brand_id platform_helpers.uuid_v7 NOT NULL,
  store_id platform_helpers.uuid_v7 NOT NULL,
  production_batch_id platform_helpers.uuid_v7 NOT NULL,
  recipe_id platform_helpers.uuid_v7 NOT NULL,
  recipe_version_id platform_helpers.uuid_v7 NOT NULL,
  station_id platform_helpers.uuid_v7 NOT NULL,
  status text NOT NULL,
  planned_yield_microunits numeric NOT NULL,
  actual_yield_microunits numeric,
  variance_basis_points integer,
  quality_hold boolean NOT NULL,
  aggregate_version integer NOT NULL CHECK(aggregate_version>0),
  projected_at timestamp with time zone NOT NULL,
  PRIMARY KEY(generation_id,production_batch_id),
  CONSTRAINT production_projection_generation_fk FOREIGN KEY(generation_id,brand_id,store_id)
    REFERENCES rms_kitchen.production_batch_projection_generation(generation_id,brand_id,store_id)
);
CREATE TABLE rms_kitchen.production_batch_projection_checkpoint (
  brand_id platform_helpers.uuid_v7 NOT NULL,
  store_id platform_helpers.uuid_v7 NOT NULL,
  active_generation_id platform_helpers.uuid_v7 NOT NULL,
  projection_version integer NOT NULL CHECK(projection_version>0),
  source_event_sequence bigint NOT NULL CHECK(source_event_sequence>=0),
  updated_at timestamp with time zone NOT NULL,
  PRIMARY KEY(brand_id,store_id),
  CONSTRAINT production_checkpoint_generation_fk FOREIGN KEY(active_generation_id,brand_id,store_id)
    REFERENCES rms_kitchen.production_batch_projection_generation(generation_id,brand_id,store_id)
);

CREATE RULE production_batch_no_update AS ON UPDATE TO rms_kitchen.production_batch DO INSTEAD NOTHING;
CREATE RULE production_batch_no_delete AS ON DELETE TO rms_kitchen.production_batch DO INSTEAD NOTHING;
CREATE RULE production_ingredient_no_update AS ON UPDATE TO rms_kitchen.production_batch_ingredient_plan DO INSTEAD NOTHING;
CREATE RULE production_ingredient_no_delete AS ON DELETE TO rms_kitchen.production_batch_ingredient_plan DO INSTEAD NOTHING;
CREATE RULE production_state_no_update AS ON UPDATE TO rms_kitchen.production_batch_state_record DO INSTEAD NOTHING;
CREATE RULE production_state_no_delete AS ON DELETE TO rms_kitchen.production_batch_state_record DO INSTEAD NOTHING;
CREATE RULE production_exception_no_update AS ON UPDATE TO rms_kitchen.production_batch_quality_exception DO INSTEAD NOTHING;
CREATE RULE production_exception_no_delete AS ON DELETE TO rms_kitchen.production_batch_quality_exception DO INSTEAD NOTHING;
CREATE RULE production_operation_no_update AS ON UPDATE TO rms_kitchen.production_batch_operation_record DO INSTEAD NOTHING;
CREATE RULE production_operation_no_delete AS ON DELETE TO rms_kitchen.production_batch_operation_record DO INSTEAD NOTHING;
CREATE RULE production_generation_no_update AS ON UPDATE TO rms_kitchen.production_batch_projection_generation DO INSTEAD NOTHING;
CREATE RULE production_generation_no_delete AS ON DELETE TO rms_kitchen.production_batch_projection_generation DO INSTEAD NOTHING;
CREATE RULE production_projection_no_delete AS ON DELETE TO rms_kitchen.production_batch_projection DO INSTEAD NOTHING;

CREATE INDEX production_batch_store_idx ON rms_kitchen.production_batch(brand_id,store_id,planned_at DESC);
CREATE INDEX production_state_status_idx ON rms_kitchen.production_batch_state_record(brand_id,store_id,status,observed_at DESC);

ALTER TABLE rms_kitchen.production_batch ENABLE ROW LEVEL SECURITY; ALTER TABLE rms_kitchen.production_batch FORCE ROW LEVEL SECURITY;
ALTER TABLE rms_kitchen.production_batch_ingredient_plan ENABLE ROW LEVEL SECURITY; ALTER TABLE rms_kitchen.production_batch_ingredient_plan FORCE ROW LEVEL SECURITY;
ALTER TABLE rms_kitchen.production_batch_state_record ENABLE ROW LEVEL SECURITY; ALTER TABLE rms_kitchen.production_batch_state_record FORCE ROW LEVEL SECURITY;
ALTER TABLE rms_kitchen.production_batch_quality_exception ENABLE ROW LEVEL SECURITY; ALTER TABLE rms_kitchen.production_batch_quality_exception FORCE ROW LEVEL SECURITY;
ALTER TABLE rms_kitchen.production_batch_operation_record ENABLE ROW LEVEL SECURITY; ALTER TABLE rms_kitchen.production_batch_operation_record FORCE ROW LEVEL SECURITY;
ALTER TABLE rms_kitchen.production_batch_projection_generation ENABLE ROW LEVEL SECURITY; ALTER TABLE rms_kitchen.production_batch_projection_generation FORCE ROW LEVEL SECURITY;
ALTER TABLE rms_kitchen.production_batch_projection ENABLE ROW LEVEL SECURITY; ALTER TABLE rms_kitchen.production_batch_projection FORCE ROW LEVEL SECURITY;
ALTER TABLE rms_kitchen.production_batch_projection_checkpoint ENABLE ROW LEVEL SECURITY; ALTER TABLE rms_kitchen.production_batch_projection_checkpoint FORCE ROW LEVEL SECURITY;

CREATE POLICY production_batch_store_policy ON rms_kitchen.production_batch USING(brand_id=platform_helpers.current_brand_id() AND store_id=platform_helpers.current_store_id()) WITH CHECK(brand_id=platform_helpers.current_brand_id() AND store_id=platform_helpers.current_store_id());
CREATE POLICY production_ingredient_store_policy ON rms_kitchen.production_batch_ingredient_plan USING(brand_id=platform_helpers.current_brand_id() AND store_id=platform_helpers.current_store_id()) WITH CHECK(brand_id=platform_helpers.current_brand_id() AND store_id=platform_helpers.current_store_id());
CREATE POLICY production_state_store_policy ON rms_kitchen.production_batch_state_record USING(brand_id=platform_helpers.current_brand_id() AND store_id=platform_helpers.current_store_id()) WITH CHECK(brand_id=platform_helpers.current_brand_id() AND store_id=platform_helpers.current_store_id());
CREATE POLICY production_exception_store_policy ON rms_kitchen.production_batch_quality_exception USING(brand_id=platform_helpers.current_brand_id() AND store_id=platform_helpers.current_store_id()) WITH CHECK(brand_id=platform_helpers.current_brand_id() AND store_id=platform_helpers.current_store_id());
CREATE POLICY production_operation_store_policy ON rms_kitchen.production_batch_operation_record USING(brand_id=platform_helpers.current_brand_id() AND store_id=platform_helpers.current_store_id()) WITH CHECK(brand_id=platform_helpers.current_brand_id() AND store_id=platform_helpers.current_store_id());
CREATE POLICY production_generation_store_policy ON rms_kitchen.production_batch_projection_generation USING(brand_id=platform_helpers.current_brand_id() AND store_id=platform_helpers.current_store_id()) WITH CHECK(brand_id=platform_helpers.current_brand_id() AND store_id=platform_helpers.current_store_id());
CREATE POLICY production_projection_store_policy ON rms_kitchen.production_batch_projection USING(brand_id=platform_helpers.current_brand_id() AND store_id=platform_helpers.current_store_id()) WITH CHECK(brand_id=platform_helpers.current_brand_id() AND store_id=platform_helpers.current_store_id());
CREATE POLICY production_checkpoint_store_policy ON rms_kitchen.production_batch_projection_checkpoint USING(brand_id=platform_helpers.current_brand_id() AND store_id=platform_helpers.current_store_id()) WITH CHECK(brand_id=platform_helpers.current_brand_id() AND store_id=platform_helpers.current_store_id());

REVOKE ALL ON TABLE rms_kitchen.production_batch FROM PUBLIC;
REVOKE ALL ON TABLE rms_kitchen.production_batch_ingredient_plan FROM PUBLIC;
REVOKE ALL ON TABLE rms_kitchen.production_batch_state_record FROM PUBLIC;
REVOKE ALL ON TABLE rms_kitchen.production_batch_quality_exception FROM PUBLIC;
REVOKE ALL ON TABLE rms_kitchen.production_batch_operation_record FROM PUBLIC;
REVOKE ALL ON TABLE rms_kitchen.production_batch_projection_generation FROM PUBLIC;
REVOKE ALL ON TABLE rms_kitchen.production_batch_projection FROM PUBLIC;
REVOKE ALL ON TABLE rms_kitchen.production_batch_projection_checkpoint FROM PUBLIC;
