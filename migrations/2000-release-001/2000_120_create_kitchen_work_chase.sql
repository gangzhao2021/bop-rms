-- bop-rms-migration: 1
-- owner: @rms/kitchen
-- schema: rms_kitchen
-- phase: expand
-- risk: low
-- transaction: required
-- lock-timeout-ms: 5000
-- statement-timeout-ms: 60000
-- recovery: forward-fix
-- WP-2423 item 8 ⑦ DEC-STORE-FEATURES (Owner 2026-10-28 decision 4): a server chases a dish not yet
-- served; the kitchen's ticket turns red and sounds, and shows how many times it was chased. Each
-- chase is one append-only record of the work item, who and when. A chase is of a work item still
-- to be made (queued, held or in progress), and a round (order batch) is chased at most once in
-- any 5 minutes.
-- Grants: api SELECT/INSERT (Owner standing approval 2026-10-14, WP-2423).
CREATE FUNCTION rms_kitchen.reject_kitchen_work_chase_mutation() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
BEGIN
 RAISE EXCEPTION 'append-only kitchen chase record' USING ERRCODE='55000';
END;
$$;
REVOKE ALL ON FUNCTION rms_kitchen.reject_kitchen_work_chase_mutation() FROM PUBLIC;

CREATE TABLE rms_kitchen.kitchen_work_chase (
 brand_id platform_helpers.uuid_v7 NOT NULL,
 store_id platform_helpers.uuid_v7 NOT NULL,
 chase_id platform_helpers.uuid_v7 NOT NULL,
 kitchen_work_item_id platform_helpers.uuid_v7 NOT NULL,
 order_batch_id platform_helpers.uuid_v7 NOT NULL,
 actor_id platform_helpers.uuid_v7 NOT NULL,
 chased_at timestamptz NOT NULL CHECK (isfinite(chased_at) AND chased_at=date_trunc('milliseconds',chased_at)),
 PRIMARY KEY (brand_id,store_id,chase_id)
);
CREATE INDEX kitchen_work_chase_item ON rms_kitchen.kitchen_work_chase (brand_id,store_id,kitchen_work_item_id);
CREATE INDEX kitchen_work_chase_batch ON rms_kitchen.kitchen_work_chase (brand_id,store_id,order_batch_id,chased_at);

-- The work item is still to be made and belongs to the round; the round was not chased in the
-- last 5 minutes (serialized per round).
CREATE FUNCTION rms_kitchen.check_kitchen_work_chase() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
BEGIN
 PERFORM pg_advisory_xact_lock(hashtextextended('KitchenWorkChase:'||NEW.brand_id||':'||NEW.store_id||':'||NEW.order_batch_id,0));
 IF NOT EXISTS (
  SELECT 1 FROM rms_kitchen.kitchen_work_item w
  WHERE w.kitchen_work_item_id=NEW.kitchen_work_item_id AND w.brand_id=NEW.brand_id
   AND w.store_id=NEW.store_id AND w.order_batch_id=NEW.order_batch_id
   AND w.status IN ('Queued','Held','In Progress')
 ) THEN
  RAISE EXCEPTION 'kitchen chase needs a dish still being made' USING ERRCODE='23514';
 END IF;
 IF EXISTS (
  SELECT 1 FROM rms_kitchen.kitchen_work_chase c
  WHERE c.brand_id=NEW.brand_id AND c.store_id=NEW.store_id AND c.order_batch_id=NEW.order_batch_id
   AND c.chase_id<>NEW.chase_id AND c.chased_at > NEW.chased_at - interval '5 minutes'
 ) THEN
  RAISE EXCEPTION 'kitchen chase: this round was chased in the last 5 minutes' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION rms_kitchen.check_kitchen_work_chase() FROM PUBLIC;
CREATE TRIGGER kitchen_work_chase_check BEFORE INSERT ON rms_kitchen.kitchen_work_chase
 FOR EACH ROW EXECUTE FUNCTION rms_kitchen.check_kitchen_work_chase();
CREATE TRIGGER kitchen_work_chase_no_mutation BEFORE UPDATE OR DELETE ON rms_kitchen.kitchen_work_chase
 FOR EACH ROW EXECUTE FUNCTION rms_kitchen.reject_kitchen_work_chase_mutation();
CREATE TRIGGER kitchen_work_chase_no_truncate BEFORE TRUNCATE ON rms_kitchen.kitchen_work_chase
 FOR EACH STATEMENT EXECUTE FUNCTION rms_kitchen.reject_kitchen_work_chase_mutation();
ALTER TABLE rms_kitchen.kitchen_work_chase ENABLE ROW LEVEL SECURITY;
ALTER TABLE rms_kitchen.kitchen_work_chase FORCE ROW LEVEL SECURITY;
CREATE POLICY kitchen_work_chase_store_policy ON rms_kitchen.kitchen_work_chase
 USING (brand_id=platform_helpers.current_brand_id() AND store_id=platform_helpers.current_store_id())
 WITH CHECK (brand_id=platform_helpers.current_brand_id() AND store_id=platform_helpers.current_store_id());
REVOKE ALL ON TABLE rms_kitchen.kitchen_work_chase FROM PUBLIC;
