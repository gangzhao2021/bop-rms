-- bop-rms-migration: 1
-- owner: @bop/operating-entity
-- schema: bop_operating_entity
-- phase: expand
-- risk: medium
-- transaction: required
-- lock-timeout-ms: 5000
-- statement-timeout-ms: 60000
-- recovery: forward-fix
CREATE SCHEMA bop_operating_entity;
REVOKE ALL ON SCHEMA bop_operating_entity FROM PUBLIC;

CREATE TABLE bop_operating_entity.operating_entity (
  operating_entity_id platform_helpers.uuid_v7 PRIMARY KEY,
  kind text NOT NULL CHECK (kind = 'LegalEntity'),
  legal_name text NOT NULL CHECK (char_length(legal_name) BETWEEN 1 AND 200),
  trade_name text CHECK (trade_name IS NULL OR char_length(trade_name) BETWEEN 1 AND 200),
  jurisdiction_code text NOT NULL CHECK (jurisdiction_code = 'CA-ON'),
  registration_reference platform_helpers.uuid_v7,
  tax_registration_reference platform_helpers.uuid_v7,
  billing_identity_reference platform_helpers.uuid_v7,
  settlement_reference platform_helpers.uuid_v7,
  evidence_reference platform_helpers.uuid_v7,
  lifecycle text NOT NULL CHECK (
    lifecycle IN ('Draft', 'PendingExternalEvidence', 'Active', 'Suspended', 'Archived')
  ),
  version integer NOT NULL CHECK (version > 0),
  created_at timestamp with time zone NOT NULL,
  updated_at timestamp with time zone NOT NULL,
  CONSTRAINT operating_entity_time_order_check CHECK (updated_at >= created_at),
  CONSTRAINT operating_entity_active_evidence_check CHECK (
    lifecycle <> 'Active' OR evidence_reference IS NOT NULL
  )
);

CREATE TABLE bop_operating_entity.brand_operating_entity_assignment (
  assignment_id platform_helpers.uuid_v7 PRIMARY KEY,
  brand_id platform_helpers.uuid_v7 NOT NULL,
  operating_entity_id platform_helpers.uuid_v7 NOT NULL,
  business_function text NOT NULL CHECK (
    business_function IN (
      'SalesReceiptIssuer',
      'TaxRegistrant',
      'PaymentSettlementOwner',
      'ProcurementBuyer',
      'LicenseHolder',
      'Employer'
    )
  ),
  lifecycle text NOT NULL CHECK (lifecycle IN ('Active', 'Suspended', 'Archived')),
  effective_from timestamp with time zone NOT NULL,
  effective_until timestamp with time zone,
  version integer NOT NULL CHECK (version > 0),
  created_at timestamp with time zone NOT NULL,
  updated_at timestamp with time zone NOT NULL,
  CONSTRAINT brand_assignment_entity_fkey FOREIGN KEY (operating_entity_id)
    REFERENCES bop_operating_entity.operating_entity (operating_entity_id)
    DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT brand_assignment_period_check CHECK (
    effective_until IS NULL OR effective_until > effective_from
  ),
  CONSTRAINT brand_assignment_time_order_check CHECK (updated_at >= created_at)
);

CREATE TABLE bop_operating_entity.store_operating_entity_assignment (
  assignment_id platform_helpers.uuid_v7 PRIMARY KEY,
  brand_id platform_helpers.uuid_v7 NOT NULL,
  store_id platform_helpers.uuid_v7 NOT NULL,
  operating_entity_id platform_helpers.uuid_v7 NOT NULL,
  business_function text NOT NULL CHECK (
    business_function IN (
      'SalesReceiptIssuer',
      'TaxRegistrant',
      'PaymentSettlementOwner',
      'ProcurementBuyer',
      'LicenseHolder',
      'Employer'
    )
  ),
  lifecycle text NOT NULL CHECK (lifecycle IN ('Active', 'Suspended', 'Archived')),
  effective_from timestamp with time zone NOT NULL,
  effective_until timestamp with time zone,
  version integer NOT NULL CHECK (version > 0),
  created_at timestamp with time zone NOT NULL,
  updated_at timestamp with time zone NOT NULL,
  CONSTRAINT store_assignment_entity_fkey FOREIGN KEY (operating_entity_id)
    REFERENCES bop_operating_entity.operating_entity (operating_entity_id)
    DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT store_assignment_period_check CHECK (
    effective_until IS NULL OR effective_until > effective_from
  ),
  CONSTRAINT store_assignment_time_order_check CHECK (updated_at >= created_at)
);

CREATE INDEX brand_assignment_resolution_idx
  ON bop_operating_entity.brand_operating_entity_assignment
  (brand_id, business_function, lifecycle, effective_from, effective_until);
CREATE INDEX store_assignment_resolution_idx
  ON bop_operating_entity.store_operating_entity_assignment
  (brand_id, store_id, business_function, lifecycle, effective_from, effective_until);

ALTER TABLE bop_operating_entity.brand_operating_entity_assignment ENABLE ROW LEVEL SECURITY;
ALTER TABLE bop_operating_entity.brand_operating_entity_assignment FORCE ROW LEVEL SECURITY;
CREATE POLICY brand_assignment_scope_policy
  ON bop_operating_entity.brand_operating_entity_assignment
  USING (
    brand_id = platform_helpers.current_brand_id()
    AND platform_helpers.current_store_id() IS NULL
  )
  WITH CHECK (
    brand_id = platform_helpers.current_brand_id()
    AND platform_helpers.current_store_id() IS NULL
  );

ALTER TABLE bop_operating_entity.store_operating_entity_assignment ENABLE ROW LEVEL SECURITY;
ALTER TABLE bop_operating_entity.store_operating_entity_assignment FORCE ROW LEVEL SECURITY;
CREATE POLICY store_assignment_scope_policy
  ON bop_operating_entity.store_operating_entity_assignment
  USING (
    brand_id = platform_helpers.current_brand_id()
    AND store_id = platform_helpers.current_store_id()
  )
  WITH CHECK (
    brand_id = platform_helpers.current_brand_id()
    AND store_id = platform_helpers.current_store_id()
  );

ALTER TABLE bop_operating_entity.operating_entity ENABLE ROW LEVEL SECURITY;
ALTER TABLE bop_operating_entity.operating_entity FORCE ROW LEVEL SECURITY;
CREATE POLICY operating_entity_scope_policy ON bop_operating_entity.operating_entity
  USING (
    (
      platform_helpers.current_store_id() IS NULL
      AND EXISTS (
        SELECT 1
        FROM bop_operating_entity.brand_operating_entity_assignment AS brand_assignment
        WHERE brand_assignment.operating_entity_id =
          bop_operating_entity.operating_entity.operating_entity_id
          AND brand_assignment.brand_id = platform_helpers.current_brand_id()
      )
    )
    OR EXISTS (
      SELECT 1
      FROM bop_operating_entity.store_operating_entity_assignment AS store_assignment
      WHERE store_assignment.operating_entity_id =
        bop_operating_entity.operating_entity.operating_entity_id
        AND store_assignment.brand_id = platform_helpers.current_brand_id()
        AND store_assignment.store_id = platform_helpers.current_store_id()
    )
  );

REVOKE ALL ON TABLE bop_operating_entity.operating_entity FROM PUBLIC;
REVOKE ALL ON TABLE bop_operating_entity.brand_operating_entity_assignment FROM PUBLIC;
REVOKE ALL ON TABLE bop_operating_entity.store_operating_entity_assignment FROM PUBLIC;
