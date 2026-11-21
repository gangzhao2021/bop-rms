-- bop-rms-migration: 1
-- owner: @rms/payment
-- schema: rms_payment
-- phase: expand
-- risk: medium
-- transaction: required
-- lock-timeout-ms: 5000
-- statement-timeout-ms: 60000
-- recovery: forward-fix
-- WP-2423 DEC-OWNER-DEFAULTS-2026-11-06 同桌结账 (pay at the end): guests at one table pay by dish
-- as they go ("only what I added", "choose dishes", "the rest of the table"). The table's one split
-- plan in mode "ByGuests" gets its parts appended one at a time — each with the units of the dishes
-- it pays for, who chose it and whether it took the last of the bill — so the plan never changes
-- identity after a payment (settlements, phone payments, refunds and reports keep pointing at the
-- same plan and part). A unit is in at most one part that is paid or being paid; a part whose phone
-- payment failed or was cancelled is withdrawn (its dishes are unpaid again), never deleted. The
-- other modes behave exactly as before.
-- Grants: api SELECT/INSERT on the three new tables (Owner standing approval 2026-10-14, WP-2423).
ALTER TABLE rms_payment.dining_table_split_plan DROP CONSTRAINT dining_table_split_plan_mode_check;
ALTER TABLE rms_payment.dining_table_split_plan
 ADD CONSTRAINT dining_table_split_plan_mode_check
 CHECK (mode IN ('Whole','Even','ByRounds','ByItems','ByGuests'));
ALTER TABLE rms_payment.dining_table_split_plan DROP CONSTRAINT dining_table_split_plan_parts;
ALTER TABLE rms_payment.dining_table_split_plan
 ADD CONSTRAINT dining_table_split_plan_parts CHECK (
  (mode IN ('Whole','ByGuests') AND part_count = 0)
  OR (mode NOT IN ('Whole','ByGuests') AND part_count BETWEEN 2 AND 20)
 );
-- Guests paying by dish may need more parts than a split into people (a failed payment's part is
-- withdrawn and its dishes chosen again in a new one).
ALTER TABLE rms_payment.dining_table_split_part DROP CONSTRAINT dining_table_split_part_part_number_check;
ALTER TABLE rms_payment.dining_table_split_part
 ADD CONSTRAINT dining_table_split_part_part_number_check CHECK (part_number BETWEEN 1 AND 100);

CREATE TABLE rms_payment.dining_table_split_part_append (
 split_plan_id platform_helpers.uuid_v7 NOT NULL,
 part_number integer NOT NULL,
 tenant_id platform_helpers.uuid_v7 NOT NULL,
 brand_id platform_helpers.uuid_v7 NOT NULL,
 store_id platform_helpers.uuid_v7 NOT NULL,
 order_id platform_helpers.uuid_v7 NOT NULL,
 operation_id platform_helpers.uuid_v7 NOT NULL,
 intent_digest text NOT NULL CHECK (intent_digest ~ '^sha256:[0-9a-f]{64}$'),
 choice text NOT NULL CHECK (choice IN ('Mine','Chosen','Rest')),
 actor_type text NOT NULL CHECK (actor_type IN ('Guest','Staff')),
 actor_id platform_helpers.uuid_v7,
 guest_session_id platform_helpers.uuid_v7,
 completes_bill boolean NOT NULL,
 recorded_at timestamptz NOT NULL CHECK (isfinite(recorded_at) AND recorded_at=date_trunc('milliseconds',recorded_at)),
 audit_id platform_helpers.uuid_v7 NOT NULL UNIQUE,
 PRIMARY KEY (split_plan_id,part_number),
 FOREIGN KEY (split_plan_id,part_number) REFERENCES rms_payment.dining_table_split_part(split_plan_id,part_number),
 CONSTRAINT dining_table_split_part_append_operation UNIQUE (brand_id,store_id,operation_id),
 CONSTRAINT dining_table_split_part_append_actor CHECK (
  (actor_type = 'Guest' AND guest_session_id IS NOT NULL AND actor_id IS NULL)
  OR (actor_type = 'Staff' AND actor_id IS NOT NULL AND guest_session_id IS NULL)
 )
);
CREATE TABLE rms_payment.dining_table_split_part_unit (
 split_plan_id platform_helpers.uuid_v7 NOT NULL,
 part_number integer NOT NULL,
 brand_id platform_helpers.uuid_v7 NOT NULL,
 store_id platform_helpers.uuid_v7 NOT NULL,
 order_item_id platform_helpers.uuid_v7 NOT NULL,
 unit_number integer NOT NULL CHECK (unit_number BETWEEN 1 AND 1000),
 PRIMARY KEY (split_plan_id,part_number,order_item_id,unit_number),
 FOREIGN KEY (split_plan_id,part_number) REFERENCES rms_payment.dining_table_split_part(split_plan_id,part_number)
);
-- last_part_number: the plan's highest part when this one was withdrawn — a part appended before it
-- that took "the last of the bill" no longer does once an earlier part gave its dishes back.
CREATE TABLE rms_payment.dining_table_split_part_withdrawal (
 split_plan_id platform_helpers.uuid_v7 NOT NULL,
 part_number integer NOT NULL,
 brand_id platform_helpers.uuid_v7 NOT NULL,
 store_id platform_helpers.uuid_v7 NOT NULL,
 order_id platform_helpers.uuid_v7 NOT NULL,
 reason text NOT NULL CHECK (reason IN ('PaymentFailed','PaymentCancelled')),
 online_payment_id platform_helpers.uuid_v7 NOT NULL,
 last_part_number integer NOT NULL,
 recorded_at timestamptz NOT NULL CHECK (isfinite(recorded_at) AND recorded_at=date_trunc('milliseconds',recorded_at)),
 audit_id platform_helpers.uuid_v7 NOT NULL UNIQUE,
 PRIMARY KEY (split_plan_id,part_number),
 FOREIGN KEY (split_plan_id,part_number) REFERENCES rms_payment.dining_table_split_part(split_plan_id,part_number)
);

-- A "ByGuests" plan is paid in full when a part still standing took the last of the bill (and no
-- earlier part gave its dishes back after it) and every part still standing is paid.
CREATE FUNCTION rms_payment.dining_table_by_guests_paid(plan uuid) RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
 SELECT EXISTS (
   SELECT 1 FROM rms_payment.dining_table_split_part_append a
   WHERE a.split_plan_id=plan AND a.completes_bill
   AND NOT EXISTS (SELECT 1 FROM rms_payment.dining_table_split_part_withdrawal w
     WHERE w.split_plan_id=plan AND (w.part_number=a.part_number
       OR (w.part_number<a.part_number AND w.last_part_number>=a.part_number))))
  AND NOT EXISTS (
   SELECT 1 FROM rms_payment.dining_table_split_part p
   WHERE p.split_plan_id=plan
   AND NOT EXISTS (SELECT 1 FROM rms_payment.dining_table_split_part_withdrawal w
     WHERE w.split_plan_id=p.split_plan_id AND w.part_number=p.part_number)
   AND NOT EXISTS (SELECT 1 FROM rms_payment.dining_table_settlement s
     WHERE s.split_plan_id=p.split_plan_id AND s.part_number=p.part_number))
$$;
REVOKE ALL ON FUNCTION rms_payment.dining_table_by_guests_paid(uuid) FROM PUBLIC;

-- A part of a "ByGuests" plan is appended under the Order's lock: to the table's current plan, as
-- its next part, never once the table was paid whole or written off.
CREATE FUNCTION rms_payment.check_dining_table_split_part_append() RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
 plan rms_payment.dining_table_split_plan%ROWTYPE;
BEGIN
 SELECT * INTO plan FROM rms_payment.dining_table_split_plan WHERE split_plan_id=NEW.split_plan_id;
 IF plan.mode IS DISTINCT FROM 'ByGuests' THEN
  RETURN NEW;
 END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended('DiningTablePaidOrWrittenOff:'||plan.brand_id||':'||plan.store_id||':'||plan.order_id,0));
 IF plan.plan_version <> (SELECT max(p.plan_version) FROM rms_payment.dining_table_split_plan p
   WHERE p.brand_id=plan.brand_id AND p.store_id=plan.store_id AND p.order_id=plan.order_id) THEN
  RAISE EXCEPTION 'the part is not of the table''s current split' USING ERRCODE='23514';
 END IF;
 IF NEW.part_number <> coalesce((SELECT max(x.part_number) FROM rms_payment.dining_table_split_part x
   WHERE x.split_plan_id=NEW.split_plan_id),0) + 1 THEN
  RAISE EXCEPTION 'the part is not the plan''s next part' USING ERRCODE='23514';
 END IF;
 IF EXISTS (SELECT 1 FROM rms_payment.order_unpaid_write_off w WHERE w.brand_id=plan.brand_id
    AND w.store_id=plan.store_id AND w.order_id=plan.order_id) THEN
  RAISE EXCEPTION 'the table''s bill was written off' USING ERRCODE='23514';
 END IF;
 IF EXISTS (SELECT 1 FROM rms_payment.dining_table_settlement s WHERE s.brand_id=plan.brand_id
    AND s.store_id=plan.store_id AND s.order_id=plan.order_id AND s.split_plan_id IS NULL)
  OR rms_payment.dining_table_by_guests_paid(plan.split_plan_id) THEN
  RAISE EXCEPTION 'the table already paid' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION rms_payment.check_dining_table_split_part_append() FROM PUBLIC;
CREATE TRIGGER dining_table_split_part_append_next BEFORE INSERT ON rms_payment.dining_table_split_part
 FOR EACH ROW EXECUTE FUNCTION rms_payment.check_dining_table_split_part_append();

-- A part is withdrawn only after its own phone payment failed or was cancelled, never once paid.
CREATE FUNCTION rms_payment.check_dining_table_split_part_withdrawal() RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
 plan rms_payment.dining_table_split_plan%ROWTYPE;
BEGIN
 SELECT * INTO plan FROM rms_payment.dining_table_split_plan WHERE split_plan_id=NEW.split_plan_id;
 IF plan.mode IS DISTINCT FROM 'ByGuests' OR plan.brand_id<>NEW.brand_id OR plan.store_id<>NEW.store_id
  OR plan.order_id<>NEW.order_id THEN
  RAISE EXCEPTION 'only a part guests chose is withdrawn' USING ERRCODE='23514';
 END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended('DiningTablePaidOrWrittenOff:'||plan.brand_id||':'||plan.store_id||':'||plan.order_id,0));
 IF NOT EXISTS (SELECT 1 FROM rms_payment.dining_table_online_payment o
    JOIN rms_payment.dining_table_online_payment_outcome x ON x.online_payment_id=o.online_payment_id
    WHERE o.online_payment_id=NEW.online_payment_id AND o.split_plan_id=NEW.split_plan_id
    AND o.part_number=NEW.part_number
    AND x.status=CASE NEW.reason WHEN 'PaymentFailed' THEN 'Failed' ELSE 'Cancelled' END)
  OR EXISTS (SELECT 1 FROM rms_payment.dining_table_settlement s
    WHERE s.split_plan_id=NEW.split_plan_id AND s.part_number=NEW.part_number)
  OR EXISTS (SELECT 1 FROM rms_payment.dining_table_online_payment o
    WHERE o.split_plan_id=NEW.split_plan_id AND o.part_number=NEW.part_number
    AND NOT EXISTS (SELECT 1 FROM rms_payment.dining_table_online_payment_outcome x
      WHERE x.online_payment_id=o.online_payment_id AND x.status IN ('Failed','Cancelled'))) THEN
  RAISE EXCEPTION 'a part paid or being paid is not withdrawn' USING ERRCODE='23514';
 END IF;
 IF NEW.last_part_number <> (SELECT max(x.part_number) FROM rms_payment.dining_table_split_part x
   WHERE x.split_plan_id=NEW.split_plan_id) THEN
  RAISE EXCEPTION 'the withdrawal does not name the plan''s last part' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION rms_payment.check_dining_table_split_part_withdrawal() FROM PUBLIC;
CREATE TRIGGER dining_table_split_part_withdrawal_check BEFORE INSERT ON rms_payment.dining_table_split_part_withdrawal
 FOR EACH ROW EXECUTE FUNCTION rms_payment.check_dining_table_split_part_withdrawal();

-- 2000_130's rule for the other modes; a "ByGuests" plan's parts are numbered 1..n, each the sum of
-- its slices, of its bill, with who chose it and at least one unit, and no unit in two parts still
-- standing. Checked when the transaction commits.
CREATE OR REPLACE FUNCTION rms_payment.validate_dining_table_split_plan() RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
 plan rms_payment.dining_table_split_plan%ROWTYPE;
 parts record;
 mismatched integer;
 by_guests boolean;
BEGIN
 SELECT * INTO plan FROM rms_payment.dining_table_split_plan WHERE split_plan_id=NEW.split_plan_id;
 by_guests := plan.mode = 'ByGuests';
 SELECT count(*) AS n, coalesce(max(part_number),0) AS last, coalesce(sum(amount_minor),0) AS total,
   coalesce(bool_and(brand_id=plan.brand_id AND store_id=plan.store_id AND order_id=plan.order_id),true) AS same
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
     AND r.part_number=p.part_number AND (r.brand_id<>p.brand_id OR r.store_id<>p.store_id
     OR rms_payment.dining_table_bill_of(r.brand_id,r.store_id,r.order_id)<>p.order_id))
   OR (by_guests AND (
     NOT EXISTS (SELECT 1 FROM rms_payment.dining_table_split_part_append a
       WHERE a.split_plan_id=p.split_plan_id AND a.part_number=p.part_number
       AND a.tenant_id=plan.tenant_id AND a.brand_id=p.brand_id AND a.store_id=p.store_id
       AND a.order_id=p.order_id)
     OR NOT EXISTS (SELECT 1 FROM rms_payment.dining_table_split_part_unit u
       WHERE u.split_plan_id=p.split_plan_id AND u.part_number=p.part_number)
     OR EXISTS (SELECT 1 FROM rms_payment.dining_table_split_part_unit u
       WHERE u.split_plan_id=p.split_plan_id AND u.part_number=p.part_number
       AND (u.brand_id<>p.brand_id OR u.store_id<>p.store_id)))));
 IF by_guests AND (parts.last <> parts.n OR NOT parts.same OR mismatched <> 0
   OR EXISTS (SELECT 1 FROM rms_payment.dining_table_split_part_unit u
     JOIN rms_payment.dining_table_split_part_unit v ON v.split_plan_id=u.split_plan_id
      AND v.order_item_id=u.order_item_id AND v.unit_number=u.unit_number AND v.part_number<>u.part_number
     WHERE u.split_plan_id=NEW.split_plan_id
     AND NOT EXISTS (SELECT 1 FROM rms_payment.dining_table_split_part_withdrawal w
       WHERE w.split_plan_id=u.split_plan_id AND w.part_number=u.part_number)
     AND NOT EXISTS (SELECT 1 FROM rms_payment.dining_table_split_part_withdrawal w
       WHERE w.split_plan_id=v.split_plan_id AND w.part_number=v.part_number))) THEN
  RAISE EXCEPTION 'split plan parts do not match the plan' USING ERRCODE='23514';
 END IF;
 IF by_guests THEN
  RETURN NULL;
 END IF;
 IF plan.split_plan_id IS NULL OR parts.n <> plan.part_count OR parts.last <> plan.part_count
  OR (plan.part_count > 0 AND (parts.total <> plan.bill_minor OR NOT parts.same)) OR mismatched <> 0
  OR EXISTS (SELECT 1 FROM rms_payment.dining_table_split_part_append a WHERE a.split_plan_id=NEW.split_plan_id)
  OR EXISTS (SELECT 1 FROM rms_payment.dining_table_split_part_unit u WHERE u.split_plan_id=NEW.split_plan_id) THEN
  RAISE EXCEPTION 'split plan parts do not match the plan' USING ERRCODE='23514';
 END IF;
 RETURN NULL;
END;
$$;
CREATE CONSTRAINT TRIGGER dining_table_split_part_append_complete AFTER INSERT ON rms_payment.dining_table_split_part_append
 DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION rms_payment.validate_dining_table_split_plan();
CREATE CONSTRAINT TRIGGER dining_table_split_part_unit_complete AFTER INSERT ON rms_payment.dining_table_split_part_unit
 DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION rms_payment.validate_dining_table_split_plan();

-- 2000_104's rule, and for a "ByGuests" plan: a part payment is for a part still standing (a part
-- has one phone payment); the table is "already paid" for a write-off when the guests' parts cover
-- the whole bill and are paid. Under the Order's lock.
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
  IF new_plan IS NOT NULL AND current_plan.mode = 'ByGuests' AND EXISTS (
    SELECT 1 FROM rms_payment.dining_table_split_part_withdrawal w
    WHERE w.split_plan_id=new_plan AND w.part_number=new_part) THEN
   RAISE EXCEPTION 'the part is not of the table''s current split' USING ERRCODE='23514';
  END IF;
 END IF;
 IF TG_TABLE_NAME = 'order_unpaid_write_off' AND (EXISTS (
   SELECT 1 FROM rms_payment.dining_table_settlement s WHERE s.brand_id=NEW.brand_id
    AND s.store_id=NEW.store_id AND s.order_id=NEW.order_id AND s.split_plan_id IS NULL)
  OR (current_plan.split_plan_id IS NOT NULL AND current_plan.mode NOT IN ('Whole','ByGuests')
   AND (SELECT count(*) FROM rms_payment.dining_table_settlement s
     WHERE s.split_plan_id=current_plan.split_plan_id) >= current_plan.part_count)
  OR (current_plan.mode = 'ByGuests' AND rms_payment.dining_table_by_guests_paid(current_plan.split_plan_id))) THEN
  RAISE EXCEPTION 'the table already paid' USING ERRCODE='23514';
 END IF;
 IF TG_TABLE_NAME = 'dining_table_online_payment' AND EXISTS (
   SELECT 1 FROM rms_payment.dining_table_settlement s WHERE s.brand_id=NEW.brand_id
    AND s.store_id=NEW.store_id AND s.order_id=NEW.order_id
    AND (s.split_plan_id IS NULL OR new_plan IS NULL OR (s.split_plan_id=new_plan AND s.part_number=new_part))) THEN
  RAISE EXCEPTION 'the table already paid' USING ERRCODE='23514';
 END IF;
 IF TG_TABLE_NAME = 'dining_table_online_payment' AND new_plan IS NOT NULL
  AND current_plan.mode = 'ByGuests' AND EXISTS (
   SELECT 1 FROM rms_payment.dining_table_online_payment p
   WHERE p.split_plan_id=new_plan AND p.part_number=new_part) THEN
  RAISE EXCEPTION 'a guest is already paying for the table' USING ERRCODE='23514';
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

CREATE TRIGGER dining_table_split_part_append_no_mutation BEFORE UPDATE OR DELETE ON rms_payment.dining_table_split_part_append
 FOR EACH ROW EXECUTE FUNCTION rms_payment.reject_dining_table_settlement_mutation();
CREATE TRIGGER dining_table_split_part_append_no_truncate BEFORE TRUNCATE ON rms_payment.dining_table_split_part_append
 FOR EACH STATEMENT EXECUTE FUNCTION rms_payment.reject_dining_table_settlement_mutation();
CREATE TRIGGER dining_table_split_part_unit_no_mutation BEFORE UPDATE OR DELETE ON rms_payment.dining_table_split_part_unit
 FOR EACH ROW EXECUTE FUNCTION rms_payment.reject_dining_table_settlement_mutation();
CREATE TRIGGER dining_table_split_part_unit_no_truncate BEFORE TRUNCATE ON rms_payment.dining_table_split_part_unit
 FOR EACH STATEMENT EXECUTE FUNCTION rms_payment.reject_dining_table_settlement_mutation();
CREATE TRIGGER dining_table_split_part_withdrawal_no_mutation BEFORE UPDATE OR DELETE ON rms_payment.dining_table_split_part_withdrawal
 FOR EACH ROW EXECUTE FUNCTION rms_payment.reject_dining_table_settlement_mutation();
CREATE TRIGGER dining_table_split_part_withdrawal_no_truncate BEFORE TRUNCATE ON rms_payment.dining_table_split_part_withdrawal
 FOR EACH STATEMENT EXECUTE FUNCTION rms_payment.reject_dining_table_settlement_mutation();

ALTER TABLE rms_payment.dining_table_split_part_append ENABLE ROW LEVEL SECURITY;
ALTER TABLE rms_payment.dining_table_split_part_append FORCE ROW LEVEL SECURITY;
CREATE POLICY dining_table_split_part_append_scope ON rms_payment.dining_table_split_part_append
 USING (brand_id=platform_helpers.current_brand_id() AND store_id=platform_helpers.current_store_id())
 WITH CHECK (brand_id=platform_helpers.current_brand_id() AND store_id=platform_helpers.current_store_id());
ALTER TABLE rms_payment.dining_table_split_part_unit ENABLE ROW LEVEL SECURITY;
ALTER TABLE rms_payment.dining_table_split_part_unit FORCE ROW LEVEL SECURITY;
CREATE POLICY dining_table_split_part_unit_scope ON rms_payment.dining_table_split_part_unit
 USING (brand_id=platform_helpers.current_brand_id() AND store_id=platform_helpers.current_store_id())
 WITH CHECK (brand_id=platform_helpers.current_brand_id() AND store_id=platform_helpers.current_store_id());
ALTER TABLE rms_payment.dining_table_split_part_withdrawal ENABLE ROW LEVEL SECURITY;
ALTER TABLE rms_payment.dining_table_split_part_withdrawal FORCE ROW LEVEL SECURITY;
CREATE POLICY dining_table_split_part_withdrawal_scope ON rms_payment.dining_table_split_part_withdrawal
 USING (brand_id=platform_helpers.current_brand_id() AND store_id=platform_helpers.current_store_id())
 WITH CHECK (brand_id=platform_helpers.current_brand_id() AND store_id=platform_helpers.current_store_id());
REVOKE ALL ON TABLE rms_payment.dining_table_split_part_append FROM PUBLIC;
REVOKE ALL ON TABLE rms_payment.dining_table_split_part_unit FROM PUBLIC;
REVOKE ALL ON TABLE rms_payment.dining_table_split_part_withdrawal FROM PUBLIC;
