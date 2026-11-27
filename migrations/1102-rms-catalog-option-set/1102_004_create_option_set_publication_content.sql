-- bop-rms-migration: 1
-- owner: @rms/catalog
-- schema: rms_catalog
-- phase: expand
-- risk: medium
-- transaction: required
-- lock-timeout-ms: 5000
-- statement-timeout-ms: 60000
-- recovery: forward-fix
-- Owning storage prerequisite only. Frozen content remains NotEvaluated.
ALTER TABLE rms_catalog.option_set_version DROP CONSTRAINT option_set_version_status_check;
ALTER TABLE rms_catalog.option_set_version ADD CONSTRAINT option_set_version_status_check
 CHECK(status IN ('Draft','Frozen'));
ALTER TABLE rms_catalog.option_set_version DROP CONSTRAINT option_set_one_draft_unique;
CREATE UNIQUE INDEX option_set_one_draft_unique ON rms_catalog.option_set_version(option_set_id) WHERE status='Draft';
ALTER TABLE rms_catalog.option_set_operation_record DROP CONSTRAINT option_set_operation_record_action_code_check;
ALTER TABLE rms_catalog.option_set_operation_record ADD CONSTRAINT option_set_operation_record_action_code_check
 CHECK(action_code IN ('Create','ReplaceDraft','Archive','Publish'));
ALTER TABLE rms_catalog.option_set_draft_content_snapshot DROP CONSTRAINT option_set_draft_content_snapshot_action_code_check;
ALTER TABLE rms_catalog.option_set_draft_content_snapshot ADD CONSTRAINT option_set_draft_content_snapshot_action_code_check
 CHECK(action_code IN ('Create','ReplaceDraft','Publish'));
ALTER TABLE rms_catalog.option_set_draft_content_snapshot ADD CONSTRAINT option_set_full_result_tuple_unique
 UNIQUE(operation_id,tenant_id,brand_id,option_set_id,option_set_version_id,action_code,intent_digest,result_aggregate_version,occurred_at);

CREATE TABLE rms_catalog.option_set_publication_content (
 operation_id platform_helpers.uuid_v7 PRIMARY KEY,
 tenant_id platform_helpers.uuid_v7 NOT NULL,
 brand_id platform_helpers.uuid_v7 NOT NULL,
 option_set_id platform_helpers.uuid_v7 NOT NULL,
 option_set_version_id platform_helpers.uuid_v7 NOT NULL,
 successor_draft_version_id platform_helpers.uuid_v7 NOT NULL,
 action_code text NOT NULL DEFAULT 'Publish' CHECK(action_code='Publish'),
 intent_digest text NOT NULL CHECK(intent_digest ~ '^sha256:[0-9a-f]{64}$'),
 source_aggregate_version integer NOT NULL CHECK(source_aggregate_version>0 AND source_aggregate_version<2147483647),
 result_aggregate_version integer NOT NULL CHECK(result_aggregate_version::bigint=source_aggregate_version::bigint+1),
 sealed_at timestamptz NOT NULL CHECK(date_trunc('milliseconds',sealed_at)=sealed_at),
 source_digest text NOT NULL CHECK(source_digest ~ '^sha256:[0-9a-f]{64}$'),
 content_digest text NOT NULL CHECK(content_digest ~ '^sha256:[0-9a-f]{64}$'),
 configuration_digest text NOT NULL CHECK(configuration_digest ~ '^sha256:[0-9a-f]{64}$'),
 record_digest text NOT NULL CHECK(record_digest ~ '^sha256:[0-9a-f]{64}$'),
 snapshot_json jsonb NOT NULL,
 data_classification text NOT NULL DEFAULT 'ConfigurationMetadata' CHECK(data_classification='ConfigurationMetadata'),
 UNIQUE(brand_id,option_set_id,option_set_version_id),
 UNIQUE(successor_draft_version_id),
 CHECK(successor_draft_version_id<>option_set_version_id AND successor_draft_version_id<>option_set_id),
 FOREIGN KEY(option_set_version_id,option_set_id,brand_id)
  REFERENCES rms_catalog.option_set_version(option_set_version_id,option_set_id,brand_id),
 FOREIGN KEY(successor_draft_version_id,option_set_id,brand_id)
  REFERENCES rms_catalog.option_set_version(option_set_version_id,option_set_id,brand_id) DEFERRABLE INITIALLY DEFERRED,
 FOREIGN KEY(operation_id,brand_id,option_set_id,action_code,intent_digest,result_aggregate_version,sealed_at)
  REFERENCES rms_catalog.option_set_operation_record(operation_id,brand_id,option_set_id,action_code,intent_digest,result_aggregate_version,occurred_at) DEFERRABLE INITIALLY DEFERRED,
 FOREIGN KEY(operation_id,tenant_id,brand_id,option_set_id,successor_draft_version_id,action_code,intent_digest,result_aggregate_version,sealed_at)
  REFERENCES rms_catalog.option_set_draft_content_snapshot(operation_id,tenant_id,brand_id,option_set_id,option_set_version_id,action_code,intent_digest,result_aggregate_version,occurred_at) DEFERRABLE INITIALLY DEFERRED,
 CHECK((jsonb_typeof(snapshot_json)='object'
  AND octet_length(snapshot_json::text)<=1048576
  AND snapshot_json->>'profile'='CatalogFullOptionSetDraftContentV2'
  AND snapshot_json->>'eligibility'='NotEvaluated'
  AND snapshot_json->>'sourceDigest'=source_digest
  AND snapshot_json->>'contentDigest'=content_digest
  AND snapshot_json->>'configurationDigest'=configuration_digest
  AND snapshot_json->>'digest'=record_digest
  AND jsonb_typeof(snapshot_json->'supportedContent')='object'
  AND snapshot_json#>>'{supportedContent,profile}'='CatalogSupportedOptionSetDraftContentV1'
  AND snapshot_json#>>'{supportedContent,eligibility}'='NotEvaluated'
  AND snapshot_json#>>'{supportedContent,tenantReference}'=tenant_id::text
  AND snapshot_json#>>'{supportedContent,brandReference}'=brand_id::text
  AND snapshot_json#>>'{supportedContent,optionSetReference}'=option_set_id::text
  AND snapshot_json#>>'{supportedContent,versionReference}'=option_set_version_id::text
  AND snapshot_json#>'{supportedContent,sourceAggregateVersion}'=to_jsonb(source_aggregate_version)
  AND snapshot_json#>>'{supportedContent,publicationOperationReference}'=operation_id::text
  AND snapshot_json#>>'{supportedContent,publicationIntentDigest}'=intent_digest
  AND snapshot_json#>>'{supportedContent,successorDraftVersionReference}'=successor_draft_version_id::text
  AND snapshot_json#>>'{supportedContent,sealedAt}'=to_char(sealed_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
  AND jsonb_typeof(snapshot_json->'editorContent')='object'
  AND snapshot_json#>>'{editorContent,profile}'='CatalogOptionSetEditorContentV1'
  AND snapshot_json#>'{supportedContent,sourceAggregate}'=snapshot_json#>'{editorContent,sourceAggregate}'
  AND snapshot_json#>>'{editorContent,sourceAggregate,brandReference}'=brand_id::text
  AND snapshot_json#>>'{editorContent,sourceAggregate,optionSetReference}'=option_set_id::text
  AND snapshot_json#>'{editorContent,sourceAggregate,aggregateVersion}'=to_jsonb(source_aggregate_version)
  AND snapshot_json#>>'{editorContent,sourceAggregate,lifecycle}'='Draft'
  AND snapshot_json#>>'{editorContent,sourceAggregate,draft,versionReference}'=option_set_version_id::text
  AND snapshot_json#>>'{editorContent,sourceAggregate,draft,status}'='Draft') IS TRUE)
);
ALTER TABLE rms_catalog.option_set_publication_content ENABLE ROW LEVEL SECURITY;
ALTER TABLE rms_catalog.option_set_publication_content FORCE ROW LEVEL SECURITY;
CREATE POLICY option_set_publication_content_scope ON rms_catalog.option_set_publication_content
 USING((tenant_id::text=current_setting('bop.tenant_id',true)
  AND brand_id=platform_helpers.current_brand_id() AND platform_helpers.current_store_id() IS NULL) IS TRUE)
 WITH CHECK((tenant_id::text=current_setting('bop.tenant_id',true)
  AND brand_id=platform_helpers.current_brand_id() AND platform_helpers.current_store_id() IS NULL) IS TRUE);
REVOKE ALL ON TABLE rms_catalog.option_set_publication_content FROM PUBLIC;

-- Triggers retain ordinary Draft UPDATE RETURNING, unlike a conditional RULE.
CREATE FUNCTION rms_catalog.option_set_frozen_guard() RETURNS trigger LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
BEGIN
 IF OLD.status='Frozen' THEN RAISE EXCEPTION 'OPTION_SET_VERSION_IMMUTABLE' USING ERRCODE='55000'; END IF;
 IF TG_OP='DELETE' THEN RETURN OLD; END IF;
 IF (NEW.option_set_version_id,NEW.option_set_id,NEW.brand_id,NEW.created_at)
  IS DISTINCT FROM (OLD.option_set_version_id,OLD.option_set_id,OLD.brand_id,OLD.created_at)
  OR (NEW.status='Frozen' AND (to_jsonb(NEW)-'status') IS DISTINCT FROM (to_jsonb(OLD)-'status'))
 THEN RAISE EXCEPTION 'OPTION_SET_VERSION_CONFLICT' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END;
$$;
CREATE TRIGGER option_set_frozen_guard BEFORE UPDATE OR DELETE ON rms_catalog.option_set_version
 FOR EACH ROW EXECUTE FUNCTION rms_catalog.option_set_frozen_guard();
CREATE FUNCTION rms_catalog.option_set_content_immutable() RETURNS trigger LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
BEGIN
 RAISE EXCEPTION 'OPTION_SET_CONTENT_IMMUTABLE' USING ERRCODE='55000';
END;
$$;
CREATE TRIGGER option_set_content_immutable BEFORE UPDATE OR DELETE ON rms_catalog.option_set_publication_content
 FOR EACH ROW EXECUTE FUNCTION rms_catalog.option_set_content_immutable();

CREATE FUNCTION rms_catalog.option_set_content_commit_guard() RETURNS trigger LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
DECLARE expected_successor jsonb; actual_successor jsonb;
BEGIN
 IF (NEW.tenant_id::text=current_setting('bop.tenant_id',true)
  AND NEW.brand_id=platform_helpers.current_brand_id() AND platform_helpers.current_store_id() IS NULL) IS NOT TRUE
 THEN RAISE EXCEPTION 'OPTION_SET_CONTENT_UNAVAILABLE' USING ERRCODE='23514'; END IF;
 IF NOT EXISTS(SELECT 1 FROM rms_catalog.option_set p
  JOIN rms_catalog.option_set_version v ON v.option_set_id=p.option_set_id AND v.brand_id=p.brand_id
  JOIN rms_catalog.option_set_version s ON s.option_set_id=p.option_set_id AND s.brand_id=p.brand_id
  WHERE p.option_set_id=NEW.option_set_id AND p.brand_id=NEW.brand_id AND p.lifecycle='Draft'
  AND p.aggregate_version=NEW.result_aggregate_version AND p.updated_at=NEW.sealed_at
  AND v.option_set_version_id=NEW.option_set_version_id AND v.status='Frozen'
  AND s.option_set_version_id=NEW.successor_draft_version_id AND s.status='Draft'
  AND s.created_at=NEW.sealed_at AND s.updated_at=NEW.sealed_at)
 THEN RAISE EXCEPTION 'OPTION_SET_CONTENT_COMMIT_CONFLICT' USING ERRCODE='23514'; END IF;
 IF NOT EXISTS(SELECT 1 FROM rms_catalog.option_set_version v JOIN rms_catalog.option_set_version s
  ON s.option_set_version_id=NEW.successor_draft_version_id
  WHERE v.option_set_version_id=NEW.option_set_version_id
  AND v.editor_content_json=(NEW.snapshot_json->'editorContent')-'sourceAggregate'
  AND (to_jsonb(v)-'option_set_version_id'-'status'-'created_at'-'updated_at')
   =(to_jsonb(s)-'option_set_version_id'-'status'-'created_at'-'updated_at')
  AND jsonb_build_object('versionReference',v.option_set_version_id::text,'status','Draft',
   'defaultLocale',v.default_locale,'localizedNames',v.localized_names_json,'localizedDescriptions',v.localized_descriptions_json,
   'displayStyle',v.display_style,'minimumSelection',v.minimum_selection,'maximumSelection',v.maximum_selection,
   'allowRepeatedOption',v.allow_repeated_option,'perOptionMaximumQuantity',v.per_option_maximum_quantity,
   'maximumTotalQuantity',v.maximum_total_quantity,
   'createdAt',to_char(v.created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
   'updatedAt',to_char(v.updated_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
   'options',NEW.snapshot_json#>'{editorContent,sourceAggregate,draft,options}')
   =NEW.snapshot_json#>'{editorContent,sourceAggregate,draft}')
 THEN RAISE EXCEPTION 'OPTION_SET_VERSION_CONTENT_CONFLICT' USING ERRCODE='23514'; END IF;
 IF (SELECT count(*) FROM rms_catalog.option o WHERE o.option_set_id=NEW.option_set_id AND o.brand_id=NEW.brand_id)
  <>jsonb_array_length(NEW.snapshot_json#>'{editorContent,sourceAggregate,draft,options}')
  OR EXISTS(SELECT 1 FROM rms_catalog.option o WHERE o.option_set_id=NEW.option_set_id AND o.brand_id=NEW.brand_id
   AND (o.option_set_version_id<>NEW.successor_draft_version_id OR NOT EXISTS(
    SELECT 1 FROM jsonb_array_elements(NEW.snapshot_json#>'{editorContent,sourceAggregate,draft,options}') frozen
    WHERE frozen=jsonb_build_object('optionReference',o.option_id::text,'optionSetReference',o.option_set_id::text,
     'brandReference',o.brand_id::text,'stableCode',o.stable_code,'lifecycle',o.lifecycle,
     'localizedNames',o.localized_names_json,'localizedDescriptions',o.localized_descriptions_json,
     'sortOrder',o.sort_order,'defaultEligible',o.default_eligible,'triggeredOptionSetReference',o.triggered_option_set_id::text,
     'conflictOptionReferences',COALESCE((SELECT jsonb_agg(c.conflict_option_id::text ORDER BY c.conflict_option_id)
      FROM rms_catalog.option_conflict c WHERE c.option_id=o.option_id AND c.option_set_id=o.option_set_id AND c.brand_id=o.brand_id),'[]'::jsonb),
     'createdAt',to_char(o.created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
     'createdByActorReference',o.created_by_actor_id::text))))
 THEN RAISE EXCEPTION 'OPTION_SET_OPTION_CONTENT_CONFLICT' USING ERRCODE='23514'; END IF;
 IF NOT EXISTS(SELECT 1 FROM rms_catalog.option_set_draft_content_snapshot f
  WHERE f.tenant_id=NEW.tenant_id AND f.brand_id=NEW.brand_id AND f.option_set_id=NEW.option_set_id
  AND f.option_set_version_id=NEW.option_set_version_id AND f.result_aggregate_version=NEW.source_aggregate_version
  AND f.snapshot_json=NEW.snapshot_json->'editorContent' AND f.source_digest=NEW.source_digest
  AND f.content_digest=NEW.content_digest AND f.configuration_digest=NEW.configuration_digest
  AND f.occurred_at<=NEW.sealed_at)
 THEN RAISE EXCEPTION 'OPTION_SET_SOURCE_UNAVAILABLE' USING ERRCODE='23514'; END IF;
 expected_successor:=NEW.snapshot_json->'editorContent';
 expected_successor:=jsonb_set(expected_successor,'{sourceAggregate,aggregateVersion}',to_jsonb(NEW.result_aggregate_version));
 expected_successor:=jsonb_set(expected_successor,'{sourceAggregate,updatedAt}',to_jsonb(to_char(NEW.sealed_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')));
 expected_successor:=jsonb_set(expected_successor,'{sourceAggregate,draft,versionReference}',to_jsonb(NEW.successor_draft_version_id::text));
 expected_successor:=jsonb_set(expected_successor,'{sourceAggregate,draft,createdAt}',to_jsonb(to_char(NEW.sealed_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')));
 expected_successor:=jsonb_set(expected_successor,'{sourceAggregate,draft,updatedAt}',to_jsonb(to_char(NEW.sealed_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')));
 SELECT f.snapshot_json INTO actual_successor FROM rms_catalog.option_set_draft_content_snapshot f
  WHERE f.operation_id=NEW.operation_id AND f.tenant_id=NEW.tenant_id AND f.brand_id=NEW.brand_id
  AND f.option_set_id=NEW.option_set_id AND f.option_set_version_id=NEW.successor_draft_version_id;
 IF actual_successor IS DISTINCT FROM expected_successor
 THEN RAISE EXCEPTION 'OPTION_SET_SUCCESSOR_CONFLICT' USING ERRCODE='23514'; END IF;
 RETURN NULL;
END;
$$;
CREATE CONSTRAINT TRIGGER option_set_content_commit_guard AFTER INSERT ON rms_catalog.option_set_publication_content
 DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION rms_catalog.option_set_content_commit_guard();
CREATE FUNCTION rms_catalog.option_set_frozen_commit_guard() RETURNS trigger LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
BEGIN
 IF NEW.status<>'Frozen' THEN RETURN NULL; END IF;
 IF NOT EXISTS(SELECT 1 FROM rms_catalog.option_set_publication_content c
  WHERE c.option_set_version_id=NEW.option_set_version_id AND c.option_set_id=NEW.option_set_id AND c.brand_id=NEW.brand_id)
 THEN RAISE EXCEPTION 'OPTION_SET_FROZEN_CONTENT_MISSING' USING ERRCODE='23514'; END IF;
 RETURN NULL;
END;
$$;
CREATE CONSTRAINT TRIGGER option_set_frozen_commit_guard AFTER INSERT OR UPDATE ON rms_catalog.option_set_version
 DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION rms_catalog.option_set_frozen_commit_guard();

CREATE FUNCTION rms_catalog.option_set_successor_parent_guard() RETURNS trigger LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
BEGIN
 IF NEW.option_set_version_id=OLD.option_set_version_id THEN RETURN NEW; END IF;
 IF (to_jsonb(NEW)-'option_set_version_id') IS DISTINCT FROM (to_jsonb(OLD)-'option_set_version_id')
  OR NOT EXISTS(SELECT 1 FROM rms_catalog.option_set_publication_content c
   JOIN rms_catalog.option_set_version v ON v.option_set_version_id=c.option_set_version_id AND v.status='Frozen'
   JOIN rms_catalog.option_set_version s ON s.option_set_version_id=c.successor_draft_version_id AND s.status='Draft'
   JOIN rms_catalog.option_set p ON p.option_set_id=c.option_set_id AND p.brand_id=c.brand_id
    AND p.aggregate_version=c.result_aggregate_version AND p.updated_at=c.sealed_at
   WHERE c.tenant_id::text=current_setting('bop.tenant_id',true) AND c.option_set_id=NEW.option_set_id AND c.brand_id=NEW.brand_id
   AND c.option_set_version_id=OLD.option_set_version_id AND c.successor_draft_version_id=NEW.option_set_version_id
   AND EXISTS(SELECT 1 FROM jsonb_array_elements(c.snapshot_json#>'{editorContent,sourceAggregate,draft,options}') o
    WHERE o->>'optionReference'=OLD.option_id::text))
 THEN RAISE EXCEPTION 'OPTION_SET_SUCCESSOR_PARENT_CONFLICT' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END;
$$;
CREATE TRIGGER option_set_successor_parent_guard BEFORE UPDATE OF option_set_version_id ON rms_catalog.option
 FOR EACH ROW EXECUTE FUNCTION rms_catalog.option_set_successor_parent_guard();
REVOKE ALL ON FUNCTION rms_catalog.option_set_frozen_guard() FROM PUBLIC;
REVOKE ALL ON FUNCTION rms_catalog.option_set_content_immutable() FROM PUBLIC;
REVOKE ALL ON FUNCTION rms_catalog.option_set_content_commit_guard() FROM PUBLIC;
REVOKE ALL ON FUNCTION rms_catalog.option_set_frozen_commit_guard() FROM PUBLIC;
REVOKE ALL ON FUNCTION rms_catalog.option_set_successor_parent_guard() FROM PUBLIC;
