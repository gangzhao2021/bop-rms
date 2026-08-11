-- bop-rms-migration: 1
-- owner: @rms/fulfillment
-- schema: rms_fulfillment
-- phase: expand
-- risk: low
-- transaction: required
-- lock-timeout-ms: 5000
-- statement-timeout-ms: 60000
-- recovery: forward-fix
CREATE TABLE rms_fulfillment.pickup_proof_generation (
  capability_id platform_helpers.uuid_v7 NOT NULL,
  brand_id platform_helpers.uuid_v7 NOT NULL,
  store_id platform_helpers.uuid_v7 NOT NULL,
  fulfillment_id platform_helpers.uuid_v7 NOT NULL,
  proof_kind text NOT NULL CHECK (proof_kind IN ('Opaque', 'HumanCode')),
  public_order_reference text NOT NULL CHECK (public_order_reference ~ '^[A-Za-z0-9_-]{22}$'),
  selector_hash text NOT NULL CHECK (selector_hash ~ '^[0-9a-f]{64}$'),
  pepper_version integer NOT NULL CHECK (pepper_version > 0),
  generation integer NOT NULL CHECK (generation > 0),
  ready_at timestamp with time zone NOT NULL,
  expires_at timestamp with time zone NOT NULL,
  issued_at timestamp with time zone NOT NULL,
  data_classification text NOT NULL CHECK (data_classification = 'RestrictedCredential'),
  CONSTRAINT pickup_proof_generation_pkey
    PRIMARY KEY (brand_id, store_id, capability_id),
  CONSTRAINT pickup_proof_generation_parent_fkey
    FOREIGN KEY (brand_id, store_id, fulfillment_id)
    REFERENCES rms_fulfillment.fulfillment (brand_id, store_id, fulfillment_id),
  CONSTRAINT pickup_proof_generation_number_unique
    UNIQUE (brand_id, store_id, fulfillment_id, generation),
  CONSTRAINT pickup_proof_generation_scope_unique
    UNIQUE (brand_id, store_id, fulfillment_id, capability_id, generation),
  CONSTRAINT pickup_proof_generation_selector_unique
    UNIQUE (brand_id, store_id, selector_hash),
  CONSTRAINT pickup_proof_generation_lifetime_check CHECK (
    issued_at >= ready_at
    AND issued_at < expires_at
    AND expires_at <= ready_at + interval '60 minutes'
  )
);

CREATE TABLE rms_fulfillment.pickup_proof_invalidation (
  pickup_proof_invalidation_id platform_helpers.uuid_v7 NOT NULL,
  brand_id platform_helpers.uuid_v7 NOT NULL,
  store_id platform_helpers.uuid_v7 NOT NULL,
  fulfillment_id platform_helpers.uuid_v7 NOT NULL,
  prior_capability_id platform_helpers.uuid_v7 NOT NULL,
  replacement_capability_id platform_helpers.uuid_v7 NOT NULL,
  prior_generation integer NOT NULL CHECK (prior_generation > 0),
  replacement_generation integer NOT NULL CHECK (replacement_generation = prior_generation + 1),
  invalidated_at timestamp with time zone NOT NULL,
  reason text NOT NULL CHECK (reason = 'Regenerated'),
  data_classification text NOT NULL CHECK (data_classification = 'IndirectIdentifier'),
  CONSTRAINT pickup_proof_invalidation_pkey
    PRIMARY KEY (brand_id, store_id, pickup_proof_invalidation_id),
  CONSTRAINT pickup_proof_invalidation_parent_fkey
    FOREIGN KEY (brand_id, store_id, fulfillment_id)
    REFERENCES rms_fulfillment.fulfillment (brand_id, store_id, fulfillment_id),
  CONSTRAINT pickup_proof_invalidation_prior_fkey
    FOREIGN KEY (
      brand_id, store_id, fulfillment_id, prior_capability_id, prior_generation
    ) REFERENCES rms_fulfillment.pickup_proof_generation (
      brand_id, store_id, fulfillment_id, capability_id, generation
    ),
  CONSTRAINT pickup_proof_invalidation_replacement_fkey
    FOREIGN KEY (
      brand_id, store_id, fulfillment_id, replacement_capability_id, replacement_generation
    ) REFERENCES rms_fulfillment.pickup_proof_generation (
      brand_id, store_id, fulfillment_id, capability_id, generation
    ),
  CONSTRAINT pickup_proof_invalidation_prior_unique
    UNIQUE (brand_id, store_id, prior_capability_id),
  CONSTRAINT pickup_proof_invalidation_replacement_unique
    UNIQUE (brand_id, store_id, replacement_capability_id),
  CONSTRAINT pickup_proof_invalidation_distinct_check CHECK (
    pickup_proof_invalidation_id <> prior_capability_id
    AND pickup_proof_invalidation_id <> replacement_capability_id
    AND prior_capability_id <> replacement_capability_id
  )
);

CREATE TABLE rms_fulfillment.pickup_proof_verification (
  pickup_proof_verification_id platform_helpers.uuid_v7 NOT NULL,
  brand_id platform_helpers.uuid_v7 NOT NULL,
  store_id platform_helpers.uuid_v7 NOT NULL,
  fulfillment_id platform_helpers.uuid_v7 NOT NULL,
  capability_id platform_helpers.uuid_v7 NOT NULL,
  generation integer NOT NULL CHECK (generation > 0),
  verification_method text NOT NULL CHECK (verification_method IN ('Opaque', 'HumanCode')),
  validation_status text NOT NULL CHECK (validation_status = 'Validated'),
  verified_at timestamp with time zone NOT NULL,
  correlation_id platform_helpers.uuid_v7 NOT NULL,
  data_classification text NOT NULL CHECK (data_classification = 'IndirectIdentifier'),
  CONSTRAINT pickup_proof_verification_pkey
    PRIMARY KEY (brand_id, store_id, pickup_proof_verification_id),
  CONSTRAINT pickup_proof_verification_parent_fkey
    FOREIGN KEY (brand_id, store_id, fulfillment_id)
    REFERENCES rms_fulfillment.fulfillment (brand_id, store_id, fulfillment_id),
  CONSTRAINT pickup_proof_verification_capability_fkey
    FOREIGN KEY (brand_id, store_id, fulfillment_id, capability_id, generation)
    REFERENCES rms_fulfillment.pickup_proof_generation (
      brand_id, store_id, fulfillment_id, capability_id, generation
    ),
  CONSTRAINT pickup_proof_verification_distinct_check CHECK (
    pickup_proof_verification_id <> capability_id
    AND pickup_proof_verification_id <> correlation_id
  )
);

CREATE TABLE rms_fulfillment.pickup_proof_operation (
  pickup_proof_operation_id platform_helpers.uuid_v7 NOT NULL,
  brand_id platform_helpers.uuid_v7 NOT NULL,
  store_id platform_helpers.uuid_v7 NOT NULL,
  fulfillment_id platform_helpers.uuid_v7 NOT NULL,
  capability_id platform_helpers.uuid_v7 NOT NULL,
  verification_id platform_helpers.uuid_v7,
  idempotency_id platform_helpers.uuid_v7 NOT NULL,
  correlation_id platform_helpers.uuid_v7 NOT NULL,
  operation_kind text NOT NULL CHECK (operation_kind IN ('Issue', 'Regenerate', 'Verify')),
  generation integer NOT NULL CHECK (generation > 0),
  aggregate_version_before bigint,
  aggregate_version_after bigint,
  occurred_at timestamp with time zone NOT NULL,
  data_classification text NOT NULL CHECK (data_classification = 'IndirectIdentifier'),
  CONSTRAINT pickup_proof_operation_pkey
    PRIMARY KEY (brand_id, store_id, pickup_proof_operation_id),
  CONSTRAINT pickup_proof_operation_parent_fkey
    FOREIGN KEY (brand_id, store_id, fulfillment_id)
    REFERENCES rms_fulfillment.fulfillment (brand_id, store_id, fulfillment_id),
  CONSTRAINT pickup_proof_operation_capability_fkey
    FOREIGN KEY (brand_id, store_id, fulfillment_id, capability_id, generation)
    REFERENCES rms_fulfillment.pickup_proof_generation (
      brand_id, store_id, fulfillment_id, capability_id, generation
    ),
  CONSTRAINT pickup_proof_operation_verification_fkey
    FOREIGN KEY (brand_id, store_id, verification_id)
    REFERENCES rms_fulfillment.pickup_proof_verification (
      brand_id,
      store_id,
      pickup_proof_verification_id
    ),
  CONSTRAINT pickup_proof_operation_idempotency_unique
    UNIQUE (brand_id, store_id, idempotency_id),
  CONSTRAINT pickup_proof_operation_issue_generation_unique
    UNIQUE (brand_id, store_id, fulfillment_id, generation, operation_kind),
  CONSTRAINT pickup_proof_operation_shape_check CHECK (
    (
      (
        (operation_kind = 'Issue' AND generation = 1)
        OR (operation_kind = 'Regenerate' AND generation > 1)
      )
      AND verification_id IS NULL
      AND aggregate_version_before > 0
      AND aggregate_version_after = aggregate_version_before + 1
    ) OR (
      operation_kind = 'Verify'
      AND verification_id IS NOT NULL
      AND aggregate_version_before IS NULL
      AND aggregate_version_after IS NULL
    )
  ),
  CONSTRAINT pickup_proof_operation_distinct_check CHECK (
    pickup_proof_operation_id <> capability_id
    AND pickup_proof_operation_id <> idempotency_id
    AND pickup_proof_operation_id <> correlation_id
    AND idempotency_id <> correlation_id
  )
);

CREATE INDEX pickup_proof_generation_history_idx
  ON rms_fulfillment.pickup_proof_generation (
    brand_id, store_id, fulfillment_id, generation DESC
  );
CREATE INDEX pickup_proof_verification_history_idx
  ON rms_fulfillment.pickup_proof_verification (
    brand_id, store_id, fulfillment_id, verified_at, pickup_proof_verification_id
  );
CREATE INDEX pickup_proof_operation_history_idx
  ON rms_fulfillment.pickup_proof_operation (
    brand_id, store_id, fulfillment_id, occurred_at, pickup_proof_operation_id
  );

CREATE TRIGGER pickup_proof_generation_no_update_trigger
  BEFORE UPDATE ON rms_fulfillment.pickup_proof_generation
  FOR EACH ROW EXECUTE FUNCTION rms_fulfillment.reject_fulfillment_append_only_update();
CREATE RULE pickup_proof_generation_no_delete AS
  ON DELETE TO rms_fulfillment.pickup_proof_generation DO INSTEAD NOTHING;
CREATE TRIGGER pickup_proof_invalidation_no_update_trigger
  BEFORE UPDATE ON rms_fulfillment.pickup_proof_invalidation
  FOR EACH ROW EXECUTE FUNCTION rms_fulfillment.reject_fulfillment_append_only_update();
CREATE RULE pickup_proof_invalidation_no_delete AS
  ON DELETE TO rms_fulfillment.pickup_proof_invalidation DO INSTEAD NOTHING;
CREATE TRIGGER pickup_proof_verification_no_update_trigger
  BEFORE UPDATE ON rms_fulfillment.pickup_proof_verification
  FOR EACH ROW EXECUTE FUNCTION rms_fulfillment.reject_fulfillment_append_only_update();
CREATE RULE pickup_proof_verification_no_delete AS
  ON DELETE TO rms_fulfillment.pickup_proof_verification DO INSTEAD NOTHING;
CREATE TRIGGER pickup_proof_operation_no_update_trigger
  BEFORE UPDATE ON rms_fulfillment.pickup_proof_operation
  FOR EACH ROW EXECUTE FUNCTION rms_fulfillment.reject_fulfillment_append_only_update();
CREATE RULE pickup_proof_operation_no_delete AS
  ON DELETE TO rms_fulfillment.pickup_proof_operation DO INSTEAD NOTHING;

ALTER TABLE rms_fulfillment.pickup_proof_generation ENABLE ROW LEVEL SECURITY;
ALTER TABLE rms_fulfillment.pickup_proof_generation FORCE ROW LEVEL SECURITY;
ALTER TABLE rms_fulfillment.pickup_proof_invalidation ENABLE ROW LEVEL SECURITY;
ALTER TABLE rms_fulfillment.pickup_proof_invalidation FORCE ROW LEVEL SECURITY;
ALTER TABLE rms_fulfillment.pickup_proof_verification ENABLE ROW LEVEL SECURITY;
ALTER TABLE rms_fulfillment.pickup_proof_verification FORCE ROW LEVEL SECURITY;
ALTER TABLE rms_fulfillment.pickup_proof_operation ENABLE ROW LEVEL SECURITY;
ALTER TABLE rms_fulfillment.pickup_proof_operation FORCE ROW LEVEL SECURITY;

CREATE POLICY pickup_proof_generation_store_scope_policy
  ON rms_fulfillment.pickup_proof_generation
  USING (
    brand_id = platform_helpers.current_brand_id()
    AND store_id = platform_helpers.current_store_id()
  )
  WITH CHECK (
    brand_id = platform_helpers.current_brand_id()
    AND store_id = platform_helpers.current_store_id()
  );
CREATE POLICY pickup_proof_invalidation_store_scope_policy
  ON rms_fulfillment.pickup_proof_invalidation
  USING (
    brand_id = platform_helpers.current_brand_id()
    AND store_id = platform_helpers.current_store_id()
  )
  WITH CHECK (
    brand_id = platform_helpers.current_brand_id()
    AND store_id = platform_helpers.current_store_id()
  );
CREATE POLICY pickup_proof_verification_store_scope_policy
  ON rms_fulfillment.pickup_proof_verification
  USING (
    brand_id = platform_helpers.current_brand_id()
    AND store_id = platform_helpers.current_store_id()
  )
  WITH CHECK (
    brand_id = platform_helpers.current_brand_id()
    AND store_id = platform_helpers.current_store_id()
  );
CREATE POLICY pickup_proof_operation_store_scope_policy
  ON rms_fulfillment.pickup_proof_operation
  USING (
    brand_id = platform_helpers.current_brand_id()
    AND store_id = platform_helpers.current_store_id()
  )
  WITH CHECK (
    brand_id = platform_helpers.current_brand_id()
    AND store_id = platform_helpers.current_store_id()
  );

REVOKE ALL ON TABLE rms_fulfillment.pickup_proof_generation FROM PUBLIC;
REVOKE ALL ON TABLE rms_fulfillment.pickup_proof_invalidation FROM PUBLIC;
REVOKE ALL ON TABLE rms_fulfillment.pickup_proof_verification FROM PUBLIC;
REVOKE ALL ON TABLE rms_fulfillment.pickup_proof_operation FROM PUBLIC;
