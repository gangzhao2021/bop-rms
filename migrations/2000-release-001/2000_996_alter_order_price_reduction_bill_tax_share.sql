-- bop-rms-migration: 1
-- owner: @rms/ordering
-- schema: rms_ordering
-- phase: expand
-- risk: medium
-- transaction: required
-- lock-timeout-ms: 5000
-- statement-timeout-ms: 60000
-- recovery: forward-fix
-- WP-2423 v15 b16 (DEC-COMP-BILL-CENT, docs/spec/design/comp-bill-cent-b16.md): a comp, discount or
-- points redemption on a table's bill takes off exactly what the bill goes down by. The bill's tax
-- is worked out once over the whole bill (DEC-TAX-WHOLE-RECEIPT), so taking dishes off can move the
-- whole-bill tax by a cent more or less than the dishes' own tax. That cent is now part of the
-- reduction's tax, recorded on its own in tax_rounding_minor (the System computes it; the browser
-- never sends money), so the reductions plus what is still owed always equal the bill before.
-- tax_minor stays what the reduction took off the bill's tax (its dish share plus that cent), so
-- every reader keeps adding the same columns. Rows already recorded keep 0 (append-only; nothing
-- is updated). No new grant: api keeps SELECT/INSERT on the table.
-- Bound: when dishes come off a bill its tax rounding moves by about a cent per tax type (two in
-- Canada) plus one from a compound tax, and one reduction spreads it a cent at a time over its
-- dishes, so a dish takes one or two cents. The database cannot recompute the whole bill in a row
-- trigger, so it holds the dish's own share exactly and the cent to at most 9 either way: a
-- defect can never record more than $0.09 of a dish's tax beyond its own share (the System's
-- bound, billTaxRoundingShareLimitMinor, is the same).
ALTER TABLE rms_ordering.order_item_price_reduction
  ADD COLUMN tax_rounding_minor bigint NOT NULL DEFAULT 0
  CONSTRAINT order_item_price_reduction_tax_rounding CHECK (tax_rounding_minor BETWEEN -9 AND 9);

CREATE OR REPLACE FUNCTION rms_ordering.validate_order_item_price_reduction() RETURNS trigger
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
 -- The dish's own share of tax and fee is checked exactly as before; the whole-bill cent
 -- (tax_rounding_minor) only on a dish taxed at a rate.
 IF want_net < 1 OR want_net > item_net OR NEW.net_minor <> want_net
  OR (NEW.kind = 'Amount' AND NEW.net_minor >= item_net)
  OR (NEW.tax_rounding_minor <> 0 AND NOT EXISTS (SELECT 1 FROM jsonb_array_elements(item_snapshot->'taxComponents') c
   WHERE c->>'treatment'='Taxable' AND (c->>'rate')::numeric > 0))
  OR NEW.tax_minor - NEW.tax_rounding_minor <> (CASE WHEN want_net = item_net THEN item_tax
   ELSE (item_tax*want_net*2 + item_net) / (2*item_net) END)
  OR NEW.fee_minor <> (CASE WHEN want_net = item_net THEN item_fee
   ELSE (item_fee*want_net*2 + item_net) / (2*item_net) END)
 THEN RAISE EXCEPTION 'price reduction amount mismatch' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION rms_ordering.validate_order_item_price_reduction() FROM PUBLIC;
