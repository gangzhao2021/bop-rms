-- bop-rms-migration: 1
-- owner: @rms/ordering
-- schema: rms_ordering
-- phase: expand
-- risk: low
-- transaction: required
-- lock-timeout-ms: 5000
-- statement-timeout-ms: 60000
-- recovery: forward-fix
-- WP-2423 M10 (DEC-OWNER-DEFAULTS-2026-11-06 item 4): when staff refund some units of a dish they
-- are asked "stop making it too?" (Yes preselected while the kitchen has not started it). Yes is
-- recorded here, in the same transaction as the Payment refund request that returns the money:
-- these units of this order item are not to be made or handed over. It never changes the refund,
-- the sale or the kitchen's own records; the kitchen ticket, the pickup card and the guest's page
-- read it, for as long as its refund request is not declined. Append-only.
CREATE TABLE rms_ordering.order_item_refund_withdrawal (
 withdrawal_id platform_helpers.uuid_v7 PRIMARY KEY,
 operation_id platform_helpers.uuid_v7 NOT NULL,
 brand_id platform_helpers.uuid_v7 NOT NULL,
 store_id platform_helpers.uuid_v7 NOT NULL,
 order_id platform_helpers.uuid_v7 NOT NULL,
 order_batch_id platform_helpers.uuid_v7 NOT NULL,
 order_item_id platform_helpers.uuid_v7 NOT NULL,
 refund_request_id platform_helpers.uuid_v7 NOT NULL,
 withdrawn_quantity integer NOT NULL CHECK (withdrawn_quantity BETWEEN 1 AND 999),
 reason_code text NOT NULL CHECK (reason_code='REFUNDED_NOT_PROVIDED'),
 actor_type text NOT NULL CHECK (actor_type='User'),
 actor_id platform_helpers.uuid_v7 NOT NULL,
 permission_code text NOT NULL CHECK (permission_code='ordering.order.cancel'),
 recorded_at timestamptz NOT NULL CHECK (isfinite(recorded_at) AND recorded_at=date_trunc('milliseconds',recorded_at)),
 CHECK (withdrawal_id<>operation_id AND withdrawal_id<>refund_request_id),
 UNIQUE (brand_id,store_id,refund_request_id,order_item_id),
 UNIQUE (brand_id,store_id,operation_id,order_item_id),
 FOREIGN KEY (order_item_id,order_batch_id,order_id,brand_id,store_id)
  REFERENCES rms_ordering.order_item(order_item_id,order_batch_id,order_id,brand_id,store_id)
);
CREATE INDEX order_item_refund_withdrawal_order_idx
 ON rms_ordering.order_item_refund_withdrawal (brand_id,store_id,order_id);

-- Never more units than the line has; one request's rows share its operation and actor.
CREATE FUNCTION rms_ordering.validate_order_item_refund_withdrawal() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
BEGIN
 IF NOT EXISTS (SELECT 1 FROM rms_ordering.order_item i WHERE i.brand_id=NEW.brand_id AND i.store_id=NEW.store_id
  AND i.order_item_id=NEW.order_item_id AND i.quantity>=NEW.withdrawn_quantity)
 THEN RAISE EXCEPTION 'withdrawal exceeds the line' USING ERRCODE='23514'; END IF;
 IF EXISTS (SELECT 1 FROM rms_ordering.order_item_refund_withdrawal w WHERE w.brand_id=NEW.brand_id
  AND w.store_id=NEW.store_id AND w.refund_request_id=NEW.refund_request_id
  AND (w.operation_id<>NEW.operation_id OR w.actor_id<>NEW.actor_id OR w.order_id<>NEW.order_id))
 THEN RAISE EXCEPTION 'withdrawal request conflict' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION rms_ordering.validate_order_item_refund_withdrawal() FROM PUBLIC;
CREATE TRIGGER order_item_refund_withdrawal_validate BEFORE INSERT ON rms_ordering.order_item_refund_withdrawal
 FOR EACH ROW EXECUTE FUNCTION rms_ordering.validate_order_item_refund_withdrawal();

CREATE FUNCTION rms_ordering.reject_order_item_refund_withdrawal_mutation() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
BEGIN RAISE EXCEPTION 'append-only refund withdrawal' USING ERRCODE='55000'; END;
$$;
REVOKE ALL ON FUNCTION rms_ordering.reject_order_item_refund_withdrawal_mutation() FROM PUBLIC;
CREATE TRIGGER order_item_refund_withdrawal_no_mutation BEFORE UPDATE OR DELETE ON rms_ordering.order_item_refund_withdrawal
 FOR EACH ROW EXECUTE FUNCTION rms_ordering.reject_order_item_refund_withdrawal_mutation();
CREATE TRIGGER order_item_refund_withdrawal_no_truncate BEFORE TRUNCATE ON rms_ordering.order_item_refund_withdrawal
 FOR EACH STATEMENT EXECUTE FUNCTION rms_ordering.reject_order_item_refund_withdrawal_mutation();
ALTER TABLE rms_ordering.order_item_refund_withdrawal ENABLE ROW LEVEL SECURITY;
ALTER TABLE rms_ordering.order_item_refund_withdrawal FORCE ROW LEVEL SECURITY;
CREATE POLICY order_item_refund_withdrawal_scope ON rms_ordering.order_item_refund_withdrawal
 USING (brand_id=platform_helpers.current_brand_id() AND store_id=platform_helpers.current_store_id())
 WITH CHECK (brand_id=platform_helpers.current_brand_id() AND store_id=platform_helpers.current_store_id());
REVOKE ALL ON TABLE rms_ordering.order_item_refund_withdrawal FROM PUBLIC;
