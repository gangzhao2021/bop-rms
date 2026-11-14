-- bop-rms-migration: 1
-- owner: @bop/publishing
-- schema: bop_publishing
-- phase: expand
-- risk: medium
-- transaction: required
-- lock-timeout-ms: 5000
-- statement-timeout-ms: 60000
-- recovery: forward-fix
-- 0400_006 was applied in isolated acceptance; retain it unchanged.
-- Parenthesize JSON extraction before the higher-precedence subtraction operator.
CREATE FUNCTION bop_publishing.guard_mutation_history_v2()
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
      OR ((NEW.mutation_json->'next') - ARRAY['version','state','changedAt','validationEvidenceReference','approvalEvidenceReference','snapshotReference','snapshotDigest']) IS DISTINCT FROM ((prior.mutation_json->'next') - ARRAY['version','state','changedAt','validationEvidenceReference','approvalEvidenceReference','snapshotReference','snapshotDigest'])
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
REVOKE ALL ON FUNCTION bop_publishing.guard_mutation_history_v2() FROM PUBLIC;
DROP TRIGGER publishing_mutation_guard ON bop_publishing.publishing_mutation_record;
DROP TRIGGER publishing_mutation_truncate_guard ON bop_publishing.publishing_mutation_record;
CREATE TRIGGER publishing_mutation_guard BEFORE INSERT OR UPDATE OR DELETE
  ON bop_publishing.publishing_mutation_record FOR EACH ROW EXECUTE FUNCTION bop_publishing.guard_mutation_history_v2();
CREATE TRIGGER publishing_mutation_truncate_guard BEFORE TRUNCATE
  ON bop_publishing.publishing_mutation_record FOR EACH STATEMENT EXECUTE FUNCTION bop_publishing.guard_mutation_history_v2();
