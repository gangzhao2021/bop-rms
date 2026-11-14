-- bop-rms-migration: 1
-- owner: @rms/catalog
-- schema: rms_catalog
-- phase: expand
-- risk: medium
-- transaction: required
-- lock-timeout-ms: 5000
-- statement-timeout-ms: 60000
-- recovery: forward-fix
-- New V2 operations only. Historical V1 absence is not empty retirement coverage.
ALTER TABLE rms_catalog.product_publication_revision ADD CONSTRAINT product_publication_retirement_identity_unique
 UNIQUE(operation_id,tenant_id,brand_id,product_id,product_version_id,publication_version,intent_digest,state);
ALTER TABLE rms_catalog.product_publication_revision ADD CONSTRAINT product_publication_retirement_header_unique
 UNIQUE(operation_id,tenant_id,brand_id,product_id,product_version_id,publication_version,source_aggregate_version,result_aggregate_version,intent_digest,action_code);
ALTER TABLE rms_catalog.product_publication_revision ADD CONSTRAINT product_publication_profile_check CHECK((
 (NOT(snapshot_json ? 'profile') AND NOT(snapshot_json ?| ARRAY['replacementIntent','replacementIntentDigest'])) OR
 ((snapshot_json->>'profile')='CatalogProductPublicationVersionV2'
  AND jsonb_typeof(snapshot_json->'replacementIntent')='object'
  AND (snapshot_json->>'replacementIntentDigest') ~ '^sha256:[0-9a-f]{64}$'
  AND (snapshot_json#>>'{replacementIntent,digest}')=(snapshot_json->>'replacementIntentDigest')
  AND (
   ((snapshot_json#>>'{replacementIntent,profile}')='CatalogProductNoReplacementIntentV1'
    AND (snapshot_json#>>'{replacementIntent,mode}')='None'
    AND (snapshot_json->'replacementIntent') ?& ARRAY['profile','mode','digest']
    AND (snapshot_json->'replacementIntent')-ARRAY['profile','mode','digest']='{}'::jsonb)
   OR ((snapshot_json#>>'{replacementIntent,profile}')='CatalogProductExactStoreSelectorReplacementV1'
    AND (snapshot_json#>>'{replacementIntent,mode}')='PermanentSelectorRetirement'
    AND (snapshot_json->'replacementIntent') ?& ARRAY['profile','mode','previousVersionReference','previousPublicationOperationReference','expectedPreviousPublicationVersion','previousIntentDigest','previousScopeDigest','previousPeriodDigest','previousSelectorIndex','previousSelectorDigest','digest']
    AND (snapshot_json->'replacementIntent')-ARRAY['profile','mode','previousVersionReference','previousPublicationOperationReference','expectedPreviousPublicationVersion','previousIntentDigest','previousScopeDigest','previousPeriodDigest','previousSelectorIndex','previousSelectorDigest','digest']='{}'::jsonb)
  )
  AND action_code<>'Supersede' AND state<>'Superseded')
) IS TRUE);

CREATE TABLE rms_catalog.product_scope_retirement_header (
 operation_id platform_helpers.uuid_v7 PRIMARY KEY,
 tenant_id platform_helpers.uuid_v7 NOT NULL,
 brand_id platform_helpers.uuid_v7 NOT NULL,
 product_id platform_helpers.uuid_v7 NOT NULL,
 product_version_id platform_helpers.uuid_v7 NOT NULL,
 publication_version integer NOT NULL CHECK(publication_version>0),
 action_code text NOT NULL CHECK(action_code IN ('Validate','SubmitReview','Approve','Reject','Publish','SchedulePublish','ReschedulePublish','CancelScheduledPublish','ActivateScheduled')),
 source_aggregate_version integer NOT NULL CHECK(source_aggregate_version>0 AND source_aggregate_version<2147483647),
 result_aggregate_version integer NOT NULL CHECK(result_aggregate_version=source_aggregate_version+1),
 publication_intent_digest text NOT NULL CHECK(publication_intent_digest ~ '^sha256:[0-9a-f]{64}$'),
 publication_snapshot_digest text NOT NULL CHECK(publication_snapshot_digest ~ '^sha256:[0-9a-f]{64}$'),
 observed_source_revision bigint NOT NULL CHECK(observed_source_revision>0 AND observed_source_revision<9223372036854775807),
 observed_source_head_digest text NOT NULL CHECK(observed_source_head_digest ~ '^sha256:[0-9a-f]{64}$'),
 recorded_at timestamptz NOT NULL CHECK(date_trunc('milliseconds',recorded_at)=recorded_at),
 -- The deferred guard derives the exact 0/1 count from the owning revision's
 -- closed intent; a None publication still needs an explicit empty header.
 retirement_count smallint NOT NULL CHECK(retirement_count IN (0,1) AND (action_code IN ('Publish','ActivateScheduled') OR retirement_count=0)),
 header_digest text NOT NULL CHECK(header_digest ~ '^sha256:[0-9a-f]{64}$'),
 snapshot_json jsonb NOT NULL CHECK(jsonb_typeof(snapshot_json)='object' AND octet_length(snapshot_json::text)<=65536),
 data_classification text NOT NULL DEFAULT 'ConfigurationMetadata' CHECK(data_classification='ConfigurationMetadata'),
 UNIQUE(operation_id,tenant_id,brand_id,product_id,product_version_id,publication_version,publication_intent_digest,recorded_at),
 FOREIGN KEY(operation_id,tenant_id,brand_id,product_id,product_version_id,publication_version,source_aggregate_version,result_aggregate_version,publication_intent_digest,action_code)
 REFERENCES rms_catalog.product_publication_revision(operation_id,tenant_id,brand_id,product_id,product_version_id,publication_version,source_aggregate_version,result_aggregate_version,intent_digest,action_code),
 CHECK(snapshot_json ?& ARRAY['profile','tenantReference','brandReference','productReference','operationReference','versionReference','publicationVersion','publicationAction','sourceAggregateVersion','resultAggregateVersion','publicationIntentDigest','publicationSnapshotDigest','observedSourceRevision','observedSourceHeadDigest','recordedAt','retirements','digest']
  AND snapshot_json-ARRAY['profile','tenantReference','brandReference','productReference','operationReference','versionReference','publicationVersion','publicationAction','sourceAggregateVersion','resultAggregateVersion','publicationIntentDigest','publicationSnapshotDigest','observedSourceRevision','observedSourceHeadDigest','recordedAt','retirements','digest']='{}'::jsonb),
 CHECK((snapshot_json->>'profile') IS NOT DISTINCT FROM 'CatalogProductScopeRetirementHeaderV1'),
 CHECK((snapshot_json->>'tenantReference') IS NOT DISTINCT FROM tenant_id::text),
 CHECK((snapshot_json->>'brandReference') IS NOT DISTINCT FROM brand_id::text),
 CHECK((snapshot_json->>'productReference') IS NOT DISTINCT FROM product_id::text),
 CHECK((snapshot_json->>'operationReference') IS NOT DISTINCT FROM operation_id::text),
 CHECK((snapshot_json->>'versionReference') IS NOT DISTINCT FROM product_version_id::text),
 CHECK((snapshot_json->'publicationVersion') IS NOT DISTINCT FROM to_jsonb(publication_version)),
 CHECK((snapshot_json->>'publicationAction') IS NOT DISTINCT FROM action_code),
 CHECK((snapshot_json->'sourceAggregateVersion') IS NOT DISTINCT FROM to_jsonb(source_aggregate_version)),
 CHECK((snapshot_json->'resultAggregateVersion') IS NOT DISTINCT FROM to_jsonb(result_aggregate_version)),
 CHECK((snapshot_json->>'publicationIntentDigest') IS NOT DISTINCT FROM publication_intent_digest),
 CHECK((snapshot_json->>'publicationSnapshotDigest') IS NOT DISTINCT FROM publication_snapshot_digest),
 CHECK((snapshot_json->>'observedSourceRevision') IS NOT DISTINCT FROM observed_source_revision::text),
 CHECK((snapshot_json->>'observedSourceHeadDigest') IS NOT DISTINCT FROM observed_source_head_digest),
 CHECK((snapshot_json->>'recordedAt') IS NOT DISTINCT FROM to_char(recorded_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')),
 CHECK((jsonb_typeof(snapshot_json->'retirements')='array' AND jsonb_array_length(snapshot_json->'retirements')=retirement_count) IS TRUE),
 CHECK((snapshot_json->>'digest') IS NOT DISTINCT FROM header_digest)
);

CREATE TABLE rms_catalog.product_scope_retirement (
 operation_id platform_helpers.uuid_v7 PRIMARY KEY,
 tenant_id platform_helpers.uuid_v7 NOT NULL,
 brand_id platform_helpers.uuid_v7 NOT NULL,
 product_id platform_helpers.uuid_v7 NOT NULL,
 product_version_id platform_helpers.uuid_v7 NOT NULL,
 publication_version integer NOT NULL CHECK(publication_version>0),
 publication_intent_digest text NOT NULL CHECK(publication_intent_digest ~ '^sha256:[0-9a-f]{64}$'),
 previous_operation_id platform_helpers.uuid_v7 NOT NULL,
 previous_version_id platform_helpers.uuid_v7 NOT NULL,
 previous_publication_version integer NOT NULL CHECK(previous_publication_version>0),
 previous_intent_digest text NOT NULL CHECK(previous_intent_digest ~ '^sha256:[0-9a-f]{64}$'),
 previous_scope_digest text NOT NULL CHECK(previous_scope_digest ~ '^sha256:[0-9a-f]{64}$'),
 previous_period_digest text NOT NULL CHECK(previous_period_digest ~ '^sha256:[0-9a-f]{64}$'),
 previous_selector_index integer NOT NULL CHECK(previous_selector_index BETWEEN 0 AND 999),
 previous_selector_digest text NOT NULL CHECK(previous_selector_digest ~ '^sha256:[0-9a-f]{64}$'),
 previous_publication_digest text NOT NULL CHECK(previous_publication_digest ~ '^sha256:[0-9a-f]{64}$'),
 replacement_intent_digest text NOT NULL CHECK(replacement_intent_digest ~ '^sha256:[0-9a-f]{64}$'),
 retired_at timestamptz NOT NULL CHECK(date_trunc('milliseconds',retired_at)=retired_at),
 retirement_digest text NOT NULL CHECK(retirement_digest ~ '^sha256:[0-9a-f]{64}$'),
 snapshot_json jsonb NOT NULL CHECK(jsonb_typeof(snapshot_json)='object' AND octet_length(snapshot_json::text)<=32768),
 state text NOT NULL DEFAULT 'Published' CHECK(state='Published'),
 data_classification text NOT NULL DEFAULT 'ConfigurationMetadata' CHECK(data_classification='ConfigurationMetadata'),
 CONSTRAINT product_scope_retirement_once UNIQUE(tenant_id,brand_id,product_id,previous_operation_id,previous_selector_index),
 CHECK(operation_id<>previous_operation_id AND product_version_id<>previous_version_id),
 FOREIGN KEY(operation_id,tenant_id,brand_id,product_id,product_version_id,publication_version,publication_intent_digest,state)
 REFERENCES rms_catalog.product_publication_revision(operation_id,tenant_id,brand_id,product_id,product_version_id,publication_version,intent_digest,state),
 FOREIGN KEY(previous_operation_id,tenant_id,brand_id,product_id,previous_version_id,previous_publication_version,previous_intent_digest,state)
 REFERENCES rms_catalog.product_publication_revision(operation_id,tenant_id,brand_id,product_id,product_version_id,publication_version,intent_digest,state),
 FOREIGN KEY(operation_id,tenant_id,brand_id,product_id,product_version_id,publication_version,publication_intent_digest,retired_at)
 REFERENCES rms_catalog.product_scope_retirement_header(operation_id,tenant_id,brand_id,product_id,product_version_id,publication_version,publication_intent_digest,recorded_at),
 CHECK(snapshot_json ?& ARRAY['profile','replacementIntent','previousPublicationDigest','retiredAt','digest']
  AND snapshot_json-ARRAY['profile','replacementIntent','previousPublicationDigest','retiredAt','digest']='{}'::jsonb),
 CHECK((snapshot_json->>'profile') IS NOT DISTINCT FROM 'CatalogProductExactStoreSelectorRetirementV1'),
 CHECK((snapshot_json->>'previousPublicationDigest') IS NOT DISTINCT FROM previous_publication_digest),
 CHECK((snapshot_json->>'retiredAt') IS NOT DISTINCT FROM to_char(retired_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')),
 CHECK((snapshot_json->>'digest') IS NOT DISTINCT FROM retirement_digest),
 CHECK((jsonb_typeof(snapshot_json->'replacementIntent')='object'
  AND (snapshot_json->'replacementIntent') ?& ARRAY['profile','mode','previousVersionReference','previousPublicationOperationReference','expectedPreviousPublicationVersion','previousIntentDigest','previousScopeDigest','previousPeriodDigest','previousSelectorIndex','previousSelectorDigest','digest']
  AND (snapshot_json->'replacementIntent')-ARRAY['profile','mode','previousVersionReference','previousPublicationOperationReference','expectedPreviousPublicationVersion','previousIntentDigest','previousScopeDigest','previousPeriodDigest','previousSelectorIndex','previousSelectorDigest','digest']='{}'::jsonb) IS TRUE),
 CHECK((snapshot_json#>>'{replacementIntent,profile}') IS NOT DISTINCT FROM 'CatalogProductExactStoreSelectorReplacementV1'),
 CHECK((snapshot_json#>>'{replacementIntent,mode}') IS NOT DISTINCT FROM 'PermanentSelectorRetirement'),
 CHECK((snapshot_json#>>'{replacementIntent,previousVersionReference}') IS NOT DISTINCT FROM previous_version_id::text),
 CHECK((snapshot_json#>>'{replacementIntent,previousPublicationOperationReference}') IS NOT DISTINCT FROM previous_operation_id::text),
 CHECK((snapshot_json#>'{replacementIntent,expectedPreviousPublicationVersion}') IS NOT DISTINCT FROM to_jsonb(previous_publication_version)),
 CHECK((snapshot_json#>>'{replacementIntent,previousIntentDigest}') IS NOT DISTINCT FROM previous_intent_digest),
 CHECK((snapshot_json#>>'{replacementIntent,previousScopeDigest}') IS NOT DISTINCT FROM previous_scope_digest),
 CHECK((snapshot_json#>>'{replacementIntent,previousPeriodDigest}') IS NOT DISTINCT FROM previous_period_digest),
 CHECK((snapshot_json#>'{replacementIntent,previousSelectorIndex}') IS NOT DISTINCT FROM to_jsonb(previous_selector_index)),
 CHECK((snapshot_json#>>'{replacementIntent,previousSelectorDigest}') IS NOT DISTINCT FROM previous_selector_digest),
 CHECK((snapshot_json#>>'{replacementIntent,digest}') IS NOT DISTINCT FROM replacement_intent_digest)
);

CREATE TRIGGER product_scope_retirement_header_immutable BEFORE UPDATE OR DELETE ON rms_catalog.product_scope_retirement_header
 FOR EACH ROW EXECUTE FUNCTION rms_catalog.product_publication_immutable();
CREATE TRIGGER product_scope_retirement_immutable BEFORE UPDATE OR DELETE ON rms_catalog.product_scope_retirement
 FOR EACH ROW EXECUTE FUNCTION rms_catalog.product_publication_immutable();
CREATE TRIGGER product_scope_retirement_header_no_truncate BEFORE TRUNCATE ON rms_catalog.product_scope_retirement_header
 FOR EACH STATEMENT EXECUTE FUNCTION rms_catalog.product_publication_immutable();
CREATE TRIGGER product_scope_retirement_no_truncate BEFORE TRUNCATE ON rms_catalog.product_scope_retirement
 FOR EACH STATEMENT EXECUTE FUNCTION rms_catalog.product_publication_immutable();

-- The barrier serializes first participation with any concurrent legacy writer.
-- Original replay performs no INSERT and is therefore not rejected by this fence.
CREATE FUNCTION rms_catalog.product_publication_retirement_profile_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE previous rms_catalog.product_publication_revision;
BEGIN
 IF (NEW.tenant_id::text=current_setting('bop.tenant_id',true) AND NEW.brand_id=platform_helpers.current_brand_id() AND platform_helpers.current_store_id() IS NULL) IS NOT TRUE THEN RAISE EXCEPTION 'PRODUCT_SCOPE_RETIREMENT_UNAVAILABLE' USING ERRCODE='55000'; END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended('CatalogProductSource:'||NEW.brand_id::text,0));
 IF NOT(NEW.snapshot_json ? 'profile') THEN
  IF EXISTS(SELECT 1 FROM rms_catalog.product_publication_revision r WHERE r.tenant_id=NEW.tenant_id AND r.brand_id=NEW.brand_id AND r.product_id=NEW.product_id AND r.snapshot_json->>'profile'='CatalogProductPublicationVersionV2') THEN RAISE EXCEPTION 'PRODUCT_SCOPE_RETIREMENT_V2_REQUIRED' USING ERRCODE='23514'; END IF;
 ELSE
  IF (NEW.snapshot_json->>'profile') IS DISTINCT FROM 'CatalogProductPublicationVersionV2' THEN RAISE EXCEPTION 'PRODUCT_SCOPE_RETIREMENT_PROFILE_CONFLICT' USING ERRCODE='23514'; END IF;
  SELECT * INTO previous FROM rms_catalog.product_publication_revision r WHERE r.tenant_id=NEW.tenant_id AND r.brand_id=NEW.brand_id AND r.product_id=NEW.product_id AND r.product_version_id=NEW.product_version_id ORDER BY r.publication_version DESC LIMIT 1;
  IF FOUND AND ((previous.snapshot_json->>'profile') IS DISTINCT FROM 'CatalogProductPublicationVersionV2' OR (NEW.action_code<>'Validate' AND (previous.snapshot_json->'replacementIntent') IS DISTINCT FROM (NEW.snapshot_json->'replacementIntent'))) THEN RAISE EXCEPTION 'PRODUCT_SCOPE_RETIREMENT_INTENT_CONFLICT' USING ERRCODE='23514'; END IF;
 END IF;
 RETURN NEW;
END;
$$;
CREATE TRIGGER product_publication_retirement_profile_guard BEFORE INSERT ON rms_catalog.product_publication_revision
 FOR EACH ROW EXECUTE FUNCTION rms_catalog.product_publication_retirement_profile_guard();

CREATE FUNCTION rms_catalog.product_scope_retirement_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE incoming rms_catalog.product_publication_revision; previous rms_catalog.product_publication_revision; header rms_catalog.product_scope_retirement_header;
 previous_from timestamptz; previous_until timestamptz; incoming_from timestamptz; incoming_until timestamptz; previous_published_at timestamptz;
BEGIN
 SELECT * INTO incoming FROM rms_catalog.product_publication_revision WHERE operation_id=NEW.operation_id AND tenant_id=NEW.tenant_id AND brand_id=NEW.brand_id AND product_id=NEW.product_id;
 SELECT * INTO previous FROM rms_catalog.product_publication_revision WHERE operation_id=NEW.previous_operation_id AND tenant_id=NEW.tenant_id AND brand_id=NEW.brand_id AND product_id=NEW.product_id;
 SELECT * INTO header FROM rms_catalog.product_scope_retirement_header WHERE operation_id=NEW.operation_id AND tenant_id=NEW.tenant_id AND brand_id=NEW.brand_id AND product_id=NEW.product_id;
 IF incoming.operation_id IS NULL OR previous.operation_id IS NULL OR header.operation_id IS NULL
  OR (incoming.snapshot_json->>'profile') IS DISTINCT FROM 'CatalogProductPublicationVersionV2'
  OR ((previous.snapshot_json ? 'profile') AND (previous.snapshot_json->>'profile') IS DISTINCT FROM 'CatalogProductPublicationVersionV2')
  OR incoming.state<>'Published' OR previous.state<>'Published'
  OR incoming.action_code NOT IN ('Publish','ActivateScheduled')
  OR incoming.source_aggregate_version<=previous.source_aggregate_version
  OR incoming.occurred_at<>NEW.retired_at OR previous.occurred_at>NEW.retired_at
  OR (incoming.snapshot_json->>'publishedAt') IS DISTINCT FROM to_char(NEW.retired_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
  OR (incoming.snapshot_json->'replacementIntent') IS DISTINCT FROM (NEW.snapshot_json->'replacementIntent')
  OR (incoming.snapshot_json->>'replacementIntentDigest') IS DISTINCT FROM NEW.replacement_intent_digest
  OR (previous.snapshot_json->>'scopeDigest') IS DISTINCT FROM NEW.previous_scope_digest
  OR (previous.snapshot_json->>'periodDigest') IS DISTINCT FROM NEW.previous_period_digest
  OR (header.snapshot_json#>'{retirements,0}') IS DISTINCT FROM NEW.snapshot_json
  OR header.retirement_count<>1
  OR EXISTS(SELECT 1 FROM rms_catalog.product_publication_revision r WHERE r.tenant_id=NEW.tenant_id AND r.brand_id=NEW.brand_id AND r.product_id=NEW.product_id AND r.product_version_id=NEW.previous_version_id AND r.publication_version>NEW.previous_publication_version)
 THEN RAISE EXCEPTION 'PRODUCT_SCOPE_RETIREMENT_TUPLE_CONFLICT' USING ERRCODE='23514'; END IF;
 IF (jsonb_typeof(previous.snapshot_json->'scopeSet')='array' AND jsonb_array_length(previous.snapshot_json->'scopeSet') BETWEEN 1 AND 1000 AND jsonb_typeof(incoming.snapshot_json->'scopeSet')='array' AND jsonb_array_length(incoming.snapshot_json->'scopeSet')=1) IS NOT TRUE THEN RAISE EXCEPTION 'PRODUCT_SCOPE_RETIREMENT_SELECTOR_CONFLICT' USING ERRCODE='23514'; END IF;
 IF EXISTS(SELECT 1 FROM jsonb_array_elements(previous.snapshot_json->'scopeSet') s WHERE (s->>'level') IS DISTINCT FROM 'Store' OR (s->>'reference') IS NULL)
  OR (SELECT count(DISTINCT s->>'reference') FROM jsonb_array_elements(previous.snapshot_json->'scopeSet') s)<>jsonb_array_length(previous.snapshot_json->'scopeSet')
  OR (previous.snapshot_json->'scopeSet'->NEW.previous_selector_index) IS NULL
  OR (incoming.snapshot_json#>'{scopeSet,0}') IS DISTINCT FROM (previous.snapshot_json->'scopeSet'->NEW.previous_selector_index)
 THEN RAISE EXCEPTION 'PRODUCT_SCOPE_RETIREMENT_SELECTOR_CONFLICT' USING ERRCODE='23514'; END IF;
 -- Both immutable periods must cover actual execution. JSON null is an open
 -- upper bound; a missing bound or malformed UTC instant is never open-ended.
 IF (
  jsonb_typeof(previous.snapshot_json->'publishedAt')='string'
  AND (previous.snapshot_json->>'publishedAt') ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{3}Z$'
  AND jsonb_typeof(previous.snapshot_json#>'{effectivePeriod,effectiveFrom,instant}')='string'
  AND (previous.snapshot_json#>>'{effectivePeriod,effectiveFrom,instant}') ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{3}Z$'
  AND jsonb_typeof(incoming.snapshot_json#>'{effectivePeriod,effectiveFrom,instant}')='string'
  AND (incoming.snapshot_json#>>'{effectivePeriod,effectiveFrom,instant}') ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{3}Z$'
  AND ((previous.snapshot_json#>'{effectivePeriod,effectiveUntil}')='null'::jsonb
   OR (jsonb_typeof(previous.snapshot_json#>'{effectivePeriod,effectiveUntil}')='object'
    AND jsonb_typeof(previous.snapshot_json#>'{effectivePeriod,effectiveUntil,instant}')='string'
    AND (previous.snapshot_json#>>'{effectivePeriod,effectiveUntil,instant}') ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{3}Z$'))
  AND ((incoming.snapshot_json#>'{effectivePeriod,effectiveUntil}')='null'::jsonb
   OR (jsonb_typeof(incoming.snapshot_json#>'{effectivePeriod,effectiveUntil}')='object'
    AND jsonb_typeof(incoming.snapshot_json#>'{effectivePeriod,effectiveUntil,instant}')='string'
    AND (incoming.snapshot_json#>>'{effectivePeriod,effectiveUntil,instant}') ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{3}Z$'))
 ) IS NOT TRUE THEN RAISE EXCEPTION 'PRODUCT_SCOPE_RETIREMENT_PERIOD_CONFLICT' USING ERRCODE='23514'; END IF;
 BEGIN
  previous_published_at := (previous.snapshot_json->>'publishedAt')::timestamptz;
  previous_from := (previous.snapshot_json#>>'{effectivePeriod,effectiveFrom,instant}')::timestamptz;
  incoming_from := (incoming.snapshot_json#>>'{effectivePeriod,effectiveFrom,instant}')::timestamptz;
  previous_until := CASE WHEN (previous.snapshot_json#>'{effectivePeriod,effectiveUntil}')='null'::jsonb THEN NULL ELSE (previous.snapshot_json#>>'{effectivePeriod,effectiveUntil,instant}')::timestamptz END;
  incoming_until := CASE WHEN (incoming.snapshot_json#>'{effectivePeriod,effectiveUntil}')='null'::jsonb THEN NULL ELSE (incoming.snapshot_json#>>'{effectivePeriod,effectiveUntil,instant}')::timestamptz END;
 EXCEPTION WHEN invalid_datetime_format OR datetime_field_overflow THEN
  RAISE EXCEPTION 'PRODUCT_SCOPE_RETIREMENT_PERIOD_CONFLICT' USING ERRCODE='23514';
 END;
 IF previous_published_at>NEW.retired_at OR previous_from>NEW.retired_at OR incoming_from>NEW.retired_at
  OR (previous_until IS NOT NULL AND previous_until<=NEW.retired_at)
  OR (incoming_until IS NOT NULL AND incoming_until<=NEW.retired_at)
  OR to_char(previous_published_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') IS DISTINCT FROM (previous.snapshot_json->>'publishedAt')
  OR to_char(previous_from AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') IS DISTINCT FROM (previous.snapshot_json#>>'{effectivePeriod,effectiveFrom,instant}')
  OR to_char(incoming_from AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') IS DISTINCT FROM (incoming.snapshot_json#>>'{effectivePeriod,effectiveFrom,instant}')
  OR (previous_until IS NOT NULL AND to_char(previous_until AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') IS DISTINCT FROM (previous.snapshot_json#>>'{effectivePeriod,effectiveUntil,instant}'))
  OR (incoming_until IS NOT NULL AND to_char(incoming_until AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') IS DISTINCT FROM (incoming.snapshot_json#>>'{effectivePeriod,effectiveUntil,instant}'))
 THEN RAISE EXCEPTION 'PRODUCT_SCOPE_RETIREMENT_PERIOD_CONFLICT' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END;
$$;
CREATE TRIGGER product_scope_retirement_guard BEFORE INSERT ON rms_catalog.product_scope_retirement
 FOR EACH ROW EXECUTE FUNCTION rms_catalog.product_scope_retirement_guard();

-- Reverse coverage is required at COMMIT, including an explicit empty header.
CREATE FUNCTION rms_catalog.product_scope_retirement_commit_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE publication rms_catalog.product_publication_revision; header rms_catalog.product_scope_retirement_header; count_rows integer; expected_count integer;
BEGIN
 SELECT * INTO publication FROM rms_catalog.product_publication_revision WHERE operation_id=NEW.operation_id;
 IF publication.operation_id IS NULL THEN RAISE EXCEPTION 'PRODUCT_SCOPE_RETIREMENT_REVISION_MISSING' USING ERRCODE='23514'; END IF;
 IF (publication.snapshot_json->>'profile') IS DISTINCT FROM 'CatalogProductPublicationVersionV2' THEN
  -- Legacy revision writers need no new-table privilege. A header INSERT for a
  -- legacy operation still refuses through this same deferred header trigger.
  IF TG_TABLE_NAME='product_scope_retirement_header' THEN RAISE EXCEPTION 'PRODUCT_SCOPE_RETIREMENT_PROFILE_CONFLICT' USING ERRCODE='23514'; END IF;
  RETURN NEW;
 END IF;
 SELECT * INTO header FROM rms_catalog.product_scope_retirement_header WHERE operation_id=NEW.operation_id;
 SELECT count(*) INTO count_rows FROM rms_catalog.product_scope_retirement WHERE operation_id=NEW.operation_id;
 expected_count := CASE
  WHEN publication.action_code NOT IN ('Publish','ActivateScheduled') THEN 0
  WHEN (publication.snapshot_json#>>'{replacementIntent,profile}')='CatalogProductNoReplacementIntentV1' AND (publication.snapshot_json#>>'{replacementIntent,mode}')='None' THEN 0
  WHEN (publication.snapshot_json#>>'{replacementIntent,profile}')='CatalogProductExactStoreSelectorReplacementV1' AND (publication.snapshot_json#>>'{replacementIntent,mode}')='PermanentSelectorRetirement' THEN 1
  ELSE -1 END;
 IF header.operation_id IS NULL OR header.recorded_at<>publication.occurred_at OR count_rows<>header.retirement_count
  OR header.retirement_count<>expected_count
  OR NOT EXISTS(SELECT 1 FROM rms_catalog.product_source_commit c WHERE c.operation_id=publication.operation_id AND c.brand_id=publication.brand_id AND c.product_id=publication.product_id AND c.result_aggregate_version=publication.result_aggregate_version AND c.occurred_at=header.recorded_at AND c.source_revision=header.observed_source_revision+1)
  OR (publication.state='Published' AND (publication.snapshot_json->>'publishedAt') IS DISTINCT FROM to_char(header.recorded_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'))
  OR (publication.state<>'Published' AND header.retirement_count<>0)
  OR (publication.action_code='Approve' AND NOT EXISTS(SELECT 1 FROM rms_catalog.product_approval_receipt r WHERE r.operation_id=publication.operation_id AND r.tenant_id=publication.tenant_id AND r.brand_id=publication.brand_id AND r.product_id=publication.product_id AND r.snapshot_json->>'profile'='CatalogProductApprovalReceiptV2' AND r.snapshot_json->>'replacementIntentDigest'=publication.snapshot_json->>'replacementIntentDigest'))
 THEN RAISE EXCEPTION 'PRODUCT_SCOPE_RETIREMENT_COVERAGE_MISSING' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END;
$$;
CREATE CONSTRAINT TRIGGER product_publication_retirement_commit_guard AFTER INSERT ON rms_catalog.product_publication_revision
 DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION rms_catalog.product_scope_retirement_commit_guard();
CREATE CONSTRAINT TRIGGER product_scope_retirement_header_commit_guard AFTER INSERT ON rms_catalog.product_scope_retirement_header
 DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION rms_catalog.product_scope_retirement_commit_guard();

-- The existing receipt table retains V1 bytes and admits only the explicit V2 pair.
ALTER TABLE rms_catalog.product_approval_receipt DROP CONSTRAINT product_approval_receipt_snapshot_json_check1;
ALTER TABLE rms_catalog.product_approval_receipt ADD CONSTRAINT product_approval_receipt_profile_check CHECK((
 ((snapshot_json->>'profile')='CatalogProductApprovalReceiptV1' AND NOT(snapshot_json ? 'replacementIntentDigest') AND NOT((snapshot_json->'approval') ?| ARRAY['profile','replacementIntentDigest'])) OR
 ((snapshot_json->>'profile')='CatalogProductApprovalReceiptV2' AND (snapshot_json#>>'{approval,profile}')='CatalogProductPublicationApprovalV2'
  AND snapshot_json ?& ARRAY['profile','tenantReference','brandReference','productReference','versionReference','approvalOperationReference','originalIntentDigest','approvalPublicationVersion','resultAggregateVersion','recordedAt','approval','replacementIntentDigest','digest']
  AND snapshot_json-ARRAY['profile','tenantReference','brandReference','productReference','versionReference','approvalOperationReference','originalIntentDigest','approvalPublicationVersion','resultAggregateVersion','recordedAt','approval','replacementIntentDigest','digest']='{}'::jsonb
  AND jsonb_typeof(snapshot_json->'approval')='object'
  AND (snapshot_json->'approval') ?& ARRAY['evidenceReference','reviewReference','reviewVersion','requestedByActorReference','approvedByActorReference','contentDigest','configurationDigest','scopeDigest','periodDigest','policyReference','policyVersion','approvedAt','validUntil','profile','replacementIntentDigest']
  AND (snapshot_json->'approval')-ARRAY['evidenceReference','reviewReference','reviewVersion','requestedByActorReference','approvedByActorReference','contentDigest','configurationDigest','scopeDigest','periodDigest','policyReference','policyVersion','approvedAt','validUntil','profile','replacementIntentDigest']='{}'::jsonb
  AND (snapshot_json->>'replacementIntentDigest') ~ '^sha256:[0-9a-f]{64}$'
  AND (snapshot_json#>>'{approval,replacementIntentDigest}')=(snapshot_json->>'replacementIntentDigest'))
) IS TRUE);
CREATE FUNCTION rms_catalog.product_approval_receipt_v2_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE publication rms_catalog.product_publication_revision;
BEGIN
 SELECT * INTO publication FROM rms_catalog.product_publication_revision WHERE operation_id=NEW.operation_id;
 IF (NEW.snapshot_json->>'profile')='CatalogProductApprovalReceiptV2' THEN
  IF publication.operation_id IS NULL OR (publication.snapshot_json->>'profile') IS DISTINCT FROM 'CatalogProductPublicationVersionV2'
   OR publication.action_code<>'Approve' OR publication.state<>'Approved'
   OR publication.tenant_id<>NEW.tenant_id OR publication.brand_id<>NEW.brand_id OR publication.product_id<>NEW.product_id OR publication.product_version_id<>NEW.product_version_id
   OR publication.publication_version<>NEW.publication_version OR publication.result_aggregate_version<>NEW.result_aggregate_version OR publication.occurred_at<>NEW.recorded_at
   OR (NEW.snapshot_json->>'originalIntentDigest') IS DISTINCT FROM publication.intent_digest
   OR (NEW.snapshot_json->>'replacementIntentDigest') IS DISTINCT FROM (publication.snapshot_json->>'replacementIntentDigest')
   OR (NEW.snapshot_json#>>'{approval,evidenceReference}') IS DISTINCT FROM (publication.snapshot_json->>'approvalEvidenceReference')
   OR (NEW.snapshot_json#>>'{approval,reviewReference}') IS DISTINCT FROM (publication.snapshot_json->>'reviewReference')
   OR (NEW.snapshot_json#>'{approval,reviewVersion}') IS DISTINCT FROM (publication.snapshot_json->'reviewVersion')
   OR (NEW.snapshot_json#>>'{approval,requestedByActorReference}') IS DISTINCT FROM (publication.snapshot_json->>'submittedByActorReference')
   OR (NEW.snapshot_json#>>'{approval,approvedByActorReference}') IS DISTINCT FROM (publication.snapshot_json->>'actorReference')
   OR (NEW.snapshot_json#>>'{approval,contentDigest}') IS DISTINCT FROM publication.content_digest
   OR (NEW.snapshot_json#>>'{approval,configurationDigest}') IS DISTINCT FROM publication.configuration_digest
   OR (NEW.snapshot_json#>>'{approval,scopeDigest}') IS DISTINCT FROM (publication.snapshot_json->>'scopeDigest')
   OR (NEW.snapshot_json#>>'{approval,periodDigest}') IS DISTINCT FROM (publication.snapshot_json->>'periodDigest')
   OR (NEW.snapshot_json#>>'{approval,policyReference}') IS DISTINCT FROM (publication.snapshot_json->>'policyReference')
   OR (NEW.snapshot_json#>'{approval,policyVersion}') IS DISTINCT FROM (publication.snapshot_json->'policyVersion')
  THEN RAISE EXCEPTION 'PRODUCT_APPROVAL_V2_TUPLE_CONFLICT' USING ERRCODE='23514'; END IF;
 ELSIF (publication.snapshot_json->>'profile')='CatalogProductPublicationVersionV2' THEN
  RAISE EXCEPTION 'PRODUCT_APPROVAL_V2_REQUIRED' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END;
$$;
CREATE CONSTRAINT TRIGGER product_approval_receipt_v2_guard AFTER INSERT ON rms_catalog.product_approval_receipt
 DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION rms_catalog.product_approval_receipt_v2_guard();

ALTER TABLE rms_catalog.product_scope_retirement_header ENABLE ROW LEVEL SECURITY;
ALTER TABLE rms_catalog.product_scope_retirement_header FORCE ROW LEVEL SECURITY;
ALTER TABLE rms_catalog.product_scope_retirement ENABLE ROW LEVEL SECURITY;
ALTER TABLE rms_catalog.product_scope_retirement FORCE ROW LEVEL SECURITY;
CREATE POLICY product_scope_retirement_header_scope ON rms_catalog.product_scope_retirement_header
 USING ((tenant_id::text=current_setting('bop.tenant_id',true) AND brand_id=platform_helpers.current_brand_id() AND platform_helpers.current_store_id() IS NULL) IS TRUE)
 WITH CHECK ((tenant_id::text=current_setting('bop.tenant_id',true) AND brand_id=platform_helpers.current_brand_id() AND platform_helpers.current_store_id() IS NULL) IS TRUE);
CREATE POLICY product_scope_retirement_scope ON rms_catalog.product_scope_retirement
 USING ((tenant_id::text=current_setting('bop.tenant_id',true) AND brand_id=platform_helpers.current_brand_id() AND platform_helpers.current_store_id() IS NULL) IS TRUE)
 WITH CHECK ((tenant_id::text=current_setting('bop.tenant_id',true) AND brand_id=platform_helpers.current_brand_id() AND platform_helpers.current_store_id() IS NULL) IS TRUE);
REVOKE ALL ON TABLE rms_catalog.product_scope_retirement_header FROM PUBLIC;
REVOKE ALL ON TABLE rms_catalog.product_scope_retirement FROM PUBLIC;
REVOKE ALL ON FUNCTION rms_catalog.product_publication_retirement_profile_guard() FROM PUBLIC;
REVOKE ALL ON FUNCTION rms_catalog.product_scope_retirement_guard() FROM PUBLIC;
REVOKE ALL ON FUNCTION rms_catalog.product_scope_retirement_commit_guard() FROM PUBLIC;
REVOKE ALL ON FUNCTION rms_catalog.product_approval_receipt_v2_guard() FROM PUBLIC;
