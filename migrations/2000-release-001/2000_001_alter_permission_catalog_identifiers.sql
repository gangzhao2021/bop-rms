-- bop-rms-migration: 1
-- owner: @bop/permission
-- schema: bop_permission
-- phase: expand
-- risk: medium
-- transaction: required
-- lock-timeout-ms: 5000
-- statement-timeout-ms: 60000
-- recovery: forward-fix
-- WP-2423 / DEC-PERM-CATALOG: Section 88 permission names contain underscore segments
-- (e.g. kitchen.work_item.read). Replace the per-code exceptions of 0300_005..0300_009 with one rule
-- that admits single-underscore words inside a segment (no leading, trailing or doubled
-- underscores); every existing code remains valid.
ALTER TABLE bop_permission.permission_definition
  DROP CONSTRAINT permission_definition_action_code_check,
  ADD CONSTRAINT permission_definition_action_code_check CHECK (
    length(action_code) <= 128
    AND action_code ~ '^[a-z][a-z0-9]*(_[a-z0-9]+)*(-[a-z0-9]+)*(\.[a-z][a-z0-9]*(_[a-z0-9]+)*(-[a-z0-9]+)*){1,7}$'
  );
ALTER TABLE bop_permission.role_administration_permission
  DROP CONSTRAINT role_administration_permission_action_code_check,
  ADD CONSTRAINT role_administration_permission_action_code_check CHECK (
    action_code ~ '^[a-z][a-z0-9]*(_[a-z0-9]+)*(-[a-z0-9]+)*(\.[a-z][a-z0-9]*(_[a-z0-9]+)*(-[a-z0-9]+)*){1,7}$'
  );
