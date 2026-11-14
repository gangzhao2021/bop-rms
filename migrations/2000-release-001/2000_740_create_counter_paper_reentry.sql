-- bop-rms-migration: 1
-- owner: @rms/ordering
-- schema: rms_ordering
-- phase: expand
-- risk: medium
-- transaction: required
-- lock-timeout-ms: 5000
-- statement-timeout-ms: 60000
-- recovery: forward-fix
-- DEC-PAPER-ORDER-NEVER-RELEASED (v15 batch-8 review): a paper order whose payment could not be
-- recorded before its payment window ended is closed only as entered again, naming the new paper
-- order that now carries its sale. This is that link, readable by anyone checking the books: which
-- paper order, which new order, the termination that closed it, who linked it and when, and both
-- orders' sale amounts (dishes with tax, before tip) to the cent. The new order's sale is never
-- lower than the paper order's (a $200 paper sale is never closed by a $5 order), each new order
-- stands for one paper order only, and both amounts are the orders' own quote totals. One row per
-- closed paper order, append-only, Store RLS.
-- Grants: api SELECT, INSERT (Owner standing approval 2026-10-14 「我都批准，之后不需要问我」;
-- DEC-PAPER-ORDER-NEVER-RELEASED).
CREATE TABLE rms_ordering.counter_paper_reentry (
 brand_id platform_helpers.uuid_v7 NOT NULL,
 store_id platform_helpers.uuid_v7 NOT NULL,
 order_id platform_helpers.uuid_v7 NOT NULL,
 reentered_order_id platform_helpers.uuid_v7 NOT NULL,
 termination_id platform_helpers.uuid_v7 NOT NULL,
 paper_sale_minor bigint NOT NULL CHECK (paper_sale_minor >= 0),
 reentered_sale_minor bigint NOT NULL CHECK (reentered_sale_minor >= 0),
 currency_code text NOT NULL CHECK (currency_code ~ '^[A-Z]{3}$'),
 actor_id platform_helpers.uuid_v7 NOT NULL,
 recorded_at timestamptz NOT NULL CHECK (isfinite(recorded_at) AND recorded_at=date_trunc('milliseconds',recorded_at)),
 PRIMARY KEY (brand_id,store_id,order_id),
 CONSTRAINT counter_paper_reentry_new_order_once UNIQUE (brand_id,store_id,reentered_order_id),
 CONSTRAINT counter_paper_reentry_termination_once UNIQUE (termination_id),
 CONSTRAINT counter_paper_reentry_not_itself CHECK (order_id <> reentered_order_id),
 CONSTRAINT counter_paper_reentry_sale_kept CHECK (reentered_sale_minor >= paper_sale_minor),
 CONSTRAINT counter_paper_reentry_order_fk FOREIGN KEY (order_id,brand_id,store_id)
  REFERENCES rms_ordering.order_header(order_id,brand_id,store_id),
 CONSTRAINT counter_paper_reentry_new_order_fk FOREIGN KEY (reentered_order_id,brand_id,store_id)
  REFERENCES rms_ordering.order_header(order_id,brand_id,store_id)
);

-- Both orders are paper counter orders of this Store, the new one sent no earlier and still open,
-- and each amount is that order's own quote total in the same currency.
CREATE FUNCTION rms_ordering.validate_counter_paper_reentry() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
DECLARE
 paper record;
 reentered record;
BEGIN
 SELECT b.submitted_at, q.total_minor, q.currency_code INTO paper
  FROM rms_ordering.order_batch b
  JOIN rms_ordering.counter_order_entry e ON e.brand_id=b.brand_id AND e.store_id=b.store_id
   AND e.cart_id=b.source_cart_id AND e.recorded_after_outage
  JOIN rms_ordering.cart_quote_attachment q ON q.brand_id=b.brand_id AND q.store_id=b.store_id
   AND q.quote_id=b.quote_id
  WHERE b.brand_id=NEW.brand_id AND b.store_id=NEW.store_id AND b.order_id=NEW.order_id;
 SELECT b.submitted_at, q.total_minor, q.currency_code INTO reentered
  FROM rms_ordering.order_batch b
  JOIN rms_ordering.counter_order_entry e ON e.brand_id=b.brand_id AND e.store_id=b.store_id
   AND e.cart_id=b.source_cart_id AND e.recorded_after_outage
  JOIN rms_ordering.cart_quote_attachment q ON q.brand_id=b.brand_id AND q.store_id=b.store_id
   AND q.quote_id=b.quote_id
  WHERE b.brand_id=NEW.brand_id AND b.store_id=NEW.store_id AND b.order_id=NEW.reentered_order_id;
 IF paper.total_minor IS NULL OR reentered.total_minor IS NULL
   OR reentered.submitted_at < paper.submitted_at
   OR paper.total_minor <> NEW.paper_sale_minor OR reentered.total_minor <> NEW.reentered_sale_minor
   OR paper.currency_code <> NEW.currency_code OR reentered.currency_code <> NEW.currency_code
   OR EXISTS (SELECT 1 FROM rms_ordering.order_termination_record t WHERE t.brand_id=NEW.brand_id
    AND t.store_id=NEW.store_id AND t.order_id=NEW.reentered_order_id) THEN
  RAISE EXCEPTION 'a re-entry links two paper orders at their own sale amounts' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END;
$$;
CREATE TRIGGER counter_paper_reentry_validate BEFORE INSERT ON rms_ordering.counter_paper_reentry
 FOR EACH ROW EXECUTE FUNCTION rms_ordering.validate_counter_paper_reentry();

-- The paper order is closed as entered again by this link's own termination, in the same
-- transaction.
CREATE FUNCTION rms_ordering.check_counter_paper_reentry_terminated() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
BEGIN
 IF NOT EXISTS (SELECT 1 FROM rms_ordering.order_termination_record t
   WHERE t.termination_id=NEW.termination_id AND t.brand_id=NEW.brand_id AND t.store_id=NEW.store_id
   AND t.order_id=NEW.order_id AND t.reason_code='COUNTER_PAPER_REENTERED') THEN
  RAISE EXCEPTION 'a re-entry closes its paper order as entered again' USING ERRCODE='23514';
 END IF;
 RETURN NULL;
END;
$$;
CREATE CONSTRAINT TRIGGER counter_paper_reentry_terminated AFTER INSERT ON rms_ordering.counter_paper_reentry
 DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION rms_ordering.check_counter_paper_reentry_terminated();

CREATE FUNCTION rms_ordering.reject_counter_paper_reentry_mutation() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
BEGIN
 RAISE EXCEPTION 'append-only paper order re-entry' USING ERRCODE='55000';
END;
$$;
CREATE TRIGGER counter_paper_reentry_no_mutation BEFORE UPDATE OR DELETE ON rms_ordering.counter_paper_reentry
 FOR EACH ROW EXECUTE FUNCTION rms_ordering.reject_counter_paper_reentry_mutation();
CREATE TRIGGER counter_paper_reentry_no_truncate BEFORE TRUNCATE ON rms_ordering.counter_paper_reentry
 FOR EACH STATEMENT EXECUTE FUNCTION rms_ordering.reject_counter_paper_reentry_mutation();

ALTER TABLE rms_ordering.counter_paper_reentry ENABLE ROW LEVEL SECURITY;
ALTER TABLE rms_ordering.counter_paper_reentry FORCE ROW LEVEL SECURITY;
CREATE POLICY counter_paper_reentry_scope ON rms_ordering.counter_paper_reentry
 USING (brand_id=platform_helpers.current_brand_id() AND store_id=platform_helpers.current_store_id())
 WITH CHECK (brand_id=platform_helpers.current_brand_id() AND store_id=platform_helpers.current_store_id());
REVOKE ALL ON TABLE rms_ordering.counter_paper_reentry FROM PUBLIC;
REVOKE ALL ON FUNCTION rms_ordering.validate_counter_paper_reentry() FROM PUBLIC;
REVOKE ALL ON FUNCTION rms_ordering.check_counter_paper_reentry_terminated() FROM PUBLIC;
REVOKE ALL ON FUNCTION rms_ordering.reject_counter_paper_reentry_mutation() FROM PUBLIC;
