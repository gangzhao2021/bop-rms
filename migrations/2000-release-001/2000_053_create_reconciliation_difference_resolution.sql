-- bop-rms-migration: 1
-- owner: @rms/payment
-- schema: rms_payment
-- phase: expand
-- risk: medium
-- transaction: required
-- lock-timeout-ms: 5000
-- statement-timeout-ms: 60000
-- recovery: forward-fix
-- WP-2423 (2026-10-15): a business day whose settlement check found a difference is checked
-- again when new Payment records explain it (for example the refund of a charge the Provider took
-- that matched no Order). When the later check of the same day matches the Provider statement,
-- the earlier difference is resolved by that check: one append-only row per difference naming the
-- matching check, written with its audit record in the same transaction. Nothing earlier is
-- changed. Grants: api SELECT/INSERT (Owner standing approval 2026-10-14, WP-2423 reconciliation).
CREATE TABLE rms_payment.payment_reconciliation_resolution (
 reconciliation_exception_id platform_helpers.uuid_v7 NOT NULL,
 brand_id platform_helpers.uuid_v7 NOT NULL,
 store_id platform_helpers.uuid_v7 NOT NULL,
 candidate_id platform_helpers.uuid_v7 NOT NULL,
 resolution text NOT NULL CHECK (resolution = 'MatchedOnRecheck'),
 reconciliation_run_id platform_helpers.uuid_v7 NOT NULL,
 reconciliation_check_id platform_helpers.uuid_v7 NOT NULL,
 resolved_at timestamptz NOT NULL CHECK (isfinite(resolved_at)),
 audit_id platform_helpers.uuid_v7 NOT NULL,
 PRIMARY KEY (brand_id,store_id,reconciliation_exception_id),
 FOREIGN KEY (reconciliation_exception_id,brand_id,store_id,candidate_id)
  REFERENCES rms_payment.payment_reconciliation_exception (reconciliation_exception_id,brand_id,store_id,candidate_id),
 FOREIGN KEY (reconciliation_check_id) REFERENCES rms_payment.payment_reconciliation_record (reconciliation_check_id)
);

-- The resolving check must be a later matching settlement check of the same day (candidate).
CREATE FUNCTION rms_payment.check_payment_reconciliation_resolution() RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE matched rms_payment.payment_reconciliation_record%ROWTYPE;
DECLARE opened timestamptz;
BEGIN
 SELECT * INTO matched FROM rms_payment.payment_reconciliation_record
  WHERE reconciliation_check_id=NEW.reconciliation_check_id;
 SELECT opened_at INTO opened FROM rms_payment.payment_reconciliation_exception
  WHERE reconciliation_exception_id=NEW.reconciliation_exception_id
   AND brand_id=NEW.brand_id AND store_id=NEW.store_id AND candidate_id=NEW.candidate_id;
 IF NOT FOUND OR matched.reconciliation_check_id IS NULL
  OR matched.brand_id<>NEW.brand_id OR matched.store_id<>NEW.store_id
  OR matched.candidate_id<>NEW.candidate_id
  OR matched.reconciliation_run_id<>NEW.reconciliation_run_id
  OR matched.mode<>'DailySettlement' OR matched.outcome<>'Matched'
  OR matched.checked_at<opened OR NEW.resolved_at<>matched.checked_at THEN
  RAISE EXCEPTION 'reconciliation resolution needs a later matching settlement check of the same day' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION rms_payment.check_payment_reconciliation_resolution() FROM PUBLIC;
CREATE TRIGGER payment_reconciliation_resolution_check BEFORE INSERT ON rms_payment.payment_reconciliation_resolution
 FOR EACH ROW EXECUTE FUNCTION rms_payment.check_payment_reconciliation_resolution();

CREATE FUNCTION rms_payment.reject_payment_reconciliation_resolution_mutation() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
BEGIN
 RAISE EXCEPTION 'append-only reconciliation resolution' USING ERRCODE='55000';
END;
$$;
REVOKE ALL ON FUNCTION rms_payment.reject_payment_reconciliation_resolution_mutation() FROM PUBLIC;
CREATE TRIGGER payment_reconciliation_resolution_no_mutation BEFORE UPDATE OR DELETE ON rms_payment.payment_reconciliation_resolution
 FOR EACH ROW EXECUTE FUNCTION rms_payment.reject_payment_reconciliation_resolution_mutation();
CREATE TRIGGER payment_reconciliation_resolution_no_truncate BEFORE TRUNCATE ON rms_payment.payment_reconciliation_resolution
 FOR EACH STATEMENT EXECUTE FUNCTION rms_payment.reject_payment_reconciliation_resolution_mutation();
ALTER TABLE rms_payment.payment_reconciliation_resolution ENABLE ROW LEVEL SECURITY;
ALTER TABLE rms_payment.payment_reconciliation_resolution FORCE ROW LEVEL SECURITY;
CREATE POLICY payment_reconciliation_resolution_scope ON rms_payment.payment_reconciliation_resolution
 USING (brand_id=platform_helpers.current_brand_id() AND store_id=platform_helpers.current_store_id())
 WITH CHECK (brand_id=platform_helpers.current_brand_id() AND store_id=platform_helpers.current_store_id());
REVOKE ALL ON TABLE rms_payment.payment_reconciliation_resolution FROM PUBLIC;
