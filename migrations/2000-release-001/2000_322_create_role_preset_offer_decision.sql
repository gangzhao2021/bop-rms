-- bop-rms-migration: 1
-- owner: @bop/permission
-- schema: bop_permission
-- phase: expand
-- risk: medium
-- transaction: required
-- lock-timeout-ms: 5000
-- statement-timeout-ms: 60000
-- recovery: forward-fix
-- WP-2423 role presets (Owner request 2026-11-06 "预设一些角色与权限，另外允许店家自定义；店家也可以对
-- 预设进行增删改"; coordinator decision, the Owner may overrule it; Owner standing approval
-- 2026-10-14): a BOP upgrade never writes a preset over a Store's own version of it, so the Roles
-- page offers what the preset gained ("add it to yours?") or no longer has ("remove it from
-- yours?"). Adding or removing is an ordinary role change through approval. "Keep mine" is
-- recorded here, append-only, against the preset version the offer was made from (the last BOP
-- version below the Store's own, which upgrades never move): that permission is not offered again
-- for this role. A permission BOP adds or removes later is offered on its own.
CREATE FUNCTION bop_permission.reject_role_preset_offer_decision_mutation() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
BEGIN
  RAISE EXCEPTION 'append-only role preset offer decision' USING ERRCODE='55000';
END;
$$;
REVOKE ALL ON FUNCTION bop_permission.reject_role_preset_offer_decision_mutation() FROM PUBLIC;

CREATE TABLE bop_permission.role_preset_offer_decision (
  decision_id platform_helpers.uuid_v7 PRIMARY KEY,
  brand_id platform_helpers.uuid_v7 NOT NULL,
  store_id platform_helpers.uuid_v7 NOT NULL,
  role_id platform_helpers.uuid_v7 NOT NULL,
  administration_reference platform_helpers.uuid_v7 NOT NULL,
  -- The BOP preset version (System) the offer compared the Store's version with.
  preset_version bigint NOT NULL CHECK (preset_version > 0),
  catalog_version integer NOT NULL CHECK (catalog_version > 0),
  offer_kind text NOT NULL CHECK (offer_kind IN ('Add','Remove')),
  action_code text NOT NULL CHECK (
    action_code ~ '^[a-z][a-z0-9]*(-[a-z0-9]+)*(\.[a-z][a-z0-9]*(_[a-z0-9]+)*(-[a-z0-9]+)*){1,7}$'
  ),
  decision text NOT NULL CHECK (decision = 'Declined'),
  actor_id platform_helpers.uuid_v7 NOT NULL,
  operation_reference platform_helpers.uuid_v7 NOT NULL,
  decided_at timestamp with time zone NOT NULL CHECK (isfinite(decided_at)),
  audit_id platform_helpers.uuid_v7 NOT NULL,
  data_classification text NOT NULL CHECK (data_classification = 'ConfigurationMetadata'),
  CONSTRAINT role_preset_offer_decision_once
    UNIQUE (brand_id, administration_reference, preset_version, offer_kind, action_code),
  CONSTRAINT role_preset_offer_decision_role_fkey
    FOREIGN KEY (role_id, brand_id) REFERENCES bop_permission.role (role_id, brand_id),
  CONSTRAINT role_preset_offer_decision_preset_fkey
    FOREIGN KEY (brand_id, administration_reference, preset_version)
    REFERENCES bop_permission.role_administration_version (brand_id, administration_reference, version)
);

-- The decision names a BOP preset version of this Store's role (read as the migration owner).
CREATE FUNCTION bop_permission.check_role_preset_offer_decision() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog
SET row_security = off
AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM bop_permission.role_administration_version v
    WHERE v.brand_id = NEW.brand_id AND v.administration_reference = NEW.administration_reference
      AND v.version = NEW.preset_version AND v.role_id = NEW.role_id AND v.store_id = NEW.store_id
      AND v.role_type = 'System'
  ) THEN
    RAISE EXCEPTION 'role preset offer decision must name a preset version of the Store''s role' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION bop_permission.check_role_preset_offer_decision() FROM PUBLIC;
CREATE TRIGGER role_preset_offer_decision_request
  BEFORE INSERT ON bop_permission.role_preset_offer_decision
  FOR EACH ROW EXECUTE FUNCTION bop_permission.check_role_preset_offer_decision();

CREATE TRIGGER role_preset_offer_decision_no_mutation
  BEFORE UPDATE OR DELETE ON bop_permission.role_preset_offer_decision
  FOR EACH ROW EXECUTE FUNCTION bop_permission.reject_role_preset_offer_decision_mutation();
CREATE TRIGGER role_preset_offer_decision_no_truncate
  BEFORE TRUNCATE ON bop_permission.role_preset_offer_decision
  FOR EACH STATEMENT EXECUTE FUNCTION bop_permission.reject_role_preset_offer_decision_mutation();
ALTER TABLE bop_permission.role_preset_offer_decision ENABLE ROW LEVEL SECURITY;
ALTER TABLE bop_permission.role_preset_offer_decision FORCE ROW LEVEL SECURITY;
CREATE POLICY role_preset_offer_decision_scope ON bop_permission.role_preset_offer_decision
  USING (brand_id = platform_helpers.current_brand_id()
    AND store_id = platform_helpers.current_store_id())
  WITH CHECK (brand_id = platform_helpers.current_brand_id()
    AND store_id = platform_helpers.current_store_id());
REVOKE ALL ON TABLE bop_permission.role_preset_offer_decision FROM PUBLIC;
