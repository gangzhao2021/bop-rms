-- bop-rms-migration: 1
-- owner: @bop/tenant
-- schema: bop_tenant
-- phase: expand
-- risk: medium
-- transaction: required
-- lock-timeout-ms: 5000
-- statement-timeout-ms: 60000
-- recovery: forward-fix
CREATE OR REPLACE FUNCTION bop_tenant.enforce_organization_revision()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
BEGIN
  -- Branch before accessing table-specific RECORD fields.
  IF TG_TABLE_NAME = 'brand' THEN
    IF NEW.brand_id <> OLD.brand_id OR NEW.code <> OLD.code
      OR NEW.currency_code <> OLD.currency_code OR NEW.created_at <> OLD.created_at
      OR NEW.version <> OLD.version + 1
    THEN RAISE EXCEPTION 'Brand identity or revision is invalid' USING ERRCODE = '55000';
    END IF;
  ELSIF TG_TABLE_NAME = 'store' THEN
    IF NEW.store_id <> OLD.store_id OR NEW.brand_id <> OLD.brand_id OR NEW.code <> OLD.code
      OR NEW.currency_code <> OLD.currency_code OR NEW.created_at <> OLD.created_at
      OR NEW.version <> OLD.version + 1
    THEN RAISE EXCEPTION 'Store identity or revision is invalid' USING ERRCODE = '55000';
    END IF;
  END IF;
  IF OLD.lifecycle = 'Archived' THEN
    RAISE EXCEPTION 'archived organization identity is terminal' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION bop_tenant.enforce_organization_revision() FROM PUBLIC;
