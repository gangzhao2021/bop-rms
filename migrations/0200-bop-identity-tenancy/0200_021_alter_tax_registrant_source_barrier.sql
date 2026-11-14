-- bop-rms-migration: 1
-- owner: @bop/operating-entity
-- schema: bop_operating_entity
-- phase: expand
-- risk: high
-- transaction: required
-- lock-timeout-ms: 5000
-- statement-timeout-ms: 60000
-- recovery: forward-fix
-- Owning current TaxRegistrant reads retain one Store assignment and entity-profile
-- boundary through COMMIT. No table-wide locks or profile UPDATE grants are needed.
CREATE FUNCTION bop_operating_entity.lock_tax_registrant_assignment_source()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog
AS $$
DECLARE
  old_key text;
  new_key text;
BEGIN
  IF TG_OP <> 'INSERT' THEN
    IF OLD.business_function = 'TaxRegistrant' THEN
      old_key := 'TaxRegistrantAssignment:' || OLD.brand_id::text || ':' || OLD.store_id::text;
    END IF;
  END IF;
  IF TG_OP <> 'DELETE' THEN
    IF NEW.business_function = 'TaxRegistrant' THEN
      new_key := 'TaxRegistrantAssignment:' || NEW.brand_id::text || ':' || NEW.store_id::text;
    END IF;
  END IF;
  IF old_key IS NOT NULL AND new_key IS NOT NULL AND old_key <> new_key THEN
    IF old_key < new_key THEN
      PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(old_key, 0));
      PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(new_key, 0));
    ELSE
      PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(new_key, 0));
      PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(old_key, 0));
    END IF;
  ELSIF old_key IS NOT NULL THEN
    PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(old_key, 0));
  ELSIF new_key IS NOT NULL THEN
    PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(new_key, 0));
  END IF;
  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION bop_operating_entity.lock_tax_registrant_assignment_source() FROM PUBLIC;

CREATE TRIGGER tax_registrant_assignment_source_barrier
BEFORE INSERT OR UPDATE OR DELETE ON bop_operating_entity.store_operating_entity_assignment
FOR EACH ROW EXECUTE FUNCTION bop_operating_entity.lock_tax_registrant_assignment_source();

CREATE FUNCTION bop_operating_entity.lock_tax_registrant_profile_source()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog
AS $$
BEGIN
  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('TaxRegistrantProfile:' || NEW.operating_entity_id::text, 0)
  );
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION bop_operating_entity.lock_tax_registrant_profile_source() FROM PUBLIC;

CREATE TRIGGER tax_registrant_profile_source_barrier
BEFORE INSERT ON bop_operating_entity.operating_entity_profile_version
FOR EACH ROW EXECUTE FUNCTION bop_operating_entity.lock_tax_registrant_profile_source();
