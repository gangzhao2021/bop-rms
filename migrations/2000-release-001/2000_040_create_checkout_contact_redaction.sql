-- bop-rms-migration: 1
-- owner: @rms/ordering
-- schema: rms_ordering
-- phase: expand
-- risk: medium
-- transaction: required
-- lock-timeout-ms: 5000
-- statement-timeout-ms: 60000
-- recovery: forward-fix
-- WP-2423 Q10 (with Q16): a customer's pickup contact and receipt email are kept only for the
-- order they were given for. After the retention period the value is removed from the checkout
-- details record; everything else in that record (and all order, payment and audit history) is
-- unchanged. Removal is the only change the record still accepts, and only together with an
-- append-only evidence row (when, which policy) that never holds the removed value.
CREATE TABLE rms_ordering.checkout_contact_redaction (
 brand_id platform_helpers.uuid_v7 NOT NULL,
 store_id platform_helpers.uuid_v7 NOT NULL,
 details_id platform_helpers.uuid_v7 NOT NULL,
 details_version integer NOT NULL CHECK (details_version > 0),
 redaction_id platform_helpers.uuid_v7 NOT NULL UNIQUE,
 policy_code text NOT NULL CHECK (policy_code = 'CHECKOUT_CONTACT_RETENTION'),
 policy_version integer NOT NULL CHECK (policy_version = 1),
 retention_days integer NOT NULL CHECK (retention_days BETWEEN 1 AND 3650),
 details_recorded_at timestamptz NOT NULL CHECK (isfinite(details_recorded_at)),
 redacted_at timestamptz NOT NULL CHECK (isfinite(redacted_at) AND redacted_at=date_trunc('milliseconds',redacted_at)),
 PRIMARY KEY (brand_id,store_id,details_id,details_version),
 CONSTRAINT checkout_contact_redaction_details_fk FOREIGN KEY (brand_id,store_id,details_id,details_version)
  REFERENCES rms_ordering.checkout_details_record (brand_id,store_id,details_id,details_version),
 CONSTRAINT checkout_contact_redaction_after_retention CHECK (
  redacted_at >= details_recorded_at + make_interval(days => retention_days)
 )
);

CREATE FUNCTION rms_ordering.check_checkout_contact_redaction() RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
BEGIN
 IF NOT EXISTS (
  SELECT 1 FROM rms_ordering.checkout_details_record d
  WHERE d.brand_id=NEW.brand_id AND d.store_id=NEW.store_id AND d.details_id=NEW.details_id
   AND d.details_version=NEW.details_version AND d.recorded_at=NEW.details_recorded_at
 ) THEN
  RAISE EXCEPTION 'contact redaction evidence does not match its checkout details' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION rms_ordering.check_checkout_contact_redaction() FROM PUBLIC;
CREATE TRIGGER checkout_contact_redaction_check BEFORE INSERT ON rms_ordering.checkout_contact_redaction
 FOR EACH ROW EXECUTE FUNCTION rms_ordering.check_checkout_contact_redaction();

CREATE FUNCTION rms_ordering.reject_checkout_contact_redaction_mutation() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
BEGIN
 RAISE EXCEPTION 'append-only contact redaction evidence' USING ERRCODE='55000';
END;
$$;
REVOKE ALL ON FUNCTION rms_ordering.reject_checkout_contact_redaction_mutation() FROM PUBLIC;
CREATE TRIGGER checkout_contact_redaction_no_mutation BEFORE UPDATE OR DELETE ON rms_ordering.checkout_contact_redaction
 FOR EACH ROW EXECUTE FUNCTION rms_ordering.reject_checkout_contact_redaction_mutation();

ALTER TABLE rms_ordering.checkout_contact_redaction ENABLE ROW LEVEL SECURITY;
ALTER TABLE rms_ordering.checkout_contact_redaction FORCE ROW LEVEL SECURITY;
CREATE POLICY checkout_contact_redaction_scope ON rms_ordering.checkout_contact_redaction
 USING (brand_id = platform_helpers.current_brand_id() AND store_id = platform_helpers.current_store_id())
 WITH CHECK (brand_id = platform_helpers.current_brand_id() AND store_id = platform_helpers.current_store_id());
REVOKE ALL ON TABLE rms_ordering.checkout_contact_redaction FROM PUBLIC;

-- The details record stays append-only except for this one change: with its evidence row present,
-- the pickup contact becomes null and the receipt choice becomes "view here" without an email.
-- Any other UPDATE is skipped exactly like the rule it replaces (no row changes, no error).
DROP RULE checkout_details_no_update ON rms_ordering.checkout_details_record;
CREATE FUNCTION rms_ordering.guard_checkout_details_update() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
BEGIN
 IF NEW.brand_id IS NOT DISTINCT FROM OLD.brand_id
  AND NEW.store_id IS NOT DISTINCT FROM OLD.store_id
  AND NEW.details_id IS NOT DISTINCT FROM OLD.details_id
  AND NEW.details_version IS NOT DISTINCT FROM OLD.details_version
  AND NEW.operation_id IS NOT DISTINCT FROM OLD.operation_id
  AND NEW.guest_session_id IS NOT DISTINCT FROM OLD.guest_session_id
  AND NEW.cart_id IS NOT DISTINCT FROM OLD.cart_id
  AND NEW.recorded_at IS NOT DISTINCT FROM OLD.recorded_at
  AND NEW.snapshot_json = OLD.snapshot_json || jsonb_build_object(
   'pickupContact', 'null'::jsonb,
   'receipt', jsonb_build_object('choice', 'InSession', 'email', 'null'::jsonb))
  AND NEW.snapshot_json IS DISTINCT FROM OLD.snapshot_json
  AND EXISTS (
   SELECT 1 FROM rms_ordering.checkout_contact_redaction r
   WHERE r.brand_id=OLD.brand_id AND r.store_id=OLD.store_id
    AND r.details_id=OLD.details_id AND r.details_version=OLD.details_version)
 THEN
  RETURN NEW;
 END IF;
 RETURN NULL;
END;
$$;
REVOKE ALL ON FUNCTION rms_ordering.guard_checkout_details_update() FROM PUBLIC;
CREATE TRIGGER checkout_details_guard_update BEFORE UPDATE ON rms_ordering.checkout_details_record
 FOR EACH ROW EXECUTE FUNCTION rms_ordering.guard_checkout_details_update();
