-- bop-rms-migration: 1
-- owner: @bop/permission
-- schema: bop_permission
-- phase: expand
-- risk: medium
-- transaction: required
-- lock-timeout-ms: 5000
-- statement-timeout-ms: 60000
-- recovery: forward-fix
-- Permission owns the fixed System Allow decision. This migration creates no
-- authorization rows or grants. An audited owning provisioner must supply them.
CREATE TABLE bop_permission.system_media_image_promotion_authorization (
  workload_id platform_helpers.uuid_v7 PRIMARY KEY,
  tenant_id platform_helpers.uuid_v7 NOT NULL,
  brand_id platform_helpers.uuid_v7 NOT NULL,
  store_id platform_helpers.uuid_v7,
  version bigint NOT NULL CHECK (version BETWEEN 1 AND 9007199254740991),
  decision_id platform_helpers.uuid_v7 NOT NULL UNIQUE,
  updated_at timestamptz NOT NULL CHECK (isfinite(updated_at) AND updated_at=date_trunc('milliseconds',updated_at)),
  -- UPDATE privilege on this constant column permits FOR SHARE without granting
  -- UPDATE on authorization fields. Actual no-op updates are rejected below.
  lock_token smallint NOT NULL DEFAULT 0 CHECK (lock_token=0),
  UNIQUE (workload_id,tenant_id,brand_id),
  UNIQUE (workload_id,tenant_id,brand_id,store_id)
);

CREATE TABLE bop_permission.system_media_image_promotion_authorization_decision (
  decision_id platform_helpers.uuid_v7 PRIMARY KEY,
  workload_id platform_helpers.uuid_v7 NOT NULL,
  tenant_id platform_helpers.uuid_v7 NOT NULL,
  brand_id platform_helpers.uuid_v7 NOT NULL,
  store_id platform_helpers.uuid_v7,
  version bigint NOT NULL CHECK (version BETWEEN 1 AND 9007199254740991),
  profile text NOT NULL CHECK (profile='MEDIA_IMAGE_PROMOTION_V1'),
  action_code text NOT NULL CHECK (action_code='media.asset.promote'),
  purpose_code text NOT NULL CHECK (purpose_code='MEDIA_IMAGE_PROMOTION'),
  deployment_config_digest text NOT NULL CHECK (deployment_config_digest ~ '^sha256:[0-9a-f]{64}$'),
  enabled boolean NOT NULL,
  effective_from timestamptz NOT NULL CHECK (isfinite(effective_from) AND effective_from=date_trunc('milliseconds',effective_from)),
  effective_until timestamptz CHECK (effective_until IS NULL OR (isfinite(effective_until) AND effective_until=date_trunc('milliseconds',effective_until) AND effective_until>effective_from)),
  recorded_at timestamptz NOT NULL CHECK (isfinite(recorded_at) AND recorded_at=date_trunc('milliseconds',recorded_at)),
  audit_id platform_helpers.uuid_v7 NOT NULL UNIQUE,
  correlation_id platform_helpers.uuid_v7 NOT NULL,
  snapshot_json jsonb NOT NULL CHECK (jsonb_typeof(snapshot_json)='object' AND octet_length(snapshot_json::text)<=65536),
  digest text NOT NULL CHECK (digest ~ '^sha256:[0-9a-f]{64}$'),
  UNIQUE (workload_id,version),
  UNIQUE (decision_id,workload_id,tenant_id,brand_id,version),
  UNIQUE (decision_id,workload_id,tenant_id,brand_id,store_id,version),
  FOREIGN KEY (workload_id,tenant_id,brand_id)
    REFERENCES bop_permission.system_media_image_promotion_authorization(workload_id,tenant_id,brand_id) DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY (workload_id,tenant_id,brand_id,store_id)
    REFERENCES bop_permission.system_media_image_promotion_authorization(workload_id,tenant_id,brand_id,store_id) DEFERRABLE INITIALLY DEFERRED
);
ALTER TABLE bop_permission.system_media_image_promotion_authorization
  ADD CONSTRAINT system_media_promotion_current_decision_fkey
  FOREIGN KEY (decision_id,workload_id,tenant_id,brand_id,version)
  REFERENCES bop_permission.system_media_image_promotion_authorization_decision(decision_id,workload_id,tenant_id,brand_id,version) DEFERRABLE INITIALLY DEFERRED,
  ADD CONSTRAINT system_media_promotion_current_scope_fkey
  FOREIGN KEY (decision_id,workload_id,tenant_id,brand_id,store_id,version)
  REFERENCES bop_permission.system_media_image_promotion_authorization_decision(decision_id,workload_id,tenant_id,brand_id,store_id,version) DEFERRABLE INITIALLY DEFERRED;

CREATE FUNCTION bop_permission.guard_system_media_promotion_authorization()
RETURNS trigger LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
DECLARE
  current_row bop_permission.system_media_image_promotion_authorization%ROWTYPE;
  expected_snapshot jsonb;
BEGIN
  IF TG_OP IN ('DELETE','TRUNCATE') OR (TG_TABLE_NAME='system_media_image_promotion_authorization_decision' AND TG_OP<>'INSERT') THEN
    RAISE EXCEPTION 'SYSTEM_MEDIA_PROMOTION_AUTHORIZATION_IMMUTABLE' USING ERRCODE='55000';
  END IF;
  IF TG_TABLE_NAME='system_media_image_promotion_authorization' THEN
    IF TG_OP='INSERT' THEN
      IF NEW.version<>1 OR NEW.lock_token<>0 THEN
        RAISE EXCEPTION 'SYSTEM_MEDIA_PROMOTION_AUTHORIZATION_CONFLICT' USING ERRCODE='23514';
      END IF;
    ELSIF TG_OP='UPDATE' THEN
      IF NEW.workload_id<>OLD.workload_id OR NEW.tenant_id<>OLD.tenant_id OR NEW.brand_id<>OLD.brand_id
        OR NEW.store_id IS DISTINCT FROM OLD.store_id OR NEW.version<>OLD.version+1
        OR NEW.decision_id=OLD.decision_id OR NEW.updated_at<OLD.updated_at OR NEW.lock_token<>0 THEN
        RAISE EXCEPTION 'SYSTEM_MEDIA_PROMOTION_AUTHORIZATION_CONFLICT' USING ERRCODE='23514';
      END IF;
    ELSE
      RAISE EXCEPTION 'SYSTEM_MEDIA_PROMOTION_AUTHORIZATION_INVALID' USING ERRCODE='23514';
    END IF;
    RETURN NEW;
  END IF;
  IF TG_TABLE_NAME<>'system_media_image_promotion_authorization_decision' THEN
    RAISE EXCEPTION 'SYSTEM_MEDIA_PROMOTION_AUTHORIZATION_INVALID' USING ERRCODE='23514';
  END IF;
  expected_snapshot:=jsonb_build_object(
    'profile','MEDIA_IMAGE_PROMOTION_V1','decisionReference',NEW.decision_id::text,
    'workloadReference',NEW.workload_id::text,'tenantReference',NEW.tenant_id::text,
    'brandReference',NEW.brand_id::text,'storeReference',NEW.store_id::text,'version',NEW.version,
    'action','media.asset.promote','purposeCode','MEDIA_IMAGE_PROMOTION',
    'requiredFields',jsonb_build_array('sourceVersion','scanAdmission','processingIntent','processingResult','asset','renditions','audit'),
    'deploymentConfigurationDigest',NEW.deployment_config_digest,'enabled',NEW.enabled,
    'effectiveFrom',to_char(NEW.effective_from AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
    'effectiveUntil',CASE WHEN NEW.effective_until IS NULL THEN NULL ELSE to_char(NEW.effective_until AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') END,
    'recordedAt',to_char(NEW.recorded_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
    'auditReference',NEW.audit_id::text,'digest',NEW.digest);
  IF NEW.snapshot_json IS DISTINCT FROM expected_snapshot THEN
    RAISE EXCEPTION 'SYSTEM_MEDIA_PROMOTION_AUTHORIZATION_INVALID' USING ERRCODE='23514';
  END IF;
  -- A provisioner inserts the next immutable decision before advancing its root.
  -- This lock serializes actual updates with a Worker's held FOR SHARE authority.
  SELECT * INTO current_row FROM bop_permission.system_media_image_promotion_authorization
    WHERE workload_id=NEW.workload_id FOR UPDATE;
  IF FOUND THEN
    IF NEW.tenant_id<>current_row.tenant_id OR NEW.brand_id<>current_row.brand_id
      OR NEW.store_id IS DISTINCT FROM current_row.store_id OR NEW.version<>current_row.version+1
      OR NEW.recorded_at<current_row.updated_at THEN
      RAISE EXCEPTION 'SYSTEM_MEDIA_PROMOTION_AUTHORIZATION_CONFLICT' USING ERRCODE='23514';
    END IF;
  ELSIF NEW.version<>1 THEN
    RAISE EXCEPTION 'SYSTEM_MEDIA_PROMOTION_AUTHORIZATION_CONFLICT' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION bop_permission.guard_system_media_promotion_authorization() FROM PUBLIC;

-- The nullable Store component is checked explicitly as well as by the scoped
-- FKs: MATCH SIMPLE alone would skip a Brand-level FK containing NULL.
-- RFC8785 digest verification belongs to the owning parser; SQL checks the
-- complete fixed JSON/column tuple, not a different jsonb serialization hash.
CREATE FUNCTION bop_permission.assert_system_media_promotion_authorization_origin()
RETURNS trigger LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
DECLARE
  current_row bop_permission.system_media_image_promotion_authorization%ROWTYPE;
  decision_row bop_permission.system_media_image_promotion_authorization_decision%ROWTYPE;
  latest_version bigint;
BEGIN
  SELECT * INTO current_row FROM bop_permission.system_media_image_promotion_authorization
    WHERE workload_id=NEW.workload_id AND tenant_id=NEW.tenant_id AND brand_id=NEW.brand_id
      AND store_id IS NOT DISTINCT FROM NEW.store_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'SYSTEM_MEDIA_PROMOTION_AUTHORIZATION_ORIGIN_INVALID' USING ERRCODE='23514';
  END IF;
  SELECT * INTO decision_row FROM bop_permission.system_media_image_promotion_authorization_decision
    WHERE decision_id=current_row.decision_id AND workload_id=current_row.workload_id
      AND tenant_id=current_row.tenant_id AND brand_id=current_row.brand_id
      AND store_id IS NOT DISTINCT FROM current_row.store_id AND version=current_row.version;
  IF NOT FOUND OR decision_row.recorded_at<>current_row.updated_at THEN
    RAISE EXCEPTION 'SYSTEM_MEDIA_PROMOTION_AUTHORIZATION_ORIGIN_INVALID' USING ERRCODE='23514';
  END IF;
  SELECT max(version) INTO latest_version FROM bop_permission.system_media_image_promotion_authorization_decision
    WHERE workload_id=current_row.workload_id AND tenant_id=current_row.tenant_id AND brand_id=current_row.brand_id
      AND store_id IS NOT DISTINCT FROM current_row.store_id;
  IF latest_version IS DISTINCT FROM current_row.version OR NEW.version>current_row.version THEN
    RAISE EXCEPTION 'SYSTEM_MEDIA_PROMOTION_AUTHORIZATION_ORIGIN_INVALID' USING ERRCODE='23514';
  END IF;
  IF TG_TABLE_NAME='system_media_image_promotion_authorization_decision' AND NEW.version>1 THEN
    PERFORM 1 FROM bop_permission.system_media_image_promotion_authorization_decision
      WHERE workload_id=NEW.workload_id AND tenant_id=NEW.tenant_id AND brand_id=NEW.brand_id
        AND store_id IS NOT DISTINCT FROM NEW.store_id AND version=NEW.version-1 AND recorded_at<=NEW.recorded_at;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'SYSTEM_MEDIA_PROMOTION_AUTHORIZATION_ORIGIN_INVALID' USING ERRCODE='23514';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION bop_permission.assert_system_media_promotion_authorization_origin() FROM PUBLIC;

CREATE TRIGGER system_media_promotion_authorization_guard BEFORE INSERT OR UPDATE OR DELETE ON bop_permission.system_media_image_promotion_authorization FOR EACH ROW EXECUTE FUNCTION bop_permission.guard_system_media_promotion_authorization();
CREATE TRIGGER system_media_promotion_authorization_no_truncate BEFORE TRUNCATE ON bop_permission.system_media_image_promotion_authorization FOR EACH STATEMENT EXECUTE FUNCTION bop_permission.guard_system_media_promotion_authorization();
CREATE TRIGGER system_media_promotion_decision_guard BEFORE INSERT OR UPDATE OR DELETE ON bop_permission.system_media_image_promotion_authorization_decision FOR EACH ROW EXECUTE FUNCTION bop_permission.guard_system_media_promotion_authorization();
CREATE TRIGGER system_media_promotion_decision_no_truncate BEFORE TRUNCATE ON bop_permission.system_media_image_promotion_authorization_decision FOR EACH STATEMENT EXECUTE FUNCTION bop_permission.guard_system_media_promotion_authorization();
CREATE CONSTRAINT TRIGGER system_media_promotion_authorization_origin AFTER INSERT OR UPDATE ON bop_permission.system_media_image_promotion_authorization DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION bop_permission.assert_system_media_promotion_authorization_origin();
CREATE CONSTRAINT TRIGGER system_media_promotion_decision_origin AFTER INSERT ON bop_permission.system_media_image_promotion_authorization_decision DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION bop_permission.assert_system_media_promotion_authorization_origin();

ALTER TABLE bop_permission.system_media_image_promotion_authorization ENABLE ROW LEVEL SECURITY;
ALTER TABLE bop_permission.system_media_image_promotion_authorization FORCE ROW LEVEL SECURITY;
ALTER TABLE bop_permission.system_media_image_promotion_authorization_decision ENABLE ROW LEVEL SECURITY;
ALTER TABLE bop_permission.system_media_image_promotion_authorization_decision FORCE ROW LEVEL SECURITY;
CREATE POLICY system_media_promotion_authorization_scope ON bop_permission.system_media_image_promotion_authorization
  USING (tenant_id::text=current_setting('bop.tenant_id',true) AND brand_id=platform_helpers.current_brand_id() AND store_id IS NOT DISTINCT FROM platform_helpers.current_store_id())
  WITH CHECK (tenant_id::text=current_setting('bop.tenant_id',true) AND brand_id=platform_helpers.current_brand_id() AND store_id IS NOT DISTINCT FROM platform_helpers.current_store_id());
CREATE POLICY system_media_promotion_decision_scope ON bop_permission.system_media_image_promotion_authorization_decision
  USING (tenant_id::text=current_setting('bop.tenant_id',true) AND brand_id=platform_helpers.current_brand_id() AND store_id IS NOT DISTINCT FROM platform_helpers.current_store_id())
  WITH CHECK (tenant_id::text=current_setting('bop.tenant_id',true) AND brand_id=platform_helpers.current_brand_id() AND store_id IS NOT DISTINCT FROM platform_helpers.current_store_id());
REVOKE ALL ON TABLE bop_permission.system_media_image_promotion_authorization,bop_permission.system_media_image_promotion_authorization_decision FROM PUBLIC;
