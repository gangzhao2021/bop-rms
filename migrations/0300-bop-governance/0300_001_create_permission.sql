-- bop-rms-migration: 1
-- owner: @bop/permission
-- schema: bop_permission
-- phase: expand
-- risk: medium
-- transaction: required
-- lock-timeout-ms: 5000
-- statement-timeout-ms: 60000
-- recovery: forward-fix
-- Stage DB-2 governance namespace.
CREATE SCHEMA bop_permission;
REVOKE ALL ON SCHEMA bop_permission FROM PUBLIC;

CREATE TABLE bop_permission.policy_state (
  brand_id platform_helpers.uuid_v7 PRIMARY KEY,
  snapshot_id platform_helpers.uuid_v7 NOT NULL UNIQUE,
  version bigint NOT NULL CHECK (version > 0),
  updated_at timestamp with time zone NOT NULL
);

CREATE TABLE bop_permission.permission_definition (
  permission_id platform_helpers.uuid_v7 PRIMARY KEY,
  action_code text COLLATE "C" NOT NULL UNIQUE CHECK (
    length(action_code) <= 128
    AND action_code ~ '^[a-z][a-z0-9]*(\.[a-z][a-z0-9]*){1,7}$'
  ),
  lifecycle text NOT NULL CHECK (lifecycle IN ('Active', 'Retired')),
  version bigint NOT NULL CHECK (version > 0),
  created_at timestamp with time zone NOT NULL,
  updated_at timestamp with time zone NOT NULL,
  CONSTRAINT permission_definition_time_order_check CHECK (updated_at >= created_at)
);

CREATE TABLE bop_permission.role (
  role_id platform_helpers.uuid_v7 PRIMARY KEY,
  brand_id platform_helpers.uuid_v7 NOT NULL,
  store_id platform_helpers.uuid_v7,
  role_code text COLLATE "C" NOT NULL CHECK (
    length(role_code) BETWEEN 3 AND 64
    AND role_code ~ '^[a-z][a-z0-9_]{1,62}[a-z0-9]$'
  ),
  lifecycle text NOT NULL CHECK (lifecycle IN ('Active', 'Suspended', 'Retired')),
  effective_from timestamp with time zone NOT NULL,
  effective_until timestamp with time zone,
  version bigint NOT NULL CHECK (version > 0),
  created_at timestamp with time zone NOT NULL,
  updated_at timestamp with time zone NOT NULL,
  CONSTRAINT role_reference_brand_unique UNIQUE (role_id, brand_id),
  CONSTRAINT role_code_scope_unique UNIQUE NULLS NOT DISTINCT (brand_id, store_id, role_code),
  CONSTRAINT role_period_check CHECK (
    effective_until IS NULL OR effective_until > effective_from
  ),
  CONSTRAINT role_time_order_check CHECK (updated_at >= created_at)
);

CREATE TABLE bop_permission.role_assignment (
  assignment_id platform_helpers.uuid_v7 PRIMARY KEY,
  role_id platform_helpers.uuid_v7 NOT NULL,
  membership_id platform_helpers.uuid_v7 NOT NULL,
  store_assignment_id platform_helpers.uuid_v7,
  actor_id platform_helpers.uuid_v7 NOT NULL,
  brand_id platform_helpers.uuid_v7 NOT NULL,
  store_id platform_helpers.uuid_v7,
  lifecycle text NOT NULL CHECK (lifecycle IN ('Active', 'Suspended', 'Ended')),
  effective_from timestamp with time zone NOT NULL,
  effective_until timestamp with time zone,
  version bigint NOT NULL CHECK (version > 0),
  created_at timestamp with time zone NOT NULL,
  updated_at timestamp with time zone NOT NULL,
  CONSTRAINT role_assignment_role_fkey FOREIGN KEY (role_id, brand_id)
    REFERENCES bop_permission.role (role_id, brand_id)
    DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT role_assignment_store_shape_check CHECK (
    (store_id IS NULL AND store_assignment_id IS NULL)
    OR (store_id IS NOT NULL AND store_assignment_id IS NOT NULL)
  ),
  CONSTRAINT role_assignment_period_check CHECK (
    effective_until IS NULL OR effective_until > effective_from
  ),
  CONSTRAINT role_assignment_time_order_check CHECK (updated_at >= created_at)
);

CREATE TABLE bop_permission.permission_grant (
  grant_id platform_helpers.uuid_v7 PRIMARY KEY,
  role_id platform_helpers.uuid_v7 NOT NULL,
  permission_id platform_helpers.uuid_v7 NOT NULL,
  brand_id platform_helpers.uuid_v7 NOT NULL,
  store_id platform_helpers.uuid_v7,
  lifecycle text NOT NULL CHECK (lifecycle IN ('Active', 'Revoked')),
  effective_from timestamp with time zone NOT NULL,
  effective_until timestamp with time zone,
  version bigint NOT NULL CHECK (version > 0),
  created_at timestamp with time zone NOT NULL,
  updated_at timestamp with time zone NOT NULL,
  CONSTRAINT permission_grant_role_fkey FOREIGN KEY (role_id, brand_id)
    REFERENCES bop_permission.role (role_id, brand_id)
    DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT permission_grant_permission_fkey FOREIGN KEY (permission_id)
    REFERENCES bop_permission.permission_definition (permission_id)
    DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT permission_grant_period_check CHECK (
    effective_until IS NULL OR effective_until > effective_from
  ),
  CONSTRAINT permission_grant_time_order_check CHECK (updated_at >= created_at)
);

CREATE TABLE bop_permission.permission_override (
  override_id platform_helpers.uuid_v7 PRIMARY KEY,
  permission_id platform_helpers.uuid_v7 NOT NULL,
  actor_id platform_helpers.uuid_v7 NOT NULL,
  brand_id platform_helpers.uuid_v7 NOT NULL,
  store_id platform_helpers.uuid_v7,
  effect text NOT NULL CHECK (effect IN ('Deny', 'Allow')),
  lifecycle text NOT NULL CHECK (lifecycle IN ('Active', 'Revoked')),
  reason_reference platform_helpers.uuid_v7 NOT NULL,
  correlation_reference platform_helpers.uuid_v7 NOT NULL,
  effective_from timestamp with time zone NOT NULL,
  effective_until timestamp with time zone,
  version bigint NOT NULL CHECK (version > 0),
  created_at timestamp with time zone NOT NULL,
  updated_at timestamp with time zone NOT NULL,
  CONSTRAINT permission_override_permission_fkey FOREIGN KEY (permission_id)
    REFERENCES bop_permission.permission_definition (permission_id)
    DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT permission_override_period_check CHECK (
    effective_until IS NULL OR effective_until > effective_from
  ),
  CONSTRAINT permission_override_time_order_check CHECK (updated_at >= created_at)
);

CREATE UNIQUE INDEX role_assignment_active_unique
  ON bop_permission.role_assignment (actor_id, role_id)
  WHERE lifecycle = 'Active';
CREATE UNIQUE INDEX permission_grant_active_unique
  ON bop_permission.permission_grant (role_id, permission_id)
  WHERE lifecycle = 'Active';
CREATE UNIQUE INDEX permission_override_active_unique
  ON bop_permission.permission_override
  (actor_id, brand_id, store_id, permission_id, effect) NULLS NOT DISTINCT
  WHERE lifecycle = 'Active';
CREATE INDEX role_materialization_idx
  ON bop_permission.role
  (brand_id, store_id, lifecycle, effective_from, effective_until);
CREATE INDEX role_assignment_materialization_idx
  ON bop_permission.role_assignment
  (actor_id, brand_id, store_id, lifecycle, effective_from, effective_until);
CREATE INDEX permission_grant_materialization_idx
  ON bop_permission.permission_grant
  (role_id, lifecycle, effective_from, effective_until);
CREATE INDEX permission_override_materialization_idx
  ON bop_permission.permission_override
  (actor_id, brand_id, store_id, lifecycle, effective_from, effective_until);

ALTER TABLE bop_permission.policy_state ENABLE ROW LEVEL SECURITY;
ALTER TABLE bop_permission.policy_state FORCE ROW LEVEL SECURITY;
CREATE POLICY policy_state_scope_policy ON bop_permission.policy_state
  USING (brand_id = platform_helpers.current_brand_id())
  WITH CHECK (brand_id = platform_helpers.current_brand_id());

ALTER TABLE bop_permission.role ENABLE ROW LEVEL SECURITY;
ALTER TABLE bop_permission.role FORCE ROW LEVEL SECURITY;
CREATE POLICY role_scope_policy ON bop_permission.role
  USING (
    brand_id = platform_helpers.current_brand_id()
    AND (store_id IS NULL OR store_id = platform_helpers.current_store_id())
  )
  WITH CHECK (
    brand_id = platform_helpers.current_brand_id()
    AND (store_id IS NULL OR store_id = platform_helpers.current_store_id())
  );

ALTER TABLE bop_permission.role_assignment ENABLE ROW LEVEL SECURITY;
ALTER TABLE bop_permission.role_assignment FORCE ROW LEVEL SECURITY;
CREATE POLICY role_assignment_scope_policy ON bop_permission.role_assignment
  USING (
    brand_id = platform_helpers.current_brand_id()
    AND (store_id IS NULL OR store_id = platform_helpers.current_store_id())
  )
  WITH CHECK (
    brand_id = platform_helpers.current_brand_id()
    AND (store_id IS NULL OR store_id = platform_helpers.current_store_id())
  );

ALTER TABLE bop_permission.permission_grant ENABLE ROW LEVEL SECURITY;
ALTER TABLE bop_permission.permission_grant FORCE ROW LEVEL SECURITY;
CREATE POLICY permission_grant_scope_policy ON bop_permission.permission_grant
  USING (
    brand_id = platform_helpers.current_brand_id()
    AND (store_id IS NULL OR store_id = platform_helpers.current_store_id())
  )
  WITH CHECK (
    brand_id = platform_helpers.current_brand_id()
    AND (store_id IS NULL OR store_id = platform_helpers.current_store_id())
  );

ALTER TABLE bop_permission.permission_override ENABLE ROW LEVEL SECURITY;
ALTER TABLE bop_permission.permission_override FORCE ROW LEVEL SECURITY;
CREATE POLICY permission_override_scope_policy ON bop_permission.permission_override
  USING (
    brand_id = platform_helpers.current_brand_id()
    AND (store_id IS NULL OR store_id = platform_helpers.current_store_id())
  )
  WITH CHECK (
    brand_id = platform_helpers.current_brand_id()
    AND (store_id IS NULL OR store_id = platform_helpers.current_store_id())
  );

REVOKE ALL ON TABLE bop_permission.policy_state FROM PUBLIC;
REVOKE ALL ON TABLE bop_permission.permission_definition FROM PUBLIC;
REVOKE ALL ON TABLE bop_permission.role FROM PUBLIC;
REVOKE ALL ON TABLE bop_permission.role_assignment FROM PUBLIC;
REVOKE ALL ON TABLE bop_permission.permission_grant FROM PUBLIC;
REVOKE ALL ON TABLE bop_permission.permission_override FROM PUBLIC;
