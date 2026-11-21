-- bop-rms-migration: 1
-- owner: @rms/store
-- schema: rms_store
-- phase: expand
-- risk: medium
-- transaction: required
-- lock-timeout-ms: 5000
-- statement-timeout-ms: 60000
-- recovery: forward-fix
-- V1 history and hashes are unchanged. V2 prepares charge contexts only.
CREATE OR REPLACE FUNCTION rms_store.store_setup_draft_insert_guard() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
DECLARE previous rms_store.store_setup_draft_revision%ROWTYPE;
  member_name text;
  member_value jsonb;
  snapshot jsonb;
  fee jsonb;
  fee_entry jsonb;
  fee_kind text;
  fee_index integer;
  order_types jsonb;
BEGIN
  IF TG_TABLE_SCHEMA<>'rms_store' OR TG_TABLE_NAME NOT IN ('store_setup_draft_revision','store_setup_draft_operation')
    OR TG_WHEN<>'BEFORE' OR TG_LEVEL<>'ROW' OR TG_OP<>'INSERT'
    OR current_setting('transaction_isolation')<>'read committed'
    OR (NEW.tenant_id::text=current_setting('bop.tenant_id',true)
      AND NEW.brand_id=platform_helpers.current_brand_id()
      AND NEW.store_id=platform_helpers.current_store_id()) IS NOT TRUE THEN
    RAISE EXCEPTION 'STORE_SETUP_SCOPE_UNAVAILABLE' USING ERRCODE='55000';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('StoreSetupOperation:'||NEW.operation_id::text,0));
  PERFORM pg_advisory_xact_lock(hashtextextended('StoreSetupRoot:'||NEW.tenant_id::text||':'||NEW.brand_id::text||':'||NEW.store_id::text,0));
  IF TG_TABLE_NAME='store_setup_draft_revision' THEN
    snapshot:=NEW.snapshot_json;
    IF jsonb_typeof(snapshot) IS DISTINCT FROM 'object' THEN
      RAISE EXCEPTION 'STORE_SETUP_SNAPSHOT_INVALID' USING ERRCODE='23514';
    END IF;
    IF (SELECT count(*) FROM jsonb_object_keys(snapshot))<>15
      OR (snapshot->>'profile' IN ('StoreSetupDraftV1','StoreSetupDraftV2')) IS NOT TRUE
      OR snapshot->>'setupDraftReference' IS DISTINCT FROM NEW.setup_draft_id::text
      OR snapshot->>'tenantReference' IS DISTINCT FROM NEW.tenant_id::text
      OR snapshot->>'brandReference' IS DISTINCT FROM NEW.brand_id::text
      OR snapshot->>'storeReference' IS DISTINCT FROM NEW.store_id::text
      OR snapshot->'revision' IS DISTINCT FROM to_jsonb(NEW.revision)
      OR snapshot->>'authoredByReference' IS DISTINCT FROM NEW.actor_id::text
      OR snapshot->>'createdAt' IS DISTINCT FROM to_char(NEW.created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
      OR snapshot->>'updatedAt' IS DISTINCT FROM to_char(NEW.updated_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
      OR snapshot->>'purposeCode' IS DISTINCT FROM 'STORE_SETUP_DRAFT'
      OR snapshot->>'dataClassification' IS DISTINCT FROM NEW.data_classification
      OR snapshot->>'currencyCode' IS DISTINCT FROM 'CAD'
      OR (snapshot->>'defaultLocale' ~ '^[a-z]{2,3}(-[A-Z][a-z]{3})?(-[A-Z]{2}|[0-9]{3})$') IS NOT TRUE
      OR NOT snapshot ? 'baseConfigurationReference'
      OR (snapshot->'baseConfigurationReference'<>'null'::jsonb AND (snapshot->>'baseConfigurationReference' ~ '^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$') IS NOT TRUE)
      OR jsonb_typeof(snapshot->'content') IS DISTINCT FROM 'object' THEN
      RAISE EXCEPTION 'STORE_SETUP_SNAPSHOT_INVALID' USING ERRCODE='23514';
    END IF;
    IF (SELECT count(*) FROM jsonb_object_keys(snapshot->'content'))<>(CASE WHEN snapshot->>'profile'='StoreSetupDraftV2' THEN 16 ELSE 15 END)
      OR (snapshot->>'profile'='StoreSetupDraftV1' AND snapshot->'content' ? 'feeContexts') THEN
      RAISE EXCEPTION 'STORE_SETUP_CONTENT_INVALID' USING ERRCODE='23514';
    END IF;
    FOREACH member_name IN ARRAY ARRAY['source','brandBaseVersionReference','timeZone','businessDayStartLocalTime','addressReference','contactReference','receiptReference','taxConfigurationReference','paymentConfigurationReference','capacityConfigurationReference','enabledServiceModes','weeklySchedule','exceptions','effectiveFrom','effectiveUntil'] LOOP
      member_value:=snapshot->'content'->member_name;
      IF jsonb_typeof(member_value) IS DISTINCT FROM 'object' THEN
        RAISE EXCEPTION 'STORE_SETUP_CONTENT_INVALID' USING ERRCODE='23514';
      END IF;
      IF ((member_value='{"state":"Unconfigured"}'::jsonb)
          OR (member_value->>'state'='Configured' AND member_value ? 'value'
            AND (SELECT count(*) FROM jsonb_object_keys(member_value))=2
            AND (member_value->'value'<>'null'::jsonb OR member_name IN ('capacityConfigurationReference','effectiveUntil')))) IS NOT TRUE THEN
        RAISE EXCEPTION 'STORE_SETUP_CONTENT_INVALID' USING ERRCODE='23514';
      END IF;
      IF member_value->>'state'='Configured' THEN
        IF member_name IN ('brandBaseVersionReference','addressReference','contactReference','receiptReference','taxConfigurationReference','paymentConfigurationReference','capacityConfigurationReference') THEN
          IF member_value->'value'<>'null'::jsonb AND (jsonb_typeof(member_value->'value')='string'
            AND member_value->>'value' ~ '^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$') IS NOT TRUE THEN
            RAISE EXCEPTION 'STORE_SETUP_CONTENT_INVALID' USING ERRCODE='23514';
          END IF;
        ELSIF member_name IN ('enabledServiceModes','weeklySchedule','exceptions') THEN
          IF jsonb_typeof(member_value->'value') IS DISTINCT FROM 'array' THEN
            RAISE EXCEPTION 'STORE_SETUP_CONTENT_INVALID' USING ERRCODE='23514';
          END IF;
        ELSIF member_name='source' THEN
          IF (jsonb_typeof(member_value->'value')='string' AND member_value->>'value' IN ('BrandInherited','StoreOverride')) IS NOT TRUE THEN
            RAISE EXCEPTION 'STORE_SETUP_CONTENT_INVALID' USING ERRCODE='23514';
          END IF;
        ELSIF member_value->'value'<>'null'::jsonb AND jsonb_typeof(member_value->'value') IS DISTINCT FROM 'string' THEN
          RAISE EXCEPTION 'STORE_SETUP_CONTENT_INVALID' USING ERRCODE='23514';
        END IF;
      END IF;
    END LOOP;
    IF snapshot->>'profile'='StoreSetupDraftV2' THEN
      fee:=snapshot->'content'->'feeContexts';
      IF jsonb_typeof(fee) IS DISTINCT FROM 'object' THEN
        RAISE EXCEPTION 'STORE_SETUP_FEE_CONTEXT_INVALID' USING ERRCODE='23514';
      END IF;
      IF fee<>'{"state":"Unconfigured"}'::jsonb THEN
        IF fee->>'state' IS DISTINCT FROM 'Configured' OR (SELECT count(*) FROM jsonb_object_keys(fee))<>2
          OR jsonb_typeof(fee->'value') IS DISTINCT FROM 'array' THEN
          RAISE EXCEPTION 'STORE_SETUP_FEE_CONTEXT_INVALID' USING ERRCODE='23514';
        END IF;
        IF jsonb_array_length(fee->'value')<>3 THEN
          RAISE EXCEPTION 'STORE_SETUP_FEE_CONTEXT_INVALID' USING ERRCODE='23514';
        END IF;
        FOR fee_index IN 0..2 LOOP
          fee_kind:=(ARRAY['ServiceCharge','DeliveryFee','Tip'])[fee_index+1];
          fee_entry:=fee->'value'->fee_index;
          IF jsonb_typeof(fee_entry) IS DISTINCT FROM 'object' THEN
            RAISE EXCEPTION 'STORE_SETUP_FEE_CONTEXT_INVALID' USING ERRCODE='23514';
          END IF;
          IF fee_entry->>'chargeType' IS DISTINCT FROM fee_kind THEN
            RAISE EXCEPTION 'STORE_SETUP_FEE_CONTEXT_INVALID' USING ERRCODE='23514';
          END IF;
          IF fee_entry->>'state' IN ('Unconfigured','Disabled') THEN
            IF (SELECT count(*) FROM jsonb_object_keys(fee_entry))<>2 THEN
              RAISE EXCEPTION 'STORE_SETUP_FEE_CONTEXT_INVALID' USING ERRCODE='23514';
            END IF;
          ELSIF fee_entry->>'state'='Enabled' THEN
            IF (SELECT count(*) FROM jsonb_object_keys(fee_entry))<>4
              OR jsonb_typeof(fee_entry->'taxClassificationReference') IS DISTINCT FROM 'string'
              OR (fee_entry->>'taxClassificationReference' ~ '^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$') IS NOT TRUE
              OR jsonb_typeof(fee_entry->'orderTypes') IS DISTINCT FROM 'array' THEN
              RAISE EXCEPTION 'STORE_SETUP_FEE_CONTEXT_INVALID' USING ERRCODE='23514';
            END IF;
            order_types:=fee_entry->'orderTypes';
            IF jsonb_array_length(order_types) NOT BETWEEN 1 AND 3
              OR EXISTS (SELECT 1 FROM jsonb_array_elements(order_types) AS mode(value)
                WHERE jsonb_typeof(value)<>'string' OR value#>>'{}' NOT IN ('DineIn','Pickup','Delivery'))
              OR (SELECT count(*) FROM jsonb_array_elements(order_types))<>(SELECT count(DISTINCT value) FROM jsonb_array_elements(order_types) AS mode(value))
              OR order_types IS DISTINCT FROM (SELECT jsonb_agg(to_jsonb(value) ORDER BY ordinal) FROM unnest(ARRAY['DineIn','Pickup','Delivery']) WITH ORDINALITY AS mode(value,ordinal) WHERE order_types ? value) THEN
              RAISE EXCEPTION 'STORE_SETUP_FEE_CONTEXT_INVALID' USING ERRCODE='23514';
            END IF;
          ELSE
            RAISE EXCEPTION 'STORE_SETUP_FEE_CONTEXT_INVALID' USING ERRCODE='23514';
          END IF;
        END LOOP;
      END IF;
    END IF;
    SELECT * INTO previous FROM rms_store.store_setup_draft_revision
      WHERE tenant_id=NEW.tenant_id AND brand_id=NEW.brand_id AND store_id=NEW.store_id
      ORDER BY revision DESC LIMIT 1;
    IF previous.snapshot_json->>'profile'='StoreSetupDraftV2' AND snapshot->>'profile'<>'StoreSetupDraftV2' THEN
      RAISE EXCEPTION 'STORE_SETUP_PROFILE_DOWNGRADE' USING ERRCODE='23514';
    END IF;
    IF (previous.setup_draft_id IS NULL AND (NEW.revision<>1 OR NEW.created_at<>NEW.updated_at))
      OR (previous.setup_draft_id IS NOT NULL AND (NEW.setup_draft_id<>previous.setup_draft_id
        OR NEW.revision<>previous.revision+1 OR NEW.created_at<>previous.created_at OR NEW.updated_at<previous.updated_at)) THEN
      RAISE EXCEPTION 'STORE_SETUP_REVISION_CONFLICT' USING ERRCODE='23514';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION rms_store.store_setup_draft_insert_guard() FROM PUBLIC;
