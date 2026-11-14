-- bop-rms-migration: 1
-- owner: @rms/catalog
-- schema: rms_catalog
-- phase: expand
-- risk: medium
-- transaction: required
-- lock-timeout-ms: 5000
-- statement-timeout-ms: 60000
-- recovery: forward-fix
-- WP-2423 Q19 (DEC-SOLE-OPERATOR-APPROVAL): a menu version approved for publication by the person who
-- submitted it, because the Brand Owner runs the Brand alone (sole operator in effect at that
-- moment). The approval itself is the Publishing lifecycle record; this append-only companion
-- record marks it (approval_mode SoleOperator) with the approver's second-factor time (at most
-- 15 minutes before). Every other menu approval needs another person and has no such record.
CREATE FUNCTION rms_catalog.reject_menu_sole_operator_approval_mutation() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
BEGIN
 RAISE EXCEPTION 'append-only menu sole operator approval' USING ERRCODE='55000';
END;
$$;
REVOKE ALL ON FUNCTION rms_catalog.reject_menu_sole_operator_approval_mutation() FROM PUBLIC;

CREATE TABLE rms_catalog.menu_sole_operator_approval (
 brand_id platform_helpers.uuid_v7 NOT NULL,
 approval_evidence_id platform_helpers.uuid_v7 NOT NULL,
 operation_id platform_helpers.uuid_v7 NOT NULL,
 menu_id platform_helpers.uuid_v7 NOT NULL,
 menu_version_id platform_helpers.uuid_v7 NOT NULL,
 lifecycle_id platform_helpers.uuid_v7 NOT NULL,
 approval_mode text NOT NULL CHECK (approval_mode='SoleOperator'),
 actor_id platform_helpers.uuid_v7 NOT NULL,
 actor_mfa_at timestamptz NOT NULL CHECK (isfinite(actor_mfa_at)),
 approved_at timestamptz NOT NULL CHECK (isfinite(approved_at) AND approved_at=date_trunc('milliseconds',approved_at)),
 audit_id platform_helpers.uuid_v7 NOT NULL UNIQUE,
 PRIMARY KEY (brand_id,approval_evidence_id),
 CONSTRAINT menu_sole_operator_approval_operation_unique UNIQUE (brand_id,operation_id),
 CONSTRAINT menu_sole_operator_approval_recent_mfa CHECK (
  actor_mfa_at BETWEEN approved_at-interval '15 minutes' AND approved_at
 )
);
CREATE TRIGGER menu_sole_operator_approval_no_mutation BEFORE UPDATE OR DELETE ON rms_catalog.menu_sole_operator_approval
 FOR EACH ROW EXECUTE FUNCTION rms_catalog.reject_menu_sole_operator_approval_mutation();
CREATE TRIGGER menu_sole_operator_approval_no_truncate BEFORE TRUNCATE ON rms_catalog.menu_sole_operator_approval
 FOR EACH STATEMENT EXECUTE FUNCTION rms_catalog.reject_menu_sole_operator_approval_mutation();
ALTER TABLE rms_catalog.menu_sole_operator_approval ENABLE ROW LEVEL SECURITY;
ALTER TABLE rms_catalog.menu_sole_operator_approval FORCE ROW LEVEL SECURITY;
CREATE POLICY menu_sole_operator_approval_brand_policy ON rms_catalog.menu_sole_operator_approval
 USING (brand_id=platform_helpers.current_brand_id())
 WITH CHECK (brand_id=platform_helpers.current_brand_id());
REVOKE ALL ON TABLE rms_catalog.menu_sole_operator_approval FROM PUBLIC;
