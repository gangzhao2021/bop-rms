-- bop-rms-migration: 1
-- owner: @rms/payment
-- schema: rms_payment
-- phase: expand
-- risk: medium
-- transaction: required
-- lock-timeout-ms: 5000
-- statement-timeout-ms: 60000
-- recovery: forward-fix
-- WP-2423 DEC-TABLE-ONLINE-REFUND (known gap 5, Owner 2026-11-03 "按你建议即可 无需问我"): a refund a
-- manager made on the Store's card machine, of a table's card machine payment. The money moved on
-- the machine; this records the amount, who, why, when and the slip, as a compensating record. The
-- table's payment is never changed or removed. All refunds of one payment never exceed what it
-- took. Append-only.
-- Grants: api SELECT/INSERT (Owner standing approval 2026-10-14, WP-2423).
CREATE TABLE rms_payment.dining_table_card_refund (
 card_refund_id platform_helpers.uuid_v7 PRIMARY KEY,
 tenant_id platform_helpers.uuid_v7 NOT NULL,
 brand_id platform_helpers.uuid_v7 NOT NULL,
 store_id platform_helpers.uuid_v7 NOT NULL,
 operation_id platform_helpers.uuid_v7 NOT NULL,
 intent_digest text NOT NULL CHECK (intent_digest ~ '^sha256:[0-9a-f]{64}$'),
 settlement_id platform_helpers.uuid_v7 NOT NULL REFERENCES rms_payment.dining_table_settlement(settlement_id),
 order_id platform_helpers.uuid_v7 NOT NULL,
 amount_minor bigint NOT NULL CHECK (amount_minor > 0),
 currency_code text NOT NULL CHECK (currency_code = 'CAD'),
 reason_code text NOT NULL CHECK (reason_code IN ('FOOD_ISSUE','CUSTOMER_REQUEST','OVERCHARGED','STORE_ERROR')),
 slip_reference text CHECK (slip_reference IS NULL OR slip_reference ~ '^[A-Za-z0-9][A-Za-z0-9 #./-]{0,39}$'),
 approved_by_actor_id platform_helpers.uuid_v7 NOT NULL,
 refunded_at timestamptz NOT NULL CHECK (isfinite(refunded_at) AND refunded_at=date_trunc('milliseconds',refunded_at)),
 recorded_at timestamptz NOT NULL CHECK (isfinite(recorded_at) AND recorded_at=date_trunc('milliseconds',recorded_at)),
 audit_id platform_helpers.uuid_v7 NOT NULL UNIQUE,
 CONSTRAINT dining_table_card_refund_operation UNIQUE (brand_id,store_id,operation_id),
 CONSTRAINT dining_table_card_refund_time CHECK (refunded_at <= recorded_at AND refunded_at >= recorded_at - interval '72 hours')
);
CREATE INDEX dining_table_card_refund_settlement_idx
 ON rms_payment.dining_table_card_refund (brand_id,store_id,settlement_id);
CREATE INDEX dining_table_card_refund_refunded_idx
 ON rms_payment.dining_table_card_refund (brand_id,store_id,refunded_at);

-- Only a card machine payment is refunded this way, never beyond what it took or before it was taken.
CREATE FUNCTION rms_payment.validate_dining_table_card_refund() RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
 paid rms_payment.dining_table_settlement%ROWTYPE;
 already bigint;
BEGIN
 PERFORM pg_advisory_xact_lock(hashtextextended('DiningTableCardRefund:'||NEW.brand_id||':'||NEW.store_id||':'||NEW.settlement_id,0));
 SELECT * INTO paid FROM rms_payment.dining_table_settlement WHERE settlement_id=NEW.settlement_id;
 IF NOT FOUND OR paid.method<>'CardMachine' OR paid.tenant_id<>NEW.tenant_id OR paid.brand_id<>NEW.brand_id
  OR paid.store_id<>NEW.store_id OR paid.order_id<>NEW.order_id OR NEW.refunded_at<paid.taken_at THEN
  RAISE EXCEPTION 'card refund does not match a card machine payment' USING ERRCODE='23514';
 END IF;
 SELECT coalesce(sum(amount_minor),0) INTO already FROM rms_payment.dining_table_card_refund
  WHERE settlement_id=NEW.settlement_id;
 IF already + NEW.amount_minor > paid.total_minor THEN
  RAISE EXCEPTION 'card refunds exceed the card machine payment' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION rms_payment.validate_dining_table_card_refund() FROM PUBLIC;
CREATE TRIGGER dining_table_card_refund_validate BEFORE INSERT ON rms_payment.dining_table_card_refund
 FOR EACH ROW EXECUTE FUNCTION rms_payment.validate_dining_table_card_refund();
CREATE TRIGGER dining_table_card_refund_no_mutation BEFORE UPDATE OR DELETE ON rms_payment.dining_table_card_refund
 FOR EACH ROW EXECUTE FUNCTION rms_payment.reject_dining_table_settlement_mutation();
CREATE TRIGGER dining_table_card_refund_no_truncate BEFORE TRUNCATE ON rms_payment.dining_table_card_refund
 FOR EACH STATEMENT EXECUTE FUNCTION rms_payment.reject_dining_table_settlement_mutation();
ALTER TABLE rms_payment.dining_table_card_refund ENABLE ROW LEVEL SECURITY;
ALTER TABLE rms_payment.dining_table_card_refund FORCE ROW LEVEL SECURITY;
CREATE POLICY dining_table_card_refund_scope ON rms_payment.dining_table_card_refund
 USING (brand_id=platform_helpers.current_brand_id() AND store_id=platform_helpers.current_store_id())
 WITH CHECK (brand_id=platform_helpers.current_brand_id() AND store_id=platform_helpers.current_store_id());
REVOKE ALL ON TABLE rms_payment.dining_table_card_refund FROM PUBLIC;
