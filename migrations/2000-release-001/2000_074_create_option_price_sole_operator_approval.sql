-- bop-rms-migration: 1
-- owner: @rms/pricing
-- schema: rms_pricing
-- phase: expand
-- risk: medium
-- transaction: required
-- lock-timeout-ms: 5000
-- statement-timeout-ms: 60000
-- recovery: forward-fix
-- WP-2423 DEC-SOLE-OPERATOR-APPROVAL (Owner decision 2026-10-10 covers price changes; Owner
-- standing approval 2026-10-14 WP-2423 sole operator; v15 run 2026-10-16 found option prices had
-- no sole-operator path): an option price published by its own draft author because the Brand
-- Owner runs the Brand alone (sole operator in effect at that moment), exactly as price books
-- (2000_033, 2000_070). The publication itself is the existing authoring operation; this
-- append-only companion record marks it (approval_mode SoleOperator) with the author's
-- second-factor time (at most 15 minutes before). Every other option price publication still
-- needs another person and has no such record.
CREATE FUNCTION rms_pricing.reject_option_price_sole_operator_approval_mutation() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
BEGIN
 RAISE EXCEPTION 'append-only option price sole operator approval' USING ERRCODE='55000';
END;
$$;
REVOKE ALL ON FUNCTION rms_pricing.reject_option_price_sole_operator_approval_mutation() FROM PUBLIC;

CREATE TABLE rms_pricing.option_price_sole_operator_approval (
 operation_id platform_helpers.uuid_v7 PRIMARY KEY
  REFERENCES rms_pricing.option_price_authoring_operation (operation_id),
 brand_id platform_helpers.uuid_v7 NOT NULL,
 option_price_rule_id platform_helpers.uuid_v7 NOT NULL,
 approval_mode text NOT NULL CHECK (approval_mode='SoleOperator'),
 actor_id platform_helpers.uuid_v7 NOT NULL,
 actor_mfa_at timestamptz NOT NULL CHECK (isfinite(actor_mfa_at)),
 approved_at timestamptz NOT NULL CHECK (isfinite(approved_at) AND approved_at=date_trunc('milliseconds',approved_at)),
 audit_id platform_helpers.uuid_v7 NOT NULL UNIQUE,
 CONSTRAINT option_price_sole_operator_approval_recent_mfa CHECK (
  actor_mfa_at BETWEEN approved_at-interval '15 minutes' AND approved_at
 )
);

-- Marks only a committed Publish of the same rule and Brand, by the same person at the same
-- instant with the same audit, whose recorded approver is that rule draft's own author.
CREATE FUNCTION rms_pricing.check_option_price_sole_operator_approval() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog
SET row_security = off
AS $$
BEGIN
 IF NOT EXISTS (
  SELECT 1 FROM rms_pricing.option_price_authoring_operation o
  WHERE o.operation_id=NEW.operation_id AND o.brand_id=NEW.brand_id
   AND o.option_price_rule_id=NEW.option_price_rule_id AND o.action_code='Publish'
   AND o.outcome='Committed' AND o.actor_id=NEW.actor_id AND o.occurred_at=NEW.approved_at
   AND o.audit_id=NEW.audit_id
   AND o.receipt_json->'publicationAuthorization'->>'approvedActorReference'=NEW.actor_id::text
   AND o.receipt_json->'publicationAuthorization'->>'draftAuthorActorReference'=NEW.actor_id::text
 ) THEN
  RAISE EXCEPTION 'option price sole operator approval must mark its author''s own publication' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION rms_pricing.check_option_price_sole_operator_approval() FROM PUBLIC;
CREATE TRIGGER option_price_sole_operator_approval_publication BEFORE INSERT ON rms_pricing.option_price_sole_operator_approval
 FOR EACH ROW EXECUTE FUNCTION rms_pricing.check_option_price_sole_operator_approval();

-- The same setting check as 2000_070: recorded only while the Brand's sole-operator setting was
-- On at the approval instant and is still On (Organization read, 2000_066; the setting is held
-- until the publication commits).
CREATE FUNCTION rms_pricing.check_option_price_sole_operator_setting() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog
SET row_security = off
AS $$
BEGIN
 IF bop_tenant.hold_brand_sole_operator_on(NEW.brand_id, NEW.approved_at) IS NOT TRUE THEN
  RAISE EXCEPTION 'option price sole operator approval needs sole operator on' USING ERRCODE='23514';
 END IF;
 RETURN NULL;
END;
$$;
REVOKE ALL ON FUNCTION rms_pricing.check_option_price_sole_operator_setting() FROM PUBLIC;
CREATE TRIGGER option_price_sole_operator_approval_setting_on AFTER INSERT ON rms_pricing.option_price_sole_operator_approval
 FOR EACH ROW EXECUTE FUNCTION rms_pricing.check_option_price_sole_operator_setting();

CREATE TRIGGER option_price_sole_operator_approval_no_mutation BEFORE UPDATE OR DELETE ON rms_pricing.option_price_sole_operator_approval
 FOR EACH ROW EXECUTE FUNCTION rms_pricing.reject_option_price_sole_operator_approval_mutation();
CREATE TRIGGER option_price_sole_operator_approval_no_truncate BEFORE TRUNCATE ON rms_pricing.option_price_sole_operator_approval
 FOR EACH STATEMENT EXECUTE FUNCTION rms_pricing.reject_option_price_sole_operator_approval_mutation();
ALTER TABLE rms_pricing.option_price_sole_operator_approval ENABLE ROW LEVEL SECURITY;
ALTER TABLE rms_pricing.option_price_sole_operator_approval FORCE ROW LEVEL SECURITY;
CREATE POLICY option_price_sole_operator_approval_brand_scope ON rms_pricing.option_price_sole_operator_approval
 USING (brand_id=platform_helpers.current_brand_id())
 WITH CHECK (brand_id=platform_helpers.current_brand_id());
REVOKE ALL ON TABLE rms_pricing.option_price_sole_operator_approval FROM PUBLIC;

-- A publication whose recorded approver is the draft's own author stands only with its mark, in
-- the same transaction (checked at commit, or when the writer makes constraints immediate).
-- Publications approved by another person are unchanged. Rows already recorded are kept.
CREATE FUNCTION rms_pricing.check_option_price_self_publication_marked() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog
SET row_security = off
AS $$
BEGIN
 IF NEW.action_code='Publish' AND NEW.outcome='Committed'
  AND NEW.receipt_json->'publicationAuthorization'->>'approvedActorReference'
   = NEW.receipt_json->'publicationAuthorization'->>'draftAuthorActorReference'
  AND NOT EXISTS (
   SELECT 1 FROM rms_pricing.option_price_sole_operator_approval m
   WHERE m.operation_id=NEW.operation_id AND m.brand_id=NEW.brand_id
  ) THEN
  RAISE EXCEPTION 'option price published by its own author needs a sole operator approval' USING ERRCODE='23514';
 END IF;
 RETURN NULL;
END;
$$;
REVOKE ALL ON FUNCTION rms_pricing.check_option_price_self_publication_marked() FROM PUBLIC;
CREATE CONSTRAINT TRIGGER option_price_self_publication_marked
 AFTER INSERT ON rms_pricing.option_price_authoring_operation
 DEFERRABLE INITIALLY DEFERRED
 FOR EACH ROW EXECUTE FUNCTION rms_pricing.check_option_price_self_publication_marked();
