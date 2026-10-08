-- bop-rms-migration: 1
-- owner: @rms/catalog
-- schema: rms_catalog
-- phase: expand
-- risk: medium
-- transaction: required
-- lock-timeout-ms: 5000
-- statement-timeout-ms: 60000
-- recovery: forward-fix
-- WP-2423 / DEC-ALLERGEN-DECLARATIONS: an ingredient's allergen declaration is a source evidence record
-- made against one allergen registry version. Its assertions list the allergens it contains or may
-- contain; a declaration without assertions states that the ingredient contains none of that
-- registry's allergens. Each declaration keeps how it was established (supplier specification,
-- product label, manufacturer statement) and who recorded it. Registry entries and assertions are
-- append-only like their parents.
ALTER TABLE rms_catalog.allergen_source_evidence
  ADD COLUMN registry_version_id platform_helpers.uuid_v7,
  ADD COLUMN declaration_json jsonb CHECK (
    declaration_json IS NULL OR (
      jsonb_typeof(declaration_json) = 'object'
      AND declaration_json->>'sourceKind' IN
        ('SupplierSpecification', 'ProductLabel', 'ManufacturerStatement')
      AND octet_length(declaration_json::text) <= 4096
    )
  ),
  ADD COLUMN declared_by_actor_id platform_helpers.uuid_v7,
  ADD CONSTRAINT allergen_source_registry_fk FOREIGN KEY (registry_version_id, brand_id)
    REFERENCES rms_catalog.allergen_registry_version (registry_version_id, brand_id),
  ADD CONSTRAINT allergen_source_declaration_complete CHECK (
    (declaration_json IS NULL AND declared_by_actor_id IS NULL)
    OR (declaration_json IS NOT NULL AND declared_by_actor_id IS NOT NULL
        AND registry_version_id IS NOT NULL)
  );
CREATE INDEX allergen_source_evidence_subject
  ON rms_catalog.allergen_source_evidence (brand_id, subject_kind, subject_id, reviewed_at DESC);
-- Assertions of a registry-bound declaration use that registry.
CREATE FUNCTION rms_catalog.check_allergen_assertion_registry() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog
AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM rms_catalog.allergen_source_evidence e
              WHERE e.evidence_id = NEW.evidence_id AND e.registry_version_id IS NOT NULL
                AND e.registry_version_id <> NEW.registry_version_id) THEN
    RAISE EXCEPTION 'An allergen assertion must use its declaration''s registry version'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION rms_catalog.check_allergen_assertion_registry() FROM PUBLIC;
CREATE TRIGGER allergen_assertion_registry_matches
  BEFORE INSERT ON rms_catalog.allergen_source_assertion
  FOR EACH ROW EXECUTE FUNCTION rms_catalog.check_allergen_assertion_registry();
CREATE RULE allergen_registry_entry_no_update AS
  ON UPDATE TO rms_catalog.allergen_registry_entry DO INSTEAD NOTHING;
CREATE RULE allergen_registry_entry_no_delete AS
  ON DELETE TO rms_catalog.allergen_registry_entry DO INSTEAD NOTHING;
CREATE RULE allergen_source_assertion_no_update AS
  ON UPDATE TO rms_catalog.allergen_source_assertion DO INSTEAD NOTHING;
CREATE RULE allergen_source_assertion_no_delete AS
  ON DELETE TO rms_catalog.allergen_source_assertion DO INSTEAD NOTHING;

