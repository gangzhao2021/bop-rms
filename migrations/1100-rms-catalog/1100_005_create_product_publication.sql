-- bop-rms-migration: 1
-- owner: @rms/catalog
-- schema: rms_catalog
-- phase: expand
-- risk: medium
-- transaction: required
-- lock-timeout-ms: 5000
-- statement-timeout-ms: 60000
-- recovery: forward-fix
-- Owning persistence only; a normal publisher must still supply current authority,
-- validation, immutable content, successor, Audit and Outbox in the same UoW.
ALTER TABLE rms_catalog.product_version DROP CONSTRAINT product_version_status_check;
ALTER TABLE rms_catalog.product_version ADD CONSTRAINT product_version_status_check CHECK(status IN ('Draft','Frozen'));
ALTER TABLE rms_catalog.product_version DROP CONSTRAINT product_version_one_draft_unique;
CREATE UNIQUE INDEX product_version_one_draft_unique ON rms_catalog.product_version(product_id) WHERE status='Draft';
ALTER TABLE rms_catalog.product_operation_record DROP CONSTRAINT product_operation_record_action_code_check;
ALTER TABLE rms_catalog.product_operation_record ADD CONSTRAINT product_operation_record_action_code_check
CHECK(action_code IN ('Create','ReplaceDraft','ChangeLifecycle','ProductPublication'));
ALTER TABLE rms_catalog.product_source_commit DROP CONSTRAINT product_source_commit_event_type_check;
ALTER TABLE rms_catalog.product_source_commit ADD CONSTRAINT product_source_commit_event_type_check
CHECK(event_type IN ('ProductCreated','ProductDraftUpdated','ProductActivated','ProductSuspended','ProductResumed','ProductDiscontinued','ProductArchived','ProductRestored',
'ProductValidationCompleted','ProductReviewSubmitted','ProductVersionApproved','ProductVersionRejected','ProductVersionPublishScheduled','ProductVersionPublishRescheduled','ProductVersionPublishScheduleCancelled','ProductVersionPublished','ProductVersionSuperseded'));

CREATE TABLE rms_catalog.product_publication_revision (
 operation_id platform_helpers.uuid_v7 PRIMARY KEY REFERENCES rms_catalog.product_operation_record(operation_id),
 tenant_id platform_helpers.uuid_v7 NOT NULL,
 brand_id platform_helpers.uuid_v7 NOT NULL,
 product_id platform_helpers.uuid_v7 NOT NULL,
 product_version_id platform_helpers.uuid_v7 NOT NULL,
 publication_version integer NOT NULL CHECK(publication_version>0),
 source_aggregate_version integer NOT NULL CHECK(source_aggregate_version>0 AND source_aggregate_version<2147483647),
 result_aggregate_version integer NOT NULL CHECK(result_aggregate_version=source_aggregate_version+1),
 action_code text NOT NULL CHECK(action_code IN ('Validate','SubmitReview','Approve','Reject','Publish','SchedulePublish','ReschedulePublish','CancelScheduledPublish','ActivateScheduled','Supersede')),
 state text NOT NULL CHECK(state IN ('Draft','InReview','Approved','Scheduled','Published','Superseded')),
 intent_digest text NOT NULL CHECK(intent_digest ~ '^sha256:[0-9a-f]{64}$'),
 content_digest text NOT NULL CHECK(content_digest ~ '^sha256:[0-9a-f]{64}$'),
 configuration_digest text NOT NULL CHECK(configuration_digest ~ '^sha256:[0-9a-f]{64}$'),
 occurred_at timestamptz NOT NULL CHECK(date_trunc('milliseconds',occurred_at)=occurred_at),
 snapshot_json jsonb NOT NULL CHECK(jsonb_typeof(snapshot_json)='object'),
 data_classification text NOT NULL DEFAULT 'ConfigurationMetadata' CHECK(data_classification='ConfigurationMetadata'),
 UNIQUE(product_version_id,publication_version),
 FOREIGN KEY(product_version_id,product_id,brand_id) REFERENCES rms_catalog.product_version(product_version_id,product_id,brand_id),
 CHECK((snapshot_json->>'tenantReference') IS NOT DISTINCT FROM tenant_id::text),
 CHECK((snapshot_json->>'brandReference') IS NOT DISTINCT FROM brand_id::text),
 CHECK((snapshot_json->>'productReference') IS NOT DISTINCT FROM product_id::text),
 CHECK((snapshot_json->>'versionReference') IS NOT DISTINCT FROM product_version_id::text),
 CHECK((snapshot_json->>'operationReference') IS NOT DISTINCT FROM operation_id::text),
 CHECK((snapshot_json->'publicationVersion') IS NOT DISTINCT FROM to_jsonb(publication_version)),
 CHECK((snapshot_json->'productAggregateVersion') IS NOT DISTINCT FROM to_jsonb(source_aggregate_version)),
 CHECK((snapshot_json->>'state') IS NOT DISTINCT FROM state),
 CHECK((snapshot_json->>'intentDigest') IS NOT DISTINCT FROM intent_digest),
 CHECK((snapshot_json->>'contentDigest') IS NOT DISTINCT FROM content_digest),
 CHECK((snapshot_json->>'configurationDigest') IS NOT DISTINCT FROM configuration_digest),
 CHECK((snapshot_json->>'occurredAt') IS NOT DISTINCT FROM to_char(occurred_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'))
);
CREATE TABLE rms_catalog.product_publication_content (
 product_version_id platform_helpers.uuid_v7 PRIMARY KEY,
 tenant_id platform_helpers.uuid_v7 NOT NULL,
 brand_id platform_helpers.uuid_v7 NOT NULL,
 product_id platform_helpers.uuid_v7 NOT NULL,
 publication_operation_id platform_helpers.uuid_v7 NOT NULL UNIQUE REFERENCES rms_catalog.product_publication_revision(operation_id) DEFERRABLE INITIALLY DEFERRED,
 source_aggregate_version integer NOT NULL CHECK(source_aggregate_version>0 AND source_aggregate_version<2147483647),
 content_digest text NOT NULL CHECK(content_digest ~ '^sha256:[0-9a-f]{64}$'),
 configuration_digest text NOT NULL CHECK(configuration_digest ~ '^sha256:[0-9a-f]{64}$'),
 sealed_at timestamptz NOT NULL CHECK(date_trunc('milliseconds',sealed_at)=sealed_at),
 snapshot_json jsonb NOT NULL CHECK(jsonb_typeof(snapshot_json)='object'),
 data_classification text NOT NULL DEFAULT 'ConfigurationMetadata' CHECK(data_classification='ConfigurationMetadata'),
 FOREIGN KEY(product_version_id,product_id,brand_id) REFERENCES rms_catalog.product_version(product_version_id,product_id,brand_id),
 CHECK((snapshot_json->>'profile') IS NOT DISTINCT FROM 'CatalogSupportedProductDraftContentV1'),
 CHECK((snapshot_json->>'tenantReference') IS NOT DISTINCT FROM tenant_id::text),
 CHECK((snapshot_json->>'brandReference') IS NOT DISTINCT FROM brand_id::text),
 CHECK((snapshot_json->>'productReference') IS NOT DISTINCT FROM product_id::text),
 CHECK((snapshot_json->>'versionReference') IS NOT DISTINCT FROM product_version_id::text),
 CHECK((snapshot_json->>'publicationOperationReference') IS NOT DISTINCT FROM publication_operation_id::text),
 CHECK((snapshot_json->'sourceAggregateVersion') IS NOT DISTINCT FROM to_jsonb(source_aggregate_version)),
 CHECK((snapshot_json->>'contentDigest') IS NOT DISTINCT FROM content_digest),
 CHECK((snapshot_json->>'configurationDigest') IS NOT DISTINCT FROM configuration_digest),
 CHECK((snapshot_json->>'sealedAt') IS NOT DISTINCT FROM to_char(sealed_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'))
);
CREATE FUNCTION rms_catalog.product_publication_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 RAISE EXCEPTION 'PRODUCT_PUBLICATION_IMMUTABLE' USING ERRCODE='55000';
END;
$$;
CREATE TRIGGER product_publication_revision_immutable BEFORE UPDATE OR DELETE ON rms_catalog.product_publication_revision FOR EACH ROW EXECUTE FUNCTION rms_catalog.product_publication_immutable();
CREATE TRIGGER product_publication_content_immutable BEFORE UPDATE OR DELETE ON rms_catalog.product_publication_content FOR EACH ROW EXECUTE FUNCTION rms_catalog.product_publication_immutable();
CREATE FUNCTION rms_catalog.product_frozen_version_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF OLD.status='Frozen' THEN RAISE EXCEPTION 'PRODUCT_VERSION_IMMUTABLE' USING ERRCODE='55000'; END IF;
 IF TG_OP='DELETE' THEN RETURN OLD; END IF;
 RETURN NEW;
END;
$$;
CREATE TRIGGER product_frozen_version_guard BEFORE UPDATE OR DELETE ON rms_catalog.product_version FOR EACH ROW EXECUTE FUNCTION rms_catalog.product_frozen_version_guard();

CREATE FUNCTION rms_catalog.product_publication_revision_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE previous rms_catalog.product_publication_revision; operation rms_catalog.product_operation_record;
BEGIN
 IF (NEW.tenant_id::text=current_setting('bop.tenant_id',true) AND NEW.brand_id=platform_helpers.current_brand_id() AND platform_helpers.current_store_id() IS NULL) IS NOT TRUE THEN RAISE EXCEPTION 'PRODUCT_PUBLICATION_UNAVAILABLE' USING ERRCODE='55000'; END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended('CatalogProductSource:'||NEW.brand_id::text,0));
 SELECT * INTO previous FROM rms_catalog.product_publication_revision WHERE product_version_id=NEW.product_version_id ORDER BY publication_version DESC LIMIT 1;
 IF NOT FOUND THEN
  IF NEW.publication_version<>1 OR NEW.action_code<>'Validate' OR NEW.state<>'Draft' THEN RAISE EXCEPTION 'PRODUCT_PUBLICATION_VERSION_CONFLICT' USING ERRCODE='23514'; END IF;
 ELSE
  IF previous.tenant_id<>NEW.tenant_id OR NEW.publication_version<>previous.publication_version+1 OR NEW.source_aggregate_version<previous.result_aggregate_version OR NEW.occurred_at<previous.occurred_at THEN RAISE EXCEPTION 'PRODUCT_PUBLICATION_VERSION_CONFLICT' USING ERRCODE='23514'; END IF;
 END IF;
 IF NOT EXISTS(SELECT 1 FROM rms_catalog.product WHERE product_id=NEW.product_id AND brand_id=NEW.brand_id AND aggregate_version=NEW.result_aggregate_version) THEN RAISE EXCEPTION 'PRODUCT_PUBLICATION_ROOT_CONFLICT' USING ERRCODE='23514'; END IF;
 IF previous.operation_id IS NOT NULL AND NOT (
 (NEW.action_code='Validate' AND previous.state='Draft' AND NEW.state='Draft') OR
 (NEW.action_code='SubmitReview' AND previous.state='Draft' AND NEW.state='InReview') OR
 (NEW.action_code='Approve' AND previous.state='InReview' AND NEW.state='Approved') OR
 (NEW.action_code='Reject' AND previous.state='InReview' AND NEW.state='Draft') OR
 (NEW.action_code='Publish' AND previous.state IN ('Approved','InReview') AND NEW.state='Published') OR
 (NEW.action_code='SchedulePublish' AND previous.state IN ('Approved','InReview') AND NEW.state='Scheduled') OR
 (NEW.action_code='ReschedulePublish' AND previous.state='Scheduled' AND NEW.state='Scheduled') OR
 (NEW.action_code='CancelScheduledPublish' AND previous.state='Scheduled' AND NEW.state='Draft') OR
 (NEW.action_code='ActivateScheduled' AND previous.state='Scheduled' AND NEW.state='Published') OR
 (NEW.action_code='Supersede' AND previous.state='Published' AND NEW.state='Superseded')
 ) THEN RAISE EXCEPTION 'PRODUCT_PUBLICATION_STATE_CONFLICT' USING ERRCODE='23514'; END IF;
 SELECT * INTO operation FROM rms_catalog.product_operation_record WHERE operation_id=NEW.operation_id AND brand_id=NEW.brand_id AND product_id=NEW.product_id;
 IF NOT FOUND OR operation.action_code<>'ProductPublication' OR operation.intent_digest<>NEW.intent_digest OR operation.result_aggregate_version<>NEW.result_aggregate_version OR operation.occurred_at<>NEW.occurred_at THEN RAISE EXCEPTION 'PRODUCT_PUBLICATION_SOURCE_CONFLICT' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END;
$$;
CREATE TRIGGER product_publication_revision_guard BEFORE INSERT ON rms_catalog.product_publication_revision FOR EACH ROW EXECUTE FUNCTION rms_catalog.product_publication_revision_guard();

CREATE FUNCTION rms_catalog.product_publication_commit_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE expected_event text;
BEGIN
 expected_event:=CASE NEW.action_code WHEN 'Validate' THEN 'ProductValidationCompleted' WHEN 'SubmitReview' THEN 'ProductReviewSubmitted' WHEN 'Approve' THEN 'ProductVersionApproved' WHEN 'Reject' THEN 'ProductVersionRejected' WHEN 'SchedulePublish' THEN 'ProductVersionPublishScheduled' WHEN 'ReschedulePublish' THEN 'ProductVersionPublishRescheduled' WHEN 'CancelScheduledPublish' THEN 'ProductVersionPublishScheduleCancelled' WHEN 'Supersede' THEN 'ProductVersionSuperseded' ELSE 'ProductVersionPublished' END;
 IF NOT EXISTS(SELECT 1 FROM rms_catalog.product_operation_snapshot s JOIN rms_catalog.product_source_commit c ON c.operation_id=s.operation_id WHERE s.operation_id=NEW.operation_id AND s.brand_id=NEW.brand_id AND s.product_id=NEW.product_id AND s.result_aggregate_version=NEW.result_aggregate_version AND s.occurred_at=NEW.occurred_at AND c.brand_id=s.brand_id AND c.product_id=s.product_id AND c.result_aggregate_version=s.result_aggregate_version AND c.occurred_at=s.occurred_at AND c.event_type=expected_event) THEN RAISE EXCEPTION 'PRODUCT_PUBLICATION_RECEIPT_MISSING' USING ERRCODE='23514'; END IF;
 IF NEW.state IN ('Published','Superseded') AND NOT EXISTS(SELECT 1 FROM rms_catalog.product_publication_content c JOIN rms_catalog.product_version v ON v.product_version_id=c.product_version_id JOIN rms_catalog.product_version d ON d.product_id=v.product_id AND d.brand_id=v.brand_id AND d.product_version_id=(NEW.snapshot_json->>'successorDraftVersionReference')::uuid AND d.base_product_version_id=v.product_version_id WHERE c.product_version_id=NEW.product_version_id AND c.tenant_id=NEW.tenant_id AND c.brand_id=NEW.brand_id AND c.product_id=NEW.product_id AND c.content_digest=NEW.content_digest AND c.configuration_digest=NEW.configuration_digest AND (NEW.state='Superseded' OR (c.publication_operation_id=NEW.operation_id AND c.source_aggregate_version=NEW.source_aggregate_version AND c.sealed_at=NEW.occurred_at)) AND v.status='Frozen') THEN RAISE EXCEPTION 'PRODUCT_PUBLICATION_CONTENT_MISSING' USING ERRCODE='23514'; END IF;
 IF NEW.state='Published' AND EXISTS(
 SELECT 1 FROM rms_catalog.product_publication_content c WHERE c.product_version_id=NEW.product_version_id AND (
 EXISTS(SELECT 1 FROM jsonb_array_elements(c.snapshot_json->'sourceDraft'->'skus') m WHERE NOT EXISTS(SELECT 1 FROM rms_catalog.sku s WHERE s.sku_id=(m->>'skuReference')::uuid AND s.product_id=NEW.product_id AND s.brand_id=NEW.brand_id AND s.product_version_id=(NEW.snapshot_json->>'successorDraftVersionReference')::uuid)) OR
 EXISTS(SELECT 1 FROM jsonb_array_elements(c.snapshot_json->'sourceDraft'->'optionBindings') m WHERE NOT EXISTS(SELECT 1 FROM rms_catalog.product_option_binding b WHERE b.binding_id=(m->>'bindingReference')::uuid AND b.product_id=NEW.product_id AND b.brand_id=NEW.brand_id AND b.product_version_id=(NEW.snapshot_json->>'successorDraftVersionReference')::uuid))
 )) THEN RAISE EXCEPTION 'PRODUCT_SUCCESSOR_PARENT_MISSING' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END;
$$;
CREATE CONSTRAINT TRIGGER product_publication_commit_guard AFTER INSERT ON rms_catalog.product_publication_revision DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION rms_catalog.product_publication_commit_guard();
CREATE FUNCTION rms_catalog.product_publication_content_commit_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NOT EXISTS(SELECT 1 FROM rms_catalog.product_publication_revision r WHERE r.operation_id=NEW.publication_operation_id AND r.tenant_id=NEW.tenant_id AND r.brand_id=NEW.brand_id AND r.product_id=NEW.product_id AND r.product_version_id=NEW.product_version_id AND r.state='Published' AND r.source_aggregate_version=NEW.source_aggregate_version AND r.content_digest=NEW.content_digest AND r.configuration_digest=NEW.configuration_digest AND r.occurred_at=NEW.sealed_at) THEN RAISE EXCEPTION 'PRODUCT_PUBLICATION_CONTENT_CONFLICT' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END;
$$;
CREATE CONSTRAINT TRIGGER product_publication_content_commit_guard AFTER INSERT ON rms_catalog.product_publication_content DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION rms_catalog.product_publication_content_commit_guard();
CREATE FUNCTION rms_catalog.product_frozen_commit_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW.status='Frozen' AND NOT EXISTS(SELECT 1 FROM rms_catalog.product_publication_content c JOIN rms_catalog.product_publication_revision r ON r.operation_id=c.publication_operation_id WHERE c.product_version_id=NEW.product_version_id AND c.brand_id=NEW.brand_id AND c.product_id=NEW.product_id AND r.state='Published') THEN RAISE EXCEPTION 'PRODUCT_PUBLICATION_CONTENT_MISSING' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END;
$$;
CREATE CONSTRAINT TRIGGER product_frozen_commit_guard AFTER INSERT OR UPDATE ON rms_catalog.product_version DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION rms_catalog.product_frozen_commit_guard();
ALTER TABLE rms_catalog.product_publication_revision ENABLE ROW LEVEL SECURITY;
ALTER TABLE rms_catalog.product_publication_revision FORCE ROW LEVEL SECURITY;
ALTER TABLE rms_catalog.product_publication_content ENABLE ROW LEVEL SECURITY;
ALTER TABLE rms_catalog.product_publication_content FORCE ROW LEVEL SECURITY;
CREATE POLICY product_publication_revision_scope ON rms_catalog.product_publication_revision USING((tenant_id::text=current_setting('bop.tenant_id',true) AND brand_id=platform_helpers.current_brand_id() AND platform_helpers.current_store_id() IS NULL) IS TRUE) WITH CHECK((tenant_id::text=current_setting('bop.tenant_id',true) AND brand_id=platform_helpers.current_brand_id() AND platform_helpers.current_store_id() IS NULL) IS TRUE);
CREATE POLICY product_publication_content_scope ON rms_catalog.product_publication_content USING((tenant_id::text=current_setting('bop.tenant_id',true) AND brand_id=platform_helpers.current_brand_id() AND platform_helpers.current_store_id() IS NULL) IS TRUE) WITH CHECK((tenant_id::text=current_setting('bop.tenant_id',true) AND brand_id=platform_helpers.current_brand_id() AND platform_helpers.current_store_id() IS NULL) IS TRUE);
REVOKE ALL ON TABLE rms_catalog.product_publication_revision,rms_catalog.product_publication_content FROM PUBLIC;
REVOKE ALL ON FUNCTION rms_catalog.product_publication_immutable(),rms_catalog.product_frozen_version_guard(),rms_catalog.product_publication_revision_guard(),rms_catalog.product_publication_commit_guard() FROM PUBLIC;

REVOKE ALL ON FUNCTION rms_catalog.product_publication_content_commit_guard(),rms_catalog.product_frozen_commit_guard() FROM PUBLIC;

-- Section70.4 stable SKU identity is retained. Only its current editable Version
-- parent may move, backed by the owning immutable publication and successor.
DROP RULE sku_identity_no_update ON rms_catalog.sku;
CREATE RULE sku_identity_no_update AS ON UPDATE TO rms_catalog.sku
WHERE(OLD.sku_id IS DISTINCT FROM NEW.sku_id OR OLD.product_id IS DISTINCT FROM NEW.product_id OR OLD.brand_id IS DISTINCT FROM NEW.brand_id OR OLD.sku_code IS DISTINCT FROM NEW.sku_code OR OLD.unit_of_sale IS DISTINCT FROM NEW.unit_of_sale OR OLD.unit_quantity IS DISTINCT FROM NEW.unit_quantity OR OLD.created_at IS DISTINCT FROM NEW.created_at OR OLD.created_by_actor_id IS DISTINCT FROM NEW.created_by_actor_id) DO INSTEAD NOTHING;
CREATE FUNCTION rms_catalog.product_successor_parent_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE identity_field text; member_field text;
BEGIN
 IF NEW.product_version_id=OLD.product_version_id THEN RETURN NEW; END IF;
 IF (to_jsonb(NEW)-'product_version_id') IS DISTINCT FROM (to_jsonb(OLD)-'product_version_id') THEN RAISE EXCEPTION 'PRODUCT_SUCCESSOR_PARENT_CONFLICT' USING ERRCODE='23514'; END IF;
 IF TG_TABLE_NAME='sku' THEN identity_field:='skuReference'; member_field:='skus'; ELSE identity_field:='bindingReference'; member_field:='optionBindings'; END IF;
 IF NOT EXISTS(SELECT 1 FROM rms_catalog.product_version old_version JOIN rms_catalog.product_version successor ON successor.base_product_version_id=old_version.product_version_id AND successor.product_id=old_version.product_id AND successor.brand_id=old_version.brand_id JOIN rms_catalog.product_publication_content c ON c.product_version_id=old_version.product_version_id JOIN rms_catalog.product_publication_revision r ON r.operation_id=c.publication_operation_id JOIN rms_catalog.product p ON p.product_id=r.product_id AND p.brand_id=r.brand_id WHERE old_version.product_version_id=OLD.product_version_id AND old_version.status='Frozen' AND successor.product_version_id=NEW.product_version_id AND successor.status='Draft' AND old_version.product_id=NEW.product_id AND old_version.brand_id=NEW.brand_id AND c.tenant_id::text=current_setting('bop.tenant_id',true) AND r.state='Published' AND r.result_aggregate_version=p.aggregate_version AND (r.snapshot_json->>'successorDraftVersionReference') IS NOT DISTINCT FROM NEW.product_version_id::text AND EXISTS(SELECT 1 FROM jsonb_array_elements(c.snapshot_json->'sourceDraft'->member_field) m WHERE m->>identity_field=to_jsonb(OLD)->>CASE WHEN TG_TABLE_NAME='sku' THEN 'sku_id' ELSE 'binding_id' END)) THEN RAISE EXCEPTION 'PRODUCT_SUCCESSOR_PARENT_CONFLICT' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END;
$$;
CREATE TRIGGER product_sku_successor_parent_guard BEFORE UPDATE OF product_version_id ON rms_catalog.sku FOR EACH ROW EXECUTE FUNCTION rms_catalog.product_successor_parent_guard();
REVOKE ALL ON FUNCTION rms_catalog.product_successor_parent_guard() FROM PUBLIC;

REVOKE ALL ON FUNCTION rms_catalog.product_publication_immutable() FROM PUBLIC;

REVOKE ALL ON FUNCTION rms_catalog.product_frozen_version_guard() FROM PUBLIC;

REVOKE ALL ON FUNCTION rms_catalog.product_publication_revision_guard() FROM PUBLIC;

REVOKE ALL ON FUNCTION rms_catalog.product_publication_commit_guard() FROM PUBLIC;

REVOKE ALL ON FUNCTION rms_catalog.product_publication_content_commit_guard() FROM PUBLIC;

REVOKE ALL ON FUNCTION rms_catalog.product_frozen_commit_guard() FROM PUBLIC;
