-- bop-rms-migration: 1
-- owner: @rms/store
-- schema: rms_store
-- phase: expand
-- risk: medium
-- transaction: required
-- lock-timeout-ms: 5000
-- statement-timeout-ms: 60000
-- recovery: forward-fix
-- Legacy publication content is unchanged. Setup-basis publications retain actual
-- immutable owning Draft provenance; this is not current Tax/Live Gate evidence.
CREATE FUNCTION rms_store.store_publication_setup_basis_guard() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
DECLARE basis jsonb;
  snapshot jsonb;
  field_name text;
  fee jsonb;
  fee_index integer;
BEGIN
  IF TG_TABLE_SCHEMA<>'rms_store' OR TG_TABLE_NAME<>'store_configuration_publication_content'
    OR TG_WHEN<>'BEFORE' OR TG_LEVEL<>'ROW' OR TG_OP<>'INSERT' THEN
    RAISE EXCEPTION 'STORE_PUBLICATION_SETUP_BASIS_UNAVAILABLE' USING ERRCODE='55000';
  END IF;
  IF NOT (NEW.configuration_json ? 'setupBasis') THEN RETURN NEW; END IF;
  basis:=NEW.configuration_json->'setupBasis';
  IF (jsonb_typeof(basis)='object' AND (SELECT count(*) FROM jsonb_object_keys(basis))=6
    AND basis ?& ARRAY['profile','tenantReference','setupDraftReference','sourceRevision','sourceSnapshotDigest','feeContexts']
    AND basis->>'profile'='StoreSetupConfigurationBasisV2'
    AND basis->>'tenantReference'=current_setting('bop.tenant_id',true)
    AND basis->>'tenantReference' ~ '^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
    AND NEW.brand_id=platform_helpers.current_brand_id()
    AND NEW.store_id=platform_helpers.current_store_id()
    AND NEW.configuration_json->>'brandReference'=NEW.brand_id::text
    AND NEW.configuration_json->>'storeReference'=NEW.store_id::text
    AND NEW.configuration_json->>'configurationReference'=NEW.configuration_id::text
    AND date_trunc('milliseconds',NEW.recorded_at)=NEW.recorded_at
    AND basis->>'setupDraftReference' ~ '^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
    AND jsonb_typeof(basis->'sourceRevision')='number'
    AND basis->>'sourceRevision' ~ '^[1-9][0-9]{0,9}$'
    AND (basis->>'sourceRevision')::bigint BETWEEN 1 AND 2147483647
    AND basis->>'sourceSnapshotDigest' ~ '^sha256:[0-9a-f]{64}$'
    AND jsonb_typeof(basis->'feeContexts')='array'
    AND jsonb_array_length(basis->'feeContexts')=3) IS NOT TRUE THEN
    RAISE EXCEPTION 'STORE_PUBLICATION_SETUP_BASIS_UNAVAILABLE' USING ERRCODE='55000';
  END IF;
  -- Both tables belong to Store. No Publishing or Audit private facts are inferred.
  SELECT r.snapshot_json INTO snapshot
    FROM rms_store.store_setup_draft_revision r JOIN rms_store.store_setup_draft_operation o
      ON o.tenant_id=r.tenant_id AND o.brand_id=r.brand_id AND o.store_id=r.store_id
      AND o.operation_id=r.operation_id AND o.actor_id=r.actor_id AND o.outcome='Committed'
      AND o.result_setup_id=r.setup_draft_id AND o.result_revision=r.revision
      AND o.snapshot_digest=r.snapshot_digest AND o.occurred_at=r.updated_at
    WHERE r.tenant_id::text=basis->>'tenantReference' AND r.brand_id=NEW.brand_id AND r.store_id=NEW.store_id
      AND r.setup_draft_id::text=basis->>'setupDraftReference'
      AND r.revision=(basis->>'sourceRevision')::integer
      AND r.snapshot_digest=basis->>'sourceSnapshotDigest';
  IF (snapshot IS NOT NULL AND snapshot->>'profile'='StoreSetupDraftV2'
    AND snapshot->>'tenantReference'=basis->>'tenantReference'
    AND snapshot->>'brandReference'=NEW.brand_id::text AND snapshot->>'storeReference'=NEW.store_id::text
    AND snapshot->>'setupDraftReference'=basis->>'setupDraftReference'
    AND snapshot->'revision'=basis->'sourceRevision'
    AND snapshot->>'defaultLocale'=NEW.configuration_json->>'defaultLocale'
    AND snapshot->>'currencyCode'=NEW.configuration_json->>'currencyCode'
    AND snapshot->'baseConfigurationReference'=NEW.configuration_json->'supersedesConfigurationReference'
    AND snapshot->>'updatedAt'<=NEW.configuration_json->>'createdAt'
    AND snapshot->>'updatedAt'<=to_char(NEW.recorded_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
    AND snapshot->'content'->'feeContexts'->>'state'='Configured'
    AND snapshot->'content'->'feeContexts'->'value'=basis->'feeContexts') IS NOT TRUE THEN
    RAISE EXCEPTION 'STORE_PUBLICATION_SETUP_BASIS_UNAVAILABLE' USING ERRCODE='55000';
  END IF;
  FOREACH field_name IN ARRAY ARRAY['source','brandBaseVersionReference','timeZone','businessDayStartLocalTime',
    'addressReference','contactReference','receiptReference','taxConfigurationReference',
    'paymentConfigurationReference','capacityConfigurationReference','enabledServiceModes',
    'weeklySchedule','exceptions','effectiveFrom','effectiveUntil'] LOOP
    IF (snapshot->'content'->field_name->>'state'='Configured'
      AND snapshot->'content'->field_name->'value'=NEW.configuration_json->field_name) IS NOT TRUE THEN
      RAISE EXCEPTION 'STORE_PUBLICATION_SETUP_BASIS_UNAVAILABLE' USING ERRCODE='55000';
    END IF;
  END LOOP;
  FOR fee_index IN 0..2 LOOP
    fee:=basis->'feeContexts'->fee_index;
    IF (jsonb_typeof(fee)='object'
      AND fee->>'chargeType'=(ARRAY['ServiceCharge','DeliveryFee','Tip'])[fee_index+1]
      AND fee->>'state' IN ('Disabled','Enabled')) IS NOT TRUE THEN
      RAISE EXCEPTION 'STORE_PUBLICATION_SETUP_BASIS_UNAVAILABLE' USING ERRCODE='55000';
    END IF;
    IF fee->>'state'='Enabled' AND EXISTS (
      SELECT 1 FROM jsonb_array_elements(fee->'orderTypes') AS mode(value)
        WHERE (NEW.configuration_json->'enabledServiceModes' ? (value#>>'{}')) IS NOT TRUE
    ) THEN
      RAISE EXCEPTION 'STORE_PUBLICATION_SETUP_BASIS_UNAVAILABLE' USING ERRCODE='55000';
    END IF;
  END LOOP;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION rms_store.store_publication_setup_basis_guard() FROM PUBLIC;
CREATE TRIGGER store_publication_setup_basis_insert BEFORE INSERT ON rms_store.store_configuration_publication_content
  FOR EACH ROW EXECUTE FUNCTION rms_store.store_publication_setup_basis_guard();
