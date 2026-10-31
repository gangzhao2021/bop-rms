-- bop-rms-migration: 1
-- owner: @rms/ordering
-- schema: rms_ordering
-- phase: expand
-- risk: medium
-- transaction: required
-- lock-timeout-ms: 5000
-- statement-timeout-ms: 60000
-- recovery: forward-fix
-- WP-2423 item 8 ⑨ (DEC-DINING-TABLE-MERGE): when staff merge one table's party into another's,
-- the source table's dine-in Order joins the target table's Order: from then on it is on the
-- target's bill (its rounds, items, prices, comps and removals unchanged, each with who ordered
-- it), and it closes with the target's Order. The source Order keeps its own history, kitchen
-- work and dining session. An Order is merged once, never into itself; the target is not itself
-- merged into another at the time (Ordering checks it). Append-only.
-- Grants: api SELECT/INSERT (Owner standing approval 2026-10-14, WP-2423).
CREATE TABLE rms_ordering.order_merge (
 merge_id platform_helpers.uuid_v7 PRIMARY KEY,
 brand_id platform_helpers.uuid_v7 NOT NULL,
 store_id platform_helpers.uuid_v7 NOT NULL,
 source_order_id platform_helpers.uuid_v7 NOT NULL,
 target_order_id platform_helpers.uuid_v7 NOT NULL CHECK (target_order_id<>source_order_id),
 source_dining_session_id platform_helpers.uuid_v7 NOT NULL,
 target_dining_session_id platform_helpers.uuid_v7 NOT NULL CHECK (target_dining_session_id<>source_dining_session_id),
 operation_id platform_helpers.uuid_v7 NOT NULL,
 actor_id platform_helpers.uuid_v7 NOT NULL,
 merged_at timestamptz NOT NULL CHECK (isfinite(merged_at) AND merged_at=date_trunc('milliseconds',merged_at)),
 CONSTRAINT order_merge_source UNIQUE (brand_id,store_id,source_order_id),
 CONSTRAINT order_merge_operation UNIQUE (brand_id,store_id,operation_id),
 FOREIGN KEY (source_order_id,brand_id,store_id) REFERENCES rms_ordering.order_header(order_id,brand_id,store_id),
 FOREIGN KEY (target_order_id,brand_id,store_id) REFERENCES rms_ordering.order_header(order_id,brand_id,store_id)
);
CREATE INDEX order_merge_target_idx ON rms_ordering.order_merge (brand_id,store_id,target_order_id);

-- Both are dine-in Orders of the named sessions; the target is not merged into another.
CREATE FUNCTION rms_ordering.validate_order_merge_insert() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
BEGIN
 PERFORM pg_advisory_xact_lock(hashtextextended('OrderingOrderDisposition:'||NEW.brand_id||':'||NEW.store_id||':'||NEW.source_order_id,0));
 PERFORM pg_advisory_xact_lock(hashtextextended('OrderingOrderDisposition:'||NEW.brand_id||':'||NEW.store_id||':'||NEW.target_order_id,0));
 IF NOT EXISTS (SELECT 1 FROM rms_ordering.order_header h WHERE h.brand_id=NEW.brand_id AND h.store_id=NEW.store_id
   AND h.order_id=NEW.source_order_id AND h.order_type='DineIn' AND h.dining_session_id=NEW.source_dining_session_id)
 OR NOT EXISTS (SELECT 1 FROM rms_ordering.order_header h WHERE h.brand_id=NEW.brand_id AND h.store_id=NEW.store_id
   AND h.order_id=NEW.target_order_id AND h.order_type='DineIn' AND h.dining_session_id=NEW.target_dining_session_id)
 OR EXISTS (SELECT 1 FROM rms_ordering.order_merge m WHERE m.brand_id=NEW.brand_id AND m.store_id=NEW.store_id
   AND m.source_order_id=NEW.target_order_id) THEN
  RAISE EXCEPTION 'order merge source or target mismatch' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION rms_ordering.validate_order_merge_insert() FROM PUBLIC;
CREATE TRIGGER order_merge_source BEFORE INSERT ON rms_ordering.order_merge
 FOR EACH ROW EXECUTE FUNCTION rms_ordering.validate_order_merge_insert();

CREATE FUNCTION rms_ordering.reject_order_merge_mutation() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
BEGIN
 RAISE EXCEPTION 'append-only order merge' USING ERRCODE='55000';
END;
$$;
REVOKE ALL ON FUNCTION rms_ordering.reject_order_merge_mutation() FROM PUBLIC;
CREATE TRIGGER order_merge_no_mutation BEFORE UPDATE OR DELETE ON rms_ordering.order_merge
 FOR EACH ROW EXECUTE FUNCTION rms_ordering.reject_order_merge_mutation();
CREATE TRIGGER order_merge_no_truncate BEFORE TRUNCATE ON rms_ordering.order_merge
 FOR EACH STATEMENT EXECUTE FUNCTION rms_ordering.reject_order_merge_mutation();

ALTER TABLE rms_ordering.order_merge ENABLE ROW LEVEL SECURITY;
ALTER TABLE rms_ordering.order_merge FORCE ROW LEVEL SECURITY;
CREATE POLICY order_merge_scope ON rms_ordering.order_merge
 USING (brand_id=platform_helpers.current_brand_id() AND store_id=platform_helpers.current_store_id())
 WITH CHECK (brand_id=platform_helpers.current_brand_id() AND store_id=platform_helpers.current_store_id());
REVOKE ALL ON TABLE rms_ordering.order_merge FROM PUBLIC;
