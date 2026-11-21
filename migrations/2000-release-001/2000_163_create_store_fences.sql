-- bop-rms-migration: 1
-- owner: @rms/store
-- schema: rms_store
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
-- A guest's entry reads a Store's published configuration and pause state; authoring, a review
-- snapshot and the public profile have other readers, so each keeps its own key.
LOCK TABLE rms_store.store_configuration_authoring_operation,rms_store.store_configuration_version,rms_store.store_configuration_publication_content,rms_store.store_weekly_service_period,rms_store.store_service_exception,rms_store.store_service_exception_content,rms_store.store_service_exception_interval,rms_store.store_configuration_operation,rms_store.store_service_pause_content,rms_store.store_service_resume_content,rms_store.store_configuration_review_snapshot,rms_store.public_store_profile_version,rms_store.public_store_profile_timing IN SHARE ROW EXCLUSIVE MODE;
CREATE FUNCTION rms_store.take_store_fence() RETURNS trigger LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
BEGIN
 IF TG_WHEN<>'BEFORE' OR TG_LEVEL<>'ROW' OR TG_NARGS<>1 THEN RAISE EXCEPTION 'MERCHANT_FENCE_MISUSED' USING ERRCODE='55000'; END IF;
 IF TG_OP='DELETE' THEN
  PERFORM pg_advisory_xact_lock(hashtextextended(TG_ARGV[0]||':'||OLD.brand_id::text||':'||OLD.store_id::text,0));
  RETURN OLD;
 END IF;
 IF TG_OP='UPDATE' AND (OLD.brand_id,OLD.store_id) IS DISTINCT FROM (NEW.brand_id,NEW.store_id) THEN
  PERFORM pg_advisory_xact_lock(hashtextextended(TG_ARGV[0]||':'||OLD.brand_id::text||':'||OLD.store_id::text,0));
 END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended(TG_ARGV[0]||':'||NEW.brand_id::text||':'||NEW.store_id::text,0));
 RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION rms_store.take_store_fence() FROM PUBLIC;
CREATE TRIGGER a0_merchant_fence BEFORE INSERT OR UPDATE OR DELETE ON rms_store.store_configuration_authoring_operation FOR EACH ROW EXECUTE FUNCTION rms_store.take_store_fence('StoreAuthoringFence');
CREATE TRIGGER a0_merchant_fence BEFORE INSERT OR UPDATE OR DELETE ON rms_store.store_configuration_version FOR EACH ROW EXECUTE FUNCTION rms_store.take_store_fence('StoreConfigurationFence');
CREATE TRIGGER a0_merchant_fence BEFORE INSERT OR UPDATE OR DELETE ON rms_store.store_configuration_publication_content FOR EACH ROW EXECUTE FUNCTION rms_store.take_store_fence('StoreConfigurationFence');
CREATE TRIGGER a0_merchant_fence BEFORE INSERT OR UPDATE OR DELETE ON rms_store.store_weekly_service_period FOR EACH ROW EXECUTE FUNCTION rms_store.take_store_fence('StoreConfigurationFence');
CREATE TRIGGER a0_merchant_fence BEFORE INSERT OR UPDATE OR DELETE ON rms_store.store_service_exception FOR EACH ROW EXECUTE FUNCTION rms_store.take_store_fence('StoreConfigurationFence');
CREATE TRIGGER a0_merchant_fence BEFORE INSERT OR UPDATE OR DELETE ON rms_store.store_service_exception_content FOR EACH ROW EXECUTE FUNCTION rms_store.take_store_fence('StoreConfigurationFence');
CREATE TRIGGER a0_merchant_fence BEFORE INSERT OR UPDATE OR DELETE ON rms_store.store_service_exception_interval FOR EACH ROW EXECUTE FUNCTION rms_store.take_store_fence('StoreConfigurationFence');
CREATE TRIGGER a0_merchant_fence BEFORE INSERT OR UPDATE OR DELETE ON rms_store.store_configuration_operation FOR EACH ROW EXECUTE FUNCTION rms_store.take_store_fence('StoreServicePauseFence');
CREATE TRIGGER a0_merchant_fence BEFORE INSERT OR UPDATE OR DELETE ON rms_store.store_service_pause_content FOR EACH ROW EXECUTE FUNCTION rms_store.take_store_fence('StoreServicePauseFence');
CREATE TRIGGER a0_merchant_fence BEFORE INSERT OR UPDATE OR DELETE ON rms_store.store_service_resume_content FOR EACH ROW EXECUTE FUNCTION rms_store.take_store_fence('StoreServicePauseFence');
CREATE TRIGGER a0_merchant_fence BEFORE INSERT OR UPDATE OR DELETE ON rms_store.store_configuration_review_snapshot FOR EACH ROW EXECUTE FUNCTION rms_store.take_store_fence('StoreReviewSnapshotFence');
CREATE TRIGGER a0_merchant_fence BEFORE INSERT OR UPDATE OR DELETE ON rms_store.public_store_profile_version FOR EACH ROW EXECUTE FUNCTION rms_store.take_store_fence('StorePublicProfileFence');
CREATE TRIGGER a0_merchant_fence BEFORE INSERT OR UPDATE OR DELETE ON rms_store.public_store_profile_timing FOR EACH ROW EXECUTE FUNCTION rms_store.take_store_fence('StorePublicProfileTimingFence');
