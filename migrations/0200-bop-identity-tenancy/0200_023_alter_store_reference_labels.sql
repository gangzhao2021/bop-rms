-- bop-rms-migration: 1
-- owner: @bop/tenant
-- schema: bop_tenant
-- phase: expand
-- risk: medium
-- transaction: required
-- lock-timeout-ms: 5000
-- statement-timeout-ms: 60000
-- recovery: forward-fix
-- Extend the existing complete identity projection, never a Store membership or eligibility claim.
LOCK TABLE bop_tenant.brand, bop_tenant.store, bop_tenant.store_reference_generation, bop_tenant.store_reference_projection IN SHARE ROW EXCLUSIVE MODE;
SET LOCAL row_security = off;
ALTER TABLE bop_tenant.store_reference_projection ADD COLUMN code text, ADD COLUMN display_name text;
UPDATE bop_tenant.store_reference_projection AS projected
  SET code=actual.code,display_name=actual.display_name
  FROM bop_tenant.store AS actual WHERE actual.brand_id=projected.brand_id AND actual.store_id=projected.store_id;
-- Missing or RLS-inaccessible owning identities fail instead of synthesizing labels.
ALTER TABLE bop_tenant.store_reference_projection
  ALTER COLUMN code SET NOT NULL, ALTER COLUMN display_name SET NOT NULL,
  ADD CONSTRAINT store_reference_projection_code_check CHECK (code ~ '^[A-Z][A-Z0-9_-]{0,62}$'),
  ADD CONSTRAINT store_reference_projection_display_name_check CHECK (char_length(display_name) BETWEEN 1 AND 160);
SET LOCAL row_security = on;

CREATE OR REPLACE FUNCTION bop_tenant.maintain_store_reference_projection()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog
SET row_security = on
AS $$
DECLARE
  previous_brand text := current_setting('bop.brand_id',true);
  previous_store text := current_setting('bop.store_id',true);
BEGIN
  IF TG_TABLE_SCHEMA <> 'bop_tenant' OR TG_TABLE_NAME NOT IN ('brand','store')
    OR TG_OP NOT IN ('INSERT','UPDATE') OR TG_WHEN <> 'AFTER' OR TG_LEVEL <> 'ROW'
  THEN RAISE EXCEPTION 'STORE_REFERENCE_SOURCE_INVALID' USING ERRCODE='55000'; END IF;
  -- Readers and both owner root writers use this exact transaction-scoped fence.
  PERFORM pg_advisory_xact_lock(hashtextextended('TenantStoreReferenceV1:' || NEW.brand_id::text,0));
  PERFORM set_config('bop.brand_id',NEW.brand_id::text,true);
  PERFORM set_config('bop.store_id','',true);
  IF TG_TABLE_NAME = 'brand' THEN
    IF TG_OP = 'INSERT' THEN
      INSERT INTO bop_tenant.store_reference_generation VALUES (NEW.brand_id,0,0);
    ELSE
      UPDATE bop_tenant.store_reference_generation SET generation=generation+1
        WHERE brand_id=NEW.brand_id;
      IF NOT FOUND THEN RAISE EXCEPTION 'STORE_REFERENCE_SOURCE_INVALID' USING ERRCODE='55000'; END IF;
    END IF;
  ELSE
    UPDATE bop_tenant.store_reference_generation
      SET generation=generation+1,reference_count=reference_count+CASE WHEN TG_OP='INSERT' THEN 1 ELSE 0 END
      WHERE brand_id=NEW.brand_id;
    IF NOT FOUND THEN RAISE EXCEPTION 'STORE_REFERENCE_SOURCE_INVALID' USING ERRCODE='55000'; END IF;
    IF TG_OP='INSERT' THEN
      INSERT INTO bop_tenant.store_reference_projection(brand_id,store_id,lifecycle,version,created_at,updated_at,code,display_name)
        VALUES (NEW.brand_id,NEW.store_id,NEW.lifecycle,NEW.version,NEW.created_at,NEW.updated_at,NEW.code,NEW.display_name);
    ELSE
      UPDATE bop_tenant.store_reference_projection
        SET lifecycle=NEW.lifecycle,version=NEW.version,updated_at=NEW.updated_at,code=NEW.code,display_name=NEW.display_name
        WHERE brand_id=NEW.brand_id AND store_id=NEW.store_id;
      IF NOT FOUND THEN RAISE EXCEPTION 'STORE_REFERENCE_SOURCE_INVALID' USING ERRCODE='55000'; END IF;
    END IF;
  END IF;
  PERFORM set_config('bop.brand_id',COALESCE(previous_brand,''),true);
  PERFORM set_config('bop.store_id',COALESCE(previous_store,''),true);
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION bop_tenant.maintain_store_reference_projection() FROM PUBLIC;
