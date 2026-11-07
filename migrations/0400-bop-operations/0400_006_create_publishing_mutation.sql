-- bop-rms-migration: 1
-- owner: @bop/publishing
-- schema: bop_publishing
-- phase: expand
-- risk: medium
-- transaction: required
-- lock-timeout-ms: 5000
-- statement-timeout-ms: 60000
-- recovery: forward-fix
CREATE TABLE bop_publishing.publishing_mutation_record (
  tenant_id platform_helpers.uuid_v7 NOT NULL,
  brand_id platform_helpers.uuid_v7 NOT NULL,
  store_id platform_helpers.uuid_v7,
  family_id platform_helpers.uuid_v7 NOT NULL,
  lifecycle_id platform_helpers.uuid_v7 NOT NULL,
  lifecycle_version bigint NOT NULL CHECK (lifecycle_version BETWEEN 1 AND 9007199254740991),
  operation_id platform_helpers.uuid_v7 NOT NULL,
  operation_code text NOT NULL CHECK (operation_code IN ('CreateDraft','SubmitReview','Approve','Publish','Archive','Rollback')),
  actor_id platform_helpers.uuid_v7 NOT NULL,
  audit_id platform_helpers.uuid_v7 NOT NULL,
  intent_hash text NOT NULL CHECK (intent_hash ~ '^sha256:[0-9a-f]{64}$'),
  release_id platform_helpers.uuid_v7,
  release_sequence bigint CHECK (release_sequence BETWEEN 1 AND 9007199254740991),
  changed_at timestamp with time zone NOT NULL CHECK (isfinite(changed_at) AND changed_at=date_trunc('milliseconds',changed_at)),
  mutation_json jsonb NOT NULL,
  CONSTRAINT publishing_mutation_pkey PRIMARY KEY (tenant_id,brand_id,lifecycle_id,lifecycle_version),
  CONSTRAINT publishing_mutation_operation_unique UNIQUE (tenant_id,brand_id,operation_id),
  CONSTRAINT publishing_mutation_audit_unique UNIQUE (tenant_id,brand_id,audit_id),
  CONSTRAINT publishing_mutation_release_unique UNIQUE (tenant_id,brand_id,release_id),
  CONSTRAINT publishing_mutation_release_shape CHECK (
    (operation_code IN ('Publish','Rollback')) = (release_id IS NOT NULL)
    AND (release_id IS NULL) = (release_sequence IS NULL)
  ),
  CONSTRAINT publishing_mutation_json_shape CHECK (coalesce((
    jsonb_typeof(mutation_json)='object'
    AND mutation_json ?& ARRAY['operation','expectedVersion','idempotencyKey','current','next','release','supersededReleaseId','rollbackTargetReleaseId','validationEvidence','approvalEvidence','audit']
    AND mutation_json#>>'{next,state}' IN ('Draft','InReview','Approved','Published','Archived','Superseded')
    AND mutation_json->>'operation'=operation_code
    AND mutation_json->>'idempotencyKey'=operation_id::text
    AND mutation_json#>>'{next,familyReference}'=family_id::text
    AND mutation_json#>>'{next,lifecycleId}'=lifecycle_id::text
    AND (mutation_json#>>'{next,version}')::bigint=lifecycle_version
    AND mutation_json#>>'{next,scope,brandReference}'=brand_id::text
    AND (mutation_json#>'{next,scope,storeReference}') IS NOT DISTINCT FROM coalesce(to_jsonb(store_id::text),'null'::jsonb)
    AND (mutation_json#>>'{next,changedAt}')::timestamptz=changed_at
    AND mutation_json#>>'{audit,brandId}'=brand_id::text
    AND mutation_json#>>'{audit,targetType}'='PublishingLifecycle'
    AND mutation_json#>>'{audit,targetId}'=lifecycle_id::text
    AND mutation_json#>>'{audit,auditId}'=audit_id::text
    AND mutation_json#>>'{audit,actor,reference}'=actor_id::text
    AND ((release_id IS NULL AND mutation_json->'release'='null'::jsonb) OR (
      mutation_json#>>'{release,releaseId}'=release_id::text
      AND (mutation_json#>>'{release,sequence}')::bigint=release_sequence
      AND mutation_json#>>'{release,sourceLifecycleId}'=lifecycle_id::text
      AND mutation_json#>>'{release,familyReference}'=family_id::text
      AND mutation_json#>>'{release,kind}'=operation_code
      AND mutation_json#>'{release,scope}'=mutation_json#>'{next,scope}'
      AND mutation_json#>'{release,snapshotReference}'=mutation_json#>'{next,snapshotReference}'
      AND mutation_json#>'{release,snapshotDigest}'=mutation_json#>'{next,snapshotDigest}'
    ))
  ),false))
);
CREATE UNIQUE INDEX publishing_mutation_release_sequence_unique
  ON bop_publishing.publishing_mutation_record (tenant_id,brand_id,store_id,family_id,release_sequence) NULLS NOT DISTINCT
  WHERE release_id IS NOT NULL;
CREATE FUNCTION bop_publishing.guard_mutation_history()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
DECLARE
  prior bop_publishing.publishing_mutation_record%ROWTYPE;
  head bop_publishing.publishing_mutation_record%ROWTYPE;
  prior_state text;
  next_state text;
BEGIN
  IF TG_OP <> 'INSERT' THEN
    RAISE EXCEPTION 'Publishing history is append-only' USING ERRCODE='55000';
  END IF;
  IF current_setting('transaction_isolation') <> 'read committed' THEN
    RAISE EXCEPTION 'Publishing requires current transaction facts' USING ERRCODE='25000';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('PublishingFamily:' || NEW.tenant_id::text || ':' || NEW.brand_id::text || ':' || coalesce(NEW.store_id::text,'Brand') || ':' || NEW.family_id::text,0));
  SELECT * INTO prior FROM bop_publishing.publishing_mutation_record
    WHERE tenant_id=NEW.tenant_id AND brand_id=NEW.brand_id AND lifecycle_id=NEW.lifecycle_id
    ORDER BY lifecycle_version DESC LIMIT 1;
  next_state := NEW.mutation_json#>>'{next,state}';
  IF NOT FOUND THEN
    IF NEW.lifecycle_version<>1 OR NEW.operation_code<>'CreateDraft' OR next_state IS DISTINCT FROM 'Draft'
      OR NEW.mutation_json->'current' IS DISTINCT FROM 'null'::jsonb
      OR NEW.mutation_json->>'expectedVersion' IS DISTINCT FROM '1' THEN
      RAISE EXCEPTION 'Publishing lifecycle start is invalid' USING ERRCODE='23514';
    END IF;
  ELSE
    prior_state := prior.mutation_json#>>'{next,state}';
    IF NEW.lifecycle_version<>prior.lifecycle_version+1 OR NEW.family_id<>prior.family_id
      OR NEW.store_id IS DISTINCT FROM prior.store_id OR NEW.changed_at<prior.changed_at
      OR NEW.mutation_json->'current' IS DISTINCT FROM prior.mutation_json->'next'
      OR NEW.mutation_json->>'expectedVersion' IS DISTINCT FROM prior.lifecycle_version::text
      OR (NEW.mutation_json->'next' - ARRAY['version','state','changedAt','validationEvidenceReference','approvalEvidenceReference','snapshotReference','snapshotDigest']) IS DISTINCT FROM (prior.mutation_json->'next' - ARRAY['version','state','changedAt','validationEvidenceReference','approvalEvidenceReference','snapshotReference','snapshotDigest'])
      OR (NEW.operation_code<>'CreateDraft' AND (NEW.mutation_json#>'{next,snapshotReference}' IS DISTINCT FROM prior.mutation_json#>'{next,snapshotReference}' OR NEW.mutation_json#>'{next,snapshotDigest}' IS DISTINCT FROM prior.mutation_json#>'{next,snapshotDigest}'))
      OR NOT ((NEW.operation_code='CreateDraft' AND prior_state='Draft' AND next_state='Draft')
        OR (NEW.operation_code='SubmitReview' AND prior_state='Draft' AND next_state='InReview')
        OR (NEW.operation_code='Approve' AND prior_state='InReview' AND next_state='Approved')
        OR (NEW.operation_code IN ('Publish','Rollback') AND prior_state='Approved' AND next_state='Published')
        OR (NEW.operation_code='Archive' AND prior_state='Published' AND next_state='Archived')) THEN
      RAISE EXCEPTION 'Publishing lifecycle chain is invalid' USING ERRCODE='23514';
    END IF;
  END IF;
  IF NEW.release_id IS NOT NULL THEN
    SELECT * INTO head FROM bop_publishing.publishing_mutation_record
      WHERE tenant_id=NEW.tenant_id AND brand_id=NEW.brand_id AND store_id IS NOT DISTINCT FROM NEW.store_id
        AND family_id=NEW.family_id AND release_id IS NOT NULL
      ORDER BY release_sequence DESC LIMIT 1;
    IF NEW.release_sequence<>coalesce(head.release_sequence,0)+1
      OR NEW.mutation_json#>'{release,previousReleaseId}' IS DISTINCT FROM coalesce(to_jsonb(head.release_id::text),'null'::jsonb)
      OR NEW.mutation_json->'supersededReleaseId' IS DISTINCT FROM coalesce(to_jsonb(head.release_id::text),'null'::jsonb) THEN
      RAISE EXCEPTION 'Publishing release head is invalid' USING ERRCODE='23514';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION bop_publishing.guard_mutation_history() FROM PUBLIC;
CREATE TRIGGER publishing_mutation_guard BEFORE INSERT OR UPDATE OR DELETE
  ON bop_publishing.publishing_mutation_record FOR EACH ROW EXECUTE FUNCTION bop_publishing.guard_mutation_history();
CREATE TRIGGER publishing_mutation_truncate_guard BEFORE TRUNCATE
  ON bop_publishing.publishing_mutation_record FOR EACH STATEMENT EXECUTE FUNCTION bop_publishing.guard_mutation_history();
ALTER TABLE bop_publishing.publishing_mutation_record ENABLE ROW LEVEL SECURITY;
ALTER TABLE bop_publishing.publishing_mutation_record FORCE ROW LEVEL SECURITY;
CREATE POLICY publishing_mutation_scope ON bop_publishing.publishing_mutation_record
  USING (tenant_id=nullif(current_setting('bop.tenant_id',true),'')::uuid
    AND brand_id=platform_helpers.current_brand_id()
    AND (store_id IS NULL OR store_id=platform_helpers.current_store_id()))
  WITH CHECK (tenant_id=nullif(current_setting('bop.tenant_id',true),'')::uuid
    AND brand_id=platform_helpers.current_brand_id()
    AND (store_id IS NULL OR store_id=platform_helpers.current_store_id()));
REVOKE ALL ON TABLE bop_publishing.publishing_mutation_record FROM PUBLIC;
