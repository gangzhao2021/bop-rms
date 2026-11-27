-- bop-rms-migration: 1
-- owner: @rms/payment
-- schema: rms_payment
-- phase: expand
-- risk: medium
-- transaction: required
-- lock-timeout-ms: 5000
-- statement-timeout-ms: 60000
-- recovery: forward-fix
-- WP-2423 DEC-DINE-IN-PAY-LATER S4 (decisions 3-5): a guest pays the whole table on their phone.
-- One Provider transaction per attempt (`dining_table_online_payment`, created with the Provider
-- before it is recorded) and its outcome as the Provider reports it (captured, failed or
-- cancelled). A captured attempt becomes the table's one settlement (method 'Online', split by
-- round under its settlement number, tip on the last round), so reports, refunds and
-- reconciliation read it like the table's other payments.
-- While an attempt is open (no outcome yet) staff can't record a card-machine or cash payment
-- or a write-off for the table, and only one attempt is open at a time; a failed or cancelled one
-- is followed by another. All under the Order's lock (as 2000_101). Append-only, RLS.
-- Grants: api SELECT/INSERT on both tables (Owner standing approval 2026-10-14, WP-2423).
CREATE TABLE rms_payment.dining_table_online_payment (
 online_payment_id platform_helpers.uuid_v7 PRIMARY KEY,
 tenant_id platform_helpers.uuid_v7 NOT NULL,
 brand_id platform_helpers.uuid_v7 NOT NULL,
 store_id platform_helpers.uuid_v7 NOT NULL,
 operation_id platform_helpers.uuid_v7 NOT NULL,
 intent_digest text NOT NULL CHECK (intent_digest ~ '^sha256:[0-9a-f]{64}$'),
 dining_session_id platform_helpers.uuid_v7 NOT NULL,
 order_id platform_helpers.uuid_v7 NOT NULL,
 guest_session_id platform_helpers.uuid_v7 NOT NULL,
 rounds_minor bigint NOT NULL CHECK (rounds_minor > 0),
 tip_minor bigint NOT NULL CHECK (tip_minor >= 0),
 total_minor bigint NOT NULL CHECK (total_minor > 0),
 currency_code text NOT NULL CHECK (currency_code = 'CAD'),
 provider_account_id platform_helpers.uuid_v7 NOT NULL,
 payment_environment text NOT NULL CHECK (payment_environment IN ('Test','Live')),
 provider_intent_reference text NOT NULL CHECK (provider_intent_reference ~ '^pi_[A-Za-z0-9]{1,250}$'),
 created_at timestamptz NOT NULL CHECK (isfinite(created_at) AND created_at=date_trunc('milliseconds',created_at)),
 audit_id platform_helpers.uuid_v7 NOT NULL UNIQUE,
 CONSTRAINT dining_table_online_payment_operation UNIQUE (brand_id,store_id,operation_id),
 CONSTRAINT dining_table_online_payment_intent UNIQUE (provider_account_id,payment_environment,provider_intent_reference),
 CONSTRAINT dining_table_online_payment_amounts CHECK (
  total_minor::numeric = rounds_minor::numeric + tip_minor::numeric
 )
);
CREATE INDEX dining_table_online_payment_order_idx
 ON rms_payment.dining_table_online_payment (brand_id,store_id,order_id);

CREATE TABLE rms_payment.dining_table_online_payment_outcome (
 online_payment_id platform_helpers.uuid_v7 PRIMARY KEY
  REFERENCES rms_payment.dining_table_online_payment(online_payment_id),
 brand_id platform_helpers.uuid_v7 NOT NULL,
 store_id platform_helpers.uuid_v7 NOT NULL,
 order_id platform_helpers.uuid_v7 NOT NULL,
 status text NOT NULL CHECK (status IN ('Captured','Failed','Cancelled')),
 captured_minor bigint,
 provider_transaction_reference text CHECK (provider_transaction_reference ~ '^[A-Za-z0-9_]{1,255}$'),
 occurred_at timestamptz NOT NULL CHECK (isfinite(occurred_at) AND occurred_at=date_trunc('milliseconds',occurred_at)),
 recorded_at timestamptz NOT NULL CHECK (isfinite(recorded_at) AND recorded_at=date_trunc('milliseconds',recorded_at)),
 audit_id platform_helpers.uuid_v7 NOT NULL UNIQUE,
 CONSTRAINT dining_table_online_payment_outcome_shape CHECK (
  (status = 'Captured' AND captured_minor IS NOT NULL AND provider_transaction_reference IS NOT NULL)
  OR (status <> 'Captured' AND captured_minor IS NULL)
 ),
 CONSTRAINT dining_table_online_payment_outcome_time CHECK (occurred_at <= recorded_at)
);
CREATE INDEX dining_table_online_payment_outcome_occurred_idx
 ON rms_payment.dining_table_online_payment_outcome (brand_id,store_id,occurred_at);

-- The table's one settlement may be the captured online payment.
ALTER TABLE rms_payment.dining_table_settlement
 ADD COLUMN online_payment_id platform_helpers.uuid_v7 UNIQUE
  REFERENCES rms_payment.dining_table_online_payment(online_payment_id);
ALTER TABLE rms_payment.dining_table_settlement DROP CONSTRAINT dining_table_settlement_method_check;
ALTER TABLE rms_payment.dining_table_settlement
 ADD CONSTRAINT dining_table_settlement_method_check CHECK (method IN ('CardMachine','Cash','Online'));
ALTER TABLE rms_payment.dining_table_settlement DROP CONSTRAINT dining_table_settlement_tender;
ALTER TABLE rms_payment.dining_table_settlement ADD CONSTRAINT dining_table_settlement_tender CHECK (
 (method = 'Cash' AND tendered_minor IS NOT NULL AND change_minor IS NOT NULL
  AND tendered_minor >= total_minor AND change_minor = tendered_minor - total_minor
  AND total_minor % 5 = 0 AND slip_reference IS NULL AND online_payment_id IS NULL)
 OR (method = 'CardMachine' AND tendered_minor IS NULL AND change_minor IS NULL AND rounding_minor = 0
  AND online_payment_id IS NULL)
 OR (method = 'Online' AND tendered_minor IS NULL AND change_minor IS NULL AND rounding_minor = 0
  AND slip_reference IS NULL AND online_payment_id IS NOT NULL AND recording_reason = 'AtTable')
);

-- An online payment is recorded when the Provider reports the capture, at the capture's time.
ALTER TABLE rms_payment.dining_table_settlement DROP CONSTRAINT dining_table_settlement_time;
ALTER TABLE rms_payment.dining_table_settlement ADD CONSTRAINT dining_table_settlement_time CHECK (
 taken_at <= recorded_at
 AND taken_at >= recorded_at - interval '72 hours'
 AND (recording_reason = 'RecordedAfterOutage' OR taken_at = recorded_at OR method = 'Online')
);

-- An attempt matches its table and is the only open one; an outcome is the attempt's, once; a
-- payment, write-off or online settlement is refused while the guest's attempt is open (or, for
-- an online settlement, unless it is that attempt, captured for exactly its total).
CREATE OR REPLACE FUNCTION rms_payment.check_dining_table_paid_or_written_off() RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
 attempt rms_payment.dining_table_online_payment%ROWTYPE;
 outcome rms_payment.dining_table_online_payment_outcome%ROWTYPE;
 open_attempt boolean;
BEGIN
 PERFORM pg_advisory_xact_lock(hashtextextended('DiningTablePaidOrWrittenOff:'||NEW.brand_id||':'||NEW.store_id||':'||NEW.order_id,0));
 SELECT EXISTS (SELECT 1 FROM rms_payment.dining_table_online_payment p
   WHERE p.brand_id=NEW.brand_id AND p.store_id=NEW.store_id AND p.order_id=NEW.order_id
   AND NOT EXISTS (SELECT 1 FROM rms_payment.dining_table_online_payment_outcome o
     WHERE o.online_payment_id=p.online_payment_id)) INTO open_attempt;
 IF TG_TABLE_NAME IN ('dining_table_settlement','dining_table_online_payment') AND EXISTS (
   SELECT 1 FROM rms_payment.order_unpaid_write_off w WHERE w.brand_id=NEW.brand_id
    AND w.store_id=NEW.store_id AND w.order_id=NEW.order_id) THEN
  RAISE EXCEPTION 'the table''s bill was written off' USING ERRCODE='23514';
 END IF;
 IF TG_TABLE_NAME IN ('order_unpaid_write_off','dining_table_online_payment') AND EXISTS (
   SELECT 1 FROM rms_payment.dining_table_settlement s WHERE s.brand_id=NEW.brand_id
    AND s.store_id=NEW.store_id AND s.order_id=NEW.order_id) THEN
  RAISE EXCEPTION 'the table already paid' USING ERRCODE='23514';
 END IF;
 IF TG_TABLE_NAME = 'dining_table_online_payment' AND open_attempt THEN
  RAISE EXCEPTION 'a guest is already paying for the table' USING ERRCODE='23514';
 END IF;
 IF TG_TABLE_NAME = 'order_unpaid_write_off' AND open_attempt THEN
  RAISE EXCEPTION 'a guest is paying for the table on their phone' USING ERRCODE='23514';
 END IF;
 IF TG_TABLE_NAME = 'dining_table_settlement' THEN
  IF NEW.method <> 'Online' AND open_attempt THEN
   RAISE EXCEPTION 'a guest is paying for the table on their phone' USING ERRCODE='23514';
  END IF;
  IF NEW.method = 'Online' THEN
   SELECT * INTO attempt FROM rms_payment.dining_table_online_payment WHERE online_payment_id=NEW.online_payment_id;
   SELECT * INTO outcome FROM rms_payment.dining_table_online_payment_outcome WHERE online_payment_id=NEW.online_payment_id;
   IF attempt.online_payment_id IS NULL OR outcome.status IS DISTINCT FROM 'Captured'
    OR attempt.tenant_id<>NEW.tenant_id OR attempt.brand_id<>NEW.brand_id OR attempt.store_id<>NEW.store_id
    OR attempt.order_id<>NEW.order_id OR attempt.dining_session_id<>NEW.dining_session_id
    OR attempt.rounds_minor<>NEW.rounds_minor OR attempt.tip_minor<>NEW.tip_minor
    OR attempt.total_minor<>NEW.total_minor OR outcome.captured_minor<>NEW.total_minor
    OR attempt.payment_environment<>NEW.payment_environment OR NEW.taken_at<>outcome.occurred_at THEN
    RAISE EXCEPTION 'online settlement does not match the captured payment' USING ERRCODE='23514';
   END IF;
  END IF;
 END IF;
 RETURN NEW;
END;
$$;
CREATE TRIGGER dining_table_online_payment_one_open BEFORE INSERT ON rms_payment.dining_table_online_payment
 FOR EACH ROW EXECUTE FUNCTION rms_payment.check_dining_table_paid_or_written_off();

CREATE FUNCTION rms_payment.validate_dining_table_online_payment_outcome() RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
 attempt rms_payment.dining_table_online_payment%ROWTYPE;
BEGIN
 SELECT * INTO attempt FROM rms_payment.dining_table_online_payment WHERE online_payment_id=NEW.online_payment_id;
 IF NOT FOUND OR attempt.brand_id<>NEW.brand_id OR attempt.store_id<>NEW.store_id
  OR attempt.order_id<>NEW.order_id OR NEW.occurred_at < attempt.created_at - interval '1 minute'
  OR (NEW.status = 'Captured' AND NEW.captured_minor<>attempt.total_minor) THEN
  RAISE EXCEPTION 'online payment outcome does not match its payment' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION rms_payment.validate_dining_table_online_payment_outcome() FROM PUBLIC;
CREATE TRIGGER dining_table_online_payment_outcome_validate BEFORE INSERT ON rms_payment.dining_table_online_payment_outcome
 FOR EACH ROW EXECUTE FUNCTION rms_payment.validate_dining_table_online_payment_outcome();

CREATE TRIGGER dining_table_online_payment_no_mutation BEFORE UPDATE OR DELETE ON rms_payment.dining_table_online_payment
 FOR EACH ROW EXECUTE FUNCTION rms_payment.reject_dining_table_settlement_mutation();
CREATE TRIGGER dining_table_online_payment_no_truncate BEFORE TRUNCATE ON rms_payment.dining_table_online_payment
 FOR EACH STATEMENT EXECUTE FUNCTION rms_payment.reject_dining_table_settlement_mutation();
CREATE TRIGGER dining_table_online_payment_outcome_no_mutation BEFORE UPDATE OR DELETE ON rms_payment.dining_table_online_payment_outcome
 FOR EACH ROW EXECUTE FUNCTION rms_payment.reject_dining_table_settlement_mutation();
CREATE TRIGGER dining_table_online_payment_outcome_no_truncate BEFORE TRUNCATE ON rms_payment.dining_table_online_payment_outcome
 FOR EACH STATEMENT EXECUTE FUNCTION rms_payment.reject_dining_table_settlement_mutation();
ALTER TABLE rms_payment.dining_table_online_payment ENABLE ROW LEVEL SECURITY;
ALTER TABLE rms_payment.dining_table_online_payment FORCE ROW LEVEL SECURITY;
CREATE POLICY dining_table_online_payment_scope ON rms_payment.dining_table_online_payment
 USING (brand_id=platform_helpers.current_brand_id() AND store_id=platform_helpers.current_store_id())
 WITH CHECK (brand_id=platform_helpers.current_brand_id() AND store_id=platform_helpers.current_store_id());
ALTER TABLE rms_payment.dining_table_online_payment_outcome ENABLE ROW LEVEL SECURITY;
ALTER TABLE rms_payment.dining_table_online_payment_outcome FORCE ROW LEVEL SECURITY;
CREATE POLICY dining_table_online_payment_outcome_scope ON rms_payment.dining_table_online_payment_outcome
 USING (brand_id=platform_helpers.current_brand_id() AND store_id=platform_helpers.current_store_id())
 WITH CHECK (brand_id=platform_helpers.current_brand_id() AND store_id=platform_helpers.current_store_id());
REVOKE ALL ON TABLE rms_payment.dining_table_online_payment FROM PUBLIC;
REVOKE ALL ON TABLE rms_payment.dining_table_online_payment_outcome FROM PUBLIC;
