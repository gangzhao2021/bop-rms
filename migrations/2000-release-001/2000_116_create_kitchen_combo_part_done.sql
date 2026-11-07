-- bop-rms-migration: 1
-- owner: @rms/kitchen
-- schema: rms_kitchen
-- phase: expand
-- risk: low
-- transaction: required
-- lock-timeout-ms: 5000
-- statement-timeout-ms: 60000
-- recovery: forward-fix
-- WP-2423 item 8 ⑥ part 4 DEC-SINGLE-STORE-COMBO (coordinator 2026-10-28 decision 3): each dish
-- chosen in a combo is its own kitchen line under the combo and is marked done on its own. The
-- combo stays one kitchen work item (its lifecycle, ready and stock steps unchanged); this
-- append-only record marks one chosen dish (a choice of the item) done, by whom and when. The
-- record names a choice the work item actually has, of a work item not cancelled. When every
-- dish is done the board finishes the work item with the existing command.
-- Grants: api SELECT/INSERT (Owner standing approval 2026-10-14, WP-2423).
CREATE FUNCTION rms_kitchen.reject_kitchen_combo_part_done_mutation() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
BEGIN
 RAISE EXCEPTION 'append-only kitchen combo part record' USING ERRCODE='55000';
END;
$$;
REVOKE ALL ON FUNCTION rms_kitchen.reject_kitchen_combo_part_done_mutation() FROM PUBLIC;

CREATE TABLE rms_kitchen.kitchen_combo_part_done (
 brand_id platform_helpers.uuid_v7 NOT NULL,
 store_id platform_helpers.uuid_v7 NOT NULL,
 kitchen_work_item_id platform_helpers.uuid_v7 NOT NULL,
 option_id platform_helpers.uuid_v7 NOT NULL,
 operation_id platform_helpers.uuid_v7 NOT NULL,
 actor_id platform_helpers.uuid_v7 NOT NULL,
 done_at timestamptz NOT NULL CHECK (isfinite(done_at)),
 PRIMARY KEY (brand_id,store_id,kitchen_work_item_id,option_id),
 CONSTRAINT kitchen_combo_part_done_operation_unique UNIQUE (brand_id,store_id,operation_id)
);

-- The dish is one the work item has, and the work item is not cancelled.
CREATE FUNCTION rms_kitchen.check_kitchen_combo_part_done() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
BEGIN
 IF NOT EXISTS (
  SELECT 1 FROM rms_kitchen.kitchen_work_item w
  WHERE w.kitchen_work_item_id=NEW.kitchen_work_item_id AND w.brand_id=NEW.brand_id
   AND w.store_id=NEW.store_id AND w.status<>'Cancelled'
   AND w.selected_options_json @> jsonb_build_array(jsonb_build_object('optionReference',NEW.option_id::text))
 ) THEN
  RAISE EXCEPTION 'kitchen combo part needs a chosen dish of a live work item' USING ERRCODE='23514';
 END IF;
 RETURN NULL;
END;
$$;
REVOKE ALL ON FUNCTION rms_kitchen.check_kitchen_combo_part_done() FROM PUBLIC;
CREATE TRIGGER kitchen_combo_part_done_check AFTER INSERT ON rms_kitchen.kitchen_combo_part_done
 FOR EACH ROW EXECUTE FUNCTION rms_kitchen.check_kitchen_combo_part_done();
CREATE TRIGGER kitchen_combo_part_done_no_mutation BEFORE UPDATE OR DELETE ON rms_kitchen.kitchen_combo_part_done
 FOR EACH ROW EXECUTE FUNCTION rms_kitchen.reject_kitchen_combo_part_done_mutation();
CREATE TRIGGER kitchen_combo_part_done_no_truncate BEFORE TRUNCATE ON rms_kitchen.kitchen_combo_part_done
 FOR EACH STATEMENT EXECUTE FUNCTION rms_kitchen.reject_kitchen_combo_part_done_mutation();
ALTER TABLE rms_kitchen.kitchen_combo_part_done ENABLE ROW LEVEL SECURITY;
ALTER TABLE rms_kitchen.kitchen_combo_part_done FORCE ROW LEVEL SECURITY;
CREATE POLICY kitchen_combo_part_done_store_policy ON rms_kitchen.kitchen_combo_part_done
 USING (brand_id=platform_helpers.current_brand_id() AND store_id=platform_helpers.current_store_id())
 WITH CHECK (brand_id=platform_helpers.current_brand_id() AND store_id=platform_helpers.current_store_id());
REVOKE ALL ON TABLE rms_kitchen.kitchen_combo_part_done FROM PUBLIC;
