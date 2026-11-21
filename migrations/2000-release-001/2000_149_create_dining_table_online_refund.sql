-- bop-rms-migration: 1
-- owner: @rms/payment
-- schema: rms_payment
-- phase: expand
-- risk: medium
-- transaction: required
-- lock-timeout-ms: 5000
-- statement-timeout-ms: 60000
-- recovery: forward-fix
-- WP-2423 DEC-TABLE-ONLINE-REFUND (Owner 2026-11-02 "按你建议做", known gap 11): money given back
-- to the card of a table a guest paid on their phone. A manager approves it, which fixes the amount
-- and the Provider idempotency key before anything is sent; the Provider's answer is recorded
-- beside it. The table's payment is never changed or removed. An amount on its way counts against
-- what is left; only a refusal the Provider reports releases it. Append-only.
-- Grants: api SELECT/INSERT (Owner standing approval 2026-10-14, WP-2423).
CREATE TABLE rms_payment.dining_table_online_refund (
 online_refund_id platform_helpers.uuid_v7 PRIMARY KEY,
 tenant_id platform_helpers.uuid_v7 NOT NULL,
 brand_id platform_helpers.uuid_v7 NOT NULL,
 store_id platform_helpers.uuid_v7 NOT NULL,
 operation_id platform_helpers.uuid_v7 NOT NULL,
 intent_digest text NOT NULL CHECK (intent_digest ~ '^sha256:[0-9a-f]{64}$'),
 settlement_id platform_helpers.uuid_v7 NOT NULL REFERENCES rms_payment.dining_table_settlement(settlement_id),
 online_payment_id platform_helpers.uuid_v7 NOT NULL,
 order_id platform_helpers.uuid_v7 NOT NULL,
 amount_minor bigint NOT NULL CHECK (amount_minor > 0),
 currency_code text NOT NULL CHECK (currency_code = 'CAD'),
 reason_code text NOT NULL CHECK (reason_code IN ('FOOD_ISSUE','CUSTOMER_REQUEST','OVERCHARGED','STORE_ERROR')),
 approved_by_actor_id platform_helpers.uuid_v7 NOT NULL,
 provider_idempotency_key text NOT NULL UNIQUE,
 requested_at timestamptz NOT NULL CHECK (isfinite(requested_at) AND requested_at=date_trunc('milliseconds',requested_at)),
 audit_id platform_helpers.uuid_v7 NOT NULL UNIQUE,
 CONSTRAINT dining_table_online_refund_operation UNIQUE (brand_id,store_id,operation_id)
);
CREATE INDEX dining_table_online_refund_settlement_idx
 ON rms_payment.dining_table_online_refund (brand_id,store_id,settlement_id);
CREATE INDEX dining_table_online_refund_order_idx
 ON rms_payment.dining_table_online_refund (brand_id,store_id,order_id);

CREATE TABLE rms_payment.dining_table_online_refund_outcome (
 online_refund_id platform_helpers.uuid_v7 PRIMARY KEY REFERENCES rms_payment.dining_table_online_refund(online_refund_id),
 brand_id platform_helpers.uuid_v7 NOT NULL,
 store_id platform_helpers.uuid_v7 NOT NULL,
 status text NOT NULL CHECK (status IN ('Succeeded','Failed')),
 amount_minor bigint NOT NULL CHECK (amount_minor > 0),
 provider_refund_reference text UNIQUE,
 -- The Provider's creation time decides the business day the refund counts in.
 provider_created_at timestamptz CHECK (provider_created_at IS NULL OR (isfinite(provider_created_at) AND provider_created_at=date_trunc('second',provider_created_at))),
 provider_observed_at timestamptz NOT NULL CHECK (isfinite(provider_observed_at) AND provider_observed_at=date_trunc('milliseconds',provider_observed_at)),
 evidence_digest text CHECK (evidence_digest IS NULL OR evidence_digest ~ '^sha256:[0-9a-f]{64}$'),
 recorded_at timestamptz NOT NULL CHECK (isfinite(recorded_at) AND recorded_at=date_trunc('milliseconds',recorded_at)),
 audit_id platform_helpers.uuid_v7 NOT NULL UNIQUE,
 CONSTRAINT dining_table_online_refund_outcome_succeeded CHECK (
  status<>'Succeeded' OR (provider_refund_reference IS NOT NULL AND provider_created_at IS NOT NULL AND evidence_digest IS NOT NULL)
 ),
 CONSTRAINT dining_table_online_refund_outcome_time CHECK (
  provider_observed_at <= recorded_at AND (provider_created_at IS NULL OR provider_created_at <= provider_observed_at)
 )
);
CREATE INDEX dining_table_online_refund_outcome_created_idx
 ON rms_payment.dining_table_online_refund_outcome (brand_id,store_id,provider_created_at);

-- Only a table's captured phone payment is refunded this way, never beyond what it took.
CREATE FUNCTION rms_payment.validate_dining_table_online_refund() RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
 paid rms_payment.dining_table_settlement%ROWTYPE;
 already bigint;
BEGIN
 PERFORM pg_advisory_xact_lock(hashtextextended('DiningTableOnlineRefund:'||NEW.brand_id||':'||NEW.store_id||':'||NEW.settlement_id,0));
 SELECT * INTO paid FROM rms_payment.dining_table_settlement WHERE settlement_id=NEW.settlement_id;
 IF NOT FOUND OR paid.method<>'Online' OR paid.online_payment_id IS DISTINCT FROM NEW.online_payment_id
  OR paid.tenant_id<>NEW.tenant_id OR paid.brand_id<>NEW.brand_id OR paid.store_id<>NEW.store_id
  OR paid.order_id<>NEW.order_id OR NEW.requested_at<paid.taken_at THEN
  RAISE EXCEPTION 'online refund does not match a phone payment' USING ERRCODE='23514';
 END IF;
 SELECT coalesce(sum(r.amount_minor),0) INTO already
  FROM rms_payment.dining_table_online_refund r
  LEFT JOIN rms_payment.dining_table_online_refund_outcome o ON o.online_refund_id=r.online_refund_id
  WHERE r.settlement_id=NEW.settlement_id AND o.status IS DISTINCT FROM 'Failed';
 IF already + NEW.amount_minor > paid.total_minor THEN
  RAISE EXCEPTION 'online refunds exceed the phone payment' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION rms_payment.validate_dining_table_online_refund() FROM PUBLIC;
CREATE TRIGGER dining_table_online_refund_validate BEFORE INSERT ON rms_payment.dining_table_online_refund
 FOR EACH ROW EXECUTE FUNCTION rms_payment.validate_dining_table_online_refund();

-- The Provider's answer belongs to its refund: same Store, the full amount when it succeeded.
CREATE FUNCTION rms_payment.validate_dining_table_online_refund_outcome() RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
 sent rms_payment.dining_table_online_refund%ROWTYPE;
BEGIN
 SELECT * INTO sent FROM rms_payment.dining_table_online_refund WHERE online_refund_id=NEW.online_refund_id;
 IF NOT FOUND OR sent.brand_id<>NEW.brand_id OR sent.store_id<>NEW.store_id
  OR sent.amount_minor<>NEW.amount_minor OR NEW.recorded_at<sent.requested_at THEN
  RAISE EXCEPTION 'online refund outcome does not match its refund' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION rms_payment.validate_dining_table_online_refund_outcome() FROM PUBLIC;
CREATE TRIGGER dining_table_online_refund_outcome_validate BEFORE INSERT ON rms_payment.dining_table_online_refund_outcome
 FOR EACH ROW EXECUTE FUNCTION rms_payment.validate_dining_table_online_refund_outcome();

CREATE TRIGGER dining_table_online_refund_no_mutation BEFORE UPDATE OR DELETE ON rms_payment.dining_table_online_refund
 FOR EACH ROW EXECUTE FUNCTION rms_payment.reject_dining_table_settlement_mutation();
CREATE TRIGGER dining_table_online_refund_no_truncate BEFORE TRUNCATE ON rms_payment.dining_table_online_refund
 FOR EACH STATEMENT EXECUTE FUNCTION rms_payment.reject_dining_table_settlement_mutation();
CREATE TRIGGER dining_table_online_refund_outcome_no_mutation BEFORE UPDATE OR DELETE ON rms_payment.dining_table_online_refund_outcome
 FOR EACH ROW EXECUTE FUNCTION rms_payment.reject_dining_table_settlement_mutation();
CREATE TRIGGER dining_table_online_refund_outcome_no_truncate BEFORE TRUNCATE ON rms_payment.dining_table_online_refund_outcome
 FOR EACH STATEMENT EXECUTE FUNCTION rms_payment.reject_dining_table_settlement_mutation();

ALTER TABLE rms_payment.dining_table_online_refund ENABLE ROW LEVEL SECURITY;
ALTER TABLE rms_payment.dining_table_online_refund FORCE ROW LEVEL SECURITY;
CREATE POLICY dining_table_online_refund_scope ON rms_payment.dining_table_online_refund
 USING (brand_id=platform_helpers.current_brand_id() AND store_id=platform_helpers.current_store_id())
 WITH CHECK (brand_id=platform_helpers.current_brand_id() AND store_id=platform_helpers.current_store_id());
REVOKE ALL ON TABLE rms_payment.dining_table_online_refund FROM PUBLIC;
ALTER TABLE rms_payment.dining_table_online_refund_outcome ENABLE ROW LEVEL SECURITY;
ALTER TABLE rms_payment.dining_table_online_refund_outcome FORCE ROW LEVEL SECURITY;
CREATE POLICY dining_table_online_refund_outcome_scope ON rms_payment.dining_table_online_refund_outcome
 USING (brand_id=platform_helpers.current_brand_id() AND store_id=platform_helpers.current_store_id())
 WITH CHECK (brand_id=platform_helpers.current_brand_id() AND store_id=platform_helpers.current_store_id());
REVOKE ALL ON TABLE rms_payment.dining_table_online_refund_outcome FROM PUBLIC;
