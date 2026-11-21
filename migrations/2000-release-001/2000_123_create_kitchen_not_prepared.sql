-- bop-rms-migration: 1
-- owner: @rms/kitchen
-- schema: rms_kitchen
-- phase: expand
-- risk: low
-- transaction: required
-- lock-timeout-ms: 5000
-- statement-timeout-ms: 60000
-- recovery: forward-fix
-- WP-2423 item 8 ⑦ DEC-STORE-FEATURES (Owner 2026-10-28 decision 2, coordinator 2026-10-29): a
-- dish the kitchen does not prepare (a bottled drink, the per-head tea). The owner marks it on the
-- menu; it never reaches the kitchen board and counts as served once ordered, so it never holds up
-- checkout. Each change of the mark is the dish's next version at the Store, with who and when.
-- What the kitchen decided for a round is fixed when the round reaches the kitchen: which of its
-- lines it does not prepare (later changes of the mark never move work already issued). A round
-- made only of such lines makes no ticket; its intake receipt is kept with the decision, so the
-- confirmed round is still consumed exactly once. Append-only, Store RLS.
-- Grants: api SELECT/INSERT on both tables (Owner standing approval 2026-10-14, WP-2423).
CREATE TABLE rms_kitchen.kitchen_not_prepared_product (
 tenant_id platform_helpers.uuid_v7 NOT NULL,
 brand_id platform_helpers.uuid_v7 NOT NULL,
 store_id platform_helpers.uuid_v7 NOT NULL,
 product_id platform_helpers.uuid_v7 NOT NULL,
 version integer NOT NULL CHECK (version BETWEEN 1 AND 1000000),
 operation_id platform_helpers.uuid_v7 NOT NULL,
 not_prepared boolean NOT NULL,
 actor_id platform_helpers.uuid_v7 NOT NULL,
 occurred_at timestamptz NOT NULL CHECK (isfinite(occurred_at) AND occurred_at=date_trunc('milliseconds',occurred_at)),
 PRIMARY KEY (brand_id,store_id,product_id,version),
 CONSTRAINT kitchen_not_prepared_product_operation UNIQUE (brand_id,store_id,operation_id)
);

CREATE TABLE rms_kitchen.kitchen_batch_preparation_decision (
 brand_id platform_helpers.uuid_v7 NOT NULL,
 store_id platform_helpers.uuid_v7 NOT NULL,
 order_id platform_helpers.uuid_v7 NOT NULL,
 order_batch_id platform_helpers.uuid_v7 NOT NULL,
 source_event_id platform_helpers.uuid_v7 NOT NULL,
 confirmation_id platform_helpers.uuid_v7 NOT NULL,
 -- The round's lines the kitchen does not prepare (empty: every line goes to the kitchen).
 not_prepared_order_item_ids uuid[] NOT NULL CHECK (cardinality(not_prepared_order_item_ids) <= 100),
 all_not_prepared boolean NOT NULL,
 -- The intake receipt of a round that makes no ticket (null when a ticket holds it).
 intake_receipt jsonb CHECK (intake_receipt IS NULL OR (jsonb_typeof(intake_receipt)='object' AND octet_length(intake_receipt::text)<=16384)),
 decided_at timestamptz NOT NULL CHECK (isfinite(decided_at) AND decided_at=date_trunc('milliseconds',decided_at)),
 PRIMARY KEY (brand_id,store_id,order_batch_id),
 CONSTRAINT kitchen_batch_preparation_decision_receipt CHECK (
  (all_not_prepared AND cardinality(not_prepared_order_item_ids) >= 1 AND intake_receipt IS NOT NULL)
  OR (NOT all_not_prepared AND intake_receipt IS NULL)
 )
);
CREATE INDEX kitchen_batch_preparation_decision_order_idx
 ON rms_kitchen.kitchen_batch_preparation_decision (brand_id,store_id,order_id);

-- The mark's versions follow one another per dish.
CREATE FUNCTION rms_kitchen.validate_kitchen_not_prepared_product() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
DECLARE latest integer;
BEGIN
 PERFORM pg_advisory_xact_lock(hashtextextended('KitchenNotPrepared:'||NEW.brand_id||':'||NEW.store_id||':'||NEW.product_id,0));
 SELECT max(version) INTO latest FROM rms_kitchen.kitchen_not_prepared_product
  WHERE brand_id=NEW.brand_id AND store_id=NEW.store_id AND product_id=NEW.product_id;
 IF NEW.version<>coalesce(latest,0)+1 THEN
  RAISE EXCEPTION 'not prepared mark version out of order' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END;
$$;
CREATE TRIGGER kitchen_not_prepared_product_order BEFORE INSERT ON rms_kitchen.kitchen_not_prepared_product
 FOR EACH ROW EXECUTE FUNCTION rms_kitchen.validate_kitchen_not_prepared_product();

-- A round decided as not prepared at all has no kitchen work, and a round with kitchen work is
-- never decided as not prepared at all.
CREATE FUNCTION rms_kitchen.validate_kitchen_batch_preparation_decision() RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
BEGIN
 IF NEW.all_not_prepared AND EXISTS (
  SELECT 1 FROM rms_kitchen.kitchen_ticket t
   WHERE t.brand_id=NEW.brand_id AND t.store_id=NEW.store_id AND t.order_batch_id=NEW.order_batch_id
 ) THEN
  RAISE EXCEPTION 'round already has kitchen work' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END;
$$;
CREATE TRIGGER kitchen_batch_preparation_decision_check BEFORE INSERT ON rms_kitchen.kitchen_batch_preparation_decision
 FOR EACH ROW EXECUTE FUNCTION rms_kitchen.validate_kitchen_batch_preparation_decision();

CREATE FUNCTION rms_kitchen.reject_kitchen_not_prepared_mutation() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
BEGIN
 RAISE EXCEPTION 'append-only kitchen preparation record' USING ERRCODE='55000';
END;
$$;
CREATE TRIGGER kitchen_not_prepared_product_no_mutation BEFORE UPDATE OR DELETE ON rms_kitchen.kitchen_not_prepared_product
 FOR EACH ROW EXECUTE FUNCTION rms_kitchen.reject_kitchen_not_prepared_mutation();
CREATE TRIGGER kitchen_not_prepared_product_no_truncate BEFORE TRUNCATE ON rms_kitchen.kitchen_not_prepared_product
 FOR EACH STATEMENT EXECUTE FUNCTION rms_kitchen.reject_kitchen_not_prepared_mutation();
CREATE TRIGGER kitchen_batch_preparation_decision_no_mutation BEFORE UPDATE OR DELETE ON rms_kitchen.kitchen_batch_preparation_decision
 FOR EACH ROW EXECUTE FUNCTION rms_kitchen.reject_kitchen_not_prepared_mutation();
CREATE TRIGGER kitchen_batch_preparation_decision_no_truncate BEFORE TRUNCATE ON rms_kitchen.kitchen_batch_preparation_decision
 FOR EACH STATEMENT EXECUTE FUNCTION rms_kitchen.reject_kitchen_not_prepared_mutation();

ALTER TABLE rms_kitchen.kitchen_not_prepared_product ENABLE ROW LEVEL SECURITY;
ALTER TABLE rms_kitchen.kitchen_not_prepared_product FORCE ROW LEVEL SECURITY;
CREATE POLICY kitchen_not_prepared_product_scope ON rms_kitchen.kitchen_not_prepared_product
 USING (brand_id=platform_helpers.current_brand_id() AND store_id=platform_helpers.current_store_id())
 WITH CHECK (brand_id=platform_helpers.current_brand_id() AND store_id=platform_helpers.current_store_id());
ALTER TABLE rms_kitchen.kitchen_batch_preparation_decision ENABLE ROW LEVEL SECURITY;
ALTER TABLE rms_kitchen.kitchen_batch_preparation_decision FORCE ROW LEVEL SECURITY;
CREATE POLICY kitchen_batch_preparation_decision_scope ON rms_kitchen.kitchen_batch_preparation_decision
 USING (brand_id=platform_helpers.current_brand_id() AND store_id=platform_helpers.current_store_id())
 WITH CHECK (brand_id=platform_helpers.current_brand_id() AND store_id=platform_helpers.current_store_id());
REVOKE ALL ON TABLE rms_kitchen.kitchen_not_prepared_product FROM PUBLIC;
REVOKE ALL ON TABLE rms_kitchen.kitchen_batch_preparation_decision FROM PUBLIC;
REVOKE ALL ON FUNCTION rms_kitchen.validate_kitchen_not_prepared_product() FROM PUBLIC;
REVOKE ALL ON FUNCTION rms_kitchen.validate_kitchen_batch_preparation_decision() FROM PUBLIC;
REVOKE ALL ON FUNCTION rms_kitchen.reject_kitchen_not_prepared_mutation() FROM PUBLIC;
