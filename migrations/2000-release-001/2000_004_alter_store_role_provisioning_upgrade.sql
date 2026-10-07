-- bop-rms-migration: 1
-- owner: @bop/permission
-- schema: bop_permission
-- phase: expand
-- risk: medium
-- transaction: required
-- lock-timeout-ms: 5000
-- statement-timeout-ms: 60000
-- recovery: forward-fix
-- WP-2423 / DEC-PERM-CATALOG: a Store is opened once (previous_catalog_version NULL) and its template
-- System roles are later upgraded, under a new signed plan, to each newer installed catalog version,
-- strictly forward. A plan may also assign an Owner while the Store has none (opening, or Platform
-- support after the Owner left); the assignment it created is recorded.
ALTER TABLE bop_permission.store_role_provisioning
  DROP CONSTRAINT store_role_provisioning_store_unique,
  ADD COLUMN previous_catalog_version integer,
  ADD COLUMN owner_assignment_id platform_helpers.uuid_v7,
  ADD CONSTRAINT store_role_provisioning_version_unique UNIQUE (brand_id, store_id, catalog_version),
  ADD CONSTRAINT store_role_provisioning_forward CHECK (
    previous_catalog_version IS NULL OR previous_catalog_version < catalog_version
  );
CREATE UNIQUE INDEX store_role_provisioning_opening_unique
  ON bop_permission.store_role_provisioning (brand_id, store_id)
  WHERE previous_catalog_version IS NULL;
