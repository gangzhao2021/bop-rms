-- bop-rms-migration: 1
-- owner: @bop/feature-control
-- schema: bop_feature_control
-- phase: expand
-- risk: low
-- transaction: required
-- lock-timeout-ms: 5000
-- statement-timeout-ms: 60000
-- recovery: forward-fix
-- A dependency must be visible under exactly its parent Brand/Store scope.
-- Existing inconsistent rows fail validation; no append-only history is repaired.
ALTER TABLE bop_feature_control.control_version
 ADD COLUMN scope_key uuid GENERATED ALWAYS AS
 (COALESCE(store_id,'00000000-0000-0000-0000-000000000000'::uuid)) STORED,
 ADD CONSTRAINT feature_control_version_exact_scope_unique
 UNIQUE (brand_id,control_id,control_version,scope_key);
ALTER TABLE bop_feature_control.control_dependency
 ADD COLUMN scope_key uuid GENERATED ALWAYS AS
 (COALESCE(store_id,'00000000-0000-0000-0000-000000000000'::uuid)) STORED,
 ADD CONSTRAINT feature_control_dependency_exact_scope_fkey
 FOREIGN KEY (brand_id,control_id,control_version,scope_key)
 REFERENCES bop_feature_control.control_version(brand_id,control_id,control_version,scope_key);

-- Dependency identity belongs to its control; each immutable version retains it.
-- No history row is changed or removed. The owner writer rejects foreign-control reuse.
ALTER TABLE bop_feature_control.control_dependency
 DROP CONSTRAINT feature_control_dependency_pkey,
 ADD CONSTRAINT feature_control_dependency_pkey
 PRIMARY KEY (brand_id,dependency_id,control_version);
