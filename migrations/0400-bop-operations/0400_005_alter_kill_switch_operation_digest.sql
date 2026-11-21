-- bop-rms-migration: 1
-- owner: @bop/feature-control
-- schema: bop_feature_control
-- phase: expand
-- risk: low
-- transaction: required
-- lock-timeout-ms: 5000
-- statement-timeout-ms: 60000
-- recovery: forward-fix
ALTER TABLE bop_feature_control.kill_switch_version ADD COLUMN operation_digest text;
ALTER TABLE bop_feature_control.kill_switch_version ADD CONSTRAINT kill_switch_operation_digest_format
CHECK (operation_digest IS NULL OR operation_digest ~ '^sha256:[0-9a-f]{64}$');
