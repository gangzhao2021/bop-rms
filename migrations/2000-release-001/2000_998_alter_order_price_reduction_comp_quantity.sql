-- bop-rms-migration: 1
-- owner: @rms/ordering
-- schema: rms_ordering
-- phase: expand
-- risk: medium
-- transaction: required
-- lock-timeout-ms: 5000
-- statement-timeout-ms: 60000
-- recovery: forward-fix
-- WP-2423 batch 60 (v15 b59 live, staff-refund-lines; commercial fidelity, Owner 2026-10-07): a
-- manager comps part of a line ("1 of 2 × Beef noodles": one bowl was wrong or came late), not
-- only the whole line. A comp now records how many of the line's dishes it covers
-- (comped_quantity, 1..the line's quantity); a second comp may cover dishes still left, and the
-- comps of a line never cover more than it has. Each comp stays its own append-only record (who,
-- when, why, how many, how much), so the line and every comp on it stay visible; nothing is
-- updated or deleted.
-- Money: the comps of a line take off its price (net, tax and fee each) in proportion to the
-- dishes covered so far, half up to the cent: dishes 1..c come to round(amount × c / quantity),
-- and a comp of k dishes after p takes round(amount × (p+k) / q) − round(amount × p / q). So a comp
-- of the whole line takes exactly its price (as before), and comps of every dish of a line add up
-- to its price to the cent (the last one takes what is left). The whole bill's tax cent
-- (tax_rounding_minor, 2000_996) is held as before.
-- A whole-line reduction recorded before this (comped_quantity NULL), a percentage, an amount off
-- or points still covers the line alone: nothing else is recorded on that line, and none of them
-- is recorded on a line that has a comp. Rows already recorded keep NULL (append-only).
-- No new grant: api keeps SELECT/INSERT on the table.
ALTER TABLE rms_ordering.order_item_price_reduction
  ADD COLUMN comped_quantity integer
  CONSTRAINT order_item_price_reduction_comped_quantity CHECK (comped_quantity BETWEEN 1 AND 999),
  ADD CONSTRAINT order_item_price_reduction_comped_quantity_kind CHECK (
    comped_quantity IS NULL OR (kind = 'Comp' AND reason_code <> 'POINTS_REDEMPTION')
  ),
  DROP CONSTRAINT order_item_price_reduction_item;
-- One whole-line reduction per dish line, as before; comps naming their dishes are bounded by the
-- triggers below (under the Order's disposition lock).
CREATE UNIQUE INDEX order_item_price_reduction_whole_item
  ON rms_ordering.order_item_price_reduction (brand_id,store_id,order_item_id)
  WHERE comped_quantity IS NULL;
CREATE INDEX order_item_price_reduction_item_idx
  ON rms_ordering.order_item_price_reduction (brand_id,store_id,order_item_id);

CREATE OR REPLACE FUNCTION rms_ordering.validate_order_item_price_reduction() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
DECLARE
 item_snapshot jsonb;
 line_quantity integer;
 item_net bigint;
 item_tax bigint;
 item_fee bigint;
 want_net bigint;
 want_tax bigint;
 want_fee bigint;
 prior_quantity bigint;
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
 SELECT quantity, transaction_snapshot_json->'pricing' INTO line_quantity, item_snapshot FROM rms_ordering.order_item
  WHERE brand_id=NEW.brand_id AND store_id=NEW.store_id AND order_id=NEW.order_id
   AND order_batch_id=NEW.order_batch_id AND order_item_id=NEW.order_item_id;
 IF item_snapshot IS NULL OR item_snapshot->'total'->>'currencyCode' IS DISTINCT FROM NEW.currency_code
 THEN RAISE EXCEPTION 'price reduction item not found' USING ERRCODE='23514'; END IF;
 -- Batch 60: only a manager's comp names the dishes it covers (the constraint says so too; this
 -- trigger runs first).
 IF NEW.comped_quantity IS NOT NULL AND (NEW.kind <> 'Comp' OR NEW.reason_code = 'POINTS_REDEMPTION')
 THEN RAISE EXCEPTION 'price reduction names dishes only for a comp' USING ERRCODE='23514'; END IF;
 -- Batch 60: the dishes of this line comps already cover (the amounts follow them). Whether the
 -- line may take this reduction at all is checked after the row's own constraints (below).
 SELECT COALESCE(sum(comped_quantity),0) INTO prior_quantity
  FROM rms_ordering.order_item_price_reduction WHERE brand_id=NEW.brand_id AND store_id=NEW.store_id
   AND order_item_id=NEW.order_item_id;
 item_net := (item_snapshot->'subtotal'->>'amountMinor')::bigint - (item_snapshot->'discount'->>'amountMinor')::bigint;
 item_tax := (item_snapshot->'tax'->>'amountMinor')::bigint;
 item_fee := (item_snapshot->'fee'->>'amountMinor')::bigint;
 IF item_net <= 0 THEN RAISE EXCEPTION 'price reduction item has no price' USING ERRCODE='23514'; END IF;
 IF NEW.comped_quantity IS NOT NULL THEN
  -- Dishes p+1..p+k of q: round(x(p+k)/q) − round(xp/q), half up, for net, tax and fee.
  want_net := (item_net*(prior_quantity+NEW.comped_quantity)*2 + line_quantity) / (2*line_quantity)
   - (item_net*prior_quantity*2 + line_quantity) / (2*line_quantity);
  want_tax := (item_tax*(prior_quantity+NEW.comped_quantity)*2 + line_quantity) / (2*line_quantity)
   - (item_tax*prior_quantity*2 + line_quantity) / (2*line_quantity);
  want_fee := (item_fee*(prior_quantity+NEW.comped_quantity)*2 + line_quantity) / (2*line_quantity)
   - (item_fee*prior_quantity*2 + line_quantity) / (2*line_quantity);
 ELSE
  want_net := CASE NEW.kind
   WHEN 'Comp' THEN item_net
   WHEN 'Percent' THEN (item_net*NEW.percent + 50) / 100
   ELSE NEW.net_minor END;
  want_tax := CASE WHEN want_net = item_net THEN item_tax
   ELSE (item_tax*want_net*2 + item_net) / (2*item_net) END;
  want_fee := CASE WHEN want_net = item_net THEN item_fee
   ELSE (item_fee*want_net*2 + item_net) / (2*item_net) END;
 END IF;
 -- The dish's own share of tax and fee is checked exactly; the whole-bill cent
 -- (tax_rounding_minor) only on a dish taxed at a rate.
 IF want_net < 1 OR want_net > item_net OR NEW.net_minor <> want_net
  OR (NEW.kind = 'Amount' AND NEW.net_minor >= item_net)
  OR (NEW.tax_rounding_minor <> 0 AND NOT EXISTS (SELECT 1 FROM jsonb_array_elements(item_snapshot->'taxComponents') c
   WHERE c->>'treatment'='Taxable' AND (c->>'rate')::numeric > 0))
  OR NEW.tax_minor - NEW.tax_rounding_minor <> want_tax
  OR NEW.fee_minor <> want_fee
 THEN RAISE EXCEPTION 'price reduction amount mismatch' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION rms_ordering.validate_order_item_price_reduction() FROM PUBLIC;

-- Batch 60: after the row's own checks (as the unique constraint on the line was before): a
-- whole-line reduction stands alone on its line, and the comps naming their dishes never cover
-- more dishes than the line has. The Order's disposition lock taken by the trigger above is held,
-- so two comps of one line are never checked at once.
CREATE FUNCTION rms_ordering.validate_order_item_price_reduction_line() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
DECLARE
 line_quantity integer;
 line_count bigint;
 line_comped bigint;
 line_whole boolean;
BEGIN
 SELECT quantity INTO line_quantity FROM rms_ordering.order_item
  WHERE brand_id=NEW.brand_id AND store_id=NEW.store_id AND order_id=NEW.order_id
   AND order_item_id=NEW.order_item_id;
 SELECT count(*), COALESCE(sum(comped_quantity),0), COALESCE(bool_or(comped_quantity IS NULL),false)
  INTO line_count, line_comped, line_whole
  FROM rms_ordering.order_item_price_reduction WHERE brand_id=NEW.brand_id AND store_id=NEW.store_id
   AND order_item_id=NEW.order_item_id;
 IF line_whole AND line_count > 1
 THEN RAISE EXCEPTION 'price reduction item already reduced' USING ERRCODE='23505'; END IF;
 IF line_quantity IS NULL OR line_comped > line_quantity
 THEN RAISE EXCEPTION 'price reduction covers more dishes than the line has' USING ERRCODE='23514'; END IF;
 RETURN NULL;
END;
$$;
REVOKE ALL ON FUNCTION rms_ordering.validate_order_item_price_reduction_line() FROM PUBLIC;
CREATE TRIGGER order_item_price_reduction_line AFTER INSERT ON rms_ordering.order_item_price_reduction
 FOR EACH ROW EXECUTE FUNCTION rms_ordering.validate_order_item_price_reduction_line();
