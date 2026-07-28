-- bop-rms-migration: 1
-- owner: @bop/membership
-- schema: bop_membership
-- phase: expand
-- risk: medium
-- transaction: required
-- lock-timeout-ms: 5000
-- statement-timeout-ms: 60000
-- recovery: forward-fix
CREATE SCHEMA bop_membership;
REVOKE ALL ON SCHEMA bop_membership FROM PUBLIC;

CREATE TABLE bop_membership.membership (
  membership_id platform_helpers.uuid_v7 PRIMARY KEY,
  actor_id platform_helpers.uuid_v7 NOT NULL,
  brand_id platform_helpers.uuid_v7 NOT NULL,
  workforce_relationship_reference platform_helpers.uuid_v7,
  lifecycle text NOT NULL CHECK (
    lifecycle IN ('PendingActivation', 'Active', 'Suspended', 'Ended')
  ),
  effective_from timestamp with time zone NOT NULL,
  effective_until timestamp with time zone,
  version integer NOT NULL CHECK (version > 0),
  created_at timestamp with time zone NOT NULL,
  updated_at timestamp with time zone NOT NULL,
  CONSTRAINT membership_reference_actor_brand_unique UNIQUE (
    membership_id,
    actor_id,
    brand_id
  ),
  CONSTRAINT membership_period_check CHECK (
    effective_until IS NULL OR effective_until > effective_from
  ),
  CONSTRAINT membership_time_order_check CHECK (updated_at >= created_at),
  CONSTRAINT membership_active_evidence_check CHECK (
    lifecycle <> 'Active' OR workforce_relationship_reference IS NOT NULL
  )
);

CREATE TABLE bop_membership.store_assignment (
  assignment_id platform_helpers.uuid_v7 PRIMARY KEY,
  membership_id platform_helpers.uuid_v7 NOT NULL,
  actor_id platform_helpers.uuid_v7 NOT NULL,
  brand_id platform_helpers.uuid_v7 NOT NULL,
  store_id platform_helpers.uuid_v7 NOT NULL,
  lifecycle text NOT NULL CHECK (lifecycle IN ('Active', 'Suspended', 'Ended')),
  effective_from timestamp with time zone NOT NULL,
  effective_until timestamp with time zone,
  version integer NOT NULL CHECK (version > 0),
  created_at timestamp with time zone NOT NULL,
  updated_at timestamp with time zone NOT NULL,
  CONSTRAINT store_assignment_membership_fkey FOREIGN KEY (
    membership_id,
    actor_id,
    brand_id
  )
    REFERENCES bop_membership.membership (membership_id, actor_id, brand_id)
    DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT store_assignment_period_check CHECK (
    effective_until IS NULL OR effective_until > effective_from
  ),
  CONSTRAINT store_assignment_time_order_check CHECK (updated_at >= created_at)
);

CREATE INDEX membership_resolution_idx
  ON bop_membership.membership
  (actor_id, brand_id, lifecycle, effective_from, effective_until);
CREATE INDEX store_assignment_resolution_idx
  ON bop_membership.store_assignment
  (actor_id, brand_id, store_id, lifecycle, effective_from, effective_until);
CREATE INDEX store_assignment_membership_idx
  ON bop_membership.store_assignment
  (membership_id, lifecycle);

ALTER TABLE bop_membership.membership ENABLE ROW LEVEL SECURITY;
ALTER TABLE bop_membership.membership FORCE ROW LEVEL SECURITY;
CREATE POLICY membership_scope_policy ON bop_membership.membership
  USING (brand_id = platform_helpers.current_brand_id())
  WITH CHECK (brand_id = platform_helpers.current_brand_id());

ALTER TABLE bop_membership.store_assignment ENABLE ROW LEVEL SECURITY;
ALTER TABLE bop_membership.store_assignment FORCE ROW LEVEL SECURITY;
CREATE POLICY store_assignment_scope_policy ON bop_membership.store_assignment
  USING (
    brand_id = platform_helpers.current_brand_id()
    AND store_id = platform_helpers.current_store_id()
  )
  WITH CHECK (
    brand_id = platform_helpers.current_brand_id()
    AND store_id = platform_helpers.current_store_id()
  );

REVOKE ALL ON TABLE bop_membership.membership FROM PUBLIC;
REVOKE ALL ON TABLE bop_membership.store_assignment FROM PUBLIC;
