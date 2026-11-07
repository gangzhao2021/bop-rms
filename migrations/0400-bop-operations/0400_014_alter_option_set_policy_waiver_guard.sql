-- bop-rms-migration: 1
-- owner: @bop/publishing
-- schema: bop_publishing
-- phase: expand
-- risk: medium
-- transaction: required
-- lock-timeout-ms: 5000
-- statement-timeout-ms: 60000
-- recovery: forward-fix
-- Forward-only Option content waiver; governance policy itself still requires independent approval.
-- Application configuration is not a database trust fact. This guard verifies stored owner history,
-- not an adversary capable of fabricating an entire trusted chain with writer privileges.
CREATE FUNCTION bop_publishing.guard_mutation_history_v3()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
DECLARE
  prior bop_publishing.publishing_mutation_record%ROWTYPE;
  head bop_publishing.publishing_mutation_record%ROWTYPE;
  prior_state text;
  next_state text;
  binding jsonb;
  waiver jsonb;
  policy_release bop_publishing.publishing_mutation_record%ROWTYPE;
  policy_review bop_publishing.publishing_mutation_record%ROWTYPE;
  policy_approval bop_publishing.publishing_mutation_record%ROWTYPE;
  policy_created bop_publishing.publishing_mutation_record%ROWTYPE;
  policy_head bop_publishing.publishing_mutation_record%ROWTYPE;
  is_waived boolean;

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
  waiver := NEW.mutation_json->'optionSetApprovalWaiver';
  is_waived := waiver IS NOT NULL;
  binding := CASE WHEN is_waived THEN waiver->'reviewPolicy' ELSE NEW.mutation_json->'optionSetReviewPolicy' END;
  IF NEW.mutation_json ? 'optionSetReviewPolicy' AND NEW.operation_code <> 'SubmitReview'
     OR is_waived AND NEW.operation_code <> 'Publish' THEN
    RAISE EXCEPTION 'Option waiver operation is invalid' USING ERRCODE='23514';
  END IF;
  IF binding IS NOT NULL THEN
    IF jsonb_typeof(binding) IS DISTINCT FROM 'object'
      OR binding->>'profile' IS DISTINCT FROM 'PublishingOptionSetReviewPolicyV1'
      OR (binding - ARRAY['profile','tenantReference','policyContent','policyReleaseReference','policyReleaseSequence','policySnapshotDigest','reviewOperationReference','reviewLifecycle','validationEvidence','submittedActorReference','submittedAt']) <> '{}'::jsonb
      OR NOT binding ?& ARRAY['profile','tenantReference','policyContent','policyReleaseReference','policyReleaseSequence','policySnapshotDigest','reviewOperationReference','reviewLifecycle','validationEvidence','submittedActorReference','submittedAt']
      OR NEW.store_id IS NOT NULL OR NEW.mutation_json#>>'{next,scope,kind}' IS DISTINCT FROM 'Brand'
      OR NEW.mutation_json#>>'{next,configurationType}' IS DISTINCT FROM 'CATALOG_OPTION_SET'
      OR NEW.mutation_json#>>'{next,purposeCode}' IS DISTINCT FROM 'CATALOG_OPTION_SET_PUBLICATION'
      OR binding->>'tenantReference' IS DISTINCT FROM NEW.tenant_id::text
      OR binding#>>'{policyContent,tenantReference}' IS DISTINCT FROM NEW.tenant_id::text
      OR binding#>>'{policyContent,brandReference}' IS DISTINCT FROM NEW.brand_id::text
      OR binding#>>'{reviewLifecycle,configurationType}' IS DISTINCT FROM 'CATALOG_OPTION_SET'
      OR binding#>>'{reviewLifecycle,purposeCode}' IS DISTINCT FROM 'CATALOG_OPTION_SET_PUBLICATION'
      OR binding#>>'{reviewLifecycle,state}' IS DISTINCT FROM 'InReview'
      OR binding#>'{reviewLifecycle,approvalEvidenceReference}' IS DISTINCT FROM 'null'::jsonb
      OR binding#>'{reviewLifecycle,scope}' IS DISTINCT FROM NEW.mutation_json#>'{next,scope}'
      OR binding#>'{reviewLifecycle,snapshotReference}' IS DISTINCT FROM NEW.mutation_json#>'{next,snapshotReference}'
      OR binding#>'{reviewLifecycle,snapshotDigest}' IS DISTINCT FROM NEW.mutation_json#>'{next,snapshotDigest}'
      OR binding->'validationEvidence' IS DISTINCT FROM NEW.mutation_json->'validationEvidence'
      OR binding#>>'{validationEvidence,result}' IS DISTINCT FROM 'Pass'
      OR binding#>'{validationEvidence,scope}' IS DISTINCT FROM NEW.mutation_json#>'{next,scope}'
      OR binding#>'{validationEvidence,snapshotReference}' IS DISTINCT FROM NEW.mutation_json#>'{next,snapshotReference}'
      OR binding#>'{validationEvidence,snapshotDigest}' IS DISTINCT FROM NEW.mutation_json#>'{next,snapshotDigest}'
      OR binding#>'{validationEvidence,evidenceReference}' IS DISTINCT FROM NEW.mutation_json#>'{next,validationEvidenceReference}'
      OR (binding#>>'{validationEvidence,checkedAt}')::timestamptz > (binding->>'submittedAt')::timestamptz
      OR (binding#>>'{validationEvidence,validUntil}')::timestamptz <= NEW.changed_at
      OR binding#>>'{policyContent,profile}' IS DISTINCT FROM 'PublishingOptionSetPublicationPolicyV1'
      OR (binding#>>'{policyContent,effectiveFrom}')::timestamptz > (binding->>'submittedAt')::timestamptz
      OR (binding#>>'{policyContent,effectiveUntil}')::timestamptz <= NEW.changed_at THEN
      RAISE EXCEPTION 'Option review policy binding is invalid' USING ERRCODE='23514';
    END IF;
    -- Hold the owning current source through this INSERT and the outer COMMIT.
    LOCK TABLE bop_publishing.publishing_mutation_record IN SHARE MODE;
    SELECT * INTO policy_release FROM bop_publishing.publishing_mutation_record
      WHERE tenant_id=NEW.tenant_id AND brand_id=NEW.brand_id AND store_id IS NULL
        AND release_id::text=binding->>'policyReleaseReference';
    IF NOT FOUND OR policy_release.operation_code NOT IN ('Publish','Rollback')
      OR policy_release.mutation_json#>>'{next,state}' IS DISTINCT FROM 'Published'
      OR policy_release.mutation_json#>>'{next,configurationType}' IS DISTINCT FROM 'OPTION_SET_PUBLICATION_POLICY'
      OR policy_release.mutation_json#>>'{next,purposeCode}' IS DISTINCT FROM 'OPTION_SET_PUBLICATION_POLICY'
      OR policy_release.family_id::text IS DISTINCT FROM binding#>>'{policyContent,familyReference}'
      OR policy_release.release_sequence::text IS DISTINCT FROM binding->>'policyReleaseSequence'
      OR policy_release.mutation_json#>>'{next,snapshotReference}' IS DISTINCT FROM binding#>>'{policyContent,policyReference}'
      OR policy_release.mutation_json#>>'{next,snapshotDigest}' IS DISTINCT FROM binding->>'policySnapshotDigest'
      OR policy_release.changed_at > (binding->>'submittedAt')::timestamptz
      OR policy_release.mutation_json->'approvalEvidence' IS NOT DISTINCT FROM 'null'::jsonb
      OR policy_release.mutation_json->'validationEvidence' IS NOT DISTINCT FROM 'null'::jsonb
      OR policy_release.mutation_json#>>'{validationEvidence,result}' IS DISTINCT FROM 'Pass'
      OR policy_release.mutation_json#>>'{approvalEvidence,decision}' IS DISTINCT FROM 'Accepted'
      OR policy_release.mutation_json#>'{next,scope}' IS DISTINCT FROM NEW.mutation_json#>'{next,scope}'
      OR (policy_release.mutation_json#>>'{validationEvidence,checkedAt}')::timestamptz > policy_release.changed_at
      OR (policy_release.mutation_json#>>'{approvalEvidence,approvedAt}')::timestamptz > policy_release.changed_at THEN
      RAISE EXCEPTION 'Option governing publication is invalid' USING ERRCODE='23514';
    END IF;
    SELECT * INTO policy_head FROM bop_publishing.publishing_mutation_record
      WHERE tenant_id=NEW.tenant_id AND brand_id=NEW.brand_id AND store_id IS NULL AND family_id=policy_release.family_id AND release_id IS NOT NULL
      ORDER BY release_sequence DESC LIMIT 1;
    IF policy_head.release_id IS DISTINCT FROM policy_release.release_id OR EXISTS (
      SELECT 1 FROM bop_publishing.publishing_mutation_record
      WHERE tenant_id=NEW.tenant_id AND brand_id=NEW.brand_id AND lifecycle_id=policy_release.lifecycle_id AND lifecycle_version>policy_release.lifecycle_version) THEN
      RAISE EXCEPTION 'Option governing publication is no longer current' USING ERRCODE='23514';
    END IF;
    SELECT * INTO policy_created FROM bop_publishing.publishing_mutation_record
      WHERE tenant_id=NEW.tenant_id AND brand_id=NEW.brand_id AND store_id IS NULL AND family_id=policy_release.family_id
        AND operation_code='CreateDraft' AND mutation_json->'optionSetPolicyContent'=binding->'policyContent'
        AND mutation_json#>'{next,snapshotReference}'=policy_release.mutation_json#>'{next,snapshotReference}'
        AND mutation_json#>'{next,snapshotDigest}'=policy_release.mutation_json#>'{next,snapshotDigest}'
        AND changed_at<=policy_release.changed_at
        AND (mutation_json#>>'{audit,occurredAt}')::timestamptz<=(policy_release.mutation_json#>>'{release,createdAt}')::timestamptz
      ORDER BY changed_at DESC,lifecycle_version DESC LIMIT 1;
    IF NOT FOUND OR policy_created.mutation_json#>'{next,snapshotDigest}' IS DISTINCT FROM policy_release.mutation_json#>'{next,snapshotDigest}' THEN
      RAISE EXCEPTION 'Option governing body is invalid' USING ERRCODE='23514';
    END IF;
    SELECT * INTO policy_review FROM bop_publishing.publishing_mutation_record
      WHERE tenant_id=NEW.tenant_id AND brand_id=NEW.brand_id AND store_id IS NULL AND lifecycle_id=policy_release.lifecycle_id AND operation_code='SubmitReview'
        AND lifecycle_version=(policy_release.mutation_json#>>'{approvalEvidence,reviewVersion}')::bigint;
    SELECT * INTO policy_approval FROM bop_publishing.publishing_mutation_record
      WHERE tenant_id=NEW.tenant_id AND brand_id=NEW.brand_id AND store_id IS NULL AND lifecycle_id=policy_release.lifecycle_id AND operation_code='Approve'
        AND lifecycle_version=(policy_release.mutation_json#>>'{approvalEvidence,reviewVersion}')::bigint+1;
    IF policy_review.operation_id IS NULL OR policy_approval.operation_id IS NULL OR policy_review.actor_id=policy_approval.actor_id
      OR policy_review.mutation_json#>>'{audit,actor,type}' IS DISTINCT FROM 'User'
      OR policy_approval.mutation_json#>>'{audit,actor,type}' IS DISTINCT FROM 'User'
      OR policy_approval.actor_id::text IS DISTINCT FROM policy_release.mutation_json#>>'{approvalEvidence,approvedActorReference}'
      OR policy_review.mutation_json->'validationEvidence' IS DISTINCT FROM policy_release.mutation_json->'validationEvidence'
      OR policy_approval.mutation_json->'approvalEvidence' IS DISTINCT FROM policy_release.mutation_json->'approvalEvidence'
      OR policy_approval.mutation_json->'next' IS DISTINCT FROM policy_release.mutation_json->'current'
      OR (policy_release.mutation_json#>>'{validationEvidence,validUntil}')::timestamptz <= policy_release.changed_at
      OR (policy_release.mutation_json#>>'{approvalEvidence,validUntil}')::timestamptz <= policy_release.changed_at THEN
      RAISE EXCEPTION 'Option governance approval is invalid' USING ERRCODE='23514';
    END IF;
    IF is_waived THEN
      IF jsonb_typeof(waiver) IS DISTINCT FROM 'object' OR (waiver - ARRAY['profile','reviewPolicy','recordedAt']) <> '{}'::jsonb
        OR NOT waiver ?& ARRAY['profile','reviewPolicy','recordedAt']
        OR waiver->>'profile' IS DISTINCT FROM 'PublishingOptionSetApprovalWaiverV1'
        OR binding#>>'{policyContent,approvalPolicy}' IS DISTINCT FROM 'NotRequired'
        OR waiver->>'recordedAt' IS DISTINCT FROM NEW.mutation_json#>>'{audit,occurredAt}'
        OR NEW.mutation_json->'approvalEvidence' IS DISTINCT FROM 'null'::jsonb
        OR NEW.mutation_json#>'{next,approvalEvidenceReference}' IS DISTINCT FROM 'null'::jsonb
        OR binding->'reviewLifecycle' IS DISTINCT FROM prior.mutation_json->'next'
        OR binding IS DISTINCT FROM prior.mutation_json->'optionSetReviewPolicy'
        OR binding->>'reviewOperationReference' IS DISTINCT FROM prior.operation_id::text
        OR binding->>'submittedActorReference' IS DISTINCT FROM prior.actor_id::text
        OR binding->>'submittedAt' IS DISTINCT FROM prior.mutation_json#>>'{audit,occurredAt}' THEN
        RAISE EXCEPTION 'Option publication waiver is invalid' USING ERRCODE='23514';
      END IF;
    ELSE
      IF binding->'reviewLifecycle' IS DISTINCT FROM NEW.mutation_json->'next'
        OR binding->>'reviewOperationReference' IS DISTINCT FROM NEW.operation_id::text
        OR binding->>'submittedActorReference' IS DISTINCT FROM NEW.actor_id::text
        OR binding->>'submittedAt' IS DISTINCT FROM NEW.mutation_json#>>'{audit,occurredAt}' THEN
        RAISE EXCEPTION 'Option original review is invalid' USING ERRCODE='23514';
      END IF;
    END IF;
  ELSIF is_waived THEN
    RAISE EXCEPTION 'Option publication waiver is missing' USING ERRCODE='23514';
  END IF;

  IF prior.lifecycle_id IS NULL THEN
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
        OR (is_waived AND NEW.operation_code='Publish' AND prior_state='InReview' AND next_state='Published')
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
REVOKE ALL ON FUNCTION bop_publishing.guard_mutation_history_v3() FROM PUBLIC;
DROP TRIGGER publishing_mutation_guard ON bop_publishing.publishing_mutation_record;
DROP TRIGGER publishing_mutation_truncate_guard ON bop_publishing.publishing_mutation_record;
CREATE TRIGGER publishing_mutation_guard BEFORE INSERT OR UPDATE OR DELETE
  ON bop_publishing.publishing_mutation_record FOR EACH ROW EXECUTE FUNCTION bop_publishing.guard_mutation_history_v3();
CREATE TRIGGER publishing_mutation_truncate_guard BEFORE TRUNCATE
  ON bop_publishing.publishing_mutation_record FOR EACH STATEMENT EXECUTE FUNCTION bop_publishing.guard_mutation_history_v3();
