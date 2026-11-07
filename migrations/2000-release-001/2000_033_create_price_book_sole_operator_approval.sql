-- bop-rms-migration: 1
-- owner: @rms/pricing
-- schema: rms_pricing
-- phase: expand
-- risk: medium
-- transaction: required
-- lock-timeout-ms: 5000
-- statement-timeout-ms: 60000
-- recovery: forward-fix
-- WP-2423 Q19 (DEC-SOLE-OPERATOR-APPROVAL): a price book published by its own draft author because
-- the Brand Owner runs the Brand alone (sole operator in effect at that moment). The publication
-- itself is the existing operation record; this append-only companion record marks it
-- (approval_mode SoleOperator) with the author's second-factor time (at most 15 minutes before).
-- Every other publication still needs another person and has no such record.
CREATE FUNCTION rms_pricing.reject_price_book_sole_operator_approval_mutation() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
BEGIN
 RAISE EXCEPTION 'append-only price book sole operator approval' USING ERRCODE='55000';
END;
$$;
REVOKE ALL ON FUNCTION rms_pricing.reject_price_book_sole_operator_approval_mutation() FROM PUBLIC;

CREATE TABLE rms_pricing.price_book_sole_operator_approval (
 operation_id platform_helpers.uuid_v7 PRIMARY KEY
  REFERENCES rms_pricing.price_book_operation_record (operation_id),
 brand_id platform_helpers.uuid_v7 NOT NULL,
 price_book_id platform_helpers.uuid_v7 NOT NULL,
 approval_mode text NOT NULL CHECK (approval_mode='SoleOperator'),
 actor_id platform_helpers.uuid_v7 NOT NULL,
 actor_mfa_at timestamptz NOT NULL CHECK (isfinite(actor_mfa_at)),
 approved_at timestamptz NOT NULL CHECK (isfinite(approved_at) AND approved_at=date_trunc('milliseconds',approved_at)),
 audit_id platform_helpers.uuid_v7 NOT NULL UNIQUE,
 CONSTRAINT price_book_sole_operator_approval_recent_mfa CHECK (
  actor_mfa_at BETWEEN approved_at-interval '15 minutes' AND approved_at
 )
);

-- Marks only a Publish operation of the same price book and Brand.
CREATE FUNCTION rms_pricing.check_price_book_sole_operator_approval() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
BEGIN
 IF NOT EXISTS (
  SELECT 1 FROM rms_pricing.price_book_operation_record o
  WHERE o.operation_id=NEW.operation_id AND o.brand_id=NEW.brand_id
   AND o.price_book_id=NEW.price_book_id AND o.action_code='Publish'
 ) THEN
  RAISE EXCEPTION 'price book sole operator approval must mark a publication' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION rms_pricing.check_price_book_sole_operator_approval() FROM PUBLIC;

CREATE TRIGGER price_book_sole_operator_approval_publication BEFORE INSERT ON rms_pricing.price_book_sole_operator_approval
 FOR EACH ROW EXECUTE FUNCTION rms_pricing.check_price_book_sole_operator_approval();
CREATE TRIGGER price_book_sole_operator_approval_no_mutation BEFORE UPDATE OR DELETE ON rms_pricing.price_book_sole_operator_approval
 FOR EACH ROW EXECUTE FUNCTION rms_pricing.reject_price_book_sole_operator_approval_mutation();
CREATE TRIGGER price_book_sole_operator_approval_no_truncate BEFORE TRUNCATE ON rms_pricing.price_book_sole_operator_approval
 FOR EACH STATEMENT EXECUTE FUNCTION rms_pricing.reject_price_book_sole_operator_approval_mutation();
ALTER TABLE rms_pricing.price_book_sole_operator_approval ENABLE ROW LEVEL SECURITY;
ALTER TABLE rms_pricing.price_book_sole_operator_approval FORCE ROW LEVEL SECURITY;
CREATE POLICY price_book_sole_operator_approval_brand_scope ON rms_pricing.price_book_sole_operator_approval
 USING (brand_id=platform_helpers.current_brand_id())
 WITH CHECK (brand_id=platform_helpers.current_brand_id());
REVOKE ALL ON TABLE rms_pricing.price_book_sole_operator_approval FROM PUBLIC;
