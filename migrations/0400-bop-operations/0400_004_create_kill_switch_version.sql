-- bop-rms-migration: 1
-- owner: @bop/feature-control
-- schema: bop_feature_control
-- phase: expand
-- risk: medium
-- transaction: required
-- lock-timeout-ms: 5000
-- statement-timeout-ms: 60000
-- recovery: forward-fix
CREATE TABLE bop_feature_control.kill_switch_version (
  brand_id platform_helpers.uuid_v7 NOT NULL,
  store_id platform_helpers.uuid_v7,
  control_id platform_helpers.uuid_v7 NOT NULL,
  control_key text NOT NULL CHECK (control_key ~ '^[a-z][a-z0-9]*(\.[a-z][a-z0-9]*){2,7}$'),
  control_version bigint NOT NULL CHECK (control_version BETWEEN 1 AND 9007199254740991),
  definition_json jsonb NOT NULL CHECK (jsonb_typeof(definition_json) = 'object'),
  recorded_at timestamp with time zone NOT NULL,
  audit_reference platform_helpers.uuid_v7 NOT NULL,
  PRIMARY KEY (brand_id, control_id, control_version),
  CONSTRAINT kill_switch_definition_identity CHECK (
    (definition_json->>'kind' = 'KillSwitch'
    AND definition_json->>'controlId' = control_id::text
    AND definition_json->>'key' = control_key
    AND definition_json->>'version' = control_version::text
    AND definition_json->'scope'->>'brandReference' = brand_id::text
    AND definition_json->'scope'->>'kind' = CASE WHEN store_id IS NULL THEN 'Brand' ELSE 'Store' END
    AND (definition_json->'scope'->>'storeReference') IS NOT DISTINCT FROM store_id::text) IS TRUE
  ),
  CONSTRAINT kill_switch_recorded_precision CHECK (date_trunc('milliseconds', recorded_at) = recorded_at)
);
CREATE UNIQUE INDEX kill_switch_scope_key_version_unique
ON bop_feature_control.kill_switch_version
(brand_id, COALESCE(store_id,'00000000-0000-0000-0000-000000000000'::uuid),control_key,control_version);

CREATE FUNCTION bop_feature_control.enforce_kill_switch_version() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
DECLARE previous bop_feature_control.kill_switch_version%ROWTYPE;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended(NEW.brand_id::text || ':' || NEW.control_id::text,0));
  SELECT * INTO previous FROM bop_feature_control.kill_switch_version
    WHERE brand_id=NEW.brand_id AND control_id=NEW.control_id ORDER BY control_version DESC LIMIT 1;
  IF FOUND THEN
    IF NEW.control_version<>previous.control_version+1
      OR NEW.store_id IS DISTINCT FROM previous.store_id OR NEW.control_key<>previous.control_key
      OR NEW.recorded_at<previous.recorded_at THEN
      RAISE EXCEPTION 'invalid Kill Switch version sequence' USING ERRCODE='23514';
    END IF;
  ELSIF NEW.control_version<>1 THEN
    RAISE EXCEPTION 'initial Kill Switch version must be one' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION bop_feature_control.enforce_kill_switch_version() FROM PUBLIC;
CREATE TRIGGER kill_switch_version_sequence BEFORE INSERT ON bop_feature_control.kill_switch_version
FOR EACH ROW EXECUTE FUNCTION bop_feature_control.enforce_kill_switch_version();
CREATE TRIGGER kill_switch_version_no_update BEFORE UPDATE ON bop_feature_control.kill_switch_version
FOR EACH ROW EXECUTE FUNCTION bop_feature_control.reject_feature_control_history_update();
CREATE RULE kill_switch_version_no_delete AS ON DELETE TO bop_feature_control.kill_switch_version DO INSTEAD NOTHING;
ALTER TABLE bop_feature_control.kill_switch_version ENABLE ROW LEVEL SECURITY;
ALTER TABLE bop_feature_control.kill_switch_version FORCE ROW LEVEL SECURITY;
CREATE POLICY kill_switch_version_scope ON bop_feature_control.kill_switch_version
USING (brand_id=platform_helpers.current_brand_id() AND (store_id IS NULL OR store_id=platform_helpers.current_store_id()))
WITH CHECK (brand_id=platform_helpers.current_brand_id() AND (store_id IS NULL OR store_id=platform_helpers.current_store_id()));
REVOKE ALL ON TABLE bop_feature_control.kill_switch_version FROM PUBLIC;
