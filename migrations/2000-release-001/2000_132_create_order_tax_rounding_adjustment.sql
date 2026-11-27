-- bop-rms-migration: 1
-- owner: @rms/ordering
-- schema: rms_ordering
-- phase: expand
-- risk: medium
-- transaction: required
-- lock-timeout-ms: 5000
-- statement-timeout-ms: 60000
-- recovery: forward-fix
-- WP-2423 DEC-TAX-WHOLE-RECEIPT step 2 (coordinator 2026-10-30, Owner authorized): a table's bill
-- is one receipt, so its tax per tax type is round(Σ taxable × rate) over all its rounds once.
-- The rounds were priced one by one, so the difference between that and the tax each round was
-- charged is recorded here as the bill's "Tax rounding" (positive or negative, normally a cent
-- or two), allocated to the rounds by largest remainder. It is computed by the system rule only
-- (rule code and version recorded), never chosen by staff and never a comp or discount. When the
-- bill changes before it is paid, a new version supersedes the last one (append-only: never
-- updated or deleted); once a payment is recorded no new version is written (checked by the
-- command under the Order's fence: Payment is not read here).
-- Grants: api SELECT/INSERT (Owner standing approval 2026-10-14, WP-2423).
CREATE TABLE rms_ordering.order_tax_rounding_adjustment (
 adjustment_id platform_helpers.uuid_v7 PRIMARY KEY,
 brand_id platform_helpers.uuid_v7 NOT NULL,
 store_id platform_helpers.uuid_v7 NOT NULL,
 bill_order_id platform_helpers.uuid_v7 NOT NULL,
 version integer NOT NULL CHECK (version BETWEEN 1 AND 1000),
 supersedes_adjustment_id platform_helpers.uuid_v7,
 rule_code text NOT NULL CHECK (rule_code = 'DEC_TAX_WHOLE_RECEIPT'),
 rule_version integer NOT NULL CHECK (rule_version = 1),
 basis_digest text NOT NULL CHECK (basis_digest ~ '^sha256:[0-9a-f]{64}$'),
 total_minor bigint NOT NULL CHECK (total_minor BETWEEN -100000 AND 100000),
 currency_code text NOT NULL CHECK (currency_code = 'CAD'),
 recorded_at timestamptz NOT NULL CHECK (isfinite(recorded_at) AND recorded_at=date_trunc('milliseconds',recorded_at)),
 CONSTRAINT order_tax_rounding_adjustment_version UNIQUE (brand_id,store_id,bill_order_id,version),
 CONSTRAINT order_tax_rounding_adjustment_key UNIQUE (adjustment_id,brand_id,store_id,bill_order_id),
 CONSTRAINT order_tax_rounding_adjustment_chain CHECK ((version = 1) = (supersedes_adjustment_id IS NULL)),
 FOREIGN KEY (bill_order_id,brand_id,store_id) REFERENCES rms_ordering.order_header(order_id,brand_id,store_id),
 FOREIGN KEY (supersedes_adjustment_id,brand_id,store_id,bill_order_id)
  REFERENCES rms_ordering.order_tax_rounding_adjustment(adjustment_id,brand_id,store_id,bill_order_id)
);

-- Each round's share per tax type (a round of the bill's own Order or of an Order merged into it).
CREATE TABLE rms_ordering.order_tax_rounding_adjustment_line (
 adjustment_id platform_helpers.uuid_v7 NOT NULL,
 brand_id platform_helpers.uuid_v7 NOT NULL,
 store_id platform_helpers.uuid_v7 NOT NULL,
 bill_order_id platform_helpers.uuid_v7 NOT NULL,
 line_number integer NOT NULL CHECK (line_number BETWEEN 1 AND 2000),
 order_id platform_helpers.uuid_v7 NOT NULL,
 order_batch_id platform_helpers.uuid_v7 NOT NULL,
 tax_component_code text NOT NULL CHECK (tax_component_code ~ '^[A-Z][A-Z0-9_]{0,63}$'),
 amount_minor bigint NOT NULL CHECK (amount_minor <> 0 AND amount_minor BETWEEN -100000 AND 100000),
 PRIMARY KEY (adjustment_id,line_number),
 CONSTRAINT order_tax_rounding_adjustment_line_once UNIQUE (adjustment_id,order_batch_id,tax_component_code),
 FOREIGN KEY (adjustment_id,brand_id,store_id,bill_order_id)
  REFERENCES rms_ordering.order_tax_rounding_adjustment(adjustment_id,brand_id,store_id,bill_order_id),
 FOREIGN KEY (order_batch_id,order_id,brand_id,store_id)
  REFERENCES rms_ordering.order_batch(order_batch_id,order_id,brand_id,store_id)
);
CREATE INDEX order_tax_rounding_adjustment_line_order_idx
 ON rms_ordering.order_tax_rounding_adjustment_line (brand_id,store_id,order_id);

-- The bill is a dine-in Order; a new version follows the last one, which it supersedes.
CREATE FUNCTION rms_ordering.validate_order_tax_rounding_adjustment() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
DECLARE
 last_id uuid;
 last_version integer;
BEGIN
 PERFORM pg_advisory_xact_lock(hashtextextended('OrderingOrderDisposition:'||NEW.brand_id||':'||NEW.store_id||':'||NEW.bill_order_id,0));
 IF NOT EXISTS (SELECT 1 FROM rms_ordering.order_header WHERE brand_id=NEW.brand_id AND store_id=NEW.store_id
   AND order_id=NEW.bill_order_id AND order_type='DineIn') THEN
  RAISE EXCEPTION 'tax rounding bill is not a dine-in order' USING ERRCODE='23514';
 END IF;
 SELECT adjustment_id,version INTO last_id,last_version FROM rms_ordering.order_tax_rounding_adjustment
  WHERE brand_id=NEW.brand_id AND store_id=NEW.store_id AND bill_order_id=NEW.bill_order_id
  ORDER BY version DESC LIMIT 1;
 IF (last_id IS NULL AND NEW.version<>1)
  OR (last_id IS NOT NULL AND (NEW.version<>last_version+1 OR NEW.supersedes_adjustment_id IS DISTINCT FROM last_id)) THEN
  RAISE EXCEPTION 'tax rounding version does not follow the last one' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION rms_ordering.validate_order_tax_rounding_adjustment() FROM PUBLIC;
CREATE TRIGGER order_tax_rounding_adjustment_follows BEFORE INSERT ON rms_ordering.order_tax_rounding_adjustment
 FOR EACH ROW EXECUTE FUNCTION rms_ordering.validate_order_tax_rounding_adjustment();

-- A line is a round of a dine-in Order on this bill (the bill's own Order or one merged into it).
CREATE FUNCTION rms_ordering.validate_order_tax_rounding_adjustment_line() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
BEGIN
 IF NOT EXISTS (SELECT 1 FROM rms_ordering.order_header WHERE brand_id=NEW.brand_id AND store_id=NEW.store_id
   AND order_id=NEW.order_id AND order_type='DineIn')
  OR (NEW.order_id<>NEW.bill_order_id AND NOT EXISTS (
   WITH RECURSIVE down(order_id,depth) AS (
    SELECT NEW.bill_order_id,0
    UNION ALL SELECT m.source_order_id,down.depth+1 FROM rms_ordering.order_merge m
     JOIN down ON m.brand_id=NEW.brand_id AND m.store_id=NEW.store_id AND m.target_order_id=down.order_id
     WHERE down.depth<50)
   SELECT 1 FROM down WHERE down.order_id=NEW.order_id)) THEN
  RAISE EXCEPTION 'tax rounding line is not a round of this bill' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION rms_ordering.validate_order_tax_rounding_adjustment_line() FROM PUBLIC;
CREATE TRIGGER order_tax_rounding_adjustment_line_round BEFORE INSERT ON rms_ordering.order_tax_rounding_adjustment_line
 FOR EACH ROW EXECUTE FUNCTION rms_ordering.validate_order_tax_rounding_adjustment_line();

-- At commit the lines add up to the record's total.
CREATE FUNCTION rms_ordering.check_order_tax_rounding_adjustment_total() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
BEGIN
 IF (SELECT total_minor FROM rms_ordering.order_tax_rounding_adjustment WHERE adjustment_id=NEW.adjustment_id)
   IS DISTINCT FROM (SELECT coalesce(sum(amount_minor),0) FROM rms_ordering.order_tax_rounding_adjustment_line
   WHERE adjustment_id=NEW.adjustment_id) THEN
  RAISE EXCEPTION 'tax rounding lines do not add up to the total' USING ERRCODE='23514';
 END IF;
 RETURN NULL;
END;
$$;
REVOKE ALL ON FUNCTION rms_ordering.check_order_tax_rounding_adjustment_total() FROM PUBLIC;
CREATE CONSTRAINT TRIGGER order_tax_rounding_adjustment_total AFTER INSERT ON rms_ordering.order_tax_rounding_adjustment
 DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION rms_ordering.check_order_tax_rounding_adjustment_total();
CREATE CONSTRAINT TRIGGER order_tax_rounding_adjustment_line_total AFTER INSERT ON rms_ordering.order_tax_rounding_adjustment_line
 DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION rms_ordering.check_order_tax_rounding_adjustment_total();

CREATE FUNCTION rms_ordering.reject_order_tax_rounding_mutation() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
BEGIN
 RAISE EXCEPTION 'append-only tax rounding adjustment' USING ERRCODE='55000';
END;
$$;
REVOKE ALL ON FUNCTION rms_ordering.reject_order_tax_rounding_mutation() FROM PUBLIC;
CREATE TRIGGER order_tax_rounding_adjustment_no_mutation BEFORE UPDATE OR DELETE ON rms_ordering.order_tax_rounding_adjustment
 FOR EACH ROW EXECUTE FUNCTION rms_ordering.reject_order_tax_rounding_mutation();
CREATE TRIGGER order_tax_rounding_adjustment_no_truncate BEFORE TRUNCATE ON rms_ordering.order_tax_rounding_adjustment
 FOR EACH STATEMENT EXECUTE FUNCTION rms_ordering.reject_order_tax_rounding_mutation();
CREATE TRIGGER order_tax_rounding_adjustment_line_no_mutation BEFORE UPDATE OR DELETE ON rms_ordering.order_tax_rounding_adjustment_line
 FOR EACH ROW EXECUTE FUNCTION rms_ordering.reject_order_tax_rounding_mutation();
CREATE TRIGGER order_tax_rounding_adjustment_line_no_truncate BEFORE TRUNCATE ON rms_ordering.order_tax_rounding_adjustment_line
 FOR EACH STATEMENT EXECUTE FUNCTION rms_ordering.reject_order_tax_rounding_mutation();

ALTER TABLE rms_ordering.order_tax_rounding_adjustment ENABLE ROW LEVEL SECURITY;
ALTER TABLE rms_ordering.order_tax_rounding_adjustment FORCE ROW LEVEL SECURITY;
CREATE POLICY order_tax_rounding_adjustment_scope ON rms_ordering.order_tax_rounding_adjustment
 USING (brand_id=platform_helpers.current_brand_id() AND store_id=platform_helpers.current_store_id())
 WITH CHECK (brand_id=platform_helpers.current_brand_id() AND store_id=platform_helpers.current_store_id());
REVOKE ALL ON TABLE rms_ordering.order_tax_rounding_adjustment FROM PUBLIC;
ALTER TABLE rms_ordering.order_tax_rounding_adjustment_line ENABLE ROW LEVEL SECURITY;
ALTER TABLE rms_ordering.order_tax_rounding_adjustment_line FORCE ROW LEVEL SECURITY;
CREATE POLICY order_tax_rounding_adjustment_line_scope ON rms_ordering.order_tax_rounding_adjustment_line
 USING (brand_id=platform_helpers.current_brand_id() AND store_id=platform_helpers.current_store_id())
 WITH CHECK (brand_id=platform_helpers.current_brand_id() AND store_id=platform_helpers.current_store_id());
REVOKE ALL ON TABLE rms_ordering.order_tax_rounding_adjustment_line FROM PUBLIC;
