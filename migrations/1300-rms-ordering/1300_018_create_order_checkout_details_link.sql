-- bop-rms-migration: 1
-- owner: @rms/ordering
-- schema: rms_ordering
-- phase: expand
-- risk: medium
-- transaction: required
-- lock-timeout-ms: 5000
-- statement-timeout-ms: 60000
-- recovery: forward-fix
CREATE TABLE rms_ordering.order_checkout_details_link (
 brand_id platform_helpers.uuid_v7 NOT NULL,
 store_id platform_helpers.uuid_v7 NOT NULL,
 submission_id platform_helpers.uuid_v7 NOT NULL,
 order_id platform_helpers.uuid_v7 NOT NULL,
 details_id platform_helpers.uuid_v7 NOT NULL,
 details_version integer NOT NULL CHECK (details_version > 0),
 PRIMARY KEY (brand_id,store_id,submission_id),
 FOREIGN KEY (submission_id,brand_id,store_id,order_id)
 REFERENCES rms_ordering.order_submission_record(submission_id,brand_id,store_id,order_id),
 FOREIGN KEY (brand_id,store_id,details_id,details_version)
 REFERENCES rms_ordering.checkout_details_record(brand_id,store_id,details_id,details_version)
);
CREATE RULE order_checkout_details_no_update AS ON UPDATE TO rms_ordering.order_checkout_details_link DO INSTEAD NOTHING;
CREATE RULE order_checkout_details_no_delete AS ON DELETE TO rms_ordering.order_checkout_details_link DO INSTEAD NOTHING;
ALTER TABLE rms_ordering.order_checkout_details_link ENABLE ROW LEVEL SECURITY;
ALTER TABLE rms_ordering.order_checkout_details_link FORCE ROW LEVEL SECURITY;
CREATE POLICY order_checkout_details_scope ON rms_ordering.order_checkout_details_link
 USING (brand_id=platform_helpers.current_brand_id() AND store_id=platform_helpers.current_store_id())
 WITH CHECK (brand_id=platform_helpers.current_brand_id() AND store_id=platform_helpers.current_store_id());
REVOKE ALL ON TABLE rms_ordering.order_checkout_details_link FROM PUBLIC;
