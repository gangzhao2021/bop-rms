-- bop-rms-migration: 1
-- owner: @bop/permission
-- schema: bop_permission
-- phase: expand
-- risk: low
-- transaction: required
-- lock-timeout-ms: 5000
-- statement-timeout-ms: 60000
-- recovery: forward-fix
-- WP-2423 item 13 ② (Owner 2026-11-05): pausing and resuming a merchant's new guests is a platform
-- support permission of its own, given to a person in a new version of their record. Earlier
-- versions keep the two permissions they were recorded with.
ALTER TABLE bop_permission.platform_support_person
 DROP CONSTRAINT platform_support_person_actions_check;
ALTER TABLE bop_permission.platform_support_person
 ADD CONSTRAINT platform_support_person_actions_check CHECK (
  actions <@ ARRAY['platform.support.view','platform.support.change','platform.merchant.pause']::text[]
 );
