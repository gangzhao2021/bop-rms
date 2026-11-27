-- bop-rms-migration: 1
-- owner: @rms/store
-- schema: rms_store
-- phase: expand
-- risk: low
-- transaction: required
-- lock-timeout-ms: 5000
-- statement-timeout-ms: 60000
-- recovery: forward-fix
-- WP-2423 取舍 18 DEC-MEMBER-POINTS: whether this Store offers points. Its own column, off for every
-- Store and version so far: the older `loyalty` column was carried forward as true by saves of a page
-- that never showed it, so it says nothing about what an Owner chose. No guest is enrolled by that.
ALTER TABLE rms_store.store_feature_setting
 ADD COLUMN points_offered boolean NOT NULL DEFAULT false;
