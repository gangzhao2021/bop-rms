-- bop-rms-migration: 1
-- owner: @bop/tenant
-- schema: bop_tenant
-- phase: expand
-- risk: medium
-- transaction: required
-- lock-timeout-ms: 5000
-- statement-timeout-ms: 60000
-- recovery: forward-fix
-- WP-2423 Q19 (DEC-SOLE-OPERATOR-APPROVAL): the Brand Owner turns "sole operator" on or off for a
-- Brand. Each change is an append-only record (who, when, why, and the second-factor verification
-- it was made under) with its Audit; the current state is the highest version. The setting alone
-- never waives a second person: each approval gate rechecks, in its own transaction, that the
-- actor is the only active holder of that approval permission (Organization public read).
CREATE FUNCTION bop_tenant.reject_brand_sole_operator_setting_mutation() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
BEGIN
 RAISE EXCEPTION 'append-only brand sole operator setting' USING ERRCODE='55000';
END;
$$;
REVOKE ALL ON FUNCTION bop_tenant.reject_brand_sole_operator_setting_mutation() FROM PUBLIC;

CREATE TABLE bop_tenant.brand_sole_operator_setting (
 tenant_id platform_helpers.uuid_v7 NOT NULL,
 brand_id platform_helpers.uuid_v7 NOT NULL REFERENCES bop_tenant.brand (brand_id),
 setting_id platform_helpers.uuid_v7 NOT NULL,
 version bigint NOT NULL CHECK (version BETWEEN 1 AND 9007199254740991),
 state text NOT NULL CHECK (state IN ('On','Off')),
 reason_code varchar(64) NOT NULL,
 actor_id platform_helpers.uuid_v7 NOT NULL,
 actor_mfa_at timestamptz NOT NULL CHECK (isfinite(actor_mfa_at)),
 recorded_at timestamptz NOT NULL CHECK (isfinite(recorded_at) AND recorded_at=date_trunc('milliseconds',recorded_at)),
 operation_id platform_helpers.uuid_v7 NOT NULL,
 audit_id platform_helpers.uuid_v7 NOT NULL UNIQUE,
 PRIMARY KEY (brand_id,setting_id),
 CONSTRAINT brand_sole_operator_setting_version_unique UNIQUE (brand_id,version),
 CONSTRAINT brand_sole_operator_setting_operation_unique UNIQUE (brand_id,operation_id),
 CONSTRAINT brand_sole_operator_setting_reason CHECK (
  (state='On' AND reason_code='OWNER_RUNS_STORE_ALONE')
  OR (state='Off' AND reason_code IN ('SECOND_APPROVER_AVAILABLE','OWNER_CHOICE','ENTERED_IN_ERROR'))
 ),
 CONSTRAINT brand_sole_operator_setting_recent_mfa CHECK (
  actor_mfa_at BETWEEN recorded_at-interval '15 minutes' AND recorded_at
 )
);

-- Versions are contiguous per Brand and every record changes the state (the first one turns it on).
CREATE FUNCTION bop_tenant.check_brand_sole_operator_setting_sequence() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
DECLARE
 previous_version bigint;
 previous_state text;
BEGIN
 SELECT s.version,s.state INTO previous_version,previous_state
 FROM bop_tenant.brand_sole_operator_setting s
 WHERE s.brand_id=NEW.brand_id ORDER BY s.version DESC LIMIT 1;
 IF NEW.version<>COALESCE(previous_version,0)+1
  OR NEW.state=COALESCE(previous_state,'Off') THEN
  RAISE EXCEPTION 'brand sole operator setting out of sequence' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION bop_tenant.check_brand_sole_operator_setting_sequence() FROM PUBLIC;

CREATE TRIGGER brand_sole_operator_setting_sequence BEFORE INSERT ON bop_tenant.brand_sole_operator_setting
 FOR EACH ROW EXECUTE FUNCTION bop_tenant.check_brand_sole_operator_setting_sequence();
CREATE TRIGGER brand_sole_operator_setting_no_mutation BEFORE UPDATE OR DELETE ON bop_tenant.brand_sole_operator_setting
 FOR EACH ROW EXECUTE FUNCTION bop_tenant.reject_brand_sole_operator_setting_mutation();
CREATE TRIGGER brand_sole_operator_setting_no_truncate BEFORE TRUNCATE ON bop_tenant.brand_sole_operator_setting
 FOR EACH STATEMENT EXECUTE FUNCTION bop_tenant.reject_brand_sole_operator_setting_mutation();
ALTER TABLE bop_tenant.brand_sole_operator_setting ENABLE ROW LEVEL SECURITY;
ALTER TABLE bop_tenant.brand_sole_operator_setting FORCE ROW LEVEL SECURITY;
CREATE POLICY brand_sole_operator_setting_scope ON bop_tenant.brand_sole_operator_setting
 USING (brand_id=platform_helpers.current_brand_id())
 WITH CHECK (brand_id=platform_helpers.current_brand_id());
REVOKE ALL ON TABLE bop_tenant.brand_sole_operator_setting FROM PUBLIC;
