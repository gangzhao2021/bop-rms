-- bop-rms-migration: 1
-- owner: @bop/publishing
-- schema: bop_publishing
-- phase: expand
-- risk: medium
-- transaction: required
-- lock-timeout-ms: 5000
-- statement-timeout-ms: 60000
-- recovery: forward-fix
-- Forward-only current Option qualification; original human decisions keep their original leases.
-- Only the fixed Option Publish branch consumes a new current five-second qualification.
-- Ordinary write admission must acquire the owning SHARE ROW EXCLUSIVE fence before reads.
-- Application configuration is not a database trust fact. This guard verifies stored owner history,
-- not an adversary capable of fabricating an entire trusted chain with writer privileges.
CREATE FUNCTION bop_publishing.guard_mutation_history_v4()
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
  is_qualified boolean;
  qualification jsonb;
  original_review bop_publishing.publishing_mutation_record%ROWTYPE;
  original_approval bop_publishing.publishing_mutation_record%ROWTYPE;
  qualification_fields text[] := ARRAY['profile','tenantReference','operationReference','actorReference','scope','familyReference','lifecycleReference','expectedLifecycleVersion','latestMutationOperationReference','snapshotReference','snapshotDigest','reviewOperationReference','validationEvidenceReference','approvalOperationReference','approvalEvidenceReference','policyReference','policyVersion','policyContentDigest','policyPublicationReference','qualificationEvidenceReference','qualificationReportDigest','result','originalObservedAt','checkedAt','validUntil','checkCodes','sourceAssessmentDigests'];
  field_name text;
  original_observed_at timestamptz;
  qualification_checked_at timestamptz;
  qualification_valid_until timestamptz;
  actual_at timestamptz;

BEGIN
  IF TG_OP <> 'INSERT' THEN
    RAISE EXCEPTION 'Publishing history is append-only' USING ERRCODE='55000';
  END IF;
  IF current_setting('transaction_isolation') <> 'read committed' THEN
    RAISE EXCEPTION 'Publishing requires current transaction facts' USING ERRCODE='25000';
  END IF;
  is_qualified := NEW.mutation_json ? 'optionSetCurrentQualification';
  qualification := NEW.mutation_json->'optionSetCurrentQualification';
  IF is_qualified THEN
    LOCK TABLE bop_publishing.publishing_mutation_record IN SHARE ROW EXCLUSIVE MODE;
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('PublishingFamily:' || NEW.tenant_id::text || ':' || NEW.brand_id::text || ':' || coalesce(NEW.store_id::text,'Brand') || ':' || NEW.family_id::text,0));
  SELECT * INTO prior FROM bop_publishing.publishing_mutation_record
    WHERE tenant_id=NEW.tenant_id AND brand_id=NEW.brand_id AND lifecycle_id=NEW.lifecycle_id
    ORDER BY lifecycle_version DESC LIMIT 1;
  next_state := NEW.mutation_json#>>'{next,state}';
  waiver := NEW.mutation_json->'optionSetApprovalWaiver';
  is_waived := waiver IS NOT NULL;
  binding := CASE WHEN is_waived THEN waiver->'reviewPolicy' ELSE NEW.mutation_json->'optionSetReviewPolicy' END;
  IF is_qualified THEN
    IF jsonb_typeof(qualification) IS DISTINCT FROM 'object'
      OR (qualification - qualification_fields) <> '{}'::jsonb OR NOT qualification ?& qualification_fields
      OR qualification->>'profile' IS DISTINCT FROM 'PublishingOptionSetCurrentQualificationV1'
      OR qualification->>'result' IS DISTINCT FROM 'Pass'
      OR NEW.operation_code <> 'Publish' OR NEW.store_id IS NOT NULL
      OR NEW.mutation_json#>>'{next,configurationType}' IS DISTINCT FROM 'CATALOG_OPTION_SET'
      OR NEW.mutation_json#>>'{next,purposeCode}' IS DISTINCT FROM 'CATALOG_OPTION_SET_PUBLICATION'
      OR qualification->>'tenantReference' IS DISTINCT FROM NEW.tenant_id::text
      OR qualification->>'operationReference' IS DISTINCT FROM NEW.operation_id::text
      OR qualification->>'actorReference' IS DISTINCT FROM NEW.actor_id::text
      OR NEW.mutation_json#>>'{audit,actor,type}' IS DISTINCT FROM 'User'
      OR qualification->>'familyReference' IS DISTINCT FROM NEW.family_id::text
      OR qualification->>'lifecycleReference' IS DISTINCT FROM NEW.lifecycle_id::text
      OR qualification->'expectedLifecycleVersion' IS DISTINCT FROM to_jsonb(prior.lifecycle_version)
      OR qualification->>'latestMutationOperationReference' IS DISTINCT FROM prior.operation_id::text
      OR jsonb_typeof(qualification->'scope') IS DISTINCT FROM 'object'
      OR ((qualification->'scope') - ARRAY['kind','brandReference','storeReference']) <> '{}'::jsonb
      OR NOT ((qualification->'scope') ?& ARRAY['kind','brandReference','storeReference'])
      OR qualification->'scope' IS DISTINCT FROM NEW.mutation_json#>'{next,scope}'
      OR qualification#>>'{scope,kind}' IS DISTINCT FROM 'Brand'
      OR qualification#>>'{scope,brandReference}' IS DISTINCT FROM NEW.brand_id::text
      OR qualification#>'{scope,storeReference}' IS DISTINCT FROM 'null'::jsonb
      OR qualification->>'snapshotReference' IS DISTINCT FROM NEW.mutation_json#>>'{next,snapshotReference}'
      OR qualification->>'snapshotDigest' IS DISTINCT FROM NEW.mutation_json#>>'{next,snapshotDigest}'
      OR qualification->>'validationEvidenceReference' IS DISTINCT FROM NEW.mutation_json#>>'{next,validationEvidenceReference}'
      OR qualification->'approvalEvidenceReference' IS DISTINCT FROM NEW.mutation_json#>'{next,approvalEvidenceReference}'
      OR qualification->'checkCodes' IS DISTINCT FROM '["CURRENT_REFERENCES","PUBLISHING_POLICY","RULE_SATISFIABILITY","SCOPE_TOPOLOGY"]'::jsonb
      OR jsonb_typeof(qualification->'sourceAssessmentDigests') IS DISTINCT FROM 'array'
      OR jsonb_typeof(qualification->'policyVersion') IS DISTINCT FROM 'number'
      OR jsonb_typeof(qualification->'expectedLifecycleVersion') IS DISTINCT FROM 'number'
      OR NEW.mutation_json->'current' IS DISTINCT FROM prior.mutation_json->'next' THEN
      RAISE EXCEPTION 'Option current qualification is invalid' USING ERRCODE='23514';
    END IF;
    IF (qualification->>'policyVersion' ~ '^[1-9][0-9]{0,15}$') IS NOT TRUE THEN
      RAISE EXCEPTION 'Option qualification policy version is invalid' USING ERRCODE='23514';
    END IF;
    IF (qualification->>'policyVersion')::numeric > 9007199254740991 THEN
      RAISE EXCEPTION 'Option qualification policy version is invalid' USING ERRCODE='23514';
    END IF;
    FOREACH field_name IN ARRAY ARRAY['tenantReference','operationReference','actorReference','familyReference','lifecycleReference','latestMutationOperationReference','snapshotReference','reviewOperationReference','validationEvidenceReference','policyReference','policyPublicationReference','qualificationEvidenceReference'] LOOP
      IF jsonb_typeof(qualification->field_name) IS DISTINCT FROM 'string'
        OR (qualification->>field_name ~ '^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$') IS NOT TRUE THEN
        RAISE EXCEPTION 'Option qualification reference is invalid' USING ERRCODE='23514';
      END IF;
    END LOOP;
    FOREACH field_name IN ARRAY ARRAY['snapshotDigest','policyContentDigest','qualificationReportDigest'] LOOP
      IF jsonb_typeof(qualification->field_name) IS DISTINCT FROM 'string'
        OR (qualification->>field_name ~ '^sha256:[0-9a-f]{64}$') IS NOT TRUE THEN
        RAISE EXCEPTION 'Option qualification digest is invalid' USING ERRCODE='23514';
      END IF;
    END LOOP;
    IF jsonb_array_length(qualification->'sourceAssessmentDigests') NOT BETWEEN 1 AND 32
      OR EXISTS (SELECT 1 FROM jsonb_array_elements(qualification->'sourceAssessmentDigests') value WHERE jsonb_typeof(value) <> 'string' OR (value#>>'{}' ~ '^sha256:[0-9a-f]{64}$') IS NOT TRUE)
      OR (SELECT count(*) FROM jsonb_array_elements(qualification->'sourceAssessmentDigests')) <> (SELECT count(DISTINCT value) FROM jsonb_array_elements(qualification->'sourceAssessmentDigests') value) THEN
      RAISE EXCEPTION 'Option qualification source coverage is invalid' USING ERRCODE='23514';
    END IF;
    FOREACH field_name IN ARRAY ARRAY['originalObservedAt','checkedAt','validUntil'] LOOP
      IF jsonb_typeof(qualification->field_name) IS DISTINCT FROM 'string'
        OR (qualification->>field_name ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{3}Z$') IS NOT TRUE THEN
        RAISE EXCEPTION 'Option qualification instant is invalid' USING ERRCODE='23514';
      END IF;
      IF to_char((qualification->>field_name)::timestamptz AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') IS DISTINCT FROM qualification->>field_name THEN
        RAISE EXCEPTION 'Option qualification instant is not canonical' USING ERRCODE='23514';
      END IF;
    END LOOP;
    original_observed_at := (qualification->>'originalObservedAt')::timestamptz;
    qualification_checked_at := (qualification->>'checkedAt')::timestamptz;
    qualification_valid_until := (qualification->>'validUntil')::timestamptz;
    actual_at := date_trunc('milliseconds',clock_timestamp());
    IF qualification_checked_at < original_observed_at OR qualification_valid_until <= qualification_checked_at
      OR qualification_valid_until > original_observed_at + interval '5 seconds'
      OR qualification_checked_at > (NEW.mutation_json#>>'{audit,occurredAt}')::timestamptz
      OR qualification_valid_until <= (NEW.mutation_json#>>'{audit,occurredAt}')::timestamptz
      OR actual_at < (NEW.mutation_json#>>'{audit,occurredAt}')::timestamptz OR actual_at >= qualification_valid_until THEN
      RAISE EXCEPTION 'Option current qualification has expired' USING ERRCODE='23514';
    END IF;
    SELECT * INTO original_review FROM bop_publishing.publishing_mutation_record
      WHERE tenant_id=NEW.tenant_id AND brand_id=NEW.brand_id AND store_id IS NULL
        AND lifecycle_id=NEW.lifecycle_id AND operation_id::text=qualification->>'reviewOperationReference';
    IF NOT FOUND OR original_review.operation_code <> 'SubmitReview'
      OR original_review.mutation_json#>>'{next,state}' IS DISTINCT FROM 'InReview'
      OR original_review.family_id <> NEW.family_id
      OR original_review.mutation_json#>>'{audit,actor,type}' IS DISTINCT FROM 'User'
      OR original_review.mutation_json#>'{next,scope}' IS DISTINCT FROM qualification->'scope'
      OR original_review.mutation_json#>'{next,snapshotReference}' IS DISTINCT FROM qualification->'snapshotReference'
      OR original_review.mutation_json#>'{next,snapshotDigest}' IS DISTINCT FROM qualification->'snapshotDigest'
      OR original_review.mutation_json->'validationEvidence' IS DISTINCT FROM NEW.mutation_json->'validationEvidence'
      OR jsonb_typeof(original_review.mutation_json#>'{audit,occurredAt}') IS DISTINCT FROM 'string'
      OR jsonb_typeof(original_review.mutation_json#>'{validationEvidence,checkedAt}') IS DISTINCT FROM 'string'
      OR jsonb_typeof(original_review.mutation_json#>'{validationEvidence,validUntil}') IS DISTINCT FROM 'string'
      OR original_review.mutation_json#>'{validationEvidence,evidenceReference}' IS DISTINCT FROM qualification->'validationEvidenceReference'
      OR original_review.mutation_json#>'{validationEvidence,scope}' IS DISTINCT FROM qualification->'scope'
      OR original_review.mutation_json#>'{validationEvidence,snapshotReference}' IS DISTINCT FROM qualification->'snapshotReference'
      OR original_review.mutation_json#>'{validationEvidence,snapshotDigest}' IS DISTINCT FROM qualification->'snapshotDigest'
      OR original_review.mutation_json#>>'{validationEvidence,result}' IS DISTINCT FROM 'Pass'
      OR jsonb_typeof(original_review.mutation_json#>'{validationEvidence,checkCodes}') IS DISTINCT FROM 'array'
      OR jsonb_array_length(original_review.mutation_json#>'{validationEvidence,checkCodes}') <> 4
      OR NOT ((original_review.mutation_json#>'{validationEvidence,checkCodes}') @> (qualification->'checkCodes'))
      OR NOT ((qualification->'checkCodes') @> (original_review.mutation_json#>'{validationEvidence,checkCodes}'))
      OR (original_review.mutation_json#>>'{validationEvidence,checkedAt}')::timestamptz > (original_review.mutation_json#>>'{audit,occurredAt}')::timestamptz
      OR (original_review.mutation_json#>>'{validationEvidence,validUntil}')::timestamptz <= (original_review.mutation_json#>>'{audit,occurredAt}')::timestamptz THEN
      RAISE EXCEPTION 'Option original review evidence is invalid' USING ERRCODE='23514';
    END IF;
    -- Source policy is the actual recorded Review binding, never a caller packet.
    binding := original_review.mutation_json->'optionSetReviewPolicy';
    IF binding IS NULL OR binding->'reviewLifecycle' IS DISTINCT FROM original_review.mutation_json->'next'
      OR binding->'validationEvidence' IS DISTINCT FROM original_review.mutation_json->'validationEvidence'
      OR binding->>'reviewOperationReference' IS DISTINCT FROM original_review.operation_id::text
      OR binding->>'submittedActorReference' IS DISTINCT FROM original_review.actor_id::text
      OR binding->>'submittedAt' IS DISTINCT FROM original_review.mutation_json#>>'{audit,occurredAt}'
      OR qualification->'policyReference' IS DISTINCT FROM binding#>'{policyContent,policyReference}'
      OR qualification->'policyVersion' IS DISTINCT FROM binding#>'{policyContent,policyVersion}'
      OR qualification->'policyContentDigest' IS DISTINCT FROM binding->'policySnapshotDigest'
      OR qualification->'policyPublicationReference' IS DISTINCT FROM binding->'policyReleaseReference' THEN
      RAISE EXCEPTION 'Option qualification policy is not the original policy' USING ERRCODE='23514';
    END IF;
    IF is_waived THEN
      IF qualification->'approvalOperationReference' IS DISTINCT FROM 'null'::jsonb
        OR qualification->'approvalEvidenceReference' IS DISTINCT FROM 'null'::jsonb
        OR waiver->'currentQualification' IS DISTINCT FROM qualification
        OR waiver->'reviewPolicy' IS DISTINCT FROM binding
        OR prior.operation_id IS DISTINCT FROM original_review.operation_id THEN
        RAISE EXCEPTION 'Option qualified waiver is invalid' USING ERRCODE='23514';
      END IF;
    ELSE
      FOREACH field_name IN ARRAY ARRAY['approvalOperationReference','approvalEvidenceReference'] LOOP
        IF jsonb_typeof(qualification->field_name) IS DISTINCT FROM 'string'
          OR (qualification->>field_name ~ '^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$') IS NOT TRUE THEN
          RAISE EXCEPTION 'Option original approval reference is invalid' USING ERRCODE='23514';
        END IF;
      END LOOP;
      SELECT * INTO original_approval FROM bop_publishing.publishing_mutation_record
        WHERE tenant_id=NEW.tenant_id AND brand_id=NEW.brand_id AND store_id IS NULL
          AND lifecycle_id=NEW.lifecycle_id AND operation_id::text=qualification->>'approvalOperationReference';
      IF NOT FOUND OR original_approval.operation_code <> 'Approve' OR original_approval.operation_id IS DISTINCT FROM prior.operation_id
        OR original_approval.mutation_json#>>'{next,state}' IS DISTINCT FROM 'Approved'
        OR original_approval.actor_id = original_review.actor_id
        OR original_approval.mutation_json#>>'{audit,actor,type}' IS DISTINCT FROM 'User'
        OR original_approval.mutation_json#>>'{approvalEvidence,approvedActorReference}' IS DISTINCT FROM original_approval.actor_id::text
        OR jsonb_typeof(original_approval.mutation_json#>'{audit,occurredAt}') IS DISTINCT FROM 'string'
        OR jsonb_typeof(original_approval.mutation_json#>'{approvalEvidence,approvedAt}') IS DISTINCT FROM 'string'
        OR jsonb_typeof(original_approval.mutation_json#>'{approvalEvidence,validUntil}') IS DISTINCT FROM 'string'
        OR original_approval.mutation_json#>>'{approvalEvidence,decision}' IS DISTINCT FROM 'Accepted'
        OR original_approval.mutation_json#>>'{approvalEvidence,reviewLifecycleId}' IS DISTINCT FROM NEW.lifecycle_id::text
        OR original_approval.mutation_json#>'{approvalEvidence,reviewVersion}' IS DISTINCT FROM to_jsonb(original_review.lifecycle_version)
        OR original_approval.mutation_json#>'{approvalEvidence,evidenceReference}' IS DISTINCT FROM qualification->'approvalEvidenceReference'
        OR original_approval.mutation_json->'approvalEvidence' IS DISTINCT FROM NEW.mutation_json->'approvalEvidence'
        OR original_approval.mutation_json->'current' IS DISTINCT FROM original_review.mutation_json->'next'
        OR original_approval.mutation_json#>'{approvalEvidence,scope}' IS DISTINCT FROM qualification->'scope'
        OR original_approval.mutation_json#>'{approvalEvidence,snapshotReference}' IS DISTINCT FROM qualification->'snapshotReference'
        OR original_approval.mutation_json#>'{approvalEvidence,snapshotDigest}' IS DISTINCT FROM qualification->'snapshotDigest'
        OR (original_approval.mutation_json#>>'{approvalEvidence,approvedAt}')::timestamptz < (original_review.mutation_json#>>'{audit,occurredAt}')::timestamptz
        OR (original_approval.mutation_json#>>'{approvalEvidence,approvedAt}')::timestamptz > (original_approval.mutation_json#>>'{audit,occurredAt}')::timestamptz
        OR (original_approval.mutation_json#>>'{approvalEvidence,validUntil}')::timestamptz <= (original_approval.mutation_json#>>'{audit,occurredAt}')::timestamptz THEN
        RAISE EXCEPTION 'Option original independent approval is invalid' USING ERRCODE='23514';
      END IF;
    END IF;
  ELSIF waiver ? 'currentQualification' THEN
    RAISE EXCEPTION 'Option waiver current qualification is missing' USING ERRCODE='23514';
  END IF;
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
      OR (binding#>>'{validationEvidence,validUntil}')::timestamptz <= (CASE WHEN is_qualified THEN (binding->>'submittedAt')::timestamptz ELSE NEW.changed_at END)
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
      IF jsonb_typeof(waiver) IS DISTINCT FROM 'object' OR (waiver - CASE WHEN is_qualified THEN ARRAY['profile','reviewPolicy','recordedAt','currentQualification'] ELSE ARRAY['profile','reviewPolicy','recordedAt'] END) <> '{}'::jsonb
        OR NOT (waiver ?& (CASE WHEN is_qualified THEN ARRAY['profile','reviewPolicy','recordedAt','currentQualification'] ELSE ARRAY['profile','reviewPolicy','recordedAt'] END))
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
    ELSIF NOT is_qualified THEN
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
  IF is_qualified THEN
    actual_at := date_trunc('milliseconds',clock_timestamp());
    IF actual_at >= qualification_valid_until OR actual_at < qualification_checked_at
      OR (binding#>>'{policyContent,effectiveFrom}')::timestamptz > actual_at
      OR (binding#>>'{policyContent,effectiveUntil}')::timestamptz <= actual_at THEN
      RAISE EXCEPTION 'Option current qualification expired during source checks' USING ERRCODE='23514';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION bop_publishing.guard_mutation_history_v4() FROM PUBLIC;
DROP TRIGGER publishing_mutation_guard ON bop_publishing.publishing_mutation_record;
DROP TRIGGER publishing_mutation_truncate_guard ON bop_publishing.publishing_mutation_record;
CREATE TRIGGER publishing_mutation_guard BEFORE INSERT OR UPDATE OR DELETE
  ON bop_publishing.publishing_mutation_record FOR EACH ROW EXECUTE FUNCTION bop_publishing.guard_mutation_history_v4();
CREATE TRIGGER publishing_mutation_truncate_guard BEFORE TRUNCATE
  ON bop_publishing.publishing_mutation_record FOR EACH STATEMENT EXECUTE FUNCTION bop_publishing.guard_mutation_history_v4();
