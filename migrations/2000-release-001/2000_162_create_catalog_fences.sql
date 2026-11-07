-- bop-rms-migration: 1
-- owner: @rms/catalog
-- schema: rms_catalog
-- phase: expand
-- risk: medium
-- transaction: required
-- lock-timeout-ms: 5000
-- statement-timeout-ms: 60000
-- recovery: forward-fix
-- WP-2423 DEC-MERCHANT-LOCK-SCOPE: a fence's scope is the fact it protects. Table locks on these
-- tables made one merchant's write stop every other merchant's reads. Readers now take the key
-- shared; this trigger takes it exclusive for every write, whatever the path, so none can skip it
-- (as the table lock caught every writer). "a0_" fires it before every other row trigger.
-- Keys follow who reads what today: a dish save writes bindings and reads option content, a review
-- reads all, so they stay apart and a dish save never meets an option-content reader.
LOCK TABLE rms_catalog.sku,rms_catalog.product_version,rms_catalog.option_set,rms_catalog.option_set_version,rms_catalog.option,rms_catalog.option_conflict,rms_catalog.product_option_binding,rms_catalog.product_option_binding_option,rms_catalog.product_option_binding_sku_scope,rms_catalog.product_option_binding_channel,rms_catalog.allergen_registry_version,rms_catalog.allergen_registry_entry,rms_catalog.allergen_source_evidence,rms_catalog.allergen_source_assertion IN SHARE ROW EXCLUSIVE MODE;
CREATE FUNCTION rms_catalog.take_brand_fence() RETURNS trigger LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
BEGIN
 IF TG_WHEN<>'BEFORE' OR TG_LEVEL<>'ROW' OR TG_NARGS<>1 THEN RAISE EXCEPTION 'MERCHANT_FENCE_MISUSED' USING ERRCODE='55000'; END IF;
 IF TG_OP='DELETE' THEN
  PERFORM pg_advisory_xact_lock(hashtextextended(TG_ARGV[0]||':'||OLD.brand_id::text,0));
  RETURN OLD;
 END IF;
 IF TG_OP='UPDATE' AND OLD.brand_id IS DISTINCT FROM NEW.brand_id THEN
  PERFORM pg_advisory_xact_lock(hashtextextended(TG_ARGV[0]||':'||OLD.brand_id::text,0));
 END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended(TG_ARGV[0]||':'||NEW.brand_id::text,0));
 RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION rms_catalog.take_brand_fence() FROM PUBLIC;
CREATE TRIGGER a0_merchant_fence BEFORE INSERT OR UPDATE OR DELETE ON rms_catalog.option_set FOR EACH ROW EXECUTE FUNCTION rms_catalog.take_brand_fence('CatalogOptionContentFence');
CREATE TRIGGER a0_merchant_fence BEFORE INSERT OR UPDATE OR DELETE ON rms_catalog.option_set_version FOR EACH ROW EXECUTE FUNCTION rms_catalog.take_brand_fence('CatalogOptionContentFence');
CREATE TRIGGER a0_merchant_fence BEFORE INSERT OR UPDATE OR DELETE ON rms_catalog.option FOR EACH ROW EXECUTE FUNCTION rms_catalog.take_brand_fence('CatalogOptionContentFence');
CREATE TRIGGER a0_merchant_fence BEFORE INSERT OR UPDATE OR DELETE ON rms_catalog.option_conflict FOR EACH ROW EXECUTE FUNCTION rms_catalog.take_brand_fence('CatalogOptionContentFence');
CREATE TRIGGER a0_merchant_fence BEFORE INSERT OR UPDATE OR DELETE ON rms_catalog.sku FOR EACH ROW EXECUTE FUNCTION rms_catalog.take_brand_fence('CatalogProductBindingFence');
CREATE TRIGGER a0_merchant_fence BEFORE INSERT OR UPDATE OR DELETE ON rms_catalog.product_version FOR EACH ROW EXECUTE FUNCTION rms_catalog.take_brand_fence('CatalogProductBindingFence');
CREATE TRIGGER a0_merchant_fence BEFORE INSERT OR UPDATE OR DELETE ON rms_catalog.product_option_binding FOR EACH ROW EXECUTE FUNCTION rms_catalog.take_brand_fence('CatalogProductBindingFence');
CREATE TRIGGER a0_merchant_fence BEFORE INSERT OR UPDATE OR DELETE ON rms_catalog.product_option_binding_option FOR EACH ROW EXECUTE FUNCTION rms_catalog.take_brand_fence('CatalogProductBindingFence');
CREATE TRIGGER a0_merchant_fence BEFORE INSERT OR UPDATE OR DELETE ON rms_catalog.product_option_binding_sku_scope FOR EACH ROW EXECUTE FUNCTION rms_catalog.take_brand_fence('CatalogProductBindingFence');
CREATE TRIGGER a0_merchant_fence BEFORE INSERT OR UPDATE OR DELETE ON rms_catalog.product_option_binding_channel FOR EACH ROW EXECUTE FUNCTION rms_catalog.take_brand_fence('CatalogProductBindingFence');
CREATE TRIGGER a0_merchant_fence BEFORE INSERT OR UPDATE OR DELETE ON rms_catalog.allergen_registry_version FOR EACH ROW EXECUTE FUNCTION rms_catalog.take_brand_fence('CatalogAllergenRegistryFence');
CREATE TRIGGER a0_merchant_fence BEFORE INSERT OR UPDATE OR DELETE ON rms_catalog.allergen_registry_entry FOR EACH ROW EXECUTE FUNCTION rms_catalog.take_brand_fence('CatalogAllergenRegistryFence');
CREATE TRIGGER a0_merchant_fence BEFORE INSERT OR UPDATE OR DELETE ON rms_catalog.allergen_source_evidence FOR EACH ROW EXECUTE FUNCTION rms_catalog.take_brand_fence('CatalogAllergenEvidenceFence');
CREATE TRIGGER a0_merchant_fence BEFORE INSERT OR UPDATE OR DELETE ON rms_catalog.allergen_source_assertion FOR EACH ROW EXECUTE FUNCTION rms_catalog.take_brand_fence('CatalogAllergenEvidenceFence');
