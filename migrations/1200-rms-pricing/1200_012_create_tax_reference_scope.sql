-- bop-rms-migration: 1
-- owner: @rms/pricing
-- schema: rms_pricing
-- phase: expand
-- risk: high
-- transaction: required
-- lock-timeout-ms: 5000
-- statement-timeout-ms: 60000
-- recovery: forward-fix
LOCK TABLE rms_pricing.tax_configuration,rms_pricing.tax_configuration_version,rms_pricing.tax_configuration_rule IN SHARE ROW EXCLUSIVE MODE;
SET LOCAL row_security=off;
CREATE TABLE rms_pricing.tax_reference_generation (
  brand_id platform_helpers.uuid_v7 PRIMARY KEY,
  generation bigint NOT NULL CHECK (generation>=0),
  reference_count bigint NOT NULL CHECK (reference_count>=0)
);
CREATE TABLE rms_pricing.tax_reference_scope (
  brand_id platform_helpers.uuid_v7 NOT NULL,
  store_id platform_helpers.uuid_v7 NOT NULL,
  tax_configuration_id platform_helpers.uuid_v7 NOT NULL,
  present boolean NOT NULL,
  aggregate_version integer NOT NULL CHECK (aggregate_version>0),
  current_version_id platform_helpers.uuid_v7,
  CONSTRAINT tax_reference_scope_pkey PRIMARY KEY (brand_id,store_id,tax_configuration_id)
);
INSERT INTO rms_pricing.tax_reference_generation SELECT brand_id,0,count(*) FROM rms_pricing.tax_configuration GROUP BY brand_id;
INSERT INTO rms_pricing.tax_reference_scope SELECT brand_id,store_id,tax_configuration_id,true,aggregate_version,current_version_id FROM rms_pricing.tax_configuration;
ALTER TABLE rms_pricing.tax_reference_generation ENABLE ROW LEVEL SECURITY;
ALTER TABLE rms_pricing.tax_reference_generation FORCE ROW LEVEL SECURITY;
ALTER TABLE rms_pricing.tax_reference_scope ENABLE ROW LEVEL SECURITY;
ALTER TABLE rms_pricing.tax_reference_scope FORCE ROW LEVEL SECURITY;
CREATE POLICY tax_reference_generation_scope ON rms_pricing.tax_reference_generation
  USING (brand_id=platform_helpers.current_brand_id() AND platform_helpers.current_store_id() IS NULL)
  WITH CHECK (brand_id=platform_helpers.current_brand_id() AND platform_helpers.current_store_id() IS NULL);
CREATE POLICY tax_reference_scope_policy ON rms_pricing.tax_reference_scope
  USING (brand_id=platform_helpers.current_brand_id() AND platform_helpers.current_store_id() IS NULL)
  WITH CHECK (brand_id=platform_helpers.current_brand_id() AND platform_helpers.current_store_id() IS NULL);
REVOKE ALL ON TABLE rms_pricing.tax_reference_generation FROM PUBLIC;
REVOKE ALL ON TABLE rms_pricing.tax_reference_scope FROM PUBLIC;

-- Static trigger-only same-owner metadata; no foreign Store enumeration or grants.
CREATE FUNCTION rms_pricing.maintain_tax_reference_scope()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog
SET row_security = on
AS $$
DECLARE
  previous_brand text := current_setting('bop.brand_id',true);
  previous_store text := current_setting('bop.store_id',true);
  old_brand uuid;
  new_brand uuid;
  scope_brand uuid;
  inserted_count integer;
BEGIN
  IF TG_TABLE_SCHEMA <> 'rms_pricing' OR TG_TABLE_NAME NOT IN ('tax_configuration','tax_configuration_version','tax_configuration_rule')
    OR TG_WHEN <> 'AFTER' OR TG_LEVEL <> 'ROW'
    OR (TG_TABLE_NAME<>'tax_configuration' AND TG_OP<>'INSERT')
  THEN RAISE EXCEPTION 'TAX_REFERENCE_SCOPE_INVALID' USING ERRCODE='55000'; END IF;
  IF TG_OP<>'INSERT' THEN old_brand:=OLD.brand_id; END IF;
  IF TG_OP<>'DELETE' THEN new_brand:=NEW.brand_id; END IF;
  -- Deterministic order also covers legacy root moves between scopes.
  FOR scope_brand IN SELECT DISTINCT b FROM unnest(ARRAY[old_brand,new_brand]) AS b WHERE b IS NOT NULL ORDER BY b LOOP
    PERFORM pg_advisory_xact_lock(hashtextextended('PricingTaxReferenceV1:'||scope_brand::text,0));
    PERFORM set_config('bop.brand_id',scope_brand::text,true);
    PERFORM set_config('bop.store_id','',true);
    IF TG_TABLE_NAME='tax_configuration' AND scope_brand=new_brand
      AND (TG_OP='INSERT' OR scope_brand IS DISTINCT FROM old_brand) THEN
      INSERT INTO rms_pricing.tax_reference_generation VALUES (scope_brand,0,0) ON CONFLICT (brand_id) DO NOTHING;
    END IF;
    UPDATE rms_pricing.tax_reference_generation SET generation=generation+1 WHERE brand_id=scope_brand;
    IF NOT FOUND THEN RAISE EXCEPTION 'TAX_REFERENCE_SCOPE_INVALID' USING ERRCODE='55000'; END IF;
  END LOOP;
  IF TG_TABLE_NAME='tax_configuration' THEN
    IF TG_OP<>'INSERT' THEN
      PERFORM set_config('bop.brand_id',old_brand::text,true);
      UPDATE rms_pricing.tax_reference_scope SET present=false
        WHERE brand_id=OLD.brand_id AND store_id=OLD.store_id AND tax_configuration_id=OLD.tax_configuration_id;
      IF NOT FOUND THEN RAISE EXCEPTION 'TAX_REFERENCE_SCOPE_INVALID' USING ERRCODE='55000'; END IF;
    END IF;
    IF TG_OP<>'DELETE' THEN
      PERFORM set_config('bop.brand_id',new_brand::text,true);
      INSERT INTO rms_pricing.tax_reference_scope VALUES (NEW.brand_id,NEW.store_id,NEW.tax_configuration_id,true,NEW.aggregate_version,NEW.current_version_id)
        ON CONFLICT (brand_id,store_id,tax_configuration_id) DO NOTHING;
      GET DIAGNOSTICS inserted_count=ROW_COUNT;
      UPDATE rms_pricing.tax_reference_generation SET reference_count=reference_count+inserted_count WHERE brand_id=NEW.brand_id;
      UPDATE rms_pricing.tax_reference_scope SET present=true,aggregate_version=NEW.aggregate_version,current_version_id=NEW.current_version_id
        WHERE brand_id=NEW.brand_id AND store_id=NEW.store_id AND tax_configuration_id=NEW.tax_configuration_id;
    END IF;
  END IF;
  PERFORM set_config('bop.brand_id',COALESCE(previous_brand,''),true);
  PERFORM set_config('bop.store_id',COALESCE(previous_store,''),true);
  IF TG_OP='DELETE' THEN RETURN OLD; ELSE RETURN NEW; END IF;
END;
$$;
REVOKE ALL ON FUNCTION rms_pricing.maintain_tax_reference_scope() FROM PUBLIC;
CREATE TRIGGER tax_reference_root_scope_trigger AFTER INSERT OR UPDATE OR DELETE ON rms_pricing.tax_configuration
  FOR EACH ROW EXECUTE FUNCTION rms_pricing.maintain_tax_reference_scope();
CREATE TRIGGER tax_reference_version_fence_trigger AFTER INSERT ON rms_pricing.tax_configuration_version
  FOR EACH ROW EXECUTE FUNCTION rms_pricing.maintain_tax_reference_scope();
CREATE TRIGGER tax_reference_rule_fence_trigger AFTER INSERT ON rms_pricing.tax_configuration_rule
  FOR EACH ROW EXECUTE FUNCTION rms_pricing.maintain_tax_reference_scope();
SET LOCAL row_security=on;
