-- bop-rms-migration: 1
-- owner: @rms/ordering
-- schema: rms_ordering
-- phase: expand
-- risk: medium
-- transaction: required
-- lock-timeout-ms: 5000
-- statement-timeout-ms: 60000
-- recovery: forward-fix
-- WP-2423 item 8 ① segment 2 (Owner decision 2, 2026-10-27; DEC-TABLES-SERVER-MAIN): a manager
-- comps or discounts a dish the kitchen has started or the table was served, before the table
-- pays. One append-only record per dish (who decided, which dish, how much, why), as a
-- compensating operation on the sale: the dish stays sold at its price; the reduction comes off
-- the Order's priced total (the table's bill) and is reported on its own line ("Comps and
-- discounts"). Never updated or deleted; a paid table is refunded instead (checked by the command
-- under the Order's fence: Payment's settlement is not read here).
-- The amounts are checked against the dish's frozen price snapshot: a comp takes the whole dish
-- (net, tax and fee); a percentage or an amount off the net takes tax and fee in proportion,
-- rounded half up to the cent, so the browser can never choose the money.
-- Grants: api SELECT/INSERT (Owner standing approval 2026-10-14, WP-2423).
CREATE TABLE rms_ordering.order_item_price_reduction (
 reduction_id platform_helpers.uuid_v7 PRIMARY KEY,
 operation_id platform_helpers.uuid_v7 NOT NULL,
 brand_id platform_helpers.uuid_v7 NOT NULL,
 store_id platform_helpers.uuid_v7 NOT NULL,
 order_id platform_helpers.uuid_v7 NOT NULL,
 order_batch_id platform_helpers.uuid_v7 NOT NULL,
 order_item_id platform_helpers.uuid_v7 NOT NULL,
 kind text NOT NULL CHECK (kind IN ('Comp','Percent','Amount')),
 percent integer CHECK (percent BETWEEN 1 AND 99),
 net_minor bigint NOT NULL CHECK (net_minor >= 0),
 tax_minor bigint NOT NULL CHECK (tax_minor >= 0),
 fee_minor bigint NOT NULL CHECK (fee_minor >= 0),
 total_minor bigint NOT NULL CHECK (total_minor > 0),
 currency_code text NOT NULL CHECK (currency_code = 'CAD'),
 reason_code text NOT NULL CHECK (reason_code IN ('QUALITY','WRONG_DISH','LONG_WAIT','GOODWILL')),
 actor_id platform_helpers.uuid_v7 NOT NULL,
 permission_code text NOT NULL CHECK (permission_code = 'ordering.order.comp'),
 audit_id platform_helpers.uuid_v7 NOT NULL UNIQUE,
 decided_at timestamptz NOT NULL CHECK (isfinite(decided_at) AND decided_at=date_trunc('milliseconds',decided_at)),
 CONSTRAINT order_item_price_reduction_total CHECK (
  total_minor::numeric = net_minor::numeric + tax_minor::numeric + fee_minor::numeric
 ),
 CONSTRAINT order_item_price_reduction_kind CHECK ((kind = 'Percent') = (percent IS NOT NULL)),
 CONSTRAINT order_item_price_reduction_operation_item UNIQUE (brand_id,store_id,operation_id,order_item_id),
 -- One reduction per dish: a second decision on the same dish is refused.
 CONSTRAINT order_item_price_reduction_item UNIQUE (brand_id,store_id,order_item_id),
 FOREIGN KEY (order_batch_id,order_id,brand_id,store_id)
  REFERENCES rms_ordering.order_batch(order_batch_id,order_id,brand_id,store_id)
);
CREATE INDEX order_item_price_reduction_order_idx
 ON rms_ordering.order_item_price_reduction (brand_id,store_id,order_id);
CREATE INDEX order_item_price_reduction_decided_idx
 ON rms_ordering.order_item_price_reduction (brand_id,store_id,decided_at);

CREATE FUNCTION rms_ordering.validate_order_item_price_reduction() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
DECLARE
 item_snapshot jsonb;
 item_net bigint;
 item_tax bigint;
 item_fee bigint;
 want_net bigint;
BEGIN
 PERFORM pg_advisory_xact_lock(hashtextextended('OrderingOrderDisposition:'||NEW.brand_id||':'||NEW.store_id||':'||NEW.order_id,0));
 IF NOT EXISTS (SELECT 1 FROM rms_ordering.order_header WHERE brand_id=NEW.brand_id AND store_id=NEW.store_id
   AND order_id=NEW.order_id AND order_type='DineIn')
 THEN RAISE EXCEPTION 'price reduction order is not dine-in' USING ERRCODE='23514'; END IF;
 -- A round of a table that pays at the end (sent to the kitchen unpaid).
 IF NOT EXISTS (SELECT 1 FROM rms_ordering.order_pay_later_confirmation p
   JOIN rms_ordering.order_batch b ON b.brand_id=p.brand_id AND b.store_id=p.store_id AND b.order_id=p.order_id
    AND b.order_batch_id=p.order_batch_id AND b.submission_id=p.submission_id
   WHERE p.brand_id=NEW.brand_id AND p.store_id=NEW.store_id AND p.order_id=NEW.order_id
    AND p.order_batch_id=NEW.order_batch_id AND p.confirmed_at<=NEW.decided_at)
 THEN RAISE EXCEPTION 'price reduction round is not pay-later' USING ERRCODE='23514'; END IF;
 IF EXISTS (SELECT 1 FROM rms_ordering.order_termination_record WHERE brand_id=NEW.brand_id
   AND store_id=NEW.store_id AND order_id=NEW.order_id)
  OR (SELECT status FROM rms_ordering.order_closure_version WHERE brand_id=NEW.brand_id AND store_id=NEW.store_id
   AND order_id=NEW.order_id ORDER BY closure_version DESC LIMIT 1)='Closed'
  OR EXISTS (SELECT 1 FROM rms_ordering.order_staff_cancellation WHERE brand_id=NEW.brand_id
   AND store_id=NEW.store_id AND order_id=NEW.order_id AND order_batch_id=NEW.order_batch_id)
  OR EXISTS (SELECT 1 FROM rms_ordering.order_batch_checkout_cancellation WHERE brand_id=NEW.brand_id
   AND store_id=NEW.store_id AND order_id=NEW.order_id AND order_batch_id=NEW.order_batch_id)
  OR EXISTS (SELECT 1 FROM rms_ordering.order_item_staff_cancellation c WHERE c.brand_id=NEW.brand_id
   AND c.store_id=NEW.store_id AND c.order_id=NEW.order_id AND NEW.order_item_id::uuid = ANY(c.order_item_ids))
 THEN RAISE EXCEPTION 'price reduction state conflict' USING ERRCODE='23514'; END IF;
 SELECT transaction_snapshot_json->'pricing' INTO item_snapshot FROM rms_ordering.order_item
  WHERE brand_id=NEW.brand_id AND store_id=NEW.store_id AND order_id=NEW.order_id
   AND order_batch_id=NEW.order_batch_id AND order_item_id=NEW.order_item_id;
 IF item_snapshot IS NULL OR item_snapshot->'total'->>'currencyCode' IS DISTINCT FROM NEW.currency_code
 THEN RAISE EXCEPTION 'price reduction item not found' USING ERRCODE='23514'; END IF;
 item_net := (item_snapshot->'subtotal'->>'amountMinor')::bigint - (item_snapshot->'discount'->>'amountMinor')::bigint;
 item_tax := (item_snapshot->'tax'->>'amountMinor')::bigint;
 item_fee := (item_snapshot->'fee'->>'amountMinor')::bigint;
 IF item_net <= 0 THEN RAISE EXCEPTION 'price reduction item has no price' USING ERRCODE='23514'; END IF;
 want_net := CASE NEW.kind
  WHEN 'Comp' THEN item_net
  WHEN 'Percent' THEN (item_net*NEW.percent + 50) / 100
  ELSE NEW.net_minor END;
 IF want_net < 1 OR want_net > item_net OR NEW.net_minor <> want_net
  OR (NEW.kind = 'Amount' AND NEW.net_minor >= item_net)
  OR NEW.tax_minor <> (CASE WHEN want_net = item_net THEN item_tax
   ELSE (item_tax*want_net*2 + item_net) / (2*item_net) END)
  OR NEW.fee_minor <> (CASE WHEN want_net = item_net THEN item_fee
   ELSE (item_fee*want_net*2 + item_net) / (2*item_net) END)
 THEN RAISE EXCEPTION 'price reduction amount mismatch' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION rms_ordering.validate_order_item_price_reduction() FROM PUBLIC;
CREATE TRIGGER order_item_price_reduction_validate BEFORE INSERT ON rms_ordering.order_item_price_reduction
 FOR EACH ROW EXECUTE FUNCTION rms_ordering.validate_order_item_price_reduction();

CREATE FUNCTION rms_ordering.reject_order_item_price_reduction_mutation() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
BEGIN RAISE EXCEPTION 'append-only price reduction' USING ERRCODE='55000'; END;
$$;
REVOKE ALL ON FUNCTION rms_ordering.reject_order_item_price_reduction_mutation() FROM PUBLIC;
CREATE TRIGGER order_item_price_reduction_no_mutation BEFORE UPDATE OR DELETE ON rms_ordering.order_item_price_reduction
 FOR EACH ROW EXECUTE FUNCTION rms_ordering.reject_order_item_price_reduction_mutation();
CREATE TRIGGER order_item_price_reduction_no_truncate BEFORE TRUNCATE ON rms_ordering.order_item_price_reduction
 FOR EACH STATEMENT EXECUTE FUNCTION rms_ordering.reject_order_item_price_reduction_mutation();
ALTER TABLE rms_ordering.order_item_price_reduction ENABLE ROW LEVEL SECURITY;
ALTER TABLE rms_ordering.order_item_price_reduction FORCE ROW LEVEL SECURITY;
CREATE POLICY order_item_price_reduction_scope ON rms_ordering.order_item_price_reduction
 USING (brand_id=platform_helpers.current_brand_id() AND store_id=platform_helpers.current_store_id())
 WITH CHECK (brand_id=platform_helpers.current_brand_id() AND store_id=platform_helpers.current_store_id());
REVOKE ALL ON TABLE rms_ordering.order_item_price_reduction FROM PUBLIC;
