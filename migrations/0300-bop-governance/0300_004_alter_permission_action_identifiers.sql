-- bop-rms-migration: 1
-- owner: @bop/permission
-- schema: bop_permission
-- phase: expand
-- risk: medium
-- transaction: required
-- lock-timeout-ms: 5000
-- statement-timeout-ms: 60000
-- recovery: forward-fix
-- Align accepted canonical hyphenated action components with public parsers.
ALTER TABLE bop_permission.permission_definition
  DROP CONSTRAINT permission_definition_action_code_check,
  ADD CONSTRAINT permission_definition_action_code_check CHECK (
    length(action_code) <= 128
    AND action_code ~ '^[a-z][a-z0-9]*(-[a-z0-9]+)*(\.[a-z][a-z0-9]*(-[a-z0-9]+)*){1,7}$'
  );
ALTER TABLE bop_permission.role_administration_permission
  DROP CONSTRAINT role_administration_permission_action_code_check,
  ADD CONSTRAINT role_administration_permission_action_code_check CHECK (
    action_code ~ '^[a-z][a-z0-9]*(-[a-z0-9]+)*(\.[a-z][a-z0-9]*(-[a-z0-9]+)*){1,7}$'
  );
