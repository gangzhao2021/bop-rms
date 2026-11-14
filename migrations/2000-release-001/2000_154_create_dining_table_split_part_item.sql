-- bop-rms-migration: 1
-- owner: @rms/payment
-- schema: rms_payment
-- phase: expand
-- risk: medium
-- transaction: required
-- lock-timeout-ms: 5000
-- statement-timeout-ms: 60000
-- recovery: forward-fix
-- WP-2423 按菜分单 (Owner 2026-11-04): a table's bill split by dish. The parts and their round
-- slices stay as 2000_104 records them, so payments, reports and refunds are unchanged; this adds
-- the choices they were computed from: which part each unit of a dish goes to, or NULL when all
-- the parts share it. Append-only, like the plan it belongs to.
-- Grants: api SELECT/INSERT on the new table (Owner standing approval 2026-10-14, WP-2423).
ALTER TABLE rms_payment.dining_table_split_plan DROP CONSTRAINT dining_table_split_plan_mode_check;
ALTER TABLE rms_payment.dining_table_split_plan
 ADD CONSTRAINT dining_table_split_plan_mode_check CHECK (mode IN ('Whole','Even','ByRounds','ByItems'));

CREATE TABLE rms_payment.dining_table_split_part_item (
 split_plan_id platform_helpers.uuid_v7 NOT NULL REFERENCES rms_payment.dining_table_split_plan(split_plan_id),
 brand_id platform_helpers.uuid_v7 NOT NULL,
 store_id platform_helpers.uuid_v7 NOT NULL,
 order_item_id platform_helpers.uuid_v7 NOT NULL,
 unit_number integer NOT NULL CHECK (unit_number BETWEEN 1 AND 1000),
 part_number integer,
 PRIMARY KEY (split_plan_id,order_item_id,unit_number),
 FOREIGN KEY (split_plan_id,part_number) REFERENCES rms_payment.dining_table_split_part(split_plan_id,part_number)
);

CREATE TRIGGER dining_table_split_part_item_no_mutation BEFORE UPDATE OR DELETE ON rms_payment.dining_table_split_part_item
 FOR EACH ROW EXECUTE FUNCTION rms_payment.reject_dining_table_settlement_mutation();
CREATE TRIGGER dining_table_split_part_item_no_truncate BEFORE TRUNCATE ON rms_payment.dining_table_split_part_item
 FOR EACH STATEMENT EXECUTE FUNCTION rms_payment.reject_dining_table_settlement_mutation();

ALTER TABLE rms_payment.dining_table_split_part_item ENABLE ROW LEVEL SECURITY;
ALTER TABLE rms_payment.dining_table_split_part_item FORCE ROW LEVEL SECURITY;
CREATE POLICY dining_table_split_part_item_scope ON rms_payment.dining_table_split_part_item
 USING (brand_id=platform_helpers.current_brand_id() AND store_id=platform_helpers.current_store_id())
 WITH CHECK (brand_id=platform_helpers.current_brand_id() AND store_id=platform_helpers.current_store_id());
REVOKE ALL ON TABLE rms_payment.dining_table_split_part_item FROM PUBLIC;
