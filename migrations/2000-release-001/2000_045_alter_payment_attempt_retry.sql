-- bop-rms-migration: 1
-- owner: @rms/payment
-- schema: rms_payment
-- phase: expand
-- risk: medium
-- transaction: required
-- lock-timeout-ms: 5000
-- statement-timeout-ms: 60000
-- recovery: forward-fix
-- WP-2423 Q20 (DEC-PAYMENT-CARD-RETRY): after a declined card the customer may try another card
-- for the same order. Each try is a new, append-only Payment Attempt on the same Payment Intent
-- (same order batch, same amount, same payment window). A new attempt is allowed only while the
-- previous attempt ended Failed, no attempt of the intent succeeded, the payment window is still
-- open and fewer than five attempts exist. An intent has at most one successful terminal fact, so
-- a retry can never charge an order twice. Earlier attempts and their facts are never changed.
ALTER TABLE rms_payment.payment_attempt DROP CONSTRAINT payment_attempt_attempt_number_check;
ALTER TABLE rms_payment.payment_attempt
  ADD CONSTRAINT payment_attempt_attempt_number_check CHECK (attempt_number BETWEEN 1 AND 5);

ALTER TABLE rms_payment.payment_terminal_fact
  DROP CONSTRAINT payment_terminal_fact_intent_terminal_unique;
CREATE UNIQUE INDEX payment_terminal_fact_intent_success_unique
  ON rms_payment.payment_terminal_fact (payment_intent_id)
  WHERE terminal_outcome = 'Succeeded';
CREATE INDEX payment_terminal_fact_intent_idx
  ON rms_payment.payment_terminal_fact (brand_id, store_id, payment_intent_id);

CREATE FUNCTION rms_payment.check_payment_attempt_sequence() RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE intent rms_payment.payment_intent%ROWTYPE;
DECLARE previous rms_payment.payment_attempt%ROWTYPE;
BEGIN
 IF NEW.attempt_number = 1 THEN
  RETURN NEW;
 END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended(
  'PaymentTerminal:'||NEW.brand_id||':'||NEW.store_id||':'||NEW.payment_intent_id,0));
 SELECT * INTO intent FROM rms_payment.payment_intent
  WHERE payment_intent_id=NEW.payment_intent_id AND brand_id=NEW.brand_id AND store_id=NEW.store_id;
 IF NOT FOUND THEN
  RAISE EXCEPTION 'payment attempt has no intent' USING ERRCODE='23514';
 END IF;
 SELECT * INTO previous FROM rms_payment.payment_attempt
  WHERE payment_intent_id=NEW.payment_intent_id AND brand_id=NEW.brand_id AND store_id=NEW.store_id
   AND attempt_number=NEW.attempt_number-1;
 IF NOT FOUND
  OR NEW.provider <> previous.provider
  OR NEW.provider_environment <> previous.provider_environment
  OR NEW.created_at <= previous.created_at
  OR NEW.created_at >= intent.capacity_expires_at
  OR clock_timestamp() >= intent.capacity_expires_at
  OR NOT EXISTS (
   SELECT 1 FROM rms_payment.payment_terminal_fact f
   WHERE f.payment_attempt_id=previous.payment_attempt_id AND f.payment_intent_id=NEW.payment_intent_id
    AND f.brand_id=NEW.brand_id AND f.store_id=NEW.store_id AND f.terminal_outcome='Failed'
    AND f.recorded_at <= NEW.created_at)
  OR EXISTS (
   SELECT 1 FROM rms_payment.payment_terminal_fact f
   WHERE f.payment_intent_id=NEW.payment_intent_id AND f.brand_id=NEW.brand_id
    AND f.store_id=NEW.store_id AND f.terminal_outcome='Succeeded') THEN
  RAISE EXCEPTION 'payment attempt is not a retry of a failed attempt' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION rms_payment.check_payment_attempt_sequence() FROM PUBLIC;
CREATE TRIGGER payment_attempt_sequence_check BEFORE INSERT ON rms_payment.payment_attempt
 FOR EACH ROW EXECUTE FUNCTION rms_payment.check_payment_attempt_sequence();

CREATE INDEX payment_attempt_latest_idx
  ON rms_payment.payment_attempt (brand_id, store_id, payment_intent_id, attempt_number DESC);
