-- bop-rms-migration: 1
-- owner: @rms/payment
-- schema: rms_payment
-- phase: expand
-- risk: medium
-- transaction: required
-- lock-timeout-ms: 5000
-- statement-timeout-ms: 60000
-- recovery: forward-fix
-- WP-2423 M52 (DEC-OWNER-DEFAULTS-2026-11-06, DEC-COUNTER-CASH): a walk-up or pickup order at the
-- counter may be paid in cash, by the table's cash rules. The counter payment stays one record per
-- order (the same record, PaymentSucceeded event, acceptance and kitchen path as the card machine),
-- now saying how it was paid: on the card machine, or in cash with the cash rounding to 5 cents, what
-- the guest handed over and the change given back. The order's amount (total_minor, tax and tip
-- included) is unchanged; the rounding is its own amount and what the drawer took is
-- total_minor + rounding_minor, a whole number of nickels. Every row recorded so far was on the card
-- machine (the defaults). Cash given back from a cash counter payment goes back in whole nickels,
-- never more than the drawer took (rounding included). Append-only, as before.
-- Grants: none new (api already SELECT/INSERT on card_machine_payment; table-level grants cover the
-- new columns).
ALTER TABLE rms_payment.card_machine_payment
 ADD COLUMN tender text NOT NULL DEFAULT 'CardMachine' CHECK (tender IN ('CardMachine','Cash')),
 ADD COLUMN rounding_minor bigint NOT NULL DEFAULT 0 CHECK (rounding_minor BETWEEN -2 AND 2),
 ADD COLUMN tendered_minor bigint,
 ADD COLUMN change_minor bigint;
-- The rounding is to the nearest 5 cents (the only multiple of 5 within 2 cents), so it is fixed by
-- the amount; a slip reference belongs to the card machine.
ALTER TABLE rms_payment.card_machine_payment
 ADD CONSTRAINT card_machine_payment_cash_tender CHECK (
  (tender = 'CardMachine' AND rounding_minor = 0 AND tendered_minor IS NULL AND change_minor IS NULL)
  OR (tender = 'Cash' AND slip_reference IS NULL
   AND total_minor::numeric + rounding_minor::numeric > 0
   AND (total_minor + rounding_minor) % 5 = 0
   AND tendered_minor IS NOT NULL AND change_minor IS NOT NULL
   AND tendered_minor::numeric >= total_minor::numeric + rounding_minor::numeric
   AND change_minor::numeric = tendered_minor::numeric - (total_minor::numeric + rounding_minor::numeric))
 );

-- A refund never exceeds what was taken (for cash: what the drawer took, rounding included), and
-- cash goes back in whole nickels.
CREATE OR REPLACE FUNCTION rms_payment.check_card_machine_refund() RETURNS trigger
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
 IF paid.tender = 'Cash' AND (NEW.amount_minor % 5 <> 0 OR NEW.slip_reference IS NOT NULL) THEN
  RAISE EXCEPTION 'cash goes back in whole nickels' USING ERRCODE='23514';
 END IF;
 SELECT COALESCE(sum(amount_minor),0) INTO refunded FROM rms_payment.card_machine_refund
  WHERE brand_id=NEW.brand_id AND store_id=NEW.store_id AND card_machine_payment_id=NEW.card_machine_payment_id;
 IF refunded::numeric + NEW.amount_minor::numeric > paid.total_minor::numeric + paid.rounding_minor::numeric THEN
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
