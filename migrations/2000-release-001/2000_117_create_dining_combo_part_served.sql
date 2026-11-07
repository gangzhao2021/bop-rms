-- bop-rms-migration: 1
-- owner: @rms/dining
-- schema: rms_dining
-- phase: expand
-- risk: low
-- transaction: required
-- lock-timeout-ms: 5000
-- statement-timeout-ms: 60000
-- recovery: forward-fix
-- WP-2423 item 8 ⑥ part 4 DEC-SINGLE-STORE-COMBO (coordinator 2026-10-28 decision 3): each dish
-- chosen in a combo is served on its own. The combo stays one order line (its service records,
-- quantities and closing rules unchanged); this append-only record marks one chosen dish (a choice
-- of the line) served at a table's session, by whom and when. When every dish is served the
-- serving page serves the line with the existing command. The command checks the dish is one the
-- line has; the session must be the table's own (foreign key).
-- Grants: api SELECT/INSERT (Owner standing approval 2026-10-14, WP-2423).
CREATE FUNCTION rms_dining.reject_dining_combo_part_served_mutation() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
BEGIN
 RAISE EXCEPTION 'append-only dining combo part record' USING ERRCODE='55000';
END;
$$;
REVOKE ALL ON FUNCTION rms_dining.reject_dining_combo_part_served_mutation() FROM PUBLIC;

CREATE TABLE rms_dining.dining_combo_part_served (
 tenant_id platform_helpers.uuid_v7 NOT NULL,
 brand_id platform_helpers.uuid_v7 NOT NULL,
 store_id platform_helpers.uuid_v7 NOT NULL,
 session_id platform_helpers.uuid_v7 NOT NULL,
 order_item_id platform_helpers.uuid_v7 NOT NULL,
 option_id platform_helpers.uuid_v7 NOT NULL,
 operation_id platform_helpers.uuid_v7 NOT NULL,
 actor_id platform_helpers.uuid_v7 NOT NULL,
 served_at timestamptz NOT NULL CHECK (isfinite(served_at)),
 PRIMARY KEY (tenant_id,brand_id,store_id,order_item_id,option_id),
 CONSTRAINT dining_combo_part_served_operation_unique UNIQUE (tenant_id,brand_id,store_id,operation_id),
 FOREIGN KEY (tenant_id,brand_id,store_id,session_id)
  REFERENCES rms_dining.dining_session(tenant_id,brand_id,store_id,session_id)
);
CREATE TRIGGER dining_combo_part_served_no_mutation BEFORE UPDATE OR DELETE ON rms_dining.dining_combo_part_served
 FOR EACH ROW EXECUTE FUNCTION rms_dining.reject_dining_combo_part_served_mutation();
CREATE TRIGGER dining_combo_part_served_no_truncate BEFORE TRUNCATE ON rms_dining.dining_combo_part_served
 FOR EACH STATEMENT EXECUTE FUNCTION rms_dining.reject_dining_combo_part_served_mutation();
ALTER TABLE rms_dining.dining_combo_part_served ENABLE ROW LEVEL SECURITY;
ALTER TABLE rms_dining.dining_combo_part_served FORCE ROW LEVEL SECURITY;
CREATE POLICY dining_combo_part_served_scope ON rms_dining.dining_combo_part_served
 USING (brand_id=platform_helpers.current_brand_id() AND store_id=platform_helpers.current_store_id())
 WITH CHECK (brand_id=platform_helpers.current_brand_id() AND store_id=platform_helpers.current_store_id());
REVOKE ALL ON TABLE rms_dining.dining_combo_part_served FROM PUBLIC;
