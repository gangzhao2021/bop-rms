-- bop-rms-migration: 1
-- owner: @rms/catalog
-- schema: rms_catalog
-- phase: expand
-- risk: medium
-- transaction: required
-- lock-timeout-ms: 5000
-- statement-timeout-ms: 60000
-- recovery: forward-fix
-- New participating commits only. Historical operations are not backfilled.
CREATE TABLE rms_catalog.product_source_head (
  brand_id platform_helpers.uuid_v7 PRIMARY KEY,
  source_revision bigint NOT NULL CHECK (source_revision > 0),
  data_classification text NOT NULL DEFAULT 'ConfigurationMetadata'
    CHECK (data_classification = 'ConfigurationMetadata')
);
CREATE FUNCTION rms_catalog.product_source_head_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'PRODUCT_SOURCE_HEAD_IMMUTABLE' USING ERRCODE = '55000';
  ELSIF TG_OP = 'INSERT' THEN
    IF NEW.source_revision <> 1 THEN
      RAISE EXCEPTION 'PRODUCT_SOURCE_REVISION_INVALID' USING ERRCODE = '23514';
    END IF;
  ELSE
    IF NEW.brand_id <> OLD.brand_id OR OLD.source_revision = 9223372036854775807
       OR NEW.source_revision <> OLD.source_revision + 1 THEN
      RAISE EXCEPTION 'PRODUCT_SOURCE_REVISION_INVALID' USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER product_source_head_guard BEFORE INSERT OR UPDATE OR DELETE
ON rms_catalog.product_source_head FOR EACH ROW EXECUTE FUNCTION rms_catalog.product_source_head_guard();
REVOKE ALL ON FUNCTION rms_catalog.product_source_head_guard() FROM PUBLIC;
CREATE TABLE rms_catalog.product_source_commit (
  operation_id platform_helpers.uuid_v7 PRIMARY KEY REFERENCES rms_catalog.product_operation_record(operation_id),
  brand_id platform_helpers.uuid_v7 NOT NULL REFERENCES rms_catalog.product_source_head(brand_id),
  source_revision bigint NOT NULL CHECK (source_revision > 0),
  product_id platform_helpers.uuid_v7 NOT NULL,
  result_aggregate_version integer NOT NULL CHECK (result_aggregate_version > 0),
  event_id platform_helpers.uuid_v7 NOT NULL UNIQUE,
  event_type text NOT NULL CHECK (event_type IN ('ProductCreated','ProductDraftUpdated','ProductActivated','ProductSuspended','ProductResumed','ProductDiscontinued','ProductArchived','ProductRestored')),
  actor_id platform_helpers.uuid_v7 NOT NULL,
  correlation_id platform_helpers.uuid_v7 NOT NULL,
  event_digest text NOT NULL CHECK (event_digest ~ '^sha256:[0-9a-f]{64}$'),
  snapshot_digest text NOT NULL CHECK (snapshot_digest ~ '^sha256:[0-9a-f]{64}$'),
  occurred_at timestamp with time zone NOT NULL,
  data_classification text NOT NULL DEFAULT 'ConfigurationMetadata' CHECK (data_classification = 'ConfigurationMetadata'),
  FOREIGN KEY(product_id,brand_id) REFERENCES rms_catalog.product(product_id,brand_id),
  UNIQUE(brand_id,source_revision),
  UNIQUE(brand_id,product_id,result_aggregate_version)
);
CREATE RULE product_source_commit_no_update AS ON UPDATE TO rms_catalog.product_source_commit DO INSTEAD NOTHING;
CREATE RULE product_source_commit_no_delete AS ON DELETE TO rms_catalog.product_source_commit DO INSTEAD NOTHING;
ALTER TABLE rms_catalog.product_source_head ENABLE ROW LEVEL SECURITY;
ALTER TABLE rms_catalog.product_source_head FORCE ROW LEVEL SECURITY;
ALTER TABLE rms_catalog.product_source_commit ENABLE ROW LEVEL SECURITY;
ALTER TABLE rms_catalog.product_source_commit FORCE ROW LEVEL SECURITY;
CREATE POLICY product_source_head_brand_scope ON rms_catalog.product_source_head
  USING (brand_id = platform_helpers.current_brand_id() AND platform_helpers.current_store_id() IS NULL)
  WITH CHECK (brand_id = platform_helpers.current_brand_id() AND platform_helpers.current_store_id() IS NULL);
CREATE POLICY product_source_commit_brand_scope ON rms_catalog.product_source_commit
  USING (brand_id = platform_helpers.current_brand_id() AND platform_helpers.current_store_id() IS NULL)
  WITH CHECK (brand_id = platform_helpers.current_brand_id() AND platform_helpers.current_store_id() IS NULL);
REVOKE ALL ON TABLE rms_catalog.product_source_head,rms_catalog.product_source_commit FROM PUBLIC;
