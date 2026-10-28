-- bop-rms-migration: 1
-- owner: @rms/catalog
-- schema: rms_catalog
-- phase: expand
-- risk: low
-- transaction: required
-- lock-timeout-ms: 5000
-- statement-timeout-ms: 60000
-- recovery: forward-fix
-- WP-2423 item 8 ⑥ DEC-SINGLE-STORE-MENU (coordinator 2026-10-28, accepted with four conditions):
-- a dish's allergens may be declared by staff in the one-page menu, without a recipe of real
-- ingredients. Such a declaration keeps how it was established as StaffDeclaration, so it is
-- labelled in data ("Allergens declared by staff") and never read as a supplier specification,
-- product label or manufacturer statement. Existing declarations keep their source.
ALTER TABLE rms_catalog.allergen_source_evidence
  DROP CONSTRAINT allergen_source_evidence_declaration_json_check;
ALTER TABLE rms_catalog.allergen_source_evidence
  ADD CONSTRAINT allergen_source_evidence_declaration_json_check CHECK (
    declaration_json IS NULL OR (
      jsonb_typeof(declaration_json) = 'object'
      AND declaration_json->>'sourceKind' IN
        ('SupplierSpecification', 'ProductLabel', 'ManufacturerStatement', 'StaffDeclaration')
      AND octet_length(declaration_json::text) <= 4096
    )
  );
