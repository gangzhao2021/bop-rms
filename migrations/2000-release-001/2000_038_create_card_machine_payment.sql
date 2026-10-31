-- bop-rms-migration: 1
-- owner: @rms/payment
-- schema: rms_payment
-- phase: expand
-- risk: medium
-- transaction: required
-- lock-timeout-ms: 5000
-- statement-timeout-ms: 60000
-- recovery: forward-fix
-- WP-2423 Q7 (DEC-COUNTER-PAYMENT-RECORD): a staff-taken order may be paid on the Store's own card
-- machine. Staff record the payment after the machine approved it: the amount is the server's
-- payment preparation total (quote incl. tax, plus the tip choice), never typed by staff. An
-- optional slip reference (the last part of the machine's slip, never a card number) helps match
-- the machine's batch total at day end. A paper order taken while the system was unreachable is
-- recorded afterwards with the time it was actually paid and the reason RecordedAfterOutage.
-- A refund of such a payment is made on the same machine and recorded here; no Provider is called.
-- Both records are append-only; corrections are new records.
CREATE FUNCTION rms_payment.reject_card_machine_mutation() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
BEGIN
 RAISE EXCEPTION 'append-only card machine payment or refund' USING ERRCODE='55000';
END;
$$;
REVOKE ALL ON FUNCTION rms_payment.reject_card_machine_mutation() FROM PUBLIC;

CREATE TABLE rms_payment.card_machine_payment (
 tenant_id platform_helpers.uuid_v7 NOT NULL,
 brand_id platform_helpers.uuid_v7 NOT NULL,
 store_id platform_helpers.uuid_v7 NOT NULL,
 card_machine_payment_id platform_helpers.uuid_v7 NOT NULL,
 payment_intent_id platform_helpers.uuid_v7 NOT NULL,
 payment_attempt_id platform_helpers.uuid_v7 NOT NULL,
 payment_operation_id platform_helpers.uuid_v7 NOT NULL,
 operation_id platform_helpers.uuid_v7 NOT NULL,
 intent_digest text NOT NULL CHECK (intent_digest ~ '^sha256:[0-9a-f]{64}$'),
 order_id platform_helpers.uuid_v7 NOT NULL,
 order_batch_id platform_helpers.uuid_v7 NOT NULL,
 submission_id platform_helpers.uuid_v7 NOT NULL,
 preparation_json jsonb NOT NULL CHECK (jsonb_typeof(preparation_json)='object'),
 order_allocation_minor bigint NOT NULL CHECK (order_allocation_minor > 0),
 tip_minor bigint NOT NULL CHECK (tip_minor >= 0),
 total_minor bigint NOT NULL CHECK (total_minor > 0 AND total_minor = order_allocation_minor + tip_minor),
 currency_code text NOT NULL CHECK (currency_code = 'CAD'),
 payment_environment text NOT NULL CHECK (payment_environment IN ('Test','Live')),
 slip_reference text CHECK (
  slip_reference ~ '^[A-Za-z0-9][A-Za-z0-9 #./-]{0,39}$'
  AND char_length(regexp_replace(slip_reference,'[^0-9]','','g')) <= 12
 ),
 recording_reason text NOT NULL CHECK (recording_reason IN ('AtCounter','RecordedAfterOutage')),
 taken_at timestamptz NOT NULL CHECK (isfinite(taken_at) AND taken_at=date_trunc('milliseconds',taken_at)),
 recorded_at timestamptz NOT NULL CHECK (isfinite(recorded_at) AND recorded_at=date_trunc('milliseconds',recorded_at)),
 actor_id platform_helpers.uuid_v7 NOT NULL,
 event_id platform_helpers.uuid_v7 NOT NULL UNIQUE,
 audit_id platform_helpers.uuid_v7 NOT NULL UNIQUE,
 PRIMARY KEY (brand_id,store_id,card_machine_payment_id),
 CONSTRAINT card_machine_payment_intent_unique UNIQUE (payment_intent_id),
 CONSTRAINT card_machine_payment_attempt_unique UNIQUE (payment_attempt_id),
 CONSTRAINT card_machine_payment_operation_unique UNIQUE (brand_id,store_id,operation_id),
 CONSTRAINT card_machine_payment_payment_operation_unique UNIQUE (brand_id,store_id,payment_operation_id),
 CONSTRAINT card_machine_payment_batch_unique UNIQUE (brand_id,store_id,order_id,order_batch_id),
 CONSTRAINT card_machine_payment_time_check CHECK (
  taken_at <= recorded_at
  AND taken_at >= recorded_at - interval '72 hours'
  AND (recording_reason = 'RecordedAfterOutage' OR taken_at = recorded_at)
 )
);
CREATE INDEX card_machine_payment_order_idx
 ON rms_payment.card_machine_payment (brand_id,store_id,order_id);
CREATE INDEX card_machine_payment_recorded_idx
 ON rms_payment.card_machine_payment (brand_id,store_id,recorded_at);

-- One way to pay a Batch: a card-machine record never joins an online Payment Intent of the same
-- Batch, and an online Payment Intent is never created once the Batch was paid on the machine.
CREATE FUNCTION rms_payment.check_card_machine_payment_exclusive() RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
BEGIN
 PERFORM pg_advisory_xact_lock(hashtextextended('CardMachineBatch:'||NEW.brand_id||':'||NEW.store_id||':'||NEW.order_batch_id,0));
 IF TG_TABLE_NAME = 'card_machine_payment' THEN
  IF EXISTS (SELECT 1 FROM rms_payment.payment_intent i WHERE i.brand_id=NEW.brand_id
   AND i.store_id=NEW.store_id AND i.order_id=NEW.order_id AND i.order_batch_id=NEW.order_batch_id) THEN
   RAISE EXCEPTION 'batch already has an online payment' USING ERRCODE='23514';
  END IF;
  IF (NEW.preparation_json->>'orderReference') IS DISTINCT FROM NEW.order_id::text
   OR (NEW.preparation_json->>'orderBatchReference') IS DISTINCT FROM NEW.order_batch_id::text
   OR (NEW.preparation_json->>'submissionReference') IS DISTINCT FROM NEW.submission_id::text
   OR (NEW.preparation_json->>'brandReference') IS DISTINCT FROM NEW.brand_id::text
   OR (NEW.preparation_json->>'storeReference') IS DISTINCT FROM NEW.store_id::text
   OR (NEW.preparation_json#>>'{total,amountMinor}') IS DISTINCT FROM NEW.total_minor::text
   OR (NEW.preparation_json#>>'{tip,amountMinor}') IS DISTINCT FROM NEW.tip_minor::text
   OR (NEW.preparation_json#>>'{orderAllocation,amountMinor}') IS DISTINCT FROM NEW.order_allocation_minor::text THEN
   RAISE EXCEPTION 'card machine payment does not match its preparation' USING ERRCODE='23514';
  END IF;
 ELSIF EXISTS (SELECT 1 FROM rms_payment.card_machine_payment c WHERE c.brand_id=NEW.brand_id
   AND c.store_id=NEW.store_id AND c.order_id=NEW.order_id AND c.order_batch_id=NEW.order_batch_id) THEN
  RAISE EXCEPTION 'batch was paid on the card machine' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION rms_payment.check_card_machine_payment_exclusive() FROM PUBLIC;
CREATE TRIGGER card_machine_payment_exclusive BEFORE INSERT ON rms_payment.card_machine_payment
 FOR EACH ROW EXECUTE FUNCTION rms_payment.check_card_machine_payment_exclusive();
CREATE TRIGGER payment_intent_card_machine_exclusive BEFORE INSERT ON rms_payment.payment_intent
 FOR EACH ROW EXECUTE FUNCTION rms_payment.check_card_machine_payment_exclusive();

CREATE TRIGGER card_machine_payment_no_mutation BEFORE UPDATE OR DELETE ON rms_payment.card_machine_payment
 FOR EACH ROW EXECUTE FUNCTION rms_payment.reject_card_machine_mutation();
CREATE TRIGGER card_machine_payment_no_truncate BEFORE TRUNCATE ON rms_payment.card_machine_payment
 FOR EACH STATEMENT EXECUTE FUNCTION rms_payment.reject_card_machine_mutation();
ALTER TABLE rms_payment.card_machine_payment ENABLE ROW LEVEL SECURITY;
ALTER TABLE rms_payment.card_machine_payment FORCE ROW LEVEL SECURITY;
CREATE POLICY card_machine_payment_scope ON rms_payment.card_machine_payment
 USING (brand_id=platform_helpers.current_brand_id() AND store_id=platform_helpers.current_store_id())
 WITH CHECK (brand_id=platform_helpers.current_brand_id() AND store_id=platform_helpers.current_store_id());
REVOKE ALL ON TABLE rms_payment.card_machine_payment FROM PUBLIC;

-- A refund made on the Store's card machine. The source names why: a staff cancellation of the
-- whole Order/Batch (Q6), a staff cancellation of item lines, a paid order the Store could not
-- fulfil (Ordering's PaidWithoutFulfillableOrder disposition), or an ordinary refund request that
-- went through the Q5 rules (request, and approval where required). Refunds of one payment never
-- exceed what it took.
CREATE TABLE rms_payment.card_machine_refund (
 tenant_id platform_helpers.uuid_v7 NOT NULL,
 brand_id platform_helpers.uuid_v7 NOT NULL,
 store_id platform_helpers.uuid_v7 NOT NULL,
 card_machine_refund_id platform_helpers.uuid_v7 NOT NULL,
 card_machine_payment_id platform_helpers.uuid_v7 NOT NULL,
 order_id platform_helpers.uuid_v7 NOT NULL,
 operation_id platform_helpers.uuid_v7 NOT NULL,
 intent_digest text NOT NULL CHECK (intent_digest ~ '^sha256:[0-9a-f]{64}$'),
 source_kind text NOT NULL CHECK (source_kind IN ('StaffCancellation','ItemCancellation','UnfulfillableOrder','OrdinaryRefund')),
 source_id platform_helpers.uuid_v7 NOT NULL,
 amount_minor bigint NOT NULL CHECK (amount_minor > 0),
 currency_code text NOT NULL CHECK (currency_code = 'CAD'),
 slip_reference text CHECK (
  slip_reference ~ '^[A-Za-z0-9][A-Za-z0-9 #./-]{0,39}$'
  AND char_length(regexp_replace(slip_reference,'[^0-9]','','g')) <= 12
 ),
 refunded_at timestamptz NOT NULL CHECK (isfinite(refunded_at) AND refunded_at=date_trunc('milliseconds',refunded_at)),
 recorded_at timestamptz NOT NULL CHECK (isfinite(recorded_at) AND recorded_at=date_trunc('milliseconds',recorded_at)),
 actor_id platform_helpers.uuid_v7 NOT NULL,
 audit_id platform_helpers.uuid_v7 NOT NULL UNIQUE,
 PRIMARY KEY (brand_id,store_id,card_machine_refund_id),
 CONSTRAINT card_machine_refund_operation_unique UNIQUE (brand_id,store_id,operation_id),
 CONSTRAINT card_machine_refund_source_unique UNIQUE (brand_id,store_id,source_kind,source_id),
 CONSTRAINT card_machine_refund_payment_fk FOREIGN KEY (brand_id,store_id,card_machine_payment_id)
  REFERENCES rms_payment.card_machine_payment (brand_id,store_id,card_machine_payment_id),
 CONSTRAINT card_machine_refund_time_check CHECK (
  refunded_at <= recorded_at AND refunded_at >= recorded_at - interval '72 hours'
 )
);
CREATE INDEX card_machine_refund_payment_idx
 ON rms_payment.card_machine_refund (brand_id,store_id,card_machine_payment_id);
CREATE INDEX card_machine_refund_recorded_idx
 ON rms_payment.card_machine_refund (brand_id,store_id,recorded_at);

CREATE FUNCTION rms_payment.check_card_machine_refund() RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE paid rms_payment.card_machine_payment%ROWTYPE;
DECLARE refunded bigint;
BEGIN
 PERFORM pg_advisory_xact_lock(hashtextextended('CardMachineRefund:'||NEW.brand_id||':'||NEW.store_id||':'||NEW.card_machine_payment_id,0));
 SELECT * INTO paid FROM rms_payment.card_machine_payment
  WHERE brand_id=NEW.brand_id AND store_id=NEW.store_id AND card_machine_payment_id=NEW.card_machine_payment_id;
 IF NOT FOUND OR paid.order_id<>NEW.order_id OR paid.tenant_id<>NEW.tenant_id
  OR NEW.refunded_at < paid.taken_at THEN
  RAISE EXCEPTION 'card machine refund does not match its payment' USING ERRCODE='23514';
 END IF;
 SELECT COALESCE(sum(amount_minor),0) INTO refunded FROM rms_payment.card_machine_refund
  WHERE brand_id=NEW.brand_id AND store_id=NEW.store_id AND card_machine_payment_id=NEW.card_machine_payment_id;
 IF refunded + NEW.amount_minor > paid.total_minor THEN
  RAISE EXCEPTION 'card machine refund exceeds the payment' USING ERRCODE='23514';
 END IF;
 IF NEW.source_kind = 'OrdinaryRefund' AND NOT EXISTS (
  SELECT 1 FROM rms_payment.ordinary_refund_request r WHERE r.brand_id=NEW.brand_id
   AND r.store_id=NEW.store_id AND r.request_id=NEW.source_id AND r.order_id=NEW.order_id) THEN
  RAISE EXCEPTION 'ordinary refund request missing' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION rms_payment.check_card_machine_refund() FROM PUBLIC;
CREATE TRIGGER card_machine_refund_check BEFORE INSERT ON rms_payment.card_machine_refund
 FOR EACH ROW EXECUTE FUNCTION rms_payment.check_card_machine_refund();
CREATE TRIGGER card_machine_refund_no_mutation BEFORE UPDATE OR DELETE ON rms_payment.card_machine_refund
 FOR EACH ROW EXECUTE FUNCTION rms_payment.reject_card_machine_mutation();
CREATE TRIGGER card_machine_refund_no_truncate BEFORE TRUNCATE ON rms_payment.card_machine_refund
 FOR EACH STATEMENT EXECUTE FUNCTION rms_payment.reject_card_machine_mutation();
ALTER TABLE rms_payment.card_machine_refund ENABLE ROW LEVEL SECURITY;
ALTER TABLE rms_payment.card_machine_refund FORCE ROW LEVEL SECURITY;
CREATE POLICY card_machine_refund_scope ON rms_payment.card_machine_refund
 USING (brand_id=platform_helpers.current_brand_id() AND store_id=platform_helpers.current_store_id())
 WITH CHECK (brand_id=platform_helpers.current_brand_id() AND store_id=platform_helpers.current_store_id());
REVOKE ALL ON TABLE rms_payment.card_machine_refund FROM PUBLIC;
