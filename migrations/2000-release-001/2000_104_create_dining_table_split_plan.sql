-- bop-rms-migration: 1
-- owner: @rms/payment
-- schema: rms_payment
-- phase: expand
-- risk: medium
-- transaction: required
-- lock-timeout-ms: 5000
-- statement-timeout-ms: 60000
-- recovery: forward-fix
-- WP-2423 item 8 ④ DEC-DINE-IN-SPLIT-BILL (Owner 2026-10-27 decision 3): a pay-later table's bill
-- split into parts paid one by one — evenly by people, or each part its rounds. The split plan is
-- an append-only, numbered record per Order with its parts and each part's slices of the rounds
-- (amounts computed by the server from the Order). "Whole" records going back to one payment.
-- A new plan is refused once anything was paid, written off, or while a guest's phone payment is
-- open or captured (a failed or cancelled one doesn't lock the split).
-- A table settlement may now be one part of the current split plan: its lines are exactly that
-- part's slices; a part is paid once; a whole-table payment and part payments never mix. A
-- guest's phone payment may be for one part: it blocks only that part. A write-off covers the
-- parts still unpaid (the stores compute the amount; 2000_098's check is unchanged).
-- Grants: api SELECT/INSERT on the three new tables (Owner standing approval 2026-10-14, WP-2423).
CREATE TABLE rms_payment.dining_table_split_plan (
 split_plan_id platform_helpers.uuid_v7 PRIMARY KEY,
 tenant_id platform_helpers.uuid_v7 NOT NULL,
 brand_id platform_helpers.uuid_v7 NOT NULL,
 store_id platform_helpers.uuid_v7 NOT NULL,
 operation_id platform_helpers.uuid_v7 NOT NULL,
 intent_digest text NOT NULL CHECK (intent_digest ~ '^sha256:[0-9a-f]{64}$'),
 dining_session_id platform_helpers.uuid_v7 NOT NULL,
 order_id platform_helpers.uuid_v7 NOT NULL,
 plan_version integer NOT NULL CHECK (plan_version BETWEEN 1 AND 1000),
 mode text NOT NULL CHECK (mode IN ('Whole','Even','ByRounds')),
 part_count integer NOT NULL CHECK (part_count BETWEEN 0 AND 20),
 bill_minor bigint NOT NULL CHECK (bill_minor > 0),
 currency_code text NOT NULL CHECK (currency_code = 'CAD'),
 recorded_at timestamptz NOT NULL CHECK (isfinite(recorded_at) AND recorded_at=date_trunc('milliseconds',recorded_at)),
 actor_id platform_helpers.uuid_v7 NOT NULL,
 audit_id platform_helpers.uuid_v7 NOT NULL UNIQUE,
 CONSTRAINT dining_table_split_plan_operation UNIQUE (brand_id,store_id,operation_id),
 CONSTRAINT dining_table_split_plan_version UNIQUE (brand_id,store_id,order_id,plan_version),
 CONSTRAINT dining_table_split_plan_parts CHECK (
  (mode = 'Whole' AND part_count = 0) OR (mode <> 'Whole' AND part_count BETWEEN 2 AND 20)
 )
);
CREATE TABLE rms_payment.dining_table_split_part (
 split_plan_id platform_helpers.uuid_v7 NOT NULL REFERENCES rms_payment.dining_table_split_plan(split_plan_id),
 brand_id platform_helpers.uuid_v7 NOT NULL,
 store_id platform_helpers.uuid_v7 NOT NULL,
 order_id platform_helpers.uuid_v7 NOT NULL,
 part_number integer NOT NULL CHECK (part_number BETWEEN 1 AND 20),
 amount_minor bigint NOT NULL CHECK (amount_minor > 0),
 subtotal_minor bigint NOT NULL CHECK (subtotal_minor >= 0),
 tax_minor bigint NOT NULL CHECK (tax_minor >= 0),
 PRIMARY KEY (split_plan_id,part_number)
);
CREATE TABLE rms_payment.dining_table_split_part_round (
 split_plan_id platform_helpers.uuid_v7 NOT NULL,
 part_number integer NOT NULL,
 brand_id platform_helpers.uuid_v7 NOT NULL,
 store_id platform_helpers.uuid_v7 NOT NULL,
 order_id platform_helpers.uuid_v7 NOT NULL,
 order_batch_id platform_helpers.uuid_v7 NOT NULL,
 round_minor bigint NOT NULL CHECK (round_minor > 0),
 subtotal_minor bigint NOT NULL CHECK (subtotal_minor >= 0),
 tax_minor bigint NOT NULL CHECK (tax_minor >= 0),
 PRIMARY KEY (split_plan_id,part_number,order_batch_id),
 FOREIGN KEY (split_plan_id,part_number) REFERENCES rms_payment.dining_table_split_part(split_plan_id,part_number)
);

-- A plan is the next version for its Order, recorded only while nothing was paid, written off or
-- started on a guest's phone; its parts are 1..part_count, each the sum of its slices, together
-- the bill. Checked when the transaction commits (parts and slices are inserted after the plan).
CREATE FUNCTION rms_payment.check_dining_table_split_plan() RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
BEGIN
 PERFORM pg_advisory_xact_lock(hashtextextended('DiningTablePaidOrWrittenOff:'||NEW.brand_id||':'||NEW.store_id||':'||NEW.order_id,0));
 IF NEW.plan_version <> coalesce((SELECT max(p.plan_version) FROM rms_payment.dining_table_split_plan p
   WHERE p.brand_id=NEW.brand_id AND p.store_id=NEW.store_id AND p.order_id=NEW.order_id),0) + 1 THEN
  RAISE EXCEPTION 'split plan is not the next version' USING ERRCODE='23514';
 END IF;
 IF EXISTS (SELECT 1 FROM rms_payment.dining_table_settlement s WHERE s.brand_id=NEW.brand_id
    AND s.store_id=NEW.store_id AND s.order_id=NEW.order_id)
  OR EXISTS (SELECT 1 FROM rms_payment.order_unpaid_write_off w WHERE w.brand_id=NEW.brand_id
    AND w.store_id=NEW.store_id AND w.order_id=NEW.order_id)
  OR EXISTS (SELECT 1 FROM rms_payment.dining_table_online_payment o WHERE o.brand_id=NEW.brand_id
    AND o.store_id=NEW.store_id AND o.order_id=NEW.order_id
    AND NOT EXISTS (SELECT 1 FROM rms_payment.dining_table_online_payment_outcome x
      WHERE x.online_payment_id=o.online_payment_id AND x.status IN ('Failed','Cancelled'))) THEN
  RAISE EXCEPTION 'the table''s split can''t change once paying started' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION rms_payment.check_dining_table_split_plan() FROM PUBLIC;
CREATE TRIGGER dining_table_split_plan_next BEFORE INSERT ON rms_payment.dining_table_split_plan
 FOR EACH ROW EXECUTE FUNCTION rms_payment.check_dining_table_split_plan();

CREATE FUNCTION rms_payment.validate_dining_table_split_plan() RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
 plan rms_payment.dining_table_split_plan%ROWTYPE;
 parts record;
 mismatched integer;
BEGIN
 SELECT * INTO plan FROM rms_payment.dining_table_split_plan WHERE split_plan_id=NEW.split_plan_id;
 SELECT count(*) AS n, coalesce(max(part_number),0) AS last, coalesce(sum(amount_minor),0) AS total,
   bool_and(brand_id=plan.brand_id AND store_id=plan.store_id AND order_id=plan.order_id) AS same
  INTO parts FROM rms_payment.dining_table_split_part WHERE split_plan_id=NEW.split_plan_id;
 SELECT count(*) INTO mismatched FROM rms_payment.dining_table_split_part p
  WHERE p.split_plan_id=NEW.split_plan_id AND (
   p.amount_minor <> coalesce((SELECT sum(r.round_minor) FROM rms_payment.dining_table_split_part_round r
     WHERE r.split_plan_id=p.split_plan_id AND r.part_number=p.part_number),0)
   OR p.subtotal_minor <> coalesce((SELECT sum(r.subtotal_minor) FROM rms_payment.dining_table_split_part_round r
     WHERE r.split_plan_id=p.split_plan_id AND r.part_number=p.part_number),0)
   OR p.tax_minor <> coalesce((SELECT sum(r.tax_minor) FROM rms_payment.dining_table_split_part_round r
     WHERE r.split_plan_id=p.split_plan_id AND r.part_number=p.part_number),0)
   OR EXISTS (SELECT 1 FROM rms_payment.dining_table_split_part_round r WHERE r.split_plan_id=p.split_plan_id
     AND r.part_number=p.part_number AND (r.brand_id<>p.brand_id OR r.store_id<>p.store_id OR r.order_id<>p.order_id)));
 IF plan.split_plan_id IS NULL OR parts.n <> plan.part_count OR parts.last <> plan.part_count
  OR (plan.part_count > 0 AND (parts.total <> plan.bill_minor OR NOT parts.same)) OR mismatched <> 0 THEN
  RAISE EXCEPTION 'split plan parts do not match the plan' USING ERRCODE='23514';
 END IF;
 RETURN NULL;
END;
$$;
REVOKE ALL ON FUNCTION rms_payment.validate_dining_table_split_plan() FROM PUBLIC;
CREATE CONSTRAINT TRIGGER dining_table_split_plan_complete AFTER INSERT ON rms_payment.dining_table_split_plan
 DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION rms_payment.validate_dining_table_split_plan();
CREATE CONSTRAINT TRIGGER dining_table_split_part_complete AFTER INSERT ON rms_payment.dining_table_split_part
 DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION rms_payment.validate_dining_table_split_plan();
CREATE CONSTRAINT TRIGGER dining_table_split_part_round_complete AFTER INSERT ON rms_payment.dining_table_split_part_round
 DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION rms_payment.validate_dining_table_split_plan();

-- A settlement or a guest's phone payment may be one part of a split plan.
ALTER TABLE rms_payment.dining_table_settlement
 ADD COLUMN split_plan_id platform_helpers.uuid_v7,
 ADD COLUMN part_number integer,
 ADD CONSTRAINT dining_table_settlement_part CHECK ((split_plan_id IS NULL) = (part_number IS NULL)),
 ADD CONSTRAINT dining_table_settlement_part_ref FOREIGN KEY (split_plan_id,part_number)
  REFERENCES rms_payment.dining_table_split_part(split_plan_id,part_number);
ALTER TABLE rms_payment.dining_table_settlement DROP CONSTRAINT dining_table_settlement_order;
-- One whole-table payment per Order; one payment per part.
CREATE UNIQUE INDEX dining_table_settlement_whole_order
 ON rms_payment.dining_table_settlement (brand_id,store_id,order_id) WHERE split_plan_id IS NULL;
CREATE UNIQUE INDEX dining_table_settlement_one_per_part
 ON rms_payment.dining_table_settlement (split_plan_id,part_number) WHERE split_plan_id IS NOT NULL;
ALTER TABLE rms_payment.dining_table_online_payment
 ADD COLUMN split_plan_id platform_helpers.uuid_v7,
 ADD COLUMN part_number integer,
 ADD CONSTRAINT dining_table_online_payment_part CHECK ((split_plan_id IS NULL) = (part_number IS NULL)),
 ADD CONSTRAINT dining_table_online_payment_part_ref FOREIGN KEY (split_plan_id,part_number)
  REFERENCES rms_payment.dining_table_split_part(split_plan_id,part_number);
-- A round may be in several parts of one plan; otherwise it is paid once, by one settlement.
ALTER TABLE rms_payment.dining_table_settlement_round DROP CONSTRAINT dining_table_settlement_round_batch;

-- A settlement's lines are its rounds (2000_098) and, for a part, exactly that part's slices.
CREATE OR REPLACE FUNCTION rms_payment.validate_dining_table_settlement() RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
 header rms_payment.dining_table_settlement%ROWTYPE;
 sums record;
 differing integer;
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
 IF header.split_plan_id IS NOT NULL THEN
  SELECT count(*) INTO differing FROM (
   (SELECT order_batch_id, round_minor FROM rms_payment.dining_table_settlement_round
     WHERE settlement_id=header.settlement_id
    EXCEPT SELECT order_batch_id, round_minor FROM rms_payment.dining_table_split_part_round
     WHERE split_plan_id=header.split_plan_id AND part_number=header.part_number)
   UNION ALL
   (SELECT order_batch_id, round_minor FROM rms_payment.dining_table_split_part_round
     WHERE split_plan_id=header.split_plan_id AND part_number=header.part_number
    EXCEPT SELECT order_batch_id, round_minor FROM rms_payment.dining_table_settlement_round
     WHERE settlement_id=header.settlement_id)) difference;
  IF differing <> 0 THEN
   RAISE EXCEPTION 'part payment lines do not match the part' USING ERRCODE='23514';
  END IF;
 END IF;
 RETURN NULL;
END;
$$;

-- Never two settlements for a round unless both are parts of the same split plan.
CREATE FUNCTION rms_payment.check_dining_table_settlement_round_once() RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
 plan_id uuid;
BEGIN
 SELECT split_plan_id INTO plan_id FROM rms_payment.dining_table_settlement WHERE settlement_id=NEW.settlement_id;
 IF EXISTS (SELECT 1 FROM rms_payment.dining_table_settlement_round r
   JOIN rms_payment.dining_table_settlement s ON s.settlement_id=r.settlement_id
   WHERE r.brand_id=NEW.brand_id AND r.store_id=NEW.store_id AND r.order_batch_id=NEW.order_batch_id
   AND r.settlement_id<>NEW.settlement_id
   AND (plan_id IS NULL OR s.split_plan_id IS DISTINCT FROM plan_id)) THEN
  RAISE EXCEPTION 'round was already paid by another settlement' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION rms_payment.check_dining_table_settlement_round_once() FROM PUBLIC;
CREATE TRIGGER dining_table_settlement_round_once BEFORE INSERT ON rms_payment.dining_table_settlement_round
 FOR EACH ROW EXECUTE FUNCTION rms_payment.check_dining_table_settlement_round_once();

-- 2000_101/2000_102 per part: a part payment (staff or phone) is for the current split plan and
-- not a part already paid or being paid on a phone; a whole-table payment only when the current
-- plan is none or "Whole"; a write-off is refused while any phone payment is open, after a whole-
-- table payment, or when every part is paid. Under the Order's lock.
CREATE OR REPLACE FUNCTION rms_payment.check_dining_table_paid_or_written_off() RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
 attempt rms_payment.dining_table_online_payment%ROWTYPE;
 outcome rms_payment.dining_table_online_payment_outcome%ROWTYPE;
 current_plan rms_payment.dining_table_split_plan%ROWTYPE;
 open_attempt boolean;
 open_whole_attempt boolean;
 new_plan uuid;
 new_part integer;
BEGIN
 PERFORM pg_advisory_xact_lock(hashtextextended('DiningTablePaidOrWrittenOff:'||NEW.brand_id||':'||NEW.store_id||':'||NEW.order_id,0));
 SELECT * INTO current_plan FROM rms_payment.dining_table_split_plan p
  WHERE p.brand_id=NEW.brand_id AND p.store_id=NEW.store_id AND p.order_id=NEW.order_id
  ORDER BY p.plan_version DESC LIMIT 1;
 IF TG_TABLE_NAME IN ('dining_table_settlement','dining_table_online_payment') THEN
  new_plan := NEW.split_plan_id; new_part := NEW.part_number;
 END IF;
 SELECT EXISTS (SELECT 1 FROM rms_payment.dining_table_online_payment p
   WHERE p.brand_id=NEW.brand_id AND p.store_id=NEW.store_id AND p.order_id=NEW.order_id
   AND NOT EXISTS (SELECT 1 FROM rms_payment.dining_table_online_payment_outcome o
     WHERE o.online_payment_id=p.online_payment_id)
   AND (TG_TABLE_NAME = 'order_unpaid_write_off' OR p.split_plan_id IS NULL OR new_plan IS NULL
     OR (p.split_plan_id=new_plan AND p.part_number=new_part))) INTO open_attempt;
 IF TG_TABLE_NAME IN ('dining_table_settlement','dining_table_online_payment') AND EXISTS (
   SELECT 1 FROM rms_payment.order_unpaid_write_off w WHERE w.brand_id=NEW.brand_id
    AND w.store_id=NEW.store_id AND w.order_id=NEW.order_id) THEN
  RAISE EXCEPTION 'the table''s bill was written off' USING ERRCODE='23514';
 END IF;
 IF TG_TABLE_NAME IN ('dining_table_settlement','dining_table_online_payment') THEN
  IF new_plan IS NULL AND current_plan.split_plan_id IS NOT NULL AND current_plan.mode <> 'Whole' THEN
   RAISE EXCEPTION 'the table''s bill is split; pay a part' USING ERRCODE='23514';
  END IF;
  IF new_plan IS NOT NULL AND (current_plan.split_plan_id IS DISTINCT FROM new_plan OR current_plan.mode = 'Whole') THEN
   RAISE EXCEPTION 'the part is not of the table''s current split' USING ERRCODE='23514';
  END IF;
 END IF;
 IF TG_TABLE_NAME = 'order_unpaid_write_off' AND (EXISTS (
   SELECT 1 FROM rms_payment.dining_table_settlement s WHERE s.brand_id=NEW.brand_id
    AND s.store_id=NEW.store_id AND s.order_id=NEW.order_id AND s.split_plan_id IS NULL)
  OR (current_plan.split_plan_id IS NOT NULL AND current_plan.mode <> 'Whole'
   AND (SELECT count(*) FROM rms_payment.dining_table_settlement s
     WHERE s.split_plan_id=current_plan.split_plan_id) >= current_plan.part_count)) THEN
  RAISE EXCEPTION 'the table already paid' USING ERRCODE='23514';
 END IF;
 IF TG_TABLE_NAME = 'dining_table_online_payment' AND EXISTS (
   SELECT 1 FROM rms_payment.dining_table_settlement s WHERE s.brand_id=NEW.brand_id
    AND s.store_id=NEW.store_id AND s.order_id=NEW.order_id
    AND (s.split_plan_id IS NULL OR new_plan IS NULL OR (s.split_plan_id=new_plan AND s.part_number=new_part))) THEN
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
    OR attempt.payment_environment<>NEW.payment_environment OR NEW.taken_at<>outcome.occurred_at
    OR attempt.split_plan_id IS DISTINCT FROM NEW.split_plan_id
    OR attempt.part_number IS DISTINCT FROM NEW.part_number THEN
    RAISE EXCEPTION 'online settlement does not match the captured payment' USING ERRCODE='23514';
   END IF;
  END IF;
 END IF;
 RETURN NEW;
END;
$$;

CREATE TRIGGER dining_table_split_plan_no_mutation BEFORE UPDATE OR DELETE ON rms_payment.dining_table_split_plan
 FOR EACH ROW EXECUTE FUNCTION rms_payment.reject_dining_table_settlement_mutation();
CREATE TRIGGER dining_table_split_plan_no_truncate BEFORE TRUNCATE ON rms_payment.dining_table_split_plan
 FOR EACH STATEMENT EXECUTE FUNCTION rms_payment.reject_dining_table_settlement_mutation();
CREATE TRIGGER dining_table_split_part_no_mutation BEFORE UPDATE OR DELETE ON rms_payment.dining_table_split_part
 FOR EACH ROW EXECUTE FUNCTION rms_payment.reject_dining_table_settlement_mutation();
CREATE TRIGGER dining_table_split_part_no_truncate BEFORE TRUNCATE ON rms_payment.dining_table_split_part
 FOR EACH STATEMENT EXECUTE FUNCTION rms_payment.reject_dining_table_settlement_mutation();
CREATE TRIGGER dining_table_split_part_round_no_mutation BEFORE UPDATE OR DELETE ON rms_payment.dining_table_split_part_round
 FOR EACH ROW EXECUTE FUNCTION rms_payment.reject_dining_table_settlement_mutation();
CREATE TRIGGER dining_table_split_part_round_no_truncate BEFORE TRUNCATE ON rms_payment.dining_table_split_part_round
 FOR EACH STATEMENT EXECUTE FUNCTION rms_payment.reject_dining_table_settlement_mutation();

ALTER TABLE rms_payment.dining_table_split_plan ENABLE ROW LEVEL SECURITY;
ALTER TABLE rms_payment.dining_table_split_plan FORCE ROW LEVEL SECURITY;
CREATE POLICY dining_table_split_plan_scope ON rms_payment.dining_table_split_plan
 USING (brand_id=platform_helpers.current_brand_id() AND store_id=platform_helpers.current_store_id())
 WITH CHECK (brand_id=platform_helpers.current_brand_id() AND store_id=platform_helpers.current_store_id());
ALTER TABLE rms_payment.dining_table_split_part ENABLE ROW LEVEL SECURITY;
ALTER TABLE rms_payment.dining_table_split_part FORCE ROW LEVEL SECURITY;
CREATE POLICY dining_table_split_part_scope ON rms_payment.dining_table_split_part
 USING (brand_id=platform_helpers.current_brand_id() AND store_id=platform_helpers.current_store_id())
 WITH CHECK (brand_id=platform_helpers.current_brand_id() AND store_id=platform_helpers.current_store_id());
ALTER TABLE rms_payment.dining_table_split_part_round ENABLE ROW LEVEL SECURITY;
ALTER TABLE rms_payment.dining_table_split_part_round FORCE ROW LEVEL SECURITY;
CREATE POLICY dining_table_split_part_round_scope ON rms_payment.dining_table_split_part_round
 USING (brand_id=platform_helpers.current_brand_id() AND store_id=platform_helpers.current_store_id())
 WITH CHECK (brand_id=platform_helpers.current_brand_id() AND store_id=platform_helpers.current_store_id());
REVOKE ALL ON TABLE rms_payment.dining_table_split_plan FROM PUBLIC;
REVOKE ALL ON TABLE rms_payment.dining_table_split_part FROM PUBLIC;
REVOKE ALL ON TABLE rms_payment.dining_table_split_part_round FROM PUBLIC;
