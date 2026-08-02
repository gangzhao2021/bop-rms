-- bop-rms-migration: 1
-- owner: @rms/catalog
-- schema: rms_catalog
-- phase: expand
-- risk: medium
-- transaction: required
-- lock-timeout-ms: 5000
-- statement-timeout-ms: 60000
-- recovery: forward-fix
ALTER TABLE rms_catalog.published_menu_projection_sellable
  ADD COLUMN allergen_disclosure_json jsonb NOT NULL
  CHECK (jsonb_typeof(allergen_disclosure_json) = 'object');

CREATE TABLE rms_catalog.allergen_registry_version (
  registry_version_id platform_helpers.uuid_v7 PRIMARY KEY,
  brand_id platform_helpers.uuid_v7 NOT NULL,
  jurisdiction_code text NOT NULL CHECK (jurisdiction_code ~ '^[A-Z][A-Z0-9_-]{1,31}$'),
  policy_document_digest text NOT NULL CHECK (policy_document_digest ~ '^sha256:[0-9a-f]{64}$'),
  reviewed_at timestamp with time zone NOT NULL,
  reviewer_actor_id platform_helpers.uuid_v7 NOT NULL,
  status text NOT NULL CHECK (status IN ('Approved', 'Superseded', 'Invalidated')),
  CONSTRAINT allergen_registry_version_identity_unique UNIQUE (registry_version_id, brand_id)
);

CREATE TABLE rms_catalog.allergen_registry_entry (
  registry_version_id platform_helpers.uuid_v7 NOT NULL,
  brand_id platform_helpers.uuid_v7 NOT NULL,
  allergen_id platform_helpers.uuid_v7 NOT NULL,
  allergen_code text NOT NULL CHECK (allergen_code ~ '^[A-Z][A-Z0-9_-]{1,63}$'),
  localized_names_json jsonb NOT NULL CHECK (jsonb_typeof(localized_names_json) = 'object'),
  PRIMARY KEY (registry_version_id, allergen_id),
  CONSTRAINT allergen_registry_entry_version_fk FOREIGN KEY (registry_version_id, brand_id)
    REFERENCES rms_catalog.allergen_registry_version (registry_version_id, brand_id),
  CONSTRAINT allergen_registry_entry_code_unique UNIQUE (registry_version_id, allergen_code),
  CONSTRAINT allergen_registry_entry_identity_unique UNIQUE (registry_version_id, allergen_id, brand_id)
);

CREATE TABLE rms_catalog.allergen_source_evidence (
  evidence_id platform_helpers.uuid_v7 PRIMARY KEY,
  brand_id platform_helpers.uuid_v7 NOT NULL,
  subject_id platform_helpers.uuid_v7 NOT NULL,
  subject_kind text NOT NULL CHECK (subject_kind IN ('Ingredient', 'Recipe', 'Product', 'Option')),
  source_version_id platform_helpers.uuid_v7 NOT NULL,
  supplier_id platform_helpers.uuid_v7,
  document_digest text NOT NULL CHECK (document_digest ~ '^sha256:[0-9a-f]{64}$'),
  reviewed_at timestamp with time zone NOT NULL,
  valid_until timestamp with time zone NOT NULL,
  evidence_status text NOT NULL CHECK (evidence_status IN ('Approved', 'Invalidated', 'Conflicting')),
  CONSTRAINT allergen_source_period_check CHECK (valid_until > reviewed_at),
  CONSTRAINT allergen_source_identity_unique UNIQUE (evidence_id, brand_id)
);

CREATE TABLE rms_catalog.allergen_source_assertion (
  evidence_id platform_helpers.uuid_v7 NOT NULL,
  brand_id platform_helpers.uuid_v7 NOT NULL,
  registry_version_id platform_helpers.uuid_v7 NOT NULL,
  allergen_id platform_helpers.uuid_v7 NOT NULL,
  classification text NOT NULL CHECK (classification IN ('Contains', 'CrossContactPossible', 'Unverified')),
  PRIMARY KEY (evidence_id, allergen_id),
  CONSTRAINT allergen_assertion_evidence_fk FOREIGN KEY (evidence_id, brand_id)
    REFERENCES rms_catalog.allergen_source_evidence (evidence_id, brand_id),
  CONSTRAINT allergen_assertion_registry_fk FOREIGN KEY (registry_version_id, allergen_id, brand_id)
    REFERENCES rms_catalog.allergen_registry_entry (registry_version_id, allergen_id, brand_id)
);

CREATE TABLE rms_catalog.menu_allergen_validation_evidence (
  validation_evidence_id platform_helpers.uuid_v7 PRIMARY KEY,
  brand_id platform_helpers.uuid_v7 NOT NULL,
  menu_id platform_helpers.uuid_v7 NOT NULL,
  menu_version_id platform_helpers.uuid_v7 NOT NULL,
  snapshot_digest text NOT NULL CHECK (snapshot_digest ~ '^sha256:[0-9a-f]{64}$'),
  registry_version_id platform_helpers.uuid_v7 NOT NULL,
  checked_at timestamp with time zone NOT NULL,
  valid_until timestamp with time zone NOT NULL,
  validation_status text NOT NULL CHECK (validation_status = 'Pass'),
  CONSTRAINT menu_allergen_validation_version_fk FOREIGN KEY (menu_version_id, menu_id, brand_id)
    REFERENCES rms_catalog.menu_version (menu_version_id, menu_id, brand_id),
  CONSTRAINT menu_allergen_validation_registry_fk FOREIGN KEY (registry_version_id, brand_id)
    REFERENCES rms_catalog.allergen_registry_version (registry_version_id, brand_id),
  CONSTRAINT menu_allergen_validation_period_check CHECK (valid_until > checked_at),
  CONSTRAINT menu_allergen_validation_identity_unique UNIQUE (validation_evidence_id, menu_version_id, menu_id, brand_id)
);

CREATE TABLE rms_catalog.menu_sellable_allergen_disclosure (
  validation_evidence_id platform_helpers.uuid_v7 NOT NULL,
  brand_id platform_helpers.uuid_v7 NOT NULL,
  menu_id platform_helpers.uuid_v7 NOT NULL,
  menu_version_id platform_helpers.uuid_v7 NOT NULL,
  sellable_id platform_helpers.uuid_v7 NOT NULL,
  product_version_id platform_helpers.uuid_v7 NOT NULL,
  disclosure_json jsonb NOT NULL CHECK (jsonb_typeof(disclosure_json) = 'object'),
  allergen_free_claim boolean NOT NULL DEFAULT false CHECK (allergen_free_claim = false),
  assistance_code text NOT NULL DEFAULT 'ALLERGEN_ASSISTANCE_REQUIRED'
    CHECK (assistance_code = 'ALLERGEN_ASSISTANCE_REQUIRED'),
  PRIMARY KEY (validation_evidence_id, sellable_id),
  CONSTRAINT menu_allergen_disclosure_validation_fk
    FOREIGN KEY (validation_evidence_id, menu_version_id, menu_id, brand_id)
    REFERENCES rms_catalog.menu_allergen_validation_evidence (validation_evidence_id, menu_version_id, menu_id, brand_id)
);

CREATE RULE allergen_registry_version_no_update AS ON UPDATE TO rms_catalog.allergen_registry_version DO INSTEAD NOTHING;
CREATE RULE allergen_registry_version_no_delete AS ON DELETE TO rms_catalog.allergen_registry_version DO INSTEAD NOTHING;
CREATE RULE allergen_source_evidence_no_update AS ON UPDATE TO rms_catalog.allergen_source_evidence DO INSTEAD NOTHING;
CREATE RULE allergen_source_evidence_no_delete AS ON DELETE TO rms_catalog.allergen_source_evidence DO INSTEAD NOTHING;
CREATE RULE menu_allergen_validation_no_update AS ON UPDATE TO rms_catalog.menu_allergen_validation_evidence DO INSTEAD NOTHING;
CREATE RULE menu_allergen_validation_no_delete AS ON DELETE TO rms_catalog.menu_allergen_validation_evidence DO INSTEAD NOTHING;
CREATE RULE menu_allergen_disclosure_no_update AS ON UPDATE TO rms_catalog.menu_sellable_allergen_disclosure DO INSTEAD NOTHING;
CREATE RULE menu_allergen_disclosure_no_delete AS ON DELETE TO rms_catalog.menu_sellable_allergen_disclosure DO INSTEAD NOTHING;

ALTER TABLE rms_catalog.allergen_registry_version ENABLE ROW LEVEL SECURITY;
ALTER TABLE rms_catalog.allergen_registry_version FORCE ROW LEVEL SECURITY;
ALTER TABLE rms_catalog.allergen_registry_entry ENABLE ROW LEVEL SECURITY;
ALTER TABLE rms_catalog.allergen_registry_entry FORCE ROW LEVEL SECURITY;
ALTER TABLE rms_catalog.allergen_source_evidence ENABLE ROW LEVEL SECURITY;
ALTER TABLE rms_catalog.allergen_source_evidence FORCE ROW LEVEL SECURITY;
ALTER TABLE rms_catalog.allergen_source_assertion ENABLE ROW LEVEL SECURITY;
ALTER TABLE rms_catalog.allergen_source_assertion FORCE ROW LEVEL SECURITY;
ALTER TABLE rms_catalog.menu_allergen_validation_evidence ENABLE ROW LEVEL SECURITY;
ALTER TABLE rms_catalog.menu_allergen_validation_evidence FORCE ROW LEVEL SECURITY;
ALTER TABLE rms_catalog.menu_sellable_allergen_disclosure ENABLE ROW LEVEL SECURITY;
ALTER TABLE rms_catalog.menu_sellable_allergen_disclosure FORCE ROW LEVEL SECURITY;

CREATE POLICY allergen_registry_version_brand_policy ON rms_catalog.allergen_registry_version
  USING (brand_id = platform_helpers.current_brand_id() AND platform_helpers.current_store_id() IS NULL)
  WITH CHECK (brand_id = platform_helpers.current_brand_id() AND platform_helpers.current_store_id() IS NULL);
CREATE POLICY allergen_registry_entry_brand_policy ON rms_catalog.allergen_registry_entry
  USING (brand_id = platform_helpers.current_brand_id() AND platform_helpers.current_store_id() IS NULL)
  WITH CHECK (brand_id = platform_helpers.current_brand_id() AND platform_helpers.current_store_id() IS NULL);
CREATE POLICY allergen_source_evidence_brand_policy ON rms_catalog.allergen_source_evidence
  USING (brand_id = platform_helpers.current_brand_id() AND platform_helpers.current_store_id() IS NULL)
  WITH CHECK (brand_id = platform_helpers.current_brand_id() AND platform_helpers.current_store_id() IS NULL);
CREATE POLICY allergen_source_assertion_brand_policy ON rms_catalog.allergen_source_assertion
  USING (brand_id = platform_helpers.current_brand_id() AND platform_helpers.current_store_id() IS NULL)
  WITH CHECK (brand_id = platform_helpers.current_brand_id() AND platform_helpers.current_store_id() IS NULL);
CREATE POLICY menu_allergen_validation_brand_policy ON rms_catalog.menu_allergen_validation_evidence
  USING (brand_id = platform_helpers.current_brand_id() AND platform_helpers.current_store_id() IS NULL)
  WITH CHECK (brand_id = platform_helpers.current_brand_id() AND platform_helpers.current_store_id() IS NULL);
CREATE POLICY menu_allergen_disclosure_brand_policy ON rms_catalog.menu_sellable_allergen_disclosure
  USING (brand_id = platform_helpers.current_brand_id() AND platform_helpers.current_store_id() IS NULL)
  WITH CHECK (brand_id = platform_helpers.current_brand_id() AND platform_helpers.current_store_id() IS NULL);

REVOKE ALL ON TABLE rms_catalog.allergen_registry_version FROM PUBLIC;
REVOKE ALL ON TABLE rms_catalog.allergen_registry_entry FROM PUBLIC;
REVOKE ALL ON TABLE rms_catalog.allergen_source_evidence FROM PUBLIC;
REVOKE ALL ON TABLE rms_catalog.allergen_source_assertion FROM PUBLIC;
REVOKE ALL ON TABLE rms_catalog.menu_allergen_validation_evidence FROM PUBLIC;
REVOKE ALL ON TABLE rms_catalog.menu_sellable_allergen_disclosure FROM PUBLIC;
