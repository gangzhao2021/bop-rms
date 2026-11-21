-- bop-rms-migration: 1
-- owner: @rms/pricing
-- schema: rms_pricing
-- phase: expand
-- risk: high
-- transaction: required
-- lock-timeout-ms: 5000
-- statement-timeout-ms: 60000
-- recovery: forward-fix
LOCK TABLE rms_pricing.price_book,rms_pricing.price_book_version,rms_pricing.price_entry,rms_pricing.option_price_rule,rms_pricing.option_price_rule_version,rms_pricing.promotion,rms_pricing.promotion_version,rms_pricing.promotion_eligibility_reference IN SHARE ROW EXCLUSIVE MODE;
SET LOCAL row_security=off;
CREATE TABLE rms_pricing.configuration_reference_generation (
  brand_id platform_helpers.uuid_v7 PRIMARY KEY,
  generation bigint NOT NULL CHECK (generation>=0)
);
INSERT INTO rms_pricing.configuration_reference_generation
  SELECT brand_id,0 FROM (SELECT brand_id FROM rms_pricing.price_book UNION
    SELECT brand_id FROM rms_pricing.option_price_rule UNION SELECT brand_id FROM rms_pricing.promotion) brands;
ALTER TABLE rms_pricing.configuration_reference_generation ENABLE ROW LEVEL SECURITY;
ALTER TABLE rms_pricing.configuration_reference_generation FORCE ROW LEVEL SECURITY;
CREATE POLICY configuration_reference_generation_scope ON rms_pricing.configuration_reference_generation
  USING (brand_id=platform_helpers.current_brand_id() AND platform_helpers.current_store_id() IS NULL)
  WITH CHECK (brand_id=platform_helpers.current_brand_id() AND platform_helpers.current_store_id() IS NULL);
REVOKE ALL ON TABLE rms_pricing.configuration_reference_generation FROM PUBLIC;
CREATE FUNCTION rms_pricing.maintain_configuration_reference_generation()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog
SET row_security = on
AS $$
DECLARE
  previous_brand text := current_setting('bop.brand_id',true);
  previous_store text := current_setting('bop.store_id',true);
  old_brand uuid; new_brand uuid; scope_brand uuid;
BEGIN
  IF TG_TABLE_SCHEMA<>'rms_pricing' OR TG_TABLE_NAME NOT IN (
    'price_book','price_book_version','price_entry','option_price_rule','option_price_rule_version',
    'promotion','promotion_version','promotion_eligibility_reference') OR
    TG_WHEN<>'AFTER' OR TG_LEVEL<>'ROW' OR TG_OP NOT IN ('INSERT','UPDATE','DELETE')
  THEN RAISE EXCEPTION 'CONFIGURATION_REFERENCE_SOURCE_UNAVAILABLE' USING ERRCODE='55000'; END IF;
  IF TG_OP<>'INSERT' THEN old_brand:=OLD.brand_id; END IF;
  IF TG_OP<>'DELETE' THEN new_brand:=NEW.brand_id; END IF;
  FOR scope_brand IN SELECT DISTINCT b FROM unnest(ARRAY[old_brand,new_brand]) AS b WHERE b IS NOT NULL ORDER BY b LOOP
    PERFORM pg_advisory_xact_lock(hashtextextended('PricingConfigurationReferenceV1:'||scope_brand::text,0));
    PERFORM set_config('bop.brand_id',scope_brand::text,true);
    PERFORM set_config('bop.store_id','',true);
    IF TG_OP='INSERT' AND TG_TABLE_NAME IN ('price_book','option_price_rule','promotion') OR
      (TG_TABLE_NAME IN ('price_book','option_price_rule','promotion') AND scope_brand=new_brand AND scope_brand IS DISTINCT FROM old_brand)
    THEN INSERT INTO rms_pricing.configuration_reference_generation VALUES (scope_brand,0) ON CONFLICT(brand_id) DO NOTHING; END IF;
    UPDATE rms_pricing.configuration_reference_generation SET generation=generation+1 WHERE brand_id=scope_brand;
    IF NOT FOUND THEN RAISE EXCEPTION 'CONFIGURATION_REFERENCE_SOURCE_UNAVAILABLE' USING ERRCODE='55000'; END IF;
  END LOOP;
  PERFORM set_config('bop.brand_id',COALESCE(previous_brand,''),true);
  PERFORM set_config('bop.store_id',COALESCE(previous_store,''),true);
  IF TG_OP='DELETE' THEN RETURN OLD; ELSE RETURN NEW; END IF;
END;
$$;
REVOKE ALL ON FUNCTION rms_pricing.maintain_configuration_reference_generation() FROM PUBLIC;
CREATE FUNCTION rms_pricing.reject_configuration_reference_truncate()
RETURNS trigger LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$ BEGIN RAISE EXCEPTION 'CONFIGURATION_REFERENCE_SOURCE_UNAVAILABLE' USING ERRCODE='55000'; END; $$;
REVOKE ALL ON FUNCTION rms_pricing.reject_configuration_reference_truncate() FROM PUBLIC;
CREATE TRIGGER price_book_configuration_reference_fence AFTER INSERT OR UPDATE OR DELETE ON rms_pricing.price_book FOR EACH ROW EXECUTE FUNCTION rms_pricing.maintain_configuration_reference_generation();
CREATE TRIGGER price_book_configuration_reference_no_truncate BEFORE TRUNCATE ON rms_pricing.price_book FOR EACH STATEMENT EXECUTE FUNCTION rms_pricing.reject_configuration_reference_truncate();
CREATE TRIGGER price_book_version_configuration_reference_fence AFTER INSERT OR UPDATE OR DELETE ON rms_pricing.price_book_version FOR EACH ROW EXECUTE FUNCTION rms_pricing.maintain_configuration_reference_generation();
CREATE TRIGGER price_book_version_configuration_reference_no_truncate BEFORE TRUNCATE ON rms_pricing.price_book_version FOR EACH STATEMENT EXECUTE FUNCTION rms_pricing.reject_configuration_reference_truncate();
CREATE TRIGGER price_entry_configuration_reference_fence AFTER INSERT OR UPDATE OR DELETE ON rms_pricing.price_entry FOR EACH ROW EXECUTE FUNCTION rms_pricing.maintain_configuration_reference_generation();
CREATE TRIGGER price_entry_configuration_reference_no_truncate BEFORE TRUNCATE ON rms_pricing.price_entry FOR EACH STATEMENT EXECUTE FUNCTION rms_pricing.reject_configuration_reference_truncate();
CREATE TRIGGER option_price_rule_configuration_reference_fence AFTER INSERT OR UPDATE OR DELETE ON rms_pricing.option_price_rule FOR EACH ROW EXECUTE FUNCTION rms_pricing.maintain_configuration_reference_generation();
CREATE TRIGGER option_price_rule_configuration_reference_no_truncate BEFORE TRUNCATE ON rms_pricing.option_price_rule FOR EACH STATEMENT EXECUTE FUNCTION rms_pricing.reject_configuration_reference_truncate();
CREATE TRIGGER option_price_rule_version_configuration_reference_fence AFTER INSERT OR UPDATE OR DELETE ON rms_pricing.option_price_rule_version FOR EACH ROW EXECUTE FUNCTION rms_pricing.maintain_configuration_reference_generation();
CREATE TRIGGER option_price_rule_version_configuration_reference_no_truncate BEFORE TRUNCATE ON rms_pricing.option_price_rule_version FOR EACH STATEMENT EXECUTE FUNCTION rms_pricing.reject_configuration_reference_truncate();
CREATE TRIGGER promotion_configuration_reference_fence AFTER INSERT OR UPDATE OR DELETE ON rms_pricing.promotion FOR EACH ROW EXECUTE FUNCTION rms_pricing.maintain_configuration_reference_generation();
CREATE TRIGGER promotion_configuration_reference_no_truncate BEFORE TRUNCATE ON rms_pricing.promotion FOR EACH STATEMENT EXECUTE FUNCTION rms_pricing.reject_configuration_reference_truncate();
CREATE TRIGGER promotion_version_configuration_reference_fence AFTER INSERT OR UPDATE OR DELETE ON rms_pricing.promotion_version FOR EACH ROW EXECUTE FUNCTION rms_pricing.maintain_configuration_reference_generation();
CREATE TRIGGER promotion_version_configuration_reference_no_truncate BEFORE TRUNCATE ON rms_pricing.promotion_version FOR EACH STATEMENT EXECUTE FUNCTION rms_pricing.reject_configuration_reference_truncate();
CREATE TRIGGER promotion_eligibility_reference_configuration_reference_fence AFTER INSERT OR UPDATE OR DELETE ON rms_pricing.promotion_eligibility_reference FOR EACH ROW EXECUTE FUNCTION rms_pricing.maintain_configuration_reference_generation();
CREATE TRIGGER promotion_eligibility_reference_configuration_reference_no_truncate BEFORE TRUNCATE ON rms_pricing.promotion_eligibility_reference FOR EACH STATEMENT EXECUTE FUNCTION rms_pricing.reject_configuration_reference_truncate();
SET LOCAL row_security=on;
