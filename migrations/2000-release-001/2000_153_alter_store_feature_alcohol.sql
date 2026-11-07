-- bop-rms-migration: 1
-- owner: @rms/store
-- schema: rms_store
-- phase: expand
-- risk: low
-- transaction: required
-- lock-timeout-ms: 5000
-- statement-timeout-ms: 60000
-- recovery: forward-fix
-- WP-2423 DEC-ALCOHOL (Owner 2026-11-04 "要卖酒"): whether this Store sells alcohol. Off for every
-- Store and version so far: only the person turning it on can say the Store holds a liquor licence.
ALTER TABLE rms_store.store_feature_setting
 ADD COLUMN alcohol_offered boolean NOT NULL DEFAULT false;
