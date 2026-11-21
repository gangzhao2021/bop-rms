-- bop-rms-migration: 1
-- owner: @rms/pricing
-- schema: rms_pricing
-- phase: expand
-- risk: medium
-- transaction: required
-- lock-timeout-ms: 5000
-- statement-timeout-ms: 60000
-- recovery: forward-fix
CREATE TABLE rms_pricing.tax_config_authoring_operation (
  operation_id platform_helpers.uuid_v7 PRIMARY KEY,
  tenant_id platform_helpers.uuid_v7 NOT NULL,
  brand_id platform_helpers.uuid_v7 NOT NULL,
  store_id platform_helpers.uuid_v7 NOT NULL,
  actor_id platform_helpers.uuid_v7 NOT NULL,
  action_code text NOT NULL CHECK (action_code IN ('CreateDraft','ReplaceDraft')),
  requested_configuration_id platform_helpers.uuid_v7,
  expected_aggregate_version integer,
  intent_digest text NOT NULL CHECK (intent_digest ~ '^sha256:[a-f0-9]{64}$'),
  outcome text NOT NULL CHECK (outcome IN ('Committed','Abandoned')),
  result_configuration_id platform_helpers.uuid_v7,
  result_version_id platform_helpers.uuid_v7,
  result_aggregate_version integer,
  service_intent_digest text CHECK (service_intent_digest ~ '^sha256:[a-f0-9]{64}$'),
  service_input_json text CHECK (octet_length(service_input_json)<=131072),
  receipt_json jsonb NOT NULL CHECK (jsonb_typeof(receipt_json)='object' AND octet_length(receipt_json::text)<=262144),
  receipt_digest text NOT NULL CHECK (receipt_digest ~ '^sha256:[a-f0-9]{64}$'),
  audit_id platform_helpers.uuid_v7 NOT NULL UNIQUE,
  audit_json jsonb NOT NULL CHECK (jsonb_typeof(audit_json)='object' AND octet_length(audit_json::text)<=65536),
  event_id platform_helpers.uuid_v7 UNIQUE,
  occurred_at timestamp with time zone NOT NULL CHECK (date_trunc('milliseconds',occurred_at)=occurred_at),
  data_classification text NOT NULL CHECK (data_classification='ConfigurationMetadata'),
  CONSTRAINT tax_config_authoring_requested_check CHECK (
    (action_code='CreateDraft' AND requested_configuration_id IS NULL AND expected_aggregate_version IS NULL)
    OR (action_code='ReplaceDraft' AND requested_configuration_id IS NOT NULL AND expected_aggregate_version IS NOT NULL AND expected_aggregate_version BETWEEN 1 AND 2147483646)
  ),
  CONSTRAINT tax_config_authoring_terminal_check CHECK (
    (outcome='Committed' AND result_configuration_id IS NOT NULL AND result_version_id IS NOT NULL
      AND result_aggregate_version IS NOT NULL AND result_aggregate_version BETWEEN 1 AND 2147483647 AND service_intent_digest IS NOT NULL
      AND service_input_json IS NOT NULL AND event_id IS NOT NULL)
    OR (outcome='Abandoned' AND result_configuration_id IS NULL AND result_version_id IS NULL
      AND result_aggregate_version IS NULL AND service_intent_digest IS NULL AND service_input_json IS NULL AND event_id IS NULL)
  ),
  CONSTRAINT tax_config_authoring_result_version_fk FOREIGN KEY (result_version_id,result_configuration_id,brand_id,store_id)
    REFERENCES rms_pricing.tax_configuration_version(tax_configuration_version_id,tax_configuration_id,brand_id,store_id)
    DEFERRABLE INITIALLY DEFERRED
);
ALTER TABLE rms_pricing.tax_configuration_version
  ADD COLUMN authoring_operation_id platform_helpers.uuid_v7,
  ADD CONSTRAINT tax_config_version_original_fk FOREIGN KEY (authoring_operation_id)
    REFERENCES rms_pricing.tax_config_authoring_operation(operation_id) DEFERRABLE INITIALLY DEFERRED;
CREATE UNIQUE INDEX tax_config_authoring_result_version_unique ON rms_pricing.tax_config_authoring_operation(result_version_id)
  WHERE result_version_id IS NOT NULL;
CREATE INDEX tax_config_authoring_history_idx ON rms_pricing.tax_config_authoring_operation(tenant_id,brand_id,store_id,result_configuration_id,result_aggregate_version);

CREATE FUNCTION rms_pricing.tax_config_authoring_insert_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog
AS $$
BEGIN
  IF NEW.tenant_id::text IS DISTINCT FROM nullif(current_setting('bop.tenant_id',true),'')
    OR NEW.brand_id IS DISTINCT FROM platform_helpers.current_brand_id()
    OR NEW.store_id IS DISTINCT FROM platform_helpers.current_store_id()
    OR current_setting('transaction_isolation') IS DISTINCT FROM 'read committed' THEN
    RAISE EXCEPTION 'Tax authoring scope unavailable' USING ERRCODE='42501';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('PricingTaxConfigOriginal:'||NEW.operation_id::text,0));
  IF COALESCE(NEW.result_configuration_id,NEW.requested_configuration_id) IS NOT NULL THEN
    PERFORM pg_advisory_xact_lock(hashtextextended('PricingTaxConfigRoot:'||NEW.brand_id::text||':'||NEW.store_id::text||':'||COALESCE(NEW.result_configuration_id,NEW.requested_configuration_id)::text,0));
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION rms_pricing.tax_config_authoring_insert_guard() FROM PUBLIC;
CREATE TRIGGER tax_config_authoring_insert_guard BEFORE INSERT ON rms_pricing.tax_config_authoring_operation
  FOR EACH ROW EXECUTE FUNCTION rms_pricing.tax_config_authoring_insert_guard();

CREATE FUNCTION rms_pricing.reject_tax_config_authoring_mutation() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog
AS $$
BEGIN
  RAISE EXCEPTION 'immutable Tax authoring original' USING ERRCODE='55000';
END;
$$;
REVOKE ALL ON FUNCTION rms_pricing.reject_tax_config_authoring_mutation() FROM PUBLIC;
CREATE TRIGGER tax_config_authoring_no_mutation BEFORE UPDATE OR DELETE ON rms_pricing.tax_config_authoring_operation
  FOR EACH ROW EXECUTE FUNCTION rms_pricing.reject_tax_config_authoring_mutation();
CREATE TRIGGER tax_config_authoring_no_truncate BEFORE TRUNCATE ON rms_pricing.tax_config_authoring_operation
  FOR EACH STATEMENT EXECUTE FUNCTION rms_pricing.reject_tax_config_authoring_mutation();

CREATE FUNCTION rms_pricing.tax_config_version_original_coherent() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog
AS $$
DECLARE original_row record;
  top_xid text := mod(pg_current_xact_id()::text::numeric,4294967296)::text;
BEGIN
  -- Existing versions remain historical; no author or professional evidence is backfilled.
  IF NEW.authoring_operation_id IS NULL THEN RETURN NEW; END IF;
  SELECT o.*,o.xmin::text AS held_xmin INTO original_row FROM rms_pricing.tax_config_authoring_operation o
    WHERE o.operation_id=NEW.authoring_operation_id;
  IF original_row.operation_id IS NULL OR original_row.held_xmin IS DISTINCT FROM top_xid
    OR original_row.outcome IS DISTINCT FROM 'Committed'
    OR original_row.tenant_id::text IS DISTINCT FROM nullif(current_setting('bop.tenant_id',true),'')
    OR original_row.brand_id IS DISTINCT FROM NEW.brand_id OR original_row.store_id IS DISTINCT FROM NEW.store_id
    OR original_row.result_configuration_id IS DISTINCT FROM NEW.tax_configuration_id
    OR original_row.result_version_id IS DISTINCT FROM NEW.tax_configuration_version_id
    OR original_row.occurred_at IS DISTINCT FROM NEW.created_at THEN
    RAISE EXCEPTION 'Tax version has no matching original terminal' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION rms_pricing.tax_config_version_original_coherent() FROM PUBLIC;
CREATE CONSTRAINT TRIGGER tax_config_version_original_coherence AFTER INSERT ON rms_pricing.tax_configuration_version
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION rms_pricing.tax_config_version_original_coherent();

CREATE FUNCTION rms_pricing.tax_config_authoring_terminal_coherent() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog
AS $$
DECLARE
  receipt jsonb := NEW.receipt_json;
  command jsonb;
  snapshot jsonb;
  service_input jsonb;
  root_row record;
  version_row record;
  operation_row record;
  prior_row record;
  stored_rules jsonb;
  content_rules jsonb;
  snapshot_rules jsonb;
  prior_count bigint;
  terminal_xmin text;
  top_xid text := mod(pg_current_xact_id()::text::numeric,4294967296)::text;
  at_text text := to_char(NEW.occurred_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"');
BEGIN
  SELECT o.xmin::text INTO terminal_xmin FROM rms_pricing.tax_config_authoring_operation o WHERE o.operation_id=NEW.operation_id;
  IF terminal_xmin IS DISTINCT FROM top_xid
    OR NEW.tenant_id::text IS DISTINCT FROM nullif(current_setting('bop.tenant_id',true),'')
    OR NEW.brand_id IS DISTINCT FROM platform_helpers.current_brand_id()
    OR NEW.store_id IS DISTINCT FROM platform_helpers.current_store_id()
    OR NOT (receipt ?& ARRAY['profile','tenantReference','brandReference','storeReference','actorReference','action','operationReference','configurationReference','expectedAggregateVersion','command','intentDigest','serviceIntentDigest','outcome','snapshot','auditReference','eventReference','occurredAt'])
    OR (SELECT count(*) FROM jsonb_object_keys(receipt))<>17
    OR receipt->>'profile' IS DISTINCT FROM 'TaxConfigAuthoringOperationV1'
    OR receipt->>'tenantReference' IS DISTINCT FROM NEW.tenant_id::text
    OR receipt->>'brandReference' IS DISTINCT FROM NEW.brand_id::text
    OR receipt->>'storeReference' IS DISTINCT FROM NEW.store_id::text
    OR receipt->>'actorReference' IS DISTINCT FROM NEW.actor_id::text
    OR receipt->>'action' IS DISTINCT FROM NEW.action_code
    OR receipt->>'operationReference' IS DISTINCT FROM NEW.operation_id::text
    OR receipt->'configurationReference' IS DISTINCT FROM COALESCE(to_jsonb(NEW.requested_configuration_id::text),'null'::jsonb)
    OR receipt->'expectedAggregateVersion' IS DISTINCT FROM COALESCE(to_jsonb(NEW.expected_aggregate_version),'null'::jsonb)
    OR receipt->>'intentDigest' IS DISTINCT FROM NEW.intent_digest
    OR receipt->'serviceIntentDigest' IS DISTINCT FROM COALESCE(to_jsonb(NEW.service_intent_digest),'null'::jsonb)
    OR receipt->>'outcome' IS DISTINCT FROM NEW.outcome
    OR receipt->>'auditReference' IS DISTINCT FROM NEW.audit_id::text
    OR receipt->'eventReference' IS DISTINCT FROM COALESCE(to_jsonb(NEW.event_id::text),'null'::jsonb)
    OR receipt->>'occurredAt' IS DISTINCT FROM at_text
    OR NEW.audit_json->>'auditId' IS DISTINCT FROM NEW.audit_id::text
    OR NEW.audit_json->>'brandId' IS DISTINCT FROM NEW.brand_id::text
    OR NEW.audit_json->>'storeId' IS DISTINCT FROM NEW.store_id::text
    OR NEW.audit_json->'actor'->>'type' IS DISTINCT FROM 'User'
    OR NEW.audit_json->'actor'->>'reference' IS DISTINCT FROM NEW.actor_id::text
    OR NEW.audit_json->>'correlationId' IS DISTINCT FROM NEW.operation_id::text
    OR NEW.audit_json->>'occurredAt' IS DISTINCT FROM at_text
    OR NEW.audit_json->>'reasonCode' IS DISTINCT FROM 'AUTHORIZED_OPERATION' THEN
    RAISE EXCEPTION 'incoherent Tax authoring original identity' USING ERRCODE='23514';
  END IF;
  IF NEW.outcome='Abandoned' THEN
    IF receipt->'command' IS DISTINCT FROM 'null'::jsonb OR receipt->'snapshot' IS DISTINCT FROM 'null'::jsonb
      OR NEW.audit_json->>'targetType' IS DISTINCT FROM 'PricingTaxAuthoringOperation'
      OR NEW.audit_json->>'targetId' IS DISTINCT FROM NEW.operation_id::text
      OR NEW.audit_json->>'actionCode' IS DISTINCT FROM 'PRICING_TAX_CONFIG_RESOLVE' THEN
      RAISE EXCEPTION 'incoherent abandoned Tax original' USING ERRCODE='23514';
    END IF;
    RETURN NEW;
  END IF;
  command := receipt->'command'; snapshot := receipt->'snapshot';
  service_input := NEW.service_input_json::jsonb;
  IF jsonb_typeof(command) IS DISTINCT FROM 'object' OR jsonb_typeof(snapshot) IS DISTINCT FROM 'object'
    OR jsonb_typeof(service_input) IS DISTINCT FROM 'object' THEN
    RAISE EXCEPTION 'invalid Tax original packet' USING ERRCODE='23514';
  END IF;
  IF (SELECT count(*) FROM jsonb_object_keys(command))<>5
    OR NOT (command ?& ARRAY['action','operationReference','configurationReference','expectedAggregateVersion','content'])
    OR command->>'action' IS DISTINCT FROM NEW.action_code OR command->>'operationReference' IS DISTINCT FROM NEW.operation_id::text
    OR command->'configurationReference' IS DISTINCT FROM receipt->'configurationReference'
    OR command->'expectedAggregateVersion' IS DISTINCT FROM receipt->'expectedAggregateVersion'
    OR (SELECT count(*) FROM jsonb_object_keys(snapshot))<>16
    OR NOT (snapshot ?& ARRAY['configurationReference','versionReference','brandReference','storeReference','stableCode','aggregateVersion','versionNumber','snapshotDigest','lifecycle','jurisdictionCode','currencyMetadata','effectivePeriod','registrationEvidence','professionalEvidence','rules','createdAt'])
    OR (SELECT count(*) FROM jsonb_object_keys(service_input))<>5
    OR NOT (service_input ?& ARRAY['action','operationReference','expectedAggregateVersion','candidate','occurredAt'])
    OR service_input->>'action' IS DISTINCT FROM NEW.action_code
    OR service_input->>'operationReference' IS DISTINCT FROM NEW.operation_id::text
    OR service_input->'expectedAggregateVersion' IS DISTINCT FROM receipt->'expectedAggregateVersion'
    OR service_input->'candidate' IS DISTINCT FROM snapshot OR service_input->>'occurredAt' IS DISTINCT FROM at_text
    OR NEW.service_intent_digest IS DISTINCT FROM 'sha256:'||encode(sha256(convert_to(NEW.service_input_json,'UTF8')),'hex') THEN
    RAISE EXCEPTION 'incoherent Tax service original preimage' USING ERRCODE='23514';
  END IF;
  SELECT r.*,r.xmin::text AS held_xmin INTO root_row FROM rms_pricing.tax_configuration r
    WHERE r.tax_configuration_id=NEW.result_configuration_id AND r.brand_id=NEW.brand_id AND r.store_id=NEW.store_id;
  SELECT v.*,v.xmin::text AS held_xmin INTO version_row FROM rms_pricing.tax_configuration_version v
    WHERE v.tax_configuration_version_id=NEW.result_version_id AND v.tax_configuration_id=NEW.result_configuration_id AND v.brand_id=NEW.brand_id AND v.store_id=NEW.store_id;
  SELECT o.*,o.xmin::text AS held_xmin INTO operation_row FROM rms_pricing.tax_configuration_operation_record o WHERE o.operation_id=NEW.operation_id;
  IF root_row.tax_configuration_id IS NULL OR version_row.tax_configuration_version_id IS NULL OR operation_row.operation_id IS NULL
    OR root_row.held_xmin IS DISTINCT FROM top_xid OR version_row.held_xmin IS DISTINCT FROM top_xid OR operation_row.held_xmin IS DISTINCT FROM top_xid
    OR version_row.authoring_operation_id IS DISTINCT FROM NEW.operation_id
    OR root_row.aggregate_version IS DISTINCT FROM NEW.result_aggregate_version
    OR root_row.current_version_id IS DISTINCT FROM NEW.result_version_id OR root_row.updated_at IS DISTINCT FROM NEW.occurred_at
    OR operation_row.tax_configuration_id IS DISTINCT FROM NEW.result_configuration_id
    OR operation_row.brand_id IS DISTINCT FROM NEW.brand_id OR operation_row.store_id IS DISTINCT FROM NEW.store_id
    OR operation_row.action_code IS DISTINCT FROM NEW.action_code OR operation_row.intent_digest IS DISTINCT FROM NEW.service_intent_digest
    OR operation_row.result_aggregate_version IS DISTINCT FROM NEW.result_aggregate_version OR operation_row.result_version_id IS DISTINCT FROM NEW.result_version_id
    OR operation_row.outbox_event_id IS DISTINCT FROM NEW.event_id OR operation_row.occurred_at IS DISTINCT FROM NEW.occurred_at
    OR NEW.result_aggregate_version IS DISTINCT FROM COALESCE(NEW.expected_aggregate_version,0)+1
    OR version_row.lifecycle IS DISTINCT FROM 'Draft'
    OR version_row.registration_applicability_id IS NOT NULL OR version_row.operating_entity_tax_reference_id IS NOT NULL
    OR version_row.jurisdiction_profile_id IS NOT NULL OR version_row.registration_evidence_valid_until IS NOT NULL
    OR version_row.professional_evidence_id IS NOT NULL OR version_row.professional_review_reference_id IS NOT NULL
    OR version_row.fixture_suite_reference_id IS NOT NULL OR version_row.fixture_suite_digest IS NOT NULL OR version_row.professional_evidence_valid_until IS NOT NULL
    OR NEW.audit_json->>'targetType' IS DISTINCT FROM 'PricingTaxConfiguration'
    OR NEW.audit_json->>'targetId' IS DISTINCT FROM NEW.result_configuration_id::text
    OR NEW.audit_json->>'actionCode' IS DISTINCT FROM 'PRICING_TAX_CONFIG_'||upper(NEW.action_code) THEN
    RAISE EXCEPTION 'Tax original has no matching committed source' USING ERRCODE='23514';
  END IF;
  IF NEW.action_code='CreateDraft' THEN
    IF version_row.version_number<>1 OR root_row.created_at IS DISTINCT FROM NEW.occurred_at OR root_row.created_by_actor_id IS DISTINCT FROM NEW.actor_id THEN
      RAISE EXCEPTION 'invalid initial Tax authoring source' USING ERRCODE='23514';
    END IF;
  ELSE
    SELECT count(*) INTO prior_count FROM rms_pricing.tax_configuration_operation_record o
      WHERE o.tax_configuration_id=NEW.requested_configuration_id AND o.brand_id=NEW.brand_id AND o.store_id=NEW.store_id AND o.result_aggregate_version=NEW.expected_aggregate_version;
    SELECT v.* INTO prior_row FROM rms_pricing.tax_configuration_version v
      JOIN rms_pricing.tax_configuration_operation_record o ON o.result_version_id=v.tax_configuration_version_id AND o.tax_configuration_id=v.tax_configuration_id AND o.brand_id=v.brand_id AND o.store_id=v.store_id
      WHERE o.tax_configuration_id=NEW.requested_configuration_id AND o.brand_id=NEW.brand_id AND o.store_id=NEW.store_id AND o.result_aggregate_version=NEW.expected_aggregate_version;
    IF prior_count<>1 OR prior_row.tax_configuration_version_id IS NULL OR prior_row.lifecycle IS DISTINCT FROM 'Draft'
      OR prior_row.created_at>NEW.occurred_at
      OR version_row.version_number IS DISTINCT FROM prior_row.version_number+1
      OR NEW.result_configuration_id IS DISTINCT FROM NEW.requested_configuration_id THEN
      RAISE EXCEPTION 'invalid successor Tax authoring source' USING ERRCODE='23514';
    END IF;
  END IF;
  IF snapshot->>'configurationReference' IS DISTINCT FROM NEW.result_configuration_id::text
    OR snapshot->>'versionReference' IS DISTINCT FROM NEW.result_version_id::text
    OR snapshot->>'brandReference' IS DISTINCT FROM NEW.brand_id::text OR snapshot->>'storeReference' IS DISTINCT FROM NEW.store_id::text
    OR snapshot->>'stableCode' IS DISTINCT FROM root_row.stable_code
    OR snapshot->'aggregateVersion' IS DISTINCT FROM to_jsonb(NEW.result_aggregate_version)
    OR snapshot->'versionNumber' IS DISTINCT FROM to_jsonb(version_row.version_number)
    OR snapshot->>'snapshotDigest' IS DISTINCT FROM version_row.snapshot_digest OR snapshot->>'lifecycle' IS DISTINCT FROM 'Draft'
    OR snapshot->>'jurisdictionCode' IS DISTINCT FROM version_row.jurisdiction_code
    OR snapshot->>'createdAt' IS DISTINCT FROM at_text OR version_row.created_at IS DISTINCT FROM NEW.occurred_at
    OR snapshot->'registrationEvidence' IS DISTINCT FROM 'null'::jsonb OR snapshot->'professionalEvidence' IS DISTINCT FROM 'null'::jsonb
    OR command->'content'->>'stableCode' IS DISTINCT FROM root_row.stable_code
    OR command->'content'->'effectivePeriod' IS DISTINCT FROM snapshot->'effectivePeriod' THEN
    RAISE EXCEPTION 'incoherent Tax snapshot identity' USING ERRCODE='23514';
  END IF;
  IF jsonb_typeof(snapshot->'currencyMetadata') IS DISTINCT FROM 'object'
    OR jsonb_typeof(snapshot->'effectivePeriod') IS DISTINCT FROM 'object'
    OR jsonb_typeof(snapshot->'rules') IS DISTINCT FROM 'array'
    OR jsonb_typeof(command->'content') IS DISTINCT FROM 'object'
    OR jsonb_typeof(command->'content'->'rules') IS DISTINCT FROM 'array' THEN
    RAISE EXCEPTION 'invalid Tax snapshot fields' USING ERRCODE='23514';
  END IF;
  IF (SELECT count(*) FROM jsonb_object_keys(snapshot->'currencyMetadata'))<>5
    OR NOT (snapshot->'currencyMetadata' ?& ARRAY['currencyCode','minorUnitExponent','metadataVersion','metadataVersionReference','metadataDigest'])
    OR snapshot->'currencyMetadata'->>'currencyCode' IS DISTINCT FROM version_row.currency_code
    OR snapshot->'currencyMetadata'->'metadataVersion' IS DISTINCT FROM to_jsonb(version_row.currency_metadata_version)
    OR snapshot->'currencyMetadata'->>'metadataVersionReference' IS DISTINCT FROM version_row.currency_metadata_version_id::text
    OR snapshot->'currencyMetadata'->>'metadataDigest' IS DISTINCT FROM version_row.currency_metadata_digest
    OR jsonb_typeof(snapshot->'currencyMetadata'->'minorUnitExponent') IS DISTINCT FROM 'number'
    OR (snapshot->'currencyMetadata'->>'minorUnitExponent') !~ '^[0-9]$'
    OR (snapshot->'currencyMetadata'->>'minorUnitExponent')::integer>6
    OR (SELECT count(*) FROM jsonb_object_keys(command->'content'))<>3
    OR NOT (command->'content' ?& ARRAY['stableCode','effectivePeriod','rules'])
    OR (SELECT count(*) FROM jsonb_object_keys(snapshot->'effectivePeriod'))<>3
    OR NOT (snapshot->'effectivePeriod' ?& ARRAY['timeZone','effectiveFrom','effectiveUntil'])
    OR snapshot->'effectivePeriod'->>'timeZone' IS DISTINCT FROM version_row.effective_time_zone
    OR snapshot->'effectivePeriod'->'effectiveFrom' IS DISTINCT FROM jsonb_build_object('instant',to_char(version_row.effective_from AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),'localDateTime',to_char(version_row.effective_from AT TIME ZONE version_row.effective_time_zone,'YYYY-MM-DD"T"HH24:MI:SS.MS'),'utcOffsetMinutes',extract(epoch FROM ((version_row.effective_from AT TIME ZONE version_row.effective_time_zone)-(version_row.effective_from AT TIME ZONE 'UTC')))/60)
    OR snapshot->'effectivePeriod'->'effectiveUntil' IS DISTINCT FROM (CASE WHEN version_row.effective_until IS NULL THEN 'null'::jsonb ELSE jsonb_build_object('instant',to_char(version_row.effective_until AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),'localDateTime',to_char(version_row.effective_until AT TIME ZONE version_row.effective_time_zone,'YYYY-MM-DD"T"HH24:MI:SS.MS'),'utcOffsetMinutes',extract(epoch FROM ((version_row.effective_until AT TIME ZONE version_row.effective_time_zone)-(version_row.effective_until AT TIME ZONE 'UTC')))/60) END)
    OR date_trunc('milliseconds',version_row.effective_from)<>version_row.effective_from
    OR (version_row.effective_until IS NOT NULL AND date_trunc('milliseconds',version_row.effective_until)<>version_row.effective_until) THEN
    RAISE EXCEPTION 'incoherent Tax currency or effective period' USING ERRCODE='23514';
  END IF;
  SELECT COALESCE(jsonb_agg(jsonb_build_object('ruleReference',r.tax_configuration_rule_id,'taxClassificationReference',r.tax_classification_id,'orderType',r.order_type,'chargeType',r.charge_type,'taxComponentCode',r.tax_component_code,'treatment',r.treatment,'rate',trim_scale(r.tax_rate)::text,'priceInclusion',r.price_inclusion,'roundingMode',r.rounding_mode,'calculationOrder',r.calculation_order,'compoundOnPriorTax',r.compound_on_prior_tax,'exceptionEvidenceReference',r.exception_evidence_id,'receiptPresentationCode',r.receipt_presentation_code) ORDER BY r.tax_configuration_rule_id),'[]'::jsonb)
    INTO stored_rules FROM rms_pricing.tax_configuration_rule r WHERE r.tax_configuration_version_id=NEW.result_version_id AND r.tax_configuration_id=NEW.result_configuration_id AND r.brand_id=NEW.brand_id AND r.store_id=NEW.store_id;
  SELECT COALESCE(jsonb_agg(value ORDER BY value->>'ruleReference'),'[]'::jsonb) INTO snapshot_rules FROM jsonb_array_elements(snapshot->'rules');
  SELECT COALESCE(jsonb_agg(value-'ruleReference' ORDER BY ordinality),'[]'::jsonb) INTO content_rules FROM jsonb_array_elements(snapshot->'rules') WITH ORDINALITY;
  IF jsonb_array_length(snapshot_rules)>256 OR stored_rules IS DISTINCT FROM snapshot_rules
    OR content_rules IS DISTINCT FROM command->'content'->'rules'
    OR EXISTS(SELECT 1 FROM rms_pricing.tax_configuration_rule r WHERE r.tax_configuration_version_id=NEW.result_version_id AND r.xmin::text IS DISTINCT FROM top_xid) THEN
    RAISE EXCEPTION 'incoherent Tax original rules' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION rms_pricing.tax_config_authoring_terminal_coherent() FROM PUBLIC;
CREATE CONSTRAINT TRIGGER tax_config_authoring_terminal_coherence AFTER INSERT ON rms_pricing.tax_config_authoring_operation
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION rms_pricing.tax_config_authoring_terminal_coherent();
ALTER TABLE rms_pricing.tax_config_authoring_operation ENABLE ROW LEVEL SECURITY;
ALTER TABLE rms_pricing.tax_config_authoring_operation FORCE ROW LEVEL SECURITY;
CREATE POLICY tax_config_authoring_scope ON rms_pricing.tax_config_authoring_operation
  USING ((tenant_id::text=current_setting('bop.tenant_id',true) AND brand_id=platform_helpers.current_brand_id() AND store_id=platform_helpers.current_store_id()) IS TRUE)
  WITH CHECK ((tenant_id::text=current_setting('bop.tenant_id',true) AND brand_id=platform_helpers.current_brand_id() AND store_id=platform_helpers.current_store_id()) IS TRUE);
REVOKE ALL ON TABLE rms_pricing.tax_config_authoring_operation FROM PUBLIC;

-- Scope-bound boolean only. Hidden legacy operations cannot become false Abandoned originals.
CREATE FUNCTION rms_pricing.tax_config_authoring_operation_available(original_operation platform_helpers.uuid_v7) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog
SET row_security = off
AS $$
BEGIN
  IF original_operation IS NULL OR platform_helpers.current_brand_id() IS NULL OR platform_helpers.current_store_id() IS NULL
    OR nullif(current_setting('bop.tenant_id',true),'') IS NULL THEN
    RAISE EXCEPTION 'Tax original availability unavailable' USING ERRCODE='42501';
  END IF;
  RETURN NOT EXISTS(SELECT 1 FROM rms_pricing.tax_config_authoring_operation WHERE operation_id=original_operation)
    AND NOT EXISTS(SELECT 1 FROM rms_pricing.tax_configuration_operation_record WHERE operation_id=original_operation);
END;
$$;
REVOKE ALL ON FUNCTION rms_pricing.tax_config_authoring_operation_available(platform_helpers.uuid_v7) FROM PUBLIC;

-- Legacy inserts participate in the same original fence; no legacy row is rewritten.
CREATE FUNCTION rms_pricing.tax_config_legacy_original_insert_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog
SET row_security = off
AS $$
DECLARE terminal record;
  top_xid text := mod(pg_current_xact_id()::text::numeric,4294967296)::text;
BEGIN
  IF NEW.brand_id IS DISTINCT FROM platform_helpers.current_brand_id() OR NEW.store_id IS DISTINCT FROM platform_helpers.current_store_id()
    OR nullif(current_setting('bop.tenant_id',true),'') IS NULL THEN
    RAISE EXCEPTION 'Tax original scope unavailable' USING ERRCODE='42501';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('PricingTaxConfigOriginal:'||NEW.operation_id::text,0));
  SELECT o.*,o.xmin::text AS held_xmin INTO terminal FROM rms_pricing.tax_config_authoring_operation o WHERE o.operation_id=NEW.operation_id;
  IF terminal.operation_id IS NOT NULL AND (
    terminal.held_xmin IS DISTINCT FROM top_xid OR terminal.outcome IS DISTINCT FROM 'Committed'
    OR terminal.tenant_id::text IS DISTINCT FROM nullif(current_setting('bop.tenant_id',true),'')
    OR terminal.brand_id IS DISTINCT FROM NEW.brand_id OR terminal.store_id IS DISTINCT FROM NEW.store_id
    OR terminal.action_code IS DISTINCT FROM NEW.action_code OR terminal.result_configuration_id IS DISTINCT FROM NEW.tax_configuration_id
    OR terminal.result_version_id IS DISTINCT FROM NEW.result_version_id OR terminal.result_aggregate_version IS DISTINCT FROM NEW.result_aggregate_version
    OR terminal.service_intent_digest IS DISTINCT FROM NEW.intent_digest OR terminal.event_id IS DISTINCT FROM NEW.outbox_event_id
    OR terminal.occurred_at IS DISTINCT FROM NEW.occurred_at
  ) THEN
    RAISE EXCEPTION 'Tax original is terminal' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION rms_pricing.tax_config_legacy_original_insert_guard() FROM PUBLIC;
CREATE TRIGGER tax_config_legacy_original_insert_guard BEFORE INSERT ON rms_pricing.tax_configuration_operation_record
  FOR EACH ROW EXECUTE FUNCTION rms_pricing.tax_config_legacy_original_insert_guard();
