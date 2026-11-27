-- bop-rms-migration: 1
-- owner: @rms/payment
-- schema: rms_payment
-- phase: expand
-- risk: medium
-- transaction: required
-- lock-timeout-ms: 5000
-- statement-timeout-ms: 60000
-- recovery: forward-fix
-- WP-2423 DEC-DINE-IN-PAY-LATER (Owner 2026-10-26, cash 2026-10-27): a table opened "pay later"
-- pays once at the end. A settlement is that one payment — recorded on the Store's card machine
-- after it approved, or taken in cash — split into one line per round the table owed, joined by
-- the settlement's reference. Each line takes its round's total (tax included); the tip and, for
-- cash only, the rounding to 5 cents go on one line (the last round). The rounding is its own
-- amount (prices, tax and sales are unchanged); cash records what was handed over and the change.
-- An unpaid-departure write-off is a manager's recorded decision that a table left without paying
-- what it still owed, with its reason: the sale stays on the books as owed and written off.
-- All three are append-only; corrections are new records.
-- Grants: api SELECT/INSERT (Owner standing approval 2026-10-14, WP-2423).
CREATE FUNCTION rms_payment.reject_dining_table_settlement_mutation() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
BEGIN
 RAISE EXCEPTION 'append-only table settlement or write-off' USING ERRCODE='55000';
END;
$$;
REVOKE ALL ON FUNCTION rms_payment.reject_dining_table_settlement_mutation() FROM PUBLIC;

CREATE TABLE rms_payment.dining_table_settlement (
 settlement_id platform_helpers.uuid_v7 PRIMARY KEY,
 tenant_id platform_helpers.uuid_v7 NOT NULL,
 brand_id platform_helpers.uuid_v7 NOT NULL,
 store_id platform_helpers.uuid_v7 NOT NULL,
 operation_id platform_helpers.uuid_v7 NOT NULL,
 intent_digest text NOT NULL CHECK (intent_digest ~ '^sha256:[0-9a-f]{64}$'),
 dining_session_id platform_helpers.uuid_v7 NOT NULL,
 order_id platform_helpers.uuid_v7 NOT NULL,
 method text NOT NULL CHECK (method IN ('CardMachine','Cash')),
 rounds_minor bigint NOT NULL CHECK (rounds_minor > 0),
 tip_minor bigint NOT NULL CHECK (tip_minor >= 0),
 rounding_minor bigint NOT NULL CHECK (rounding_minor BETWEEN -2 AND 2),
 total_minor bigint NOT NULL CHECK (total_minor > 0),
 tendered_minor bigint,
 change_minor bigint,
 currency_code text NOT NULL CHECK (currency_code = 'CAD'),
 payment_environment text NOT NULL CHECK (payment_environment IN ('Test','Live')),
 slip_reference text CHECK (
  slip_reference ~ '^[A-Za-z0-9][A-Za-z0-9 #./-]{0,39}$'
  AND char_length(regexp_replace(slip_reference,'[^0-9]','','g')) <= 12
 ),
 recording_reason text NOT NULL CHECK (recording_reason IN ('AtTable','RecordedAfterOutage')),
 taken_at timestamptz NOT NULL CHECK (isfinite(taken_at) AND taken_at=date_trunc('milliseconds',taken_at)),
 recorded_at timestamptz NOT NULL CHECK (isfinite(recorded_at) AND recorded_at=date_trunc('milliseconds',recorded_at)),
 actor_id platform_helpers.uuid_v7 NOT NULL,
 audit_id platform_helpers.uuid_v7 NOT NULL UNIQUE,
 CONSTRAINT dining_table_settlement_operation UNIQUE (brand_id,store_id,operation_id),
 -- One payment per table Order (a split bill is a later decision, never a second settlement).
 CONSTRAINT dining_table_settlement_order UNIQUE (brand_id,store_id,order_id),
 CONSTRAINT dining_table_settlement_amounts CHECK (
  total_minor::numeric = rounds_minor::numeric + tip_minor::numeric + rounding_minor::numeric
 ),
 CONSTRAINT dining_table_settlement_tender CHECK (
  (method = 'Cash' AND tendered_minor IS NOT NULL AND change_minor IS NOT NULL
   AND tendered_minor >= total_minor AND change_minor = tendered_minor - total_minor
   AND total_minor % 5 = 0 AND slip_reference IS NULL)
  OR (method = 'CardMachine' AND tendered_minor IS NULL AND change_minor IS NULL AND rounding_minor = 0)
 ),
 CONSTRAINT dining_table_settlement_time CHECK (
  taken_at <= recorded_at
  AND taken_at >= recorded_at - interval '72 hours'
  AND (recording_reason = 'RecordedAfterOutage' OR taken_at = recorded_at)
 )
);
CREATE INDEX dining_table_settlement_session_idx
 ON rms_payment.dining_table_settlement (brand_id,store_id,dining_session_id);
CREATE INDEX dining_table_settlement_recorded_idx
 ON rms_payment.dining_table_settlement (brand_id,store_id,recorded_at);

CREATE TABLE rms_payment.dining_table_settlement_round (
 settlement_id platform_helpers.uuid_v7 NOT NULL REFERENCES rms_payment.dining_table_settlement(settlement_id),
 brand_id platform_helpers.uuid_v7 NOT NULL,
 store_id platform_helpers.uuid_v7 NOT NULL,
 order_id platform_helpers.uuid_v7 NOT NULL,
 order_batch_id platform_helpers.uuid_v7 NOT NULL,
 submission_id platform_helpers.uuid_v7 NOT NULL,
 line_number integer NOT NULL CHECK (line_number BETWEEN 1 AND 200),
 round_minor bigint NOT NULL CHECK (round_minor > 0),
 tip_minor bigint NOT NULL CHECK (tip_minor >= 0),
 rounding_minor bigint NOT NULL CHECK (rounding_minor BETWEEN -2 AND 2),
 PRIMARY KEY (settlement_id,order_batch_id),
 CONSTRAINT dining_table_settlement_round_line UNIQUE (settlement_id,line_number),
 -- A round is paid once, by one settlement.
 CONSTRAINT dining_table_settlement_round_batch UNIQUE (brand_id,store_id,order_batch_id)
);

-- The lines of a settlement are its rounds of the same Order; together they come to its amounts,
-- and the tip and the rounding are on the last line only. Checked when the transaction commits.
CREATE FUNCTION rms_payment.validate_dining_table_settlement() RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
 header rms_payment.dining_table_settlement%ROWTYPE;
 sums record;
BEGIN
 SELECT * INTO header FROM rms_payment.dining_table_settlement WHERE settlement_id=NEW.settlement_id;
 SELECT count(*) AS lines, max(line_number) AS last, coalesce(sum(round_minor),0) AS rounds,
   coalesce(sum(tip_minor),0) AS tip, coalesce(sum(rounding_minor),0) AS rounding,
   count(*) FILTER (WHERE (tip_minor<>0 OR rounding_minor<>0)
     AND line_number<>(SELECT max(line_number) FROM rms_payment.dining_table_settlement_round r2
                       WHERE r2.settlement_id=NEW.settlement_id)) AS misplaced,
   bool_and(brand_id=header.brand_id AND store_id=header.store_id AND order_id=header.order_id) AS same_order
  INTO sums FROM rms_payment.dining_table_settlement_round WHERE settlement_id=NEW.settlement_id;
 IF header.settlement_id IS NULL OR sums.lines < 1 OR sums.last<>sums.lines OR NOT sums.same_order
  OR sums.rounds<>header.rounds_minor OR sums.tip<>header.tip_minor
  OR sums.rounding<>header.rounding_minor OR sums.misplaced<>0 THEN
  RAISE EXCEPTION 'table settlement lines do not match the settlement' USING ERRCODE='23514';
 END IF;
 RETURN NULL;
END;
$$;
REVOKE ALL ON FUNCTION rms_payment.validate_dining_table_settlement() FROM PUBLIC;
CREATE CONSTRAINT TRIGGER dining_table_settlement_complete AFTER INSERT ON rms_payment.dining_table_settlement
 DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION rms_payment.validate_dining_table_settlement();
CREATE CONSTRAINT TRIGGER dining_table_settlement_round_complete AFTER INSERT ON rms_payment.dining_table_settlement_round
 DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION rms_payment.validate_dining_table_settlement();

-- One way to pay a round: never a settlement line for a round paid online or on the card machine.
CREATE FUNCTION rms_payment.check_dining_table_settlement_exclusive() RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
BEGIN
 PERFORM pg_advisory_xact_lock(hashtextextended('CardMachineBatch:'||NEW.brand_id||':'||NEW.store_id||':'||NEW.order_batch_id,0));
 IF TG_TABLE_NAME = 'dining_table_settlement_round' THEN
  IF EXISTS (SELECT 1 FROM rms_payment.payment_intent i WHERE i.brand_id=NEW.brand_id
    AND i.store_id=NEW.store_id AND i.order_id=NEW.order_id AND i.order_batch_id=NEW.order_batch_id)
  OR EXISTS (SELECT 1 FROM rms_payment.card_machine_payment c WHERE c.brand_id=NEW.brand_id
    AND c.store_id=NEW.store_id AND c.order_id=NEW.order_id AND c.order_batch_id=NEW.order_batch_id) THEN
   RAISE EXCEPTION 'round was already paid another way' USING ERRCODE='23514';
  END IF;
 ELSIF EXISTS (SELECT 1 FROM rms_payment.dining_table_settlement_round s WHERE s.brand_id=NEW.brand_id
   AND s.store_id=NEW.store_id AND s.order_batch_id=NEW.order_batch_id) THEN
  RAISE EXCEPTION 'round was paid with the table' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION rms_payment.check_dining_table_settlement_exclusive() FROM PUBLIC;
CREATE TRIGGER dining_table_settlement_round_exclusive BEFORE INSERT ON rms_payment.dining_table_settlement_round
 FOR EACH ROW EXECUTE FUNCTION rms_payment.check_dining_table_settlement_exclusive();
CREATE TRIGGER payment_intent_table_settlement_exclusive BEFORE INSERT ON rms_payment.payment_intent
 FOR EACH ROW EXECUTE FUNCTION rms_payment.check_dining_table_settlement_exclusive();
CREATE TRIGGER card_machine_payment_table_settlement_exclusive BEFORE INSERT ON rms_payment.card_machine_payment
 FOR EACH ROW EXECUTE FUNCTION rms_payment.check_dining_table_settlement_exclusive();

CREATE TABLE rms_payment.order_unpaid_write_off (
 write_off_id platform_helpers.uuid_v7 PRIMARY KEY,
 tenant_id platform_helpers.uuid_v7 NOT NULL,
 brand_id platform_helpers.uuid_v7 NOT NULL,
 store_id platform_helpers.uuid_v7 NOT NULL,
 operation_id platform_helpers.uuid_v7 NOT NULL,
 dining_session_id platform_helpers.uuid_v7 NOT NULL,
 order_id platform_helpers.uuid_v7 NOT NULL,
 order_version integer NOT NULL CHECK (order_version > 0),
 order_checkpoint platform_helpers.uuid_v7 NOT NULL,
 reason_code text NOT NULL CHECK (reason_code IN ('GUEST_LEFT_UNPAID')),
 currency_code text NOT NULL CHECK (currency_code = 'CAD'),
 priced_order_total_minor bigint NOT NULL CHECK (priced_order_total_minor > 0),
 captured_order_allocation_minor bigint NOT NULL CHECK (captured_order_allocation_minor >= 0),
 written_off_minor bigint NOT NULL CHECK (written_off_minor > 0),
 requested_by_actor_id platform_helpers.uuid_v7 NOT NULL,
 approved_by_actor_id platform_helpers.uuid_v7 NOT NULL,
 order_evidence_digest text NOT NULL CHECK (order_evidence_digest ~ '^sha256:[0-9a-f]{64}$'),
 payment_evidence_digest text NOT NULL CHECK (payment_evidence_digest ~ '^sha256:[0-9a-f]{64}$'),
 decided_at timestamptz NOT NULL CHECK (isfinite(decided_at) AND decided_at=date_trunc('milliseconds',decided_at)),
 audit_id platform_helpers.uuid_v7 NOT NULL UNIQUE,
 CONSTRAINT order_unpaid_write_off_operation UNIQUE (brand_id,store_id,operation_id),
 CONSTRAINT order_unpaid_write_off_order UNIQUE (brand_id,store_id,order_id),
 CONSTRAINT order_unpaid_write_off_amount CHECK (
  written_off_minor::numeric = priced_order_total_minor::numeric - captured_order_allocation_minor::numeric
 )
);

CREATE TRIGGER dining_table_settlement_no_mutation BEFORE UPDATE OR DELETE ON rms_payment.dining_table_settlement
 FOR EACH ROW EXECUTE FUNCTION rms_payment.reject_dining_table_settlement_mutation();
CREATE TRIGGER dining_table_settlement_no_truncate BEFORE TRUNCATE ON rms_payment.dining_table_settlement
 FOR EACH STATEMENT EXECUTE FUNCTION rms_payment.reject_dining_table_settlement_mutation();
CREATE TRIGGER dining_table_settlement_round_no_mutation BEFORE UPDATE OR DELETE ON rms_payment.dining_table_settlement_round
 FOR EACH ROW EXECUTE FUNCTION rms_payment.reject_dining_table_settlement_mutation();
CREATE TRIGGER dining_table_settlement_round_no_truncate BEFORE TRUNCATE ON rms_payment.dining_table_settlement_round
 FOR EACH STATEMENT EXECUTE FUNCTION rms_payment.reject_dining_table_settlement_mutation();
CREATE TRIGGER order_unpaid_write_off_no_mutation BEFORE UPDATE OR DELETE ON rms_payment.order_unpaid_write_off
 FOR EACH ROW EXECUTE FUNCTION rms_payment.reject_dining_table_settlement_mutation();
CREATE TRIGGER order_unpaid_write_off_no_truncate BEFORE TRUNCATE ON rms_payment.order_unpaid_write_off
 FOR EACH STATEMENT EXECUTE FUNCTION rms_payment.reject_dining_table_settlement_mutation();

ALTER TABLE rms_payment.dining_table_settlement ENABLE ROW LEVEL SECURITY;
ALTER TABLE rms_payment.dining_table_settlement FORCE ROW LEVEL SECURITY;
CREATE POLICY dining_table_settlement_scope ON rms_payment.dining_table_settlement
 USING (brand_id=platform_helpers.current_brand_id() AND store_id=platform_helpers.current_store_id())
 WITH CHECK (brand_id=platform_helpers.current_brand_id() AND store_id=platform_helpers.current_store_id());
ALTER TABLE rms_payment.dining_table_settlement_round ENABLE ROW LEVEL SECURITY;
ALTER TABLE rms_payment.dining_table_settlement_round FORCE ROW LEVEL SECURITY;
CREATE POLICY dining_table_settlement_round_scope ON rms_payment.dining_table_settlement_round
 USING (brand_id=platform_helpers.current_brand_id() AND store_id=platform_helpers.current_store_id())
 WITH CHECK (brand_id=platform_helpers.current_brand_id() AND store_id=platform_helpers.current_store_id());
ALTER TABLE rms_payment.order_unpaid_write_off ENABLE ROW LEVEL SECURITY;
ALTER TABLE rms_payment.order_unpaid_write_off FORCE ROW LEVEL SECURITY;
CREATE POLICY order_unpaid_write_off_scope ON rms_payment.order_unpaid_write_off
 USING (brand_id=platform_helpers.current_brand_id() AND store_id=platform_helpers.current_store_id())
 WITH CHECK (brand_id=platform_helpers.current_brand_id() AND store_id=platform_helpers.current_store_id());
REVOKE ALL ON TABLE rms_payment.dining_table_settlement FROM PUBLIC;
REVOKE ALL ON TABLE rms_payment.dining_table_settlement_round FROM PUBLIC;
REVOKE ALL ON TABLE rms_payment.order_unpaid_write_off FROM PUBLIC;
