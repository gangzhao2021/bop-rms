-- bop-rms-migration: 1
-- owner: @rms/payment
-- schema: rms_payment
-- phase: expand
-- risk: low
-- transaction: required
-- lock-timeout-ms: 5000
-- statement-timeout-ms: 60000
-- recovery: forward-fix
-- WP-2423 M163 (DEC-OWNER-DEFAULTS-2026-11-06 item 5): when staff refunded too much by mistake and
-- the guest gives the money back, a manager or the owner records "money taken back" on the same
-- order, on the day it happens, in their own name. It is the compensating entry for the refund:
-- the refund itself is never changed. Taken in cash or charged on the Store's card machine (its
-- slip reference recorded). Never more than the order's confirmed refunds less what was already
-- taken back (checked under the Order's refund fence). Append-only.
CREATE TABLE rms_payment.refund_recovery (
 tenant_id platform_helpers.uuid_v7 NOT NULL,
 brand_id platform_helpers.uuid_v7 NOT NULL,
 store_id platform_helpers.uuid_v7 NOT NULL,
 recovery_id platform_helpers.uuid_v7 NOT NULL,
 operation_id platform_helpers.uuid_v7 NOT NULL,
 order_id platform_helpers.uuid_v7 NOT NULL,
 method text NOT NULL CHECK (method IN ('Cash','CardMachine')),
 slip_reference text NULL CHECK (slip_reference IS NULL OR slip_reference ~ '^[A-Za-z0-9 -]{1,24}$'),
 amount_minor bigint NOT NULL CHECK (amount_minor > 0 AND amount_minor <= 100000000),
 currency_code text NOT NULL CHECK (currency_code='CAD'),
 reason_code text NOT NULL CHECK (reason_code IN ('REFUNDED_TOO_MUCH','WRONG_ITEM_REFUNDED','OTHER')),
 actor_type text NOT NULL CHECK (actor_type='User'),
 actor_id platform_helpers.uuid_v7 NOT NULL,
 permission_code text NOT NULL CHECK (permission_code='payment.refund.recover'),
 business_date date NOT NULL,
 recorded_at timestamptz NOT NULL CHECK (isfinite(recorded_at) AND recorded_at=date_trunc('milliseconds',recorded_at)),
 audit_id platform_helpers.uuid_v7 NOT NULL UNIQUE,
 PRIMARY KEY (brand_id,store_id,recovery_id),
 CONSTRAINT refund_recovery_operation_once UNIQUE (brand_id,store_id,operation_id),
 CONSTRAINT refund_recovery_slip CHECK ((method='CardMachine') = (slip_reference IS NOT NULL)),
 CHECK (recovery_id<>operation_id AND recovery_id<>audit_id)
);
CREATE INDEX refund_recovery_order_idx ON rms_payment.refund_recovery (brand_id,store_id,order_id);
CREATE INDEX refund_recovery_business_date_idx ON rms_payment.refund_recovery (brand_id,store_id,business_date);

CREATE FUNCTION rms_payment.reject_refund_recovery_mutation() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
BEGIN RAISE EXCEPTION 'append-only refund recovery' USING ERRCODE='55000'; END;
$$;
REVOKE ALL ON FUNCTION rms_payment.reject_refund_recovery_mutation() FROM PUBLIC;
CREATE TRIGGER refund_recovery_no_mutation BEFORE UPDATE OR DELETE ON rms_payment.refund_recovery
 FOR EACH ROW EXECUTE FUNCTION rms_payment.reject_refund_recovery_mutation();
CREATE TRIGGER refund_recovery_no_truncate BEFORE TRUNCATE ON rms_payment.refund_recovery
 FOR EACH STATEMENT EXECUTE FUNCTION rms_payment.reject_refund_recovery_mutation();
ALTER TABLE rms_payment.refund_recovery ENABLE ROW LEVEL SECURITY;
ALTER TABLE rms_payment.refund_recovery FORCE ROW LEVEL SECURITY;
CREATE POLICY refund_recovery_scope ON rms_payment.refund_recovery
 USING (brand_id=platform_helpers.current_brand_id() AND store_id=platform_helpers.current_store_id())
 WITH CHECK (brand_id=platform_helpers.current_brand_id() AND store_id=platform_helpers.current_store_id());
REVOKE ALL ON TABLE rms_payment.refund_recovery FROM PUBLIC;
