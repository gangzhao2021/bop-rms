-- bop-rms-migration: 1
-- owner: @rms/ordering
-- schema: rms_ordering
-- phase: expand
-- risk: medium
-- transaction: required
-- lock-timeout-ms: 5000
-- statement-timeout-ms: 60000
-- recovery: forward-fix
-- WP-2423 shared-table-cart-staff-round M38: when the guest paying for a table's round stops
-- before paying ("Don't pay. Put the dishes back", 2000_411 GUEST_CANCELLED_UNPAID), the round's
-- dishes come back to the table's shared cart in the same transaction as its cancellation: each as
-- a new cart line as it was added (dish, options, note, and whose phone added it). This record says
-- so once per round (the dishes can never come back twice), which cart and version they came back
-- in, which lines, which Guest Session asked, and its Audit record. Not a sale: the round was never
-- paid and its cancellation stays in the order's history; the cart history keeps the return.
-- Grants: api SELECT, INSERT (Owner standing approval 2026-10-14 「我都批准，之后不需要问我」;
-- WP-2423 shared-table-cart-staff-round).
CREATE TABLE rms_ordering.dining_round_cart_return (
 order_batch_id platform_helpers.uuid_v7 NOT NULL,
 brand_id platform_helpers.uuid_v7 NOT NULL,
 store_id platform_helpers.uuid_v7 NOT NULL,
 order_id platform_helpers.uuid_v7 NOT NULL,
 dining_session_id platform_helpers.uuid_v7 NOT NULL,
 cart_id platform_helpers.uuid_v7 NOT NULL,
 result_aggregate_version integer NOT NULL CHECK (result_aggregate_version > 1),
 cart_line_ids uuid[] NOT NULL CHECK (cardinality(cart_line_ids) BETWEEN 1 AND 100),
 operation_id platform_helpers.uuid_v7 NOT NULL,
 guest_session_id platform_helpers.uuid_v7 NOT NULL,
 occurred_at timestamptz NOT NULL CHECK (isfinite(occurred_at) AND occurred_at=date_trunc('milliseconds',occurred_at)),
 audit_id platform_helpers.uuid_v7 NOT NULL,
 PRIMARY KEY (brand_id,store_id,order_batch_id),
 CONSTRAINT dining_round_cart_return_operation_once UNIQUE (brand_id,store_id,operation_id),
 CONSTRAINT dining_round_cart_return_version_once UNIQUE (cart_id,result_aggregate_version),
 CONSTRAINT dining_round_cart_return_cart_fk FOREIGN KEY (cart_id,brand_id,store_id)
  REFERENCES rms_ordering.cart(cart_id,brand_id,store_id),
 CONSTRAINT dining_round_cart_return_batch_fk FOREIGN KEY (order_batch_id,order_id,brand_id,store_id)
  REFERENCES rms_ordering.order_batch(order_batch_id,order_id,brand_id,store_id)
);
CREATE INDEX dining_round_cart_return_cart_idx
 ON rms_ordering.dining_round_cart_return (brand_id,store_id,cart_id,occurred_at);

-- Only a round the guest cancelled unpaid (2000_411) comes back, by the Guest Session that sent
-- it, to a table cart of the round's own dining session at the version the return produced, and
-- each listed line is in that cart.
CREATE FUNCTION rms_ordering.validate_dining_round_cart_return() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
BEGIN
 IF NOT EXISTS (SELECT 1 FROM rms_ordering.order_batch_checkout_cancellation x
   JOIN rms_ordering.order_submission_record s ON s.submission_id=x.submission_id
    AND s.brand_id=x.brand_id AND s.store_id=x.store_id
   WHERE x.brand_id=NEW.brand_id AND x.store_id=NEW.store_id AND x.order_id=NEW.order_id
    AND x.order_batch_id=NEW.order_batch_id AND x.reason_code='GUEST_CANCELLED_UNPAID'
    AND x.phase='Cancelled' AND s.guest_session_id=NEW.guest_session_id
    AND x.cancelled_at<=NEW.occurred_at) THEN
  RAISE EXCEPTION 'only a round its guest cancelled unpaid comes back' USING ERRCODE='23514';
 END IF;
 IF NOT EXISTS (SELECT 1 FROM rms_ordering.cart c WHERE c.cart_id=NEW.cart_id
   AND c.brand_id=NEW.brand_id AND c.store_id=NEW.store_id AND c.order_type='DineIn'
   AND c.dining_session_id=NEW.dining_session_id AND c.aggregate_version=NEW.result_aggregate_version)
  OR (SELECT count(*) FROM rms_ordering.cart_line l WHERE l.cart_id=NEW.cart_id
   AND l.brand_id=NEW.brand_id AND l.store_id=NEW.store_id AND l.cart_line_id = ANY (NEW.cart_line_ids))
   <> cardinality(NEW.cart_line_ids) THEN
  RAISE EXCEPTION 'a round comes back to its table cart at the version it produced' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END;
$$;
CREATE TRIGGER dining_round_cart_return_validate BEFORE INSERT ON rms_ordering.dining_round_cart_return
 FOR EACH ROW EXECUTE FUNCTION rms_ordering.validate_dining_round_cart_return();

CREATE FUNCTION rms_ordering.reject_dining_round_cart_return_mutation() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
BEGIN
 RAISE EXCEPTION 'append-only round return' USING ERRCODE='55000';
END;
$$;
CREATE TRIGGER dining_round_cart_return_no_mutation BEFORE UPDATE OR DELETE ON rms_ordering.dining_round_cart_return
 FOR EACH ROW EXECUTE FUNCTION rms_ordering.reject_dining_round_cart_return_mutation();
CREATE TRIGGER dining_round_cart_return_no_truncate BEFORE TRUNCATE ON rms_ordering.dining_round_cart_return
 FOR EACH STATEMENT EXECUTE FUNCTION rms_ordering.reject_dining_round_cart_return_mutation();

ALTER TABLE rms_ordering.dining_round_cart_return ENABLE ROW LEVEL SECURITY;
ALTER TABLE rms_ordering.dining_round_cart_return FORCE ROW LEVEL SECURITY;
CREATE POLICY dining_round_cart_return_scope ON rms_ordering.dining_round_cart_return
 USING (brand_id=platform_helpers.current_brand_id() AND store_id=platform_helpers.current_store_id())
 WITH CHECK (brand_id=platform_helpers.current_brand_id() AND store_id=platform_helpers.current_store_id());
REVOKE ALL ON TABLE rms_ordering.dining_round_cart_return FROM PUBLIC;
REVOKE ALL ON FUNCTION rms_ordering.validate_dining_round_cart_return() FROM PUBLIC;
REVOKE ALL ON FUNCTION rms_ordering.reject_dining_round_cart_return_mutation() FROM PUBLIC;
