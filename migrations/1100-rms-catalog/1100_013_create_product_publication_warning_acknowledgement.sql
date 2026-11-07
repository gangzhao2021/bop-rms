-- bop-rms-migration: 1
-- owner: @rms/catalog
-- schema: rms_catalog
-- phase: expand
-- risk: medium
-- transaction: required
-- lock-timeout-ms: 5000
-- statement-timeout-ms: 60000
-- recovery: forward-fix
-- Independent consent receipts do not mutate the displayed report or advance
-- the Product root. Canonical hashes and actual held facts remain owner checks.
ALTER TABLE rms_catalog.product_publication_validation_report
 ADD CONSTRAINT product_publication_report_ack_tuple_unique
 UNIQUE(operation_id,tenant_id,brand_id,product_id,product_version_id,report_digest);

CREATE TABLE rms_catalog.product_publication_warning_acknowledgement (
 operation_id platform_helpers.uuid_v7 PRIMARY KEY,
 tenant_id platform_helpers.uuid_v7 NOT NULL,
 brand_id platform_helpers.uuid_v7 NOT NULL,
 product_id platform_helpers.uuid_v7 NOT NULL,
 product_version_id platform_helpers.uuid_v7 NOT NULL,
 actor_id platform_helpers.uuid_v7 NOT NULL,
 acknowledgement_sequence integer NOT NULL CHECK(acknowledgement_sequence>0),
 expected_product_aggregate_version integer NOT NULL CHECK(expected_product_aggregate_version>0),
 report_operation_id platform_helpers.uuid_v7 NOT NULL CHECK(report_operation_id<>operation_id),
 report_digest text NOT NULL CHECK(report_digest ~ '^sha256:[0-9a-f]{64}$'),
 warning_binding_digest text NOT NULL CHECK(warning_binding_digest ~ '^sha256:[0-9a-f]{64}$'),
 intent_digest text NOT NULL CHECK(intent_digest ~ '^sha256:[0-9a-f]{64}$'),
 receipt_digest text NOT NULL CHECK(receipt_digest ~ '^sha256:[0-9a-f]{64}$'),
 occurred_at timestamptz NOT NULL CHECK(date_trunc('milliseconds',occurred_at)=occurred_at),
 recorded_at timestamptz NOT NULL CHECK(date_trunc('milliseconds',recorded_at)=recorded_at AND recorded_at>=occurred_at),
 receipt_json jsonb NOT NULL CHECK(jsonb_typeof(receipt_json)='object' AND octet_length(receipt_json::text)<=2097152),
 event_id platform_helpers.uuid_v7 NOT NULL UNIQUE,
 audit_id platform_helpers.uuid_v7 NOT NULL UNIQUE,
 data_classification text NOT NULL DEFAULT 'ConfigurationMetadata' CHECK(data_classification='ConfigurationMetadata'),
 UNIQUE(tenant_id,brand_id,product_id,product_version_id,actor_id,acknowledgement_sequence),
 FOREIGN KEY(report_operation_id,tenant_id,brand_id,product_id,product_version_id,report_digest)
 REFERENCES rms_catalog.product_publication_validation_report(operation_id,tenant_id,brand_id,product_id,product_version_id,report_digest),
 CHECK((receipt_json ?& ARRAY['profile','command','originalIntentDigest','observation','recordedAt','digest']
  AND receipt_json-ARRAY['profile','command','originalIntentDigest','observation','recordedAt','digest']='{}'::jsonb) IS TRUE),
 CHECK((receipt_json->>'profile') IS NOT DISTINCT FROM 'CatalogProductPublicationWarningAcknowledgementReceiptV1'),
 CHECK((receipt_json->>'originalIntentDigest') IS NOT DISTINCT FROM intent_digest),
 CHECK((receipt_json->>'digest') IS NOT DISTINCT FROM receipt_digest),
 CHECK((receipt_json->>'recordedAt') IS NOT DISTINCT FROM to_char(recorded_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')),
 CHECK(((receipt_json->'command') ?& ARRAY['profile','purposeCode','action','tenantReference','brandReference','actorReference','actorKind','operationReference','productReference','versionReference','expectedProductAggregateVersion','reportOperationReference','reportDigest','warningBindingDigest','warningCodes','reasonCode','occurredAt']
  AND (receipt_json->'command')-ARRAY['profile','purposeCode','action','tenantReference','brandReference','actorReference','actorKind','operationReference','productReference','versionReference','expectedProductAggregateVersion','reportOperationReference','reportDigest','warningBindingDigest','warningCodes','reasonCode','occurredAt']='{}'::jsonb) IS TRUE),
 CHECK((receipt_json#>>'{command,profile}') IS NOT DISTINCT FROM 'CatalogProductPublicationWarningAcknowledgementCommandV1'),
 CHECK((receipt_json#>>'{command,purposeCode}') IS NOT DISTINCT FROM 'CATALOG_PRODUCT_PUBLICATION_WARNING_ACKNOWLEDGEMENT'),
 CHECK((receipt_json#>>'{command,action}') IS NOT DISTINCT FROM 'AcknowledgeProductPublicationWarnings'),
 CHECK((receipt_json#>>'{command,actorKind}') IS NOT DISTINCT FROM 'User'),
 CHECK((receipt_json#>>'{command,tenantReference}') IS NOT DISTINCT FROM tenant_id::text),
 CHECK((receipt_json#>>'{command,brandReference}') IS NOT DISTINCT FROM brand_id::text),
 CHECK((receipt_json#>>'{command,actorReference}') IS NOT DISTINCT FROM actor_id::text),
 CHECK((receipt_json#>>'{command,productReference}') IS NOT DISTINCT FROM product_id::text),
 CHECK((receipt_json#>>'{command,versionReference}') IS NOT DISTINCT FROM product_version_id::text),
 CHECK((receipt_json#>>'{command,operationReference}') IS NOT DISTINCT FROM operation_id::text),
 CHECK((receipt_json#>'{command,expectedProductAggregateVersion}') IS NOT DISTINCT FROM to_jsonb(expected_product_aggregate_version)),
 CHECK((receipt_json#>>'{command,reportOperationReference}') IS NOT DISTINCT FROM report_operation_id::text),
 CHECK((receipt_json#>>'{command,reportDigest}') IS NOT DISTINCT FROM report_digest),
 CHECK((receipt_json#>>'{command,warningBindingDigest}') IS NOT DISTINCT FROM warning_binding_digest),
 CHECK((receipt_json#>>'{command,reasonCode}' ~ '^[A-Z][A-Z0-9_-]{0,63}$') IS TRUE),
 CHECK((receipt_json#>>'{command,occurredAt}') IS NOT DISTINCT FROM to_char(occurred_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')),
 CHECK(((receipt_json->'observation') ?& ARRAY['profile','acknowledgementOperationReference','acknowledgementIntentDigest','actorReference','binding','productAggregateVersion','validation','details','policy','warningBindingDigest','observedAt','validUntil','digest']
  AND (receipt_json->'observation')-ARRAY['profile','acknowledgementOperationReference','acknowledgementIntentDigest','actorReference','binding','productAggregateVersion','validation','details','policy','warningBindingDigest','observedAt','validUntil','digest']='{}'::jsonb) IS TRUE),
 CHECK((receipt_json#>>'{observation,profile}') IS NOT DISTINCT FROM 'CatalogProductPublicationWarningAcknowledgementObservationV1'),
 CHECK((receipt_json#>>'{observation,acknowledgementOperationReference}') IS NOT DISTINCT FROM operation_id::text),
 CHECK((receipt_json#>>'{observation,acknowledgementIntentDigest}') IS NOT DISTINCT FROM intent_digest),
 CHECK((receipt_json#>>'{observation,actorReference}') IS NOT DISTINCT FROM actor_id::text),
 CHECK((receipt_json#>'{observation,productAggregateVersion}') IS NOT DISTINCT FROM to_jsonb(expected_product_aggregate_version)),
 CHECK((receipt_json#>>'{observation,warningBindingDigest}') IS NOT DISTINCT FROM warning_binding_digest),
 CHECK((receipt_json#>>'{observation,digest}' ~ '^sha256:[0-9a-f]{64}$') IS TRUE),
 CHECK(((receipt_json#>'{observation,binding}') ?& ARRAY['tenantReference','brandReference','productReference','versionReference','contentDigest','configurationDigest','scopeDigest','periodDigest','replacementIntentDigest','policyReference','policyVersion']
  AND (receipt_json#>'{observation,binding}')-ARRAY['tenantReference','brandReference','productReference','versionReference','contentDigest','configurationDigest','scopeDigest','periodDigest','replacementIntentDigest','policyReference','policyVersion']='{}'::jsonb) IS TRUE),
 CHECK(((receipt_json#>'{observation,validation}') ?& ARRAY['profile','replacementIntentDigest','evidenceReference','productAggregateVersion','contentDigest','configurationDigest','scopeDigest','periodDigest','policyReference','policyVersion','approvalPolicy','checks','warningAcknowledgement','checkedAt','validUntil']
  AND (receipt_json#>'{observation,validation}')-ARRAY['profile','replacementIntentDigest','evidenceReference','productAggregateVersion','contentDigest','configurationDigest','scopeDigest','periodDigest','policyReference','policyVersion','approvalPolicy','checks','warningAcknowledgement','checkedAt','validUntil']='{}'::jsonb) IS TRUE),
 CHECK((receipt_json#>>'{observation,validation,profile}') IS NOT DISTINCT FROM 'CatalogProductPublicationValidationV2'),
 CHECK((receipt_json#>'{observation,validation,productAggregateVersion}') IS NOT DISTINCT FROM to_jsonb(expected_product_aggregate_version)),
 CHECK(((receipt_json#>'{observation,details}') ?& ARRAY['coverage','impact','findings','sources']
  AND (receipt_json#>'{observation,details}')-ARRAY['coverage','impact','findings','sources']='{}'::jsonb
  AND receipt_json#>>'{observation,details,coverage}'='Complete' AND receipt_json#>>'{observation,details,impact}'='Recorded'
  AND jsonb_typeof(receipt_json#>'{observation,details,findings}')='array' AND jsonb_array_length(receipt_json#>'{observation,details,findings}')<=1000
  AND jsonb_typeof(receipt_json#>'{observation,details,sources}')='array' AND jsonb_array_length(receipt_json#>'{observation,details,sources}') BETWEEN 1 AND 100) IS TRUE),
 CHECK(((receipt_json#>'{observation,policy}') ?& ARRAY['profile','tenantReference','brandReference','familyReference','policyReference','policyVersion','scopeOrder','approvalPolicy','warningOverrideAllowed','requiredLocales','mediaRequirement','effectiveFrom','effectiveUntil']
  AND (receipt_json#>'{observation,policy}')-ARRAY['profile','tenantReference','brandReference','familyReference','policyReference','policyVersion','scopeOrder','approvalPolicy','warningOverrideAllowed','requiredLocales','mediaRequirement','effectiveFrom','effectiveUntil']='{}'::jsonb) IS TRUE),
 CHECK((receipt_json#>>'{observation,policy,profile}') IS NOT DISTINCT FROM 'PublishingProductPublicationPolicyV1'),
 CHECK((receipt_json#>>'{observation,policy,tenantReference}') IS NOT DISTINCT FROM tenant_id::text),
 CHECK((receipt_json#>>'{observation,policy,brandReference}') IS NOT DISTINCT FROM brand_id::text),
 CHECK((receipt_json#>'{observation,policy,warningOverrideAllowed}') IS NOT DISTINCT FROM 'true'::jsonb)
);

CREATE FUNCTION rms_catalog.product_publication_warning_acknowledgement_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
 report rms_catalog.product_publication_validation_report;
 current_root integer;
 previous_sequence integer;
 observation jsonb := NEW.receipt_json->'observation';
 validation jsonb := observation->'validation';
 policy jsonb := observation->'policy';
 check_record jsonb;
 source_record jsonb;
 key text;
 check_codes text[];
 warning_codes jsonb;
 report_warning_codes jsonb;
 acknowledgement jsonb;
 source_codes text[];
 source_references jsonb;
 report_source_references jsonb;
 observed_at timestamptz;
 valid_until timestamptz;
 validation_until timestamptz;
BEGIN
 -- Same lock order as the owning writer, including direct INSERT attempts.
 PERFORM pg_advisory_xact_lock(hashtextextended('CatalogProductSource:'||NEW.brand_id::text,0));
 SELECT aggregate_version INTO current_root FROM rms_catalog.product
  WHERE product_id=NEW.product_id AND brand_id=NEW.brand_id FOR UPDATE;
 IF current_root IS DISTINCT FROM NEW.expected_product_aggregate_version
 THEN RAISE EXCEPTION 'PRODUCT_WARNING_ACK_ROOT_CONFLICT' USING ERRCODE='23514'; END IF;
 SELECT max(acknowledgement_sequence) INTO previous_sequence FROM rms_catalog.product_publication_warning_acknowledgement
  WHERE tenant_id=NEW.tenant_id AND brand_id=NEW.brand_id AND product_id=NEW.product_id
   AND product_version_id=NEW.product_version_id AND actor_id=NEW.actor_id;
 IF NEW.acknowledgement_sequence::bigint IS DISTINCT FROM coalesce(previous_sequence::bigint,0)+1
 THEN RAISE EXCEPTION 'PRODUCT_WARNING_ACK_SEQUENCE_CONFLICT' USING ERRCODE='23514'; END IF;
 SELECT * INTO report FROM rms_catalog.product_publication_validation_report
  WHERE operation_id=NEW.report_operation_id AND tenant_id=NEW.tenant_id AND brand_id=NEW.brand_id
   AND product_id=NEW.product_id AND product_version_id=NEW.product_version_id AND report_digest=NEW.report_digest;
 IF report.operation_id IS NULL OR report.recorded_at>NEW.occurred_at OR report.result_aggregate_version>NEW.expected_product_aggregate_version
  OR (report.snapshot_json#>>'{details,coverage}') IS DISTINCT FROM 'Complete'
  OR (report.snapshot_json#>>'{details,impact}') IS DISTINCT FROM 'Recorded'
  OR (report.snapshot_json->>'warningBindingDigest') IS DISTINCT FROM NEW.warning_binding_digest
  OR (report.snapshot_json->'binding') IS DISTINCT FROM observation->'binding'
  OR (report.snapshot_json#>'{details,findings}') IS DISTINCT FROM observation#>'{details,findings}'
 THEN RAISE EXCEPTION 'PRODUCT_WARNING_ACK_REPORT_CONFLICT' USING ERRCODE='23514'; END IF;
 -- The displayed report's historical deadline is deliberately not renewed or
 -- compared with this new write. Only the new observation must still be held.
 IF (observation->>'observedAt' ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{3}Z$'
  AND observation->>'validUntil' ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{3}Z$'
  AND validation->>'checkedAt' ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{3}Z$'
  AND validation->>'validUntil' ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{3}Z$'
  AND policy->>'effectiveFrom' ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{3}Z$'
  AND (policy->'effectiveUntil'='null'::jsonb OR policy->>'effectiveUntil' ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{3}Z$')) IS NOT TRUE
 THEN RAISE EXCEPTION 'PRODUCT_WARNING_ACK_TIME_CONFLICT' USING ERRCODE='23514'; END IF;
 observed_at := (observation->>'observedAt')::timestamptz;
 valid_until := (observation->>'validUntil')::timestamptz;
 validation_until := (validation->>'validUntil')::timestamptz;
 IF NEW.occurred_at>observed_at OR NEW.recorded_at<observed_at OR NEW.recorded_at>=valid_until
  OR valid_until<=observed_at OR valid_until>observed_at+interval '5 seconds'
  OR (validation->>'checkedAt')::timestamptz>observed_at OR validation_until<valid_until
  OR (policy->>'effectiveFrom')::timestamptz>observed_at
  OR (policy->'effectiveUntil'<>'null'::jsonb AND (policy->>'effectiveUntil')::timestamptz<valid_until)
 THEN RAISE EXCEPTION 'PRODUCT_WARNING_ACK_TIME_CONFLICT' USING ERRCODE='23514'; END IF;
 FOREACH key IN ARRAY ARRAY['contentDigest','configurationDigest','scopeDigest','periodDigest','replacementIntentDigest','policyReference','policyVersion'] LOOP
  IF validation->key IS DISTINCT FROM observation->'binding'->key
  THEN RAISE EXCEPTION 'PRODUCT_WARNING_ACK_VALIDATION_CONFLICT' USING ERRCODE='23514'; END IF;
 END LOOP;
 IF policy->'policyReference' IS DISTINCT FROM observation#>'{binding,policyReference}'
  OR policy->'policyVersion' IS DISTINCT FROM observation#>'{binding,policyVersion}'
  OR policy->'approvalPolicy' IS DISTINCT FROM validation->'approvalPolicy'
  OR (validation->>'approvalPolicy' IN ('Required','NotRequired')) IS NOT TRUE
  OR (validation->>'evidenceReference' ~ '^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$') IS NOT TRUE
  OR (jsonb_typeof(validation->'checks')='array' AND jsonb_array_length(validation->'checks')=12) IS NOT TRUE
 THEN RAISE EXCEPTION 'PRODUCT_WARNING_ACK_VALIDATION_CONFLICT' USING ERRCODE='23514'; END IF;
 FOR check_record IN SELECT value FROM jsonb_array_elements(validation->'checks') LOOP
  IF (check_record ?& ARRAY['code','outcome'] AND check_record-ARRAY['code','outcome']='{}'::jsonb
    AND check_record->>'outcome' IN ('Pass','Warning','Pending')) IS NOT TRUE
   OR (check_record->>'outcome'='Pending' AND (check_record->>'code'<>'ApprovalPolicy' OR validation->>'approvalPolicy'<>'Required'))
  THEN RAISE EXCEPTION 'PRODUCT_WARNING_ACK_VALIDATION_CONFLICT' USING ERRCODE='23514'; END IF;
 END LOOP;
 SELECT array_agg(value->>'code' ORDER BY value->>'code' COLLATE "C") INTO check_codes FROM jsonb_array_elements(validation->'checks');
 IF check_codes IS DISTINCT FROM ARRAY['ApprovalPolicy','ChangeImpact','DefaultLocaleName','EffectivePeriod','HardErrorsCleared','InternalCode','MediaReady','OptionSelection','PublishableSku','TaxResolution','UniqueScope','VariantMapping']
  OR (SELECT value->>'outcome' FROM jsonb_array_elements(validation->'checks') WHERE value->>'code'='HardErrorsCleared') IS DISTINCT FROM 'Pass'
  OR jsonb_path_exists(report.snapshot_json,'$.validation.checks[*] ? (@.outcome == "HardError")')
 THEN RAISE EXCEPTION 'PRODUCT_WARNING_ACK_VALIDATION_CONFLICT' USING ERRCODE='23514'; END IF;
 SELECT coalesce(jsonb_agg(value->>'code' ORDER BY value->>'code' COLLATE "C"),'[]'::jsonb) INTO warning_codes FROM jsonb_array_elements(validation->'checks') WHERE value->>'outcome'='Warning';
 SELECT coalesce(jsonb_agg(value->>'code' ORDER BY value->>'code' COLLATE "C"),'[]'::jsonb) INTO report_warning_codes FROM jsonb_array_elements(report.snapshot_json#>'{validation,checks}') WHERE value->>'outcome'='Warning';
 IF jsonb_array_length(warning_codes)=0 OR warning_codes IS DISTINCT FROM report_warning_codes
  OR warning_codes IS DISTINCT FROM NEW.receipt_json#>'{command,warningCodes}'
 THEN RAISE EXCEPTION 'PRODUCT_WARNING_ACK_VALIDATION_CONFLICT' USING ERRCODE='23514'; END IF;
 acknowledgement := validation->'warningAcknowledgement';
 IF acknowledgement IS DISTINCT FROM 'null'::jsonb AND
  (acknowledgement ?& ARRAY['actorReference','reasonCode','warningCodes']
   AND acknowledgement-ARRAY['actorReference','reasonCode','warningCodes']='{}'::jsonb
   AND acknowledgement->>'actorReference' ~ '^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
   AND acknowledgement->>'reasonCode' ~ '^[A-Z][A-Z0-9_-]{0,63}$'
   AND acknowledgement->'warningCodes'=warning_codes) IS NOT TRUE
 THEN RAISE EXCEPTION 'PRODUCT_WARNING_ACK_VALIDATION_CONFLICT' USING ERRCODE='23514'; END IF;
 FOR source_record IN SELECT value FROM jsonb_array_elements(observation#>'{details,sources}') LOOP
  IF (source_record ?& ARRAY['sourceCode','sourceDigest','generation','relevantReferenceDigest','observedAt','validUntil']
    AND source_record-ARRAY['sourceCode','sourceDigest','generation','relevantReferenceDigest','observedAt','validUntil']='{}'::jsonb
    AND source_record->>'sourceCode' ~ '^[A-Z][A-Z0-9_-]{0,63}$'
    AND source_record->>'sourceDigest' ~ '^sha256:[0-9a-f]{64}$'
    AND source_record->>'relevantReferenceDigest' ~ '^sha256:[0-9a-f]{64}$'
    AND (source_record->'generation'='null'::jsonb OR (jsonb_typeof(source_record->'generation')='string' AND source_record->>'generation' ~ '^(0|[1-9][0-9]{0,18})$'))
    AND source_record->>'observedAt' ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{3}Z$'
    AND source_record->>'validUntil' ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{3}Z$') IS NOT TRUE
  THEN RAISE EXCEPTION 'PRODUCT_WARNING_ACK_SOURCE_CONFLICT' USING ERRCODE='23514'; END IF;
  IF (source_record->'generation'<>'null'::jsonb AND (source_record->>'generation')::numeric>9223372036854775807)
   OR (source_record->>'observedAt')::timestamptz>observed_at
   OR (source_record->>'validUntil')::timestamptz<validation_until
   OR (source_record->>'validUntil')::timestamptz<=(source_record->>'observedAt')::timestamptz
   OR (source_record->>'validUntil')::timestamptz>(source_record->>'observedAt')::timestamptz+interval '5 seconds'
  THEN RAISE EXCEPTION 'PRODUCT_WARNING_ACK_SOURCE_CONFLICT' USING ERRCODE='23514'; END IF;
 END LOOP;
 SELECT array_agg(value->>'sourceCode'),jsonb_agg(jsonb_build_object('sourceCode',value->>'sourceCode','relevantReferenceDigest',value->>'relevantReferenceDigest') ORDER BY value->>'sourceCode' COLLATE "C")
  INTO source_codes,source_references FROM jsonb_array_elements(observation#>'{details,sources}');
 SELECT jsonb_agg(jsonb_build_object('sourceCode',value->>'sourceCode','relevantReferenceDigest',value->>'relevantReferenceDigest') ORDER BY value->>'sourceCode' COLLATE "C")
  INTO report_source_references FROM jsonb_array_elements(report.snapshot_json#>'{details,sources}');
 IF cardinality(source_codes)<>(SELECT count(DISTINCT value) FROM unnest(source_codes) AS value)
  OR source_references IS DISTINCT FROM report_source_references
 THEN RAISE EXCEPTION 'PRODUCT_WARNING_ACK_SOURCE_CONFLICT' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END;
$$;
CREATE TRIGGER product_publication_warning_acknowledgement_coherent BEFORE INSERT ON rms_catalog.product_publication_warning_acknowledgement
 FOR EACH ROW EXECUTE FUNCTION rms_catalog.product_publication_warning_acknowledgement_guard();
CREATE TRIGGER product_publication_warning_acknowledgement_immutable BEFORE UPDATE OR DELETE ON rms_catalog.product_publication_warning_acknowledgement
 FOR EACH ROW EXECUTE FUNCTION rms_catalog.product_publication_immutable();
CREATE TRIGGER product_publication_warning_acknowledgement_no_truncate BEFORE TRUNCATE ON rms_catalog.product_publication_warning_acknowledgement
 FOR EACH STATEMENT EXECUTE FUNCTION rms_catalog.product_publication_immutable();
ALTER TABLE rms_catalog.product_publication_warning_acknowledgement ENABLE ROW LEVEL SECURITY;
ALTER TABLE rms_catalog.product_publication_warning_acknowledgement FORCE ROW LEVEL SECURITY;
CREATE POLICY product_publication_warning_acknowledgement_scope ON rms_catalog.product_publication_warning_acknowledgement
 USING (tenant_id::text=current_setting('bop.tenant_id',true) AND brand_id=platform_helpers.current_brand_id() AND platform_helpers.current_store_id() IS NULL)
 WITH CHECK (tenant_id::text=current_setting('bop.tenant_id',true) AND brand_id=platform_helpers.current_brand_id() AND platform_helpers.current_store_id() IS NULL);
REVOKE ALL ON TABLE rms_catalog.product_publication_warning_acknowledgement FROM PUBLIC;
REVOKE ALL ON FUNCTION rms_catalog.product_publication_warning_acknowledgement_guard() FROM PUBLIC;
