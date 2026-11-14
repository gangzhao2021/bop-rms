-- bop-rms-migration: 1
-- owner: @bop/tenant
-- schema: bop_tenant
-- phase: expand
-- risk: high
-- transaction: required
-- lock-timeout-ms: 5000
-- statement-timeout-ms: 60000
-- recovery: forward-fix
-- Serialize bounded backfill against organization writers. FORCE RLS remains intact.
LOCK TABLE bop_tenant.brand, bop_tenant.store IN SHARE ROW EXCLUSIVE MODE;
SET LOCAL row_security = off;

CREATE TABLE bop_tenant.store_reference_generation (
  brand_id platform_helpers.uuid_v7 PRIMARY KEY REFERENCES bop_tenant.brand (brand_id),
  generation bigint NOT NULL CHECK (generation >= 0),
  reference_count bigint NOT NULL CHECK (reference_count >= 0)
);
CREATE TABLE bop_tenant.store_reference_projection (
  brand_id platform_helpers.uuid_v7 NOT NULL REFERENCES bop_tenant.brand (brand_id),
  store_id platform_helpers.uuid_v7 NOT NULL,
  lifecycle text NOT NULL CHECK (lifecycle IN ('Draft','Active','Suspended','Archived')),
  version bigint NOT NULL CHECK (version > 0),
  created_at timestamp with time zone NOT NULL,
  updated_at timestamp with time zone NOT NULL CHECK (updated_at >= created_at),
  CONSTRAINT store_reference_projection_pkey PRIMARY KEY (brand_id,store_id),
  CONSTRAINT store_reference_projection_store_fkey FOREIGN KEY (store_id,brand_id)
    REFERENCES bop_tenant.store (store_id,brand_id)
);
INSERT INTO bop_tenant.store_reference_generation (brand_id,generation,reference_count)
  SELECT brand.brand_id,0,count(store.store_id) FROM bop_tenant.brand AS brand
  LEFT JOIN bop_tenant.store AS store ON store.brand_id=brand.brand_id GROUP BY brand.brand_id;
INSERT INTO bop_tenant.store_reference_projection
  SELECT brand_id,store_id,lifecycle,version,created_at,updated_at FROM bop_tenant.store;

ALTER TABLE bop_tenant.store_reference_generation ENABLE ROW LEVEL SECURITY;
ALTER TABLE bop_tenant.store_reference_generation FORCE ROW LEVEL SECURITY;
ALTER TABLE bop_tenant.store_reference_projection ENABLE ROW LEVEL SECURITY;
ALTER TABLE bop_tenant.store_reference_projection FORCE ROW LEVEL SECURITY;
CREATE POLICY store_reference_generation_scope ON bop_tenant.store_reference_generation
  USING (brand_id=platform_helpers.current_brand_id() AND platform_helpers.current_store_id() IS NULL)
  WITH CHECK (brand_id=platform_helpers.current_brand_id() AND platform_helpers.current_store_id() IS NULL);
CREATE POLICY store_reference_projection_scope ON bop_tenant.store_reference_projection
  USING (brand_id=platform_helpers.current_brand_id() AND platform_helpers.current_store_id() IS NULL)
  WITH CHECK (brand_id=platform_helpers.current_brand_id() AND platform_helpers.current_store_id() IS NULL);
REVOKE ALL ON TABLE bop_tenant.store_reference_generation FROM PUBLIC;
REVOKE ALL ON TABLE bop_tenant.store_reference_projection FROM PUBLIC;

-- Trigger-only static metadata maintenance, never a general private-table reader.
-- Non-owner runtime roles need no projection write privileges. The original root
-- RLS/identity/revision guards still authorize and constrain the root mutation.
CREATE FUNCTION bop_tenant.maintain_store_reference_projection()
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
      INSERT INTO bop_tenant.store_reference_projection
        VALUES (NEW.brand_id,NEW.store_id,NEW.lifecycle,NEW.version,NEW.created_at,NEW.updated_at);
    ELSE
      UPDATE bop_tenant.store_reference_projection
        SET lifecycle=NEW.lifecycle,version=NEW.version,updated_at=NEW.updated_at
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
CREATE TRIGGER brand_store_reference_projection_trigger AFTER INSERT OR UPDATE ON bop_tenant.brand
  FOR EACH ROW EXECUTE FUNCTION bop_tenant.maintain_store_reference_projection();
CREATE TRIGGER store_reference_projection_trigger AFTER INSERT OR UPDATE ON bop_tenant.store
  FOR EACH ROW EXECUTE FUNCTION bop_tenant.maintain_store_reference_projection();
-- A role unable to backfill forced-RLS roots fails above instead of publishing a partial registry.
SET LOCAL row_security = on;
