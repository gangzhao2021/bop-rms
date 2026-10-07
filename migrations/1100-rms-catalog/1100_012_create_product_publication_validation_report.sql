-- bop-rms-migration: 1
-- owner: @rms/catalog
-- schema: rms_catalog
-- phase: expand
-- risk: medium
-- transaction: required
-- lock-timeout-ms: 5000
-- statement-timeout-ms: 60000
-- recovery: forward-fix
-- This database-only marker preserves every historical publication JSON/hash.
-- A historical absence is known; a missing report for a new V2 row is corruption.
ALTER TABLE rms_catalog.product_publication_revision
 ADD COLUMN validation_report_required boolean NOT NULL DEFAULT false;

CREATE TABLE rms_catalog.product_publication_validation_report (
 operation_id platform_helpers.uuid_v7 PRIMARY KEY,
 tenant_id platform_helpers.uuid_v7 NOT NULL,
 brand_id platform_helpers.uuid_v7 NOT NULL,
 product_id platform_helpers.uuid_v7 NOT NULL,
 product_version_id platform_helpers.uuid_v7 NOT NULL,
 publication_version integer NOT NULL CHECK(publication_version>0),
 source_aggregate_version integer NOT NULL CHECK(source_aggregate_version>0 AND source_aggregate_version<2147483647),
 result_aggregate_version integer NOT NULL CHECK(result_aggregate_version=source_aggregate_version+1),
 action_code text NOT NULL CHECK(action_code IN ('Validate','SubmitReview','Approve','Reject','Publish','SchedulePublish','ReschedulePublish','CancelScheduledPublish','ActivateScheduled')),
 publication_intent_digest text NOT NULL CHECK(publication_intent_digest ~ '^sha256:[0-9a-f]{64}$'),
 publication_snapshot_digest text NOT NULL CHECK(publication_snapshot_digest ~ '^sha256:[0-9a-f]{64}$'),
 validation_evidence_id platform_helpers.uuid_v7 NOT NULL,
 report_digest text NOT NULL CHECK(report_digest ~ '^sha256:[0-9a-f]{64}$'),
 recorded_at timestamptz NOT NULL CHECK(date_trunc('milliseconds',recorded_at)=recorded_at),
 snapshot_json jsonb NOT NULL CHECK(jsonb_typeof(snapshot_json)='object' AND octet_length(snapshot_json::text)<=1048576),
 data_classification text NOT NULL DEFAULT 'ConfigurationMetadata' CHECK(data_classification='ConfigurationMetadata'),
 FOREIGN KEY(operation_id,tenant_id,brand_id,product_id,product_version_id,publication_version,source_aggregate_version,result_aggregate_version,publication_intent_digest,action_code)
 REFERENCES rms_catalog.product_publication_revision(operation_id,tenant_id,brand_id,product_id,product_version_id,publication_version,source_aggregate_version,result_aggregate_version,intent_digest,action_code),
 CHECK(snapshot_json ?& ARRAY['profile','operationReference','publicationAction','originalIntentDigest','publicationSnapshotDigest','sourceAggregateVersion','resultAggregateVersion','publicationVersion','validationEvidenceReference','recordedAt','binding','validation','details','warningBindingDigest','digest']
  AND snapshot_json-ARRAY['profile','operationReference','publicationAction','originalIntentDigest','publicationSnapshotDigest','sourceAggregateVersion','resultAggregateVersion','publicationVersion','validationEvidenceReference','recordedAt','binding','validation','details','warningBindingDigest','digest']='{}'::jsonb),
 CHECK((snapshot_json->>'profile') IS NOT DISTINCT FROM 'CatalogProductPublicationValidationReportV1'),
 CHECK((snapshot_json->>'operationReference') IS NOT DISTINCT FROM operation_id::text),
 CHECK((snapshot_json->>'publicationAction') IS NOT DISTINCT FROM action_code),
 CHECK((snapshot_json->>'originalIntentDigest') IS NOT DISTINCT FROM publication_intent_digest),
 CHECK((snapshot_json->>'publicationSnapshotDigest') IS NOT DISTINCT FROM publication_snapshot_digest),
 CHECK((snapshot_json->'sourceAggregateVersion') IS NOT DISTINCT FROM to_jsonb(source_aggregate_version)),
 CHECK((snapshot_json->'resultAggregateVersion') IS NOT DISTINCT FROM to_jsonb(result_aggregate_version)),
 CHECK((snapshot_json->'publicationVersion') IS NOT DISTINCT FROM to_jsonb(publication_version)),
 CHECK((snapshot_json->>'validationEvidenceReference') IS NOT DISTINCT FROM validation_evidence_id::text),
 CHECK((snapshot_json->>'recordedAt') IS NOT DISTINCT FROM to_char(recorded_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')),
 CHECK((snapshot_json->>'digest') IS NOT DISTINCT FROM report_digest),
 CHECK((snapshot_json#>>'{binding,tenantReference}') IS NOT DISTINCT FROM tenant_id::text),
 CHECK((snapshot_json#>>'{binding,brandReference}') IS NOT DISTINCT FROM brand_id::text),
 CHECK((snapshot_json#>>'{binding,productReference}') IS NOT DISTINCT FROM product_id::text),
 CHECK((snapshot_json#>>'{binding,versionReference}') IS NOT DISTINCT FROM product_version_id::text),
 CHECK(((snapshot_json->'binding') ?& ARRAY['tenantReference','brandReference','productReference','versionReference','contentDigest','configurationDigest','scopeDigest','periodDigest','replacementIntentDigest','policyReference','policyVersion']
  AND (snapshot_json->'binding')-ARRAY['tenantReference','brandReference','productReference','versionReference','contentDigest','configurationDigest','scopeDigest','periodDigest','replacementIntentDigest','policyReference','policyVersion']='{}'::jsonb) IS TRUE),
 CHECK(((snapshot_json->'validation') ?& ARRAY['profile','replacementIntentDigest','evidenceReference','productAggregateVersion','contentDigest','configurationDigest','scopeDigest','periodDigest','policyReference','policyVersion','approvalPolicy','checks','warningAcknowledgement','checkedAt','validUntil']
  AND (snapshot_json->'validation')-ARRAY['profile','replacementIntentDigest','evidenceReference','productAggregateVersion','contentDigest','configurationDigest','scopeDigest','periodDigest','policyReference','policyVersion','approvalPolicy','checks','warningAcknowledgement','checkedAt','validUntil']='{}'::jsonb) IS TRUE),
 CHECK(((snapshot_json#>>'{validation,checkedAt}') ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{3}Z$'
  AND (snapshot_json#>>'{validation,validUntil}') ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{3}Z$') IS TRUE),
 CHECK(((snapshot_json->'details'='{"coverage":"ChecksOnly","impact":"NotRecorded"}'::jsonb AND snapshot_json->'warningBindingDigest'='null'::jsonb)
  OR ((snapshot_json->'details') ?& ARRAY['coverage','impact','findings','sources']
    AND (snapshot_json->'details')-ARRAY['coverage','impact','findings','sources']='{}'::jsonb
    AND snapshot_json#>>'{details,coverage}'='Complete' AND snapshot_json#>>'{details,impact}'='Recorded'
    AND jsonb_typeof(snapshot_json#>'{details,findings}')='array' AND jsonb_array_length(snapshot_json#>'{details,findings}')<=1000
    AND jsonb_typeof(snapshot_json#>'{details,sources}')='array' AND jsonb_array_length(snapshot_json#>'{details,sources}') BETWEEN 1 AND 100
    AND (snapshot_json->'warningBindingDigest'='null'::jsonb OR snapshot_json->>'warningBindingDigest' ~ '^sha256:[0-9a-f]{64}$'))) IS TRUE),
 CHECK((snapshot_json#>>'{validation,profile}') IS NOT DISTINCT FROM 'CatalogProductPublicationValidationV2'),
 CHECK((snapshot_json#>>'{validation,evidenceReference}') IS NOT DISTINCT FROM validation_evidence_id::text),
 CHECK((snapshot_json#>'{validation,productAggregateVersion}') IS NOT DISTINCT FROM to_jsonb(source_aggregate_version)),
 CHECK((jsonb_typeof(snapshot_json#>'{validation,checks}')='array' AND jsonb_array_length(snapshot_json#>'{validation,checks}')=12) IS TRUE)
);

CREATE FUNCTION rms_catalog.product_publication_validation_report_marker() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 -- Never accept a caller-supplied opt-out for a new V2 publication.
 NEW.validation_report_required := (NEW.snapshot_json->>'profile') IS NOT DISTINCT FROM 'CatalogProductPublicationVersionV2';
 RETURN NEW;
END;
$$;
CREATE TRIGGER product_publication_validation_report_marker BEFORE INSERT ON rms_catalog.product_publication_revision
 FOR EACH ROW EXECUTE FUNCTION rms_catalog.product_publication_validation_report_marker();

CREATE FUNCTION rms_catalog.product_publication_validation_report_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE publication rms_catalog.product_publication_revision; report rms_catalog.product_publication_validation_report; check_record jsonb; expected_decision text; check_codes text[]; warning_codes jsonb; acknowledgement jsonb; has_hard_error boolean;
BEGIN
 SELECT * INTO publication FROM rms_catalog.product_publication_revision WHERE operation_id=NEW.operation_id;
 IF publication.operation_id IS NULL THEN RAISE EXCEPTION 'PRODUCT_PUBLICATION_REPORT_TUPLE_CONFLICT' USING ERRCODE='23514'; END IF;
 IF NOT publication.validation_report_required THEN
  -- Legacy V1 writers retain their existing ACLs: no new report-table read.
  IF TG_TABLE_NAME='product_publication_validation_report' THEN RAISE EXCEPTION 'PRODUCT_PUBLICATION_REPORT_HISTORICAL_CONFLICT' USING ERRCODE='23514'; END IF;
  RETURN NEW;
 END IF;
 SELECT * INTO report FROM rms_catalog.product_publication_validation_report WHERE operation_id=NEW.operation_id;
 IF report.operation_id IS NULL THEN RAISE EXCEPTION 'PRODUCT_PUBLICATION_REPORT_MISSING' USING ERRCODE='23514'; END IF;
 IF report.recorded_at<publication.occurred_at
  OR (publication.snapshot_json->>'profile') IS DISTINCT FROM 'CatalogProductPublicationVersionV2'
  OR report.validation_evidence_id::text IS DISTINCT FROM publication.snapshot_json->>'validationEvidenceReference'
  OR (report.snapshot_json#>>'{binding,contentDigest}') IS DISTINCT FROM publication.content_digest
  OR (report.snapshot_json#>>'{binding,configurationDigest}') IS DISTINCT FROM publication.configuration_digest
  OR (report.snapshot_json#>>'{binding,scopeDigest}') IS DISTINCT FROM publication.snapshot_json->>'scopeDigest'
  OR (report.snapshot_json#>>'{binding,periodDigest}') IS DISTINCT FROM publication.snapshot_json->>'periodDigest'
  OR (report.snapshot_json#>>'{binding,replacementIntentDigest}') IS DISTINCT FROM publication.snapshot_json->>'replacementIntentDigest'
  OR (report.snapshot_json#>>'{binding,policyReference}') IS DISTINCT FROM publication.snapshot_json->>'policyReference'
  OR (report.snapshot_json#>'{binding,policyVersion}') IS DISTINCT FROM publication.snapshot_json->'policyVersion'
  OR (report.snapshot_json#>>'{validation,approvalPolicy}') IS DISTINCT FROM publication.snapshot_json->>'approvalPolicy'
  OR (report.snapshot_json#>>'{validation,checkedAt}')::timestamptz>report.recorded_at
  OR (report.snapshot_json#>>'{validation,validUntil}')::timestamptz<=report.recorded_at
 THEN RAISE EXCEPTION 'PRODUCT_PUBLICATION_REPORT_TUPLE_CONFLICT' USING ERRCODE='23514'; END IF;
 FOREACH expected_decision IN ARRAY ARRAY['contentDigest','configurationDigest','scopeDigest','periodDigest','replacementIntentDigest','policyReference','policyVersion'] LOOP
  IF (report.snapshot_json->'validation'->expected_decision) IS DISTINCT FROM (report.snapshot_json->'binding'->expected_decision)
  THEN RAISE EXCEPTION 'PRODUCT_PUBLICATION_REPORT_VALIDATION_CONFLICT' USING ERRCODE='23514'; END IF;
 END LOOP;
 FOR check_record IN SELECT value FROM jsonb_array_elements(report.snapshot_json#>'{validation,checks}') LOOP
  IF (check_record ?& ARRAY['code','outcome'] AND check_record-ARRAY['code','outcome']='{}'::jsonb
   AND check_record->>'outcome' IN ('Pass','HardError','Warning','Pending')) IS NOT TRUE
   OR (check_record->>'outcome'='Pending' AND (check_record->>'code'<>'ApprovalPolicy' OR publication.snapshot_json->>'approvalPolicy'<>'Required'))
  THEN RAISE EXCEPTION 'PRODUCT_PUBLICATION_REPORT_VALIDATION_CONFLICT' USING ERRCODE='23514'; END IF;
 END LOOP;
 SELECT array_agg(value->>'code' ORDER BY value->>'code' COLLATE "C") INTO check_codes FROM jsonb_array_elements(report.snapshot_json#>'{validation,checks}');
 IF check_codes IS DISTINCT FROM ARRAY['ApprovalPolicy','ChangeImpact','DefaultLocaleName','EffectivePeriod','HardErrorsCleared','InternalCode','MediaReady','OptionSelection','PublishableSku','TaxResolution','UniqueScope','VariantMapping']
 THEN RAISE EXCEPTION 'PRODUCT_PUBLICATION_REPORT_VALIDATION_CONFLICT' USING ERRCODE='23514'; END IF;
 has_hard_error := jsonb_path_exists(report.snapshot_json,'$.validation.checks[*] ? (@.code != "HardErrorsCleared" && @.outcome == "HardError")');
 IF (SELECT value->>'outcome' FROM jsonb_array_elements(report.snapshot_json#>'{validation,checks}') WHERE value->>'code'='HardErrorsCleared') IS DISTINCT FROM (CASE WHEN has_hard_error THEN 'HardError' ELSE 'Pass' END)
 THEN RAISE EXCEPTION 'PRODUCT_PUBLICATION_REPORT_VALIDATION_CONFLICT' USING ERRCODE='23514'; END IF;
 SELECT coalesce(jsonb_agg(value->>'code' ORDER BY value->>'code' COLLATE "C"),'[]'::jsonb) INTO warning_codes FROM jsonb_array_elements(report.snapshot_json#>'{validation,checks}') WHERE value->>'outcome'='Warning';
 acknowledgement := report.snapshot_json#>'{validation,warningAcknowledgement}';
 IF acknowledgement<>'null'::jsonb THEN
  IF (acknowledgement ?& ARRAY['actorReference','reasonCode','warningCodes']
    AND acknowledgement-ARRAY['actorReference','reasonCode','warningCodes']='{}'::jsonb
    AND acknowledgement->>'actorReference' ~ '^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
    AND acknowledgement->>'reasonCode' ~ '^[A-Z][A-Z0-9_-]{0,63}$'
    AND acknowledgement->'warningCodes'=warning_codes AND jsonb_array_length(warning_codes)>0) IS NOT TRUE
   OR (publication.action_code NOT IN ('Reject','CancelScheduledPublish') AND acknowledgement->>'actorReference' IS DISTINCT FROM CASE WHEN publication.snapshot_json->>'actorKind'='User' THEN publication.snapshot_json->>'actorReference' ELSE publication.snapshot_json->>'submittedByActorReference' END)
  THEN RAISE EXCEPTION 'PRODUCT_PUBLICATION_REPORT_VALIDATION_CONFLICT' USING ERRCODE='23514'; END IF;
 END IF;
 expected_decision := CASE
  WHEN jsonb_path_exists(report.snapshot_json,'$.validation.checks[*] ? (@.outcome == "HardError")') THEN 'HardError'
  WHEN jsonb_path_exists(report.snapshot_json,'$.validation.checks[*] ? (@.outcome == "Warning")') AND report.snapshot_json#>'{validation,warningAcknowledgement}'='null'::jsonb THEN 'WarningAcknowledgementRequired'
  WHEN jsonb_path_exists(report.snapshot_json,'$.validation.checks[*] ? (@.outcome == "Pending")') THEN 'ApprovalPending'
  ELSE 'Pass' END;
 IF (publication.snapshot_json->>'validationDecision') IS DISTINCT FROM expected_decision
 THEN RAISE EXCEPTION 'PRODUCT_PUBLICATION_REPORT_DECISION_CONFLICT' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END;
$$;
CREATE CONSTRAINT TRIGGER product_publication_validation_report_required AFTER INSERT ON rms_catalog.product_publication_revision
 DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION rms_catalog.product_publication_validation_report_guard();
CREATE CONSTRAINT TRIGGER product_publication_validation_report_coherent AFTER INSERT ON rms_catalog.product_publication_validation_report
 DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION rms_catalog.product_publication_validation_report_guard();
CREATE TRIGGER product_publication_validation_report_immutable BEFORE UPDATE OR DELETE ON rms_catalog.product_publication_validation_report
 FOR EACH ROW EXECUTE FUNCTION rms_catalog.product_publication_immutable();
CREATE TRIGGER product_publication_validation_report_no_truncate BEFORE TRUNCATE ON rms_catalog.product_publication_validation_report
 FOR EACH STATEMENT EXECUTE FUNCTION rms_catalog.product_publication_immutable();
ALTER TABLE rms_catalog.product_publication_validation_report ENABLE ROW LEVEL SECURITY;
ALTER TABLE rms_catalog.product_publication_validation_report FORCE ROW LEVEL SECURITY;
CREATE POLICY product_publication_validation_report_scope ON rms_catalog.product_publication_validation_report
 USING (tenant_id::text=current_setting('bop.tenant_id',true) AND brand_id=platform_helpers.current_brand_id() AND platform_helpers.current_store_id() IS NULL)
 WITH CHECK (tenant_id::text=current_setting('bop.tenant_id',true) AND brand_id=platform_helpers.current_brand_id() AND platform_helpers.current_store_id() IS NULL);
REVOKE ALL ON TABLE rms_catalog.product_publication_validation_report FROM PUBLIC;
REVOKE ALL ON FUNCTION rms_catalog.product_publication_validation_report_marker() FROM PUBLIC;
REVOKE ALL ON FUNCTION rms_catalog.product_publication_validation_report_guard() FROM PUBLIC;
