-- bop-rms-migration: 1
-- owner: @rms/payment
-- schema: rms_payment
-- phase: expand
-- risk: medium
-- transaction: required
-- lock-timeout-ms: 5000
-- statement-timeout-ms: 60000
-- recovery: forward-fix
-- WP-2423 item 8 ⑨ (DEC-DINING-TABLE-MERGE): a merged table pays one bill. Payment keeps its own
-- record of which Orders a table's bill includes — written when staff merge the tables, in the
-- same transaction as Ordering's order merge — so its rules check the bill without reading another
-- domain's tables. A bill is its Order plus the Orders merged into it (and into those). Each line
-- of a payment still names the Order its round belongs to; the settlement's lines and a split
-- part's rounds must be of the same bill (2000_098, 2000_104 required the same Order). Merging is
-- refused once either table has any payment, part, split plan or write-off. Append-only.
-- Grants: api SELECT/INSERT (Owner standing approval 2026-10-14, WP-2423).
CREATE TABLE rms_payment.dining_table_bill_order (
 brand_id platform_helpers.uuid_v7 NOT NULL,
 store_id platform_helpers.uuid_v7 NOT NULL,
 bill_order_id platform_helpers.uuid_v7 NOT NULL,
 member_order_id platform_helpers.uuid_v7 NOT NULL CHECK (member_order_id<>bill_order_id),
 operation_id platform_helpers.uuid_v7 NOT NULL,
 recorded_at timestamptz NOT NULL CHECK (isfinite(recorded_at) AND recorded_at=date_trunc('milliseconds',recorded_at)),
 PRIMARY KEY (brand_id,store_id,member_order_id),
 CONSTRAINT dining_table_bill_order_operation UNIQUE (brand_id,store_id,operation_id)
);
CREATE INDEX dining_table_bill_order_bill_idx ON rms_payment.dining_table_bill_order (brand_id,store_id,bill_order_id);

-- The bill an Order is paid on: itself, or the bill it was merged into (followed to the end).
CREATE FUNCTION rms_payment.dining_table_bill_of(brand uuid, store uuid, order_reference uuid) RETURNS uuid
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
 WITH RECURSIVE up(order_id, depth) AS (
  SELECT order_reference, 0
  UNION ALL
  SELECT b.bill_order_id, up.depth + 1 FROM rms_payment.dining_table_bill_order b
   JOIN up ON b.brand_id=brand AND b.store_id=store AND b.member_order_id=up.order_id
   WHERE up.depth < 50
 )
 SELECT order_id FROM up ORDER BY depth DESC LIMIT 1;
$$;
REVOKE ALL ON FUNCTION rms_payment.dining_table_bill_of(uuid,uuid,uuid) FROM PUBLIC;

-- Merged only while neither table has paid anything, split its bill or written it off; never in a
-- circle.
CREATE FUNCTION rms_payment.check_dining_table_bill_order() RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
BEGIN
 PERFORM pg_advisory_xact_lock(hashtextextended('DiningTablePaidOrWrittenOff:'||NEW.brand_id||':'||NEW.store_id||':'||NEW.bill_order_id,0));
 PERFORM pg_advisory_xact_lock(hashtextextended('DiningTablePaidOrWrittenOff:'||NEW.brand_id||':'||NEW.store_id||':'||NEW.member_order_id,0));
 IF rms_payment.dining_table_bill_of(NEW.brand_id,NEW.store_id,NEW.bill_order_id) = NEW.member_order_id
  OR EXISTS (SELECT 1 FROM rms_payment.dining_table_bill_order b WHERE b.brand_id=NEW.brand_id
    AND b.store_id=NEW.store_id AND b.member_order_id=NEW.bill_order_id)
  OR EXISTS (SELECT 1 FROM rms_payment.dining_table_settlement s WHERE s.brand_id=NEW.brand_id
    AND s.store_id=NEW.store_id AND s.order_id IN (NEW.bill_order_id,NEW.member_order_id))
  OR EXISTS (SELECT 1 FROM rms_payment.dining_table_online_payment p WHERE p.brand_id=NEW.brand_id
    AND p.store_id=NEW.store_id AND p.order_id IN (NEW.bill_order_id,NEW.member_order_id))
  OR EXISTS (SELECT 1 FROM rms_payment.dining_table_split_plan p WHERE p.brand_id=NEW.brand_id
    AND p.store_id=NEW.store_id AND p.order_id IN (NEW.bill_order_id,NEW.member_order_id))
  OR EXISTS (SELECT 1 FROM rms_payment.order_unpaid_write_off w WHERE w.brand_id=NEW.brand_id
    AND w.store_id=NEW.store_id AND w.order_id IN (NEW.bill_order_id,NEW.member_order_id))
  OR EXISTS (SELECT 1 FROM rms_payment.card_machine_payment c WHERE c.brand_id=NEW.brand_id
    AND c.store_id=NEW.store_id AND c.order_id IN (NEW.bill_order_id,NEW.member_order_id))
  OR EXISTS (SELECT 1 FROM rms_payment.payment_intent i WHERE i.brand_id=NEW.brand_id
    AND i.store_id=NEW.store_id AND i.order_id IN (NEW.bill_order_id,NEW.member_order_id)) THEN
  RAISE EXCEPTION 'tables with a payment, split or write-off are not merged' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION rms_payment.check_dining_table_bill_order() FROM PUBLIC;
CREATE TRIGGER dining_table_bill_order_check BEFORE INSERT ON rms_payment.dining_table_bill_order
 FOR EACH ROW EXECUTE FUNCTION rms_payment.check_dining_table_bill_order();
CREATE TRIGGER dining_table_bill_order_no_mutation BEFORE UPDATE OR DELETE ON rms_payment.dining_table_bill_order
 FOR EACH ROW EXECUTE FUNCTION rms_payment.reject_dining_table_settlement_mutation();
CREATE TRIGGER dining_table_bill_order_no_truncate BEFORE TRUNCATE ON rms_payment.dining_table_bill_order
 FOR EACH STATEMENT EXECUTE FUNCTION rms_payment.reject_dining_table_settlement_mutation();
ALTER TABLE rms_payment.dining_table_bill_order ENABLE ROW LEVEL SECURITY;
ALTER TABLE rms_payment.dining_table_bill_order FORCE ROW LEVEL SECURITY;
CREATE POLICY dining_table_bill_order_scope ON rms_payment.dining_table_bill_order
 USING (brand_id=platform_helpers.current_brand_id() AND store_id=platform_helpers.current_store_id())
 WITH CHECK (brand_id=platform_helpers.current_brand_id() AND store_id=platform_helpers.current_store_id());
REVOKE ALL ON TABLE rms_payment.dining_table_bill_order FROM PUBLIC;

-- A settlement's lines are its bill's rounds (2000_104 required the settlement's own Order) and,
-- for a part, exactly that part's slices.
CREATE OR REPLACE FUNCTION rms_payment.validate_dining_table_settlement() RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
 header rms_payment.dining_table_settlement%ROWTYPE;
 sums record;
 differing integer;
BEGIN
 SELECT * INTO header FROM rms_payment.dining_table_settlement WHERE settlement_id=NEW.settlement_id;
 SELECT count(*) AS lines, max(line_number) AS last, coalesce(sum(round_minor),0) AS rounds,
   coalesce(sum(tip_minor),0) AS tip, coalesce(sum(rounding_minor),0) AS rounding,
   count(*) FILTER (WHERE (tip_minor<>0 OR rounding_minor<>0)
     AND line_number<>(SELECT max(line_number) FROM rms_payment.dining_table_settlement_round r2
                       WHERE r2.settlement_id=NEW.settlement_id)) AS misplaced,
   bool_and(brand_id=header.brand_id AND store_id=header.store_id
     AND rms_payment.dining_table_bill_of(brand_id,store_id,order_id)=header.order_id) AS same_order
  INTO sums FROM rms_payment.dining_table_settlement_round WHERE settlement_id=NEW.settlement_id;
 IF header.settlement_id IS NULL OR sums.lines < 1 OR sums.last<>sums.lines OR NOT sums.same_order
  OR sums.rounds<>header.rounds_minor OR sums.tip<>header.tip_minor
  OR sums.rounding<>header.rounding_minor OR sums.misplaced<>0 THEN
  RAISE EXCEPTION 'table settlement lines do not match the settlement' USING ERRCODE='23514';
 END IF;
 IF header.split_plan_id IS NOT NULL THEN
  SELECT count(*) INTO differing FROM (
   (SELECT order_batch_id, round_minor FROM rms_payment.dining_table_settlement_round
     WHERE settlement_id=header.settlement_id
    EXCEPT SELECT order_batch_id, round_minor FROM rms_payment.dining_table_split_part_round
     WHERE split_plan_id=header.split_plan_id AND part_number=header.part_number)
   UNION ALL
   (SELECT order_batch_id, round_minor FROM rms_payment.dining_table_split_part_round
     WHERE split_plan_id=header.split_plan_id AND part_number=header.part_number
    EXCEPT SELECT order_batch_id, round_minor FROM rms_payment.dining_table_settlement_round
     WHERE settlement_id=header.settlement_id)) difference;
  IF differing <> 0 THEN
   RAISE EXCEPTION 'part payment lines do not match the part' USING ERRCODE='23514';
  END IF;
 END IF;
 RETURN NULL;
END;
$$;

-- A split plan's parts come to its bill; each part's rounds are of the plan's bill.
CREATE OR REPLACE FUNCTION rms_payment.validate_dining_table_split_plan() RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
 plan rms_payment.dining_table_split_plan%ROWTYPE;
 parts record;
 mismatched integer;
BEGIN
 SELECT * INTO plan FROM rms_payment.dining_table_split_plan WHERE split_plan_id=NEW.split_plan_id;
 SELECT count(*) AS n, coalesce(max(part_number),0) AS last, coalesce(sum(amount_minor),0) AS total,
   bool_and(brand_id=plan.brand_id AND store_id=plan.store_id AND order_id=plan.order_id) AS same
  INTO parts FROM rms_payment.dining_table_split_part WHERE split_plan_id=NEW.split_plan_id;
 SELECT count(*) INTO mismatched FROM rms_payment.dining_table_split_part p
  WHERE p.split_plan_id=NEW.split_plan_id AND (
   p.amount_minor <> coalesce((SELECT sum(r.round_minor) FROM rms_payment.dining_table_split_part_round r
     WHERE r.split_plan_id=p.split_plan_id AND r.part_number=p.part_number),0)
   OR p.subtotal_minor <> coalesce((SELECT sum(r.subtotal_minor) FROM rms_payment.dining_table_split_part_round r
     WHERE r.split_plan_id=p.split_plan_id AND r.part_number=p.part_number),0)
   OR p.tax_minor <> coalesce((SELECT sum(r.tax_minor) FROM rms_payment.dining_table_split_part_round r
     WHERE r.split_plan_id=p.split_plan_id AND r.part_number=p.part_number),0)
   OR EXISTS (SELECT 1 FROM rms_payment.dining_table_split_part_round r WHERE r.split_plan_id=p.split_plan_id
     AND r.part_number=p.part_number AND (r.brand_id<>p.brand_id OR r.store_id<>p.store_id
     OR rms_payment.dining_table_bill_of(r.brand_id,r.store_id,r.order_id)<>p.order_id)));
 IF plan.split_plan_id IS NULL OR parts.n <> plan.part_count OR parts.last <> plan.part_count
  OR (plan.part_count > 0 AND (parts.total <> plan.bill_minor OR NOT parts.same)) OR mismatched <> 0 THEN
  RAISE EXCEPTION 'split plan parts do not match the plan' USING ERRCODE='23514';
 END IF;
 RETURN NULL;
END;
$$;
