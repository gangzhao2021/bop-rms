-- bop-rms-migration: 1
-- owner: @rms/pricing
-- schema: rms_pricing
-- phase: expand
-- risk: medium
-- transaction: required
-- lock-timeout-ms: 5000
-- statement-timeout-ms: 60000
-- recovery: forward-fix
CREATE SCHEMA rms_pricing;
REVOKE ALL ON SCHEMA rms_pricing FROM PUBLIC;

CREATE TABLE rms_pricing.tax_configuration (
  tax_configuration_id platform_helpers.uuid_v7 PRIMARY KEY,
  brand_id platform_helpers.uuid_v7 NOT NULL,
  store_id platform_helpers.uuid_v7 NOT NULL,
  stable_code text NOT NULL CHECK (stable_code ~ '^[A-Z][A-Z0-9_-]{0,63}$'),
  aggregate_version integer NOT NULL CHECK (aggregate_version > 0),
  current_version_id platform_helpers.uuid_v7,
  created_at timestamp with time zone NOT NULL,
  created_by_actor_id platform_helpers.uuid_v7 NOT NULL,
  updated_at timestamp with time zone NOT NULL,
  CONSTRAINT tax_configuration_scope_code_unique UNIQUE (brand_id, store_id, stable_code),
  CONSTRAINT tax_configuration_scope_identity_unique
    UNIQUE (tax_configuration_id, brand_id, store_id),
  CONSTRAINT tax_configuration_time_order_check CHECK (updated_at >= created_at)
);

CREATE TABLE rms_pricing.tax_configuration_version (
  tax_configuration_version_id platform_helpers.uuid_v7 PRIMARY KEY,
  tax_configuration_id platform_helpers.uuid_v7 NOT NULL,
  brand_id platform_helpers.uuid_v7 NOT NULL,
  store_id platform_helpers.uuid_v7 NOT NULL,
  version_number integer NOT NULL CHECK (version_number > 0),
  snapshot_digest text NOT NULL CHECK (snapshot_digest ~ '^sha256:[0-9a-f]{64}$'),
  lifecycle text NOT NULL CHECK (lifecycle IN ('Draft', 'Published')),
  jurisdiction_code text NOT NULL CHECK (jurisdiction_code = 'CA-ON'),
  currency_code text NOT NULL CHECK (currency_code = 'CAD'),
  currency_metadata_version integer NOT NULL CHECK (currency_metadata_version > 0),
  currency_metadata_version_id platform_helpers.uuid_v7 NOT NULL,
  currency_metadata_digest text NOT NULL CHECK (currency_metadata_digest ~ '^sha256:[0-9a-f]{64}$'),
  effective_from timestamp with time zone NOT NULL,
  effective_until timestamp with time zone,
  effective_time_zone text NOT NULL CHECK (effective_time_zone = 'America/Toronto'),
  registration_applicability_id platform_helpers.uuid_v7,
  operating_entity_tax_reference_id platform_helpers.uuid_v7,
  jurisdiction_profile_id platform_helpers.uuid_v7,
  registration_evidence_valid_until timestamp with time zone,
  professional_evidence_id platform_helpers.uuid_v7,
  professional_review_reference_id platform_helpers.uuid_v7,
  fixture_suite_reference_id platform_helpers.uuid_v7,
  fixture_suite_digest text CHECK (
    fixture_suite_digest IS NULL OR fixture_suite_digest ~ '^sha256:[0-9a-f]{64}$'
  ),
  professional_evidence_valid_until timestamp with time zone,
  created_at timestamp with time zone NOT NULL,
  CONSTRAINT tax_configuration_version_configuration_fk
    FOREIGN KEY (tax_configuration_id, brand_id, store_id)
    REFERENCES rms_pricing.tax_configuration (tax_configuration_id, brand_id, store_id),
  CONSTRAINT tax_configuration_version_scope_identity_unique
    UNIQUE (tax_configuration_version_id, tax_configuration_id, brand_id, store_id),
  CONSTRAINT tax_configuration_version_number_unique
    UNIQUE (tax_configuration_id, version_number),
  CONSTRAINT tax_configuration_version_effective_period_check
    CHECK (effective_until IS NULL OR effective_until > effective_from),
  CONSTRAINT tax_configuration_version_published_evidence_check CHECK (
    lifecycle = 'Draft'
    OR (
      registration_applicability_id IS NOT NULL
      AND operating_entity_tax_reference_id IS NOT NULL
      AND jurisdiction_profile_id IS NOT NULL
      AND registration_evidence_valid_until IS NOT NULL
      AND professional_evidence_id IS NOT NULL
      AND professional_review_reference_id IS NOT NULL
      AND fixture_suite_reference_id IS NOT NULL
      AND fixture_suite_digest IS NOT NULL
      AND professional_evidence_valid_until IS NOT NULL
    )
  )
);

ALTER TABLE rms_pricing.tax_configuration
  ADD CONSTRAINT tax_configuration_current_version_fk
  FOREIGN KEY (current_version_id, tax_configuration_id, brand_id, store_id)
  REFERENCES rms_pricing.tax_configuration_version (
    tax_configuration_version_id,
    tax_configuration_id,
    brand_id,
    store_id
  );

CREATE TABLE rms_pricing.tax_configuration_rule (
  tax_configuration_rule_id platform_helpers.uuid_v7 PRIMARY KEY,
  tax_configuration_version_id platform_helpers.uuid_v7 NOT NULL,
  tax_configuration_id platform_helpers.uuid_v7 NOT NULL,
  brand_id platform_helpers.uuid_v7 NOT NULL,
  store_id platform_helpers.uuid_v7 NOT NULL,
  tax_classification_id platform_helpers.uuid_v7 NOT NULL,
  order_type text NOT NULL CHECK (order_type IN ('DineIn', 'Pickup')),
  charge_type text NOT NULL CHECK (
    charge_type IN ('Sellable', 'ServiceCharge', 'DeliveryFee', 'Tip')
  ),
  tax_component_code text NOT NULL CHECK (
    tax_component_code ~ '^[A-Z][A-Z0-9_-]{0,63}$'
  ),
  treatment text NOT NULL CHECK (treatment IN ('Taxable', 'Exempt', 'ZeroRated')),
  tax_rate numeric(18,12) NOT NULL CHECK (tax_rate >= 0),
  price_inclusion text NOT NULL CHECK (price_inclusion IN ('Exclusive', 'Inclusive')),
  rounding_mode text NOT NULL CHECK (
    rounding_mode IN ('HalfUp', 'HalfEven', 'TowardZero', 'AwayFromZero')
  ),
  calculation_order integer NOT NULL CHECK (calculation_order BETWEEN 1 AND 16),
  compound_on_prior_tax boolean NOT NULL,
  exception_evidence_id platform_helpers.uuid_v7,
  receipt_presentation_code text NOT NULL CHECK (
    receipt_presentation_code ~ '^[A-Z][A-Z0-9_-]{0,63}$'
  ),
  CONSTRAINT tax_configuration_rule_version_fk
    FOREIGN KEY (tax_configuration_version_id, tax_configuration_id, brand_id, store_id)
    REFERENCES rms_pricing.tax_configuration_version (
      tax_configuration_version_id,
      tax_configuration_id,
      brand_id,
      store_id
    ),
  CONSTRAINT tax_configuration_rule_component_unique UNIQUE (
    tax_configuration_version_id,
    tax_classification_id,
    order_type,
    charge_type,
    tax_component_code
  ),
  CONSTRAINT tax_configuration_rule_order_unique UNIQUE (
    tax_configuration_version_id,
    tax_classification_id,
    order_type,
    charge_type,
    calculation_order
  ),
  CONSTRAINT tax_configuration_rule_treatment_evidence_check CHECK (
    (treatment = 'Taxable' AND exception_evidence_id IS NULL)
    OR (treatment IN ('Exempt', 'ZeroRated') AND tax_rate = 0 AND exception_evidence_id IS NOT NULL)
  ),
  CONSTRAINT tax_configuration_rule_compound_order_check CHECK (
    calculation_order > 1 OR compound_on_prior_tax = false
  )
);

CREATE TABLE rms_pricing.tax_configuration_operation_record (
  operation_id platform_helpers.uuid_v7 PRIMARY KEY,
  tax_configuration_id platform_helpers.uuid_v7 NOT NULL,
  brand_id platform_helpers.uuid_v7 NOT NULL,
  store_id platform_helpers.uuid_v7 NOT NULL,
  action_code text NOT NULL CHECK (action_code IN ('CreateDraft', 'ReplaceDraft', 'Publish')),
  intent_digest text NOT NULL CHECK (intent_digest ~ '^sha256:[0-9a-f]{64}$'),
  result_aggregate_version integer NOT NULL CHECK (result_aggregate_version > 0),
  result_version_id platform_helpers.uuid_v7 NOT NULL,
  occurred_at timestamp with time zone NOT NULL,
  CONSTRAINT tax_configuration_operation_configuration_fk
    FOREIGN KEY (tax_configuration_id, brand_id, store_id)
    REFERENCES rms_pricing.tax_configuration (tax_configuration_id, brand_id, store_id),
  CONSTRAINT tax_configuration_operation_version_fk
    FOREIGN KEY (result_version_id, tax_configuration_id, brand_id, store_id)
    REFERENCES rms_pricing.tax_configuration_version (
      tax_configuration_version_id,
      tax_configuration_id,
      brand_id,
      store_id
    )
);

CREATE RULE tax_configuration_version_no_update AS
  ON UPDATE TO rms_pricing.tax_configuration_version DO INSTEAD NOTHING;
CREATE RULE tax_configuration_version_no_delete AS
  ON DELETE TO rms_pricing.tax_configuration_version DO INSTEAD NOTHING;
CREATE RULE tax_configuration_rule_no_update AS
  ON UPDATE TO rms_pricing.tax_configuration_rule DO INSTEAD NOTHING;
CREATE RULE tax_configuration_rule_no_delete AS
  ON DELETE TO rms_pricing.tax_configuration_rule DO INSTEAD NOTHING;
CREATE RULE tax_configuration_operation_no_update AS
  ON UPDATE TO rms_pricing.tax_configuration_operation_record DO INSTEAD NOTHING;
CREATE RULE tax_configuration_operation_no_delete AS
  ON DELETE TO rms_pricing.tax_configuration_operation_record DO INSTEAD NOTHING;

CREATE INDEX tax_configuration_scope_idx
  ON rms_pricing.tax_configuration (brand_id, store_id, stable_code);
CREATE INDEX tax_configuration_version_effective_idx
  ON rms_pricing.tax_configuration_version (
    brand_id,
    store_id,
    jurisdiction_code,
    lifecycle,
    effective_from,
    effective_until
  );

ALTER TABLE rms_pricing.tax_configuration ENABLE ROW LEVEL SECURITY;
ALTER TABLE rms_pricing.tax_configuration FORCE ROW LEVEL SECURITY;
ALTER TABLE rms_pricing.tax_configuration_version ENABLE ROW LEVEL SECURITY;
ALTER TABLE rms_pricing.tax_configuration_version FORCE ROW LEVEL SECURITY;
ALTER TABLE rms_pricing.tax_configuration_rule ENABLE ROW LEVEL SECURITY;
ALTER TABLE rms_pricing.tax_configuration_rule FORCE ROW LEVEL SECURITY;
ALTER TABLE rms_pricing.tax_configuration_operation_record ENABLE ROW LEVEL SECURITY;
ALTER TABLE rms_pricing.tax_configuration_operation_record FORCE ROW LEVEL SECURITY;

CREATE POLICY tax_configuration_store_scope_policy ON rms_pricing.tax_configuration
  USING (
    brand_id = platform_helpers.current_brand_id()
    AND store_id = platform_helpers.current_store_id()
  )
  WITH CHECK (
    brand_id = platform_helpers.current_brand_id()
    AND store_id = platform_helpers.current_store_id()
  );
CREATE POLICY tax_configuration_version_store_scope_policy
  ON rms_pricing.tax_configuration_version
  USING (
    brand_id = platform_helpers.current_brand_id()
    AND store_id = platform_helpers.current_store_id()
  )
  WITH CHECK (
    brand_id = platform_helpers.current_brand_id()
    AND store_id = platform_helpers.current_store_id()
  );
CREATE POLICY tax_configuration_rule_store_scope_policy ON rms_pricing.tax_configuration_rule
  USING (
    brand_id = platform_helpers.current_brand_id()
    AND store_id = platform_helpers.current_store_id()
  )
  WITH CHECK (
    brand_id = platform_helpers.current_brand_id()
    AND store_id = platform_helpers.current_store_id()
  );
CREATE POLICY tax_configuration_operation_store_scope_policy
  ON rms_pricing.tax_configuration_operation_record
  USING (
    brand_id = platform_helpers.current_brand_id()
    AND store_id = platform_helpers.current_store_id()
  )
  WITH CHECK (
    brand_id = platform_helpers.current_brand_id()
    AND store_id = platform_helpers.current_store_id()
  );

REVOKE ALL ON TABLE rms_pricing.tax_configuration FROM PUBLIC;
REVOKE ALL ON TABLE rms_pricing.tax_configuration_version FROM PUBLIC;
REVOKE ALL ON TABLE rms_pricing.tax_configuration_rule FROM PUBLIC;
REVOKE ALL ON TABLE rms_pricing.tax_configuration_operation_record FROM PUBLIC;
