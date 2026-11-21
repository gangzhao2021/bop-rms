-- bop-rms-migration: 1
-- owner: @bop/publishing
-- schema: bop_publishing
-- phase: expand
-- risk: high
-- transaction: required
-- lock-timeout-ms: 5000
-- statement-timeout-ms: 60000
-- recovery: forward-fix
CREATE TABLE bop_publishing.platform_template_publishing_head (
 family_id platform_helpers.uuid_v7 PRIMARY KEY,
 sequence integer NOT NULL CHECK(sequence>0),
 selected_record_id platform_helpers.uuid_v7 NOT NULL,
 release_record_id platform_helpers.uuid_v7,
 release_active boolean NOT NULL,
 CHECK(NOT release_active OR release_record_id IS NOT NULL)
);
CREATE TABLE bop_publishing.platform_template_publishing_operation (
 record_id platform_helpers.uuid_v7 PRIMARY KEY,
 actor_id platform_helpers.uuid_v7 NOT NULL,
 operation_id platform_helpers.uuid_v7 NOT NULL,
 intent_digest text NOT NULL CHECK(intent_digest ~ '^sha256:[a-f0-9]{64}$'),
 outcome text NOT NULL CHECK(outcome IN ('Committed','Abandoned')),
 family_id platform_helpers.uuid_v7,
 sequence integer,
 lifecycle_id platform_helpers.uuid_v7,
 lifecycle_version integer,
 operation_code text,
 source_digest text,
 audit_id platform_helpers.uuid_v7 NOT NULL UNIQUE,
 occurred_at timestamptz NOT NULL CHECK(isfinite(occurred_at) AND occurred_at>='0001-01-01Z'::timestamptz AND occurred_at<'10000-01-01Z'::timestamptz AND occurred_at=date_trunc('milliseconds',occurred_at)),
 reason_code text NOT NULL CHECK(reason_code ~ '^[A-Z][A-Z0-9_.:-]{0,63}$'),
 receipt_digest text NOT NULL CHECK(receipt_digest ~ '^sha256:[a-f0-9]{64}$'),
 receipt_text text NOT NULL CHECK(octet_length(receipt_text)<=65536),
 writer_transaction_id bigint NOT NULL DEFAULT txid_current(),
 UNIQUE(actor_id,operation_id),
 UNIQUE(family_id,sequence),
 UNIQUE(family_id,lifecycle_id,lifecycle_version),
 CHECK((outcome='Abandoned' AND family_id IS NULL AND sequence IS NULL AND lifecycle_id IS NULL AND lifecycle_version IS NULL AND operation_code IS NULL AND source_digest IS NULL AND reason_code='ORIGINAL_RESOLUTION_ABANDONED') OR (outcome='Committed' AND family_id IS NOT NULL AND sequence IS NOT NULL AND sequence>0 AND lifecycle_id IS NOT NULL AND lifecycle_version IS NOT NULL AND lifecycle_version>0 AND source_digest IS NOT NULL AND operation_code IS NOT NULL AND operation_code IN ('CreateDraft','SubmitReview','Approve','Publish','Archive') AND source_digest ~ '^sha256:[a-f0-9]{64}$')),
 FOREIGN KEY(family_id) REFERENCES bop_publishing.platform_template_publishing_head(family_id) DEFERRABLE INITIALLY DEFERRED
);
CREATE UNIQUE INDEX platform_template_publishing_release_unique ON bop_publishing.platform_template_publishing_operation((receipt_text::jsonb->'source'->'command'->'release'->>'releaseId')) WHERE operation_code='Publish';
ALTER TABLE bop_publishing.platform_template_publishing_head ADD CONSTRAINT platform_template_publishing_selected_fkey FOREIGN KEY(selected_record_id) REFERENCES bop_publishing.platform_template_publishing_operation(record_id) DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE bop_publishing.platform_template_publishing_head ADD CONSTRAINT platform_template_publishing_release_fkey FOREIGN KEY(release_record_id) REFERENCES bop_publishing.platform_template_publishing_operation(record_id) DEFERRABLE INITIALLY DEFERRED;
CREATE FUNCTION bop_publishing.platform_template_publishing_operation_admit(p_actor uuid,p_operation uuid) RETURNS void LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog
AS $$
BEGIN
 IF (p_actor IS NULL OR p_operation IS NULL OR p_actor::text IS DISTINCT FROM current_setting('bop.platform_actor_id',true) OR current_setting('bop.platform_purpose',true) IS DISTINCT FROM 'PLATFORM_BRAND_TEMPLATE') IS NOT FALSE THEN RAISE EXCEPTION 'Platform publishing admission unavailable' USING ERRCODE='23514'; END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended('PlatformTemplatePublishingOperation:'||p_actor::text||':'||p_operation::text,0));
END; $$;
CREATE FUNCTION bop_publishing.platform_template_publishing_family_admit(p_actor uuid,p_family uuid,p_write boolean) RETURNS void LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog
AS $$
BEGIN
 IF (p_actor IS NULL OR p_family IS NULL OR p_write IS NULL OR p_actor::text IS DISTINCT FROM current_setting('bop.platform_actor_id',true) OR current_setting('bop.platform_purpose',true) IS DISTINCT FROM 'PLATFORM_BRAND_TEMPLATE') IS NOT FALSE THEN RAISE EXCEPTION 'Platform publishing family unavailable' USING ERRCODE='23514'; END IF;
 -- Production service acquires actual public Tenant admission before this fence.
 IF p_write THEN PERFORM pg_advisory_xact_lock(hashtextextended('PlatformTemplatePublishingFamily:'||p_family::text,0));PERFORM 1 FROM bop_publishing.platform_template_publishing_head WHERE family_id=p_family FOR UPDATE;
 ELSE PERFORM pg_advisory_xact_lock_shared(hashtextextended('PlatformTemplatePublishingFamily:'||p_family::text,0));PERFORM 1 FROM bop_publishing.platform_template_publishing_head WHERE family_id=p_family FOR SHARE;END IF;
END; $$;
CREATE FUNCTION bop_publishing.platform_template_publishing_immutable() RETURNS trigger LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$ BEGIN RAISE EXCEPTION 'Platform publishing original immutable' USING ERRCODE='23514';END; $$;
CREATE FUNCTION bop_publishing.platform_template_publishing_canonical_instant(p_value text) RETURNS boolean LANGUAGE plpgsql IMMUTABLE
SET search_path = pg_catalog
AS $$
DECLARE at timestamptz;
BEGIN
 IF p_value IS NULL OR p_value!~'^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{3}Z$' THEN RETURN false;END IF;
 at:=p_value::timestamptz;
 RETURN isfinite(at) AND at>='0001-01-01Z'::timestamptz AND at<'10000-01-01Z'::timestamptz AND to_char(at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')=p_value;
 EXCEPTION WHEN OTHERS THEN RETURN false;
END; $$;
CREATE FUNCTION bop_publishing.platform_template_publishing_operation_guard() RETURNS trigger LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
DECLARE r jsonb;s jsonb;o jsonb;q jsonb;c jsonb;n jsonb;v jsonb;a jsonb;rel jsonb;cur jsonb;expected jsonb;prior bop_publishing.platform_template_publishing_operation%ROWTYPE;h bop_publishing.platform_template_publishing_head%ROWTYPE;prior_source jsonb;prior_next jsonb;last_release jsonb;
BEGIN
 IF (NEW.actor_id::text IS DISTINCT FROM current_setting('bop.platform_actor_id',true) OR current_setting('bop.platform_purpose',true) IS DISTINCT FROM 'PLATFORM_BRAND_TEMPLATE' OR NEW.writer_transaction_id<>txid_current() OR NEW.occurred_at>clock_timestamp() OR NOT pg_try_advisory_xact_lock(hashtextextended('PlatformTemplatePublishingOperation:'||NEW.actor_id::text||':'||NEW.operation_id::text,0))) IS NOT FALSE THEN RAISE EXCEPTION 'Platform publishing original unavailable' USING ERRCODE='23514';END IF;
 r:=NEW.receipt_text::jsonb;s:=r->'source';o:=r->'originalCommand';q:=o->'request';c:=s->'command';n:=c->'next';v:=c->'validationEvidence';a:=c->'approvalEvidence';rel:=c->'release';cur:=c->'current';expected:=q->'expectedLifecycle';
 IF (jsonb_typeof(r)<>'object' OR (SELECT count(*) FROM jsonb_object_keys(r))<>11 OR NOT r ?& ARRAY['profile','kind','actorReference','purposeCode','operationReference','intentDigest','outcome','originalCommand','source','auditReference','occurredAt'] OR EXISTS(SELECT 1 FROM jsonb_each(r) WHERE key NOT IN ('source','originalCommand') AND jsonb_typeof(value)<>'string') OR r->>'profile'<>'PlatformPublishingReceiptV1' OR r->>'kind'<>'Platform' OR r->>'purposeCode'<>'PLATFORM_BRAND_TEMPLATE' OR r->>'actorReference'<>NEW.actor_id::text OR r->>'operationReference'<>NEW.operation_id::text OR r->>'intentDigest'<>NEW.intent_digest OR r->>'outcome'<>NEW.outcome OR r->>'auditReference'<>NEW.audit_id::text OR r->>'occurredAt'<>to_char(NEW.occurred_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')) IS NOT FALSE THEN RAISE EXCEPTION 'Platform publishing receipt invalid' USING ERRCODE='23514';END IF;
 IF NEW.outcome='Abandoned' THEN IF (s IS DISTINCT FROM 'null'::jsonb OR o IS DISTINCT FROM 'null'::jsonb) IS NOT FALSE THEN RAISE EXCEPTION 'Platform publishing abandonment invalid' USING ERRCODE='23514';END IF;RETURN NEW;END IF;
 IF NOT pg_try_advisory_xact_lock(hashtextextended('PlatformTemplatePublishingFamily:'||NEW.family_id::text,0)) THEN RAISE EXCEPTION 'Platform publishing lock order invalid' USING ERRCODE='23514';END IF;
 SELECT * INTO h FROM bop_publishing.platform_template_publishing_head WHERE family_id=NEW.family_id;
 IF NEW.sequence<>COALESCE(h.sequence,0)+1 THEN RAISE EXCEPTION 'Platform publishing sequence conflict' USING ERRCODE='23514';END IF;
 IF (jsonb_typeof(s)<>'object' OR (SELECT count(*) FROM jsonb_object_keys(s))<>8 OR NOT s ?& ARRAY['profile','sequence','templateSourceDigest','originalCommand','intentDigest','command','auditReference','sourceDigest'] OR s->>'profile'<>'PlatformPublishingSourceV1' OR jsonb_typeof(s->'sequence')<>'number' OR s->>'sequence'<>NEW.sequence::text OR s->>'sourceDigest'<>NEW.source_digest OR s->>'intentDigest'<>NEW.intent_digest OR s->>'auditReference'<>NEW.audit_id::text OR s->'originalCommand' IS DISTINCT FROM o
 OR jsonb_typeof(o)<>'object' OR (SELECT count(*) FROM jsonb_object_keys(o))<>3 OR NOT o ?& ARRAY['profile','scope','request'] OR o->>'profile'<>'PlatformPublishingOriginalV1' OR o->'scope' IS DISTINCT FROM jsonb_build_object('kind','Platform','actorReference',NEW.actor_id::text,'purposeCode','PLATFORM_BRAND_TEMPLATE')
 OR jsonb_typeof(q)<>'object' OR (SELECT count(*) FROM jsonb_object_keys(q))<>10 OR NOT q ?& ARRAY['profile','operation','operationReference','templateReference','templateVersionReference','contentDigest','templateSourceDigest','expectedLifecycle','reviewValidUntil','reasonCode'] OR EXISTS(SELECT 1 FROM jsonb_each(q) WHERE key NOT IN ('expectedLifecycle','reviewValidUntil') AND jsonb_typeof(value)<>'string') OR q->>'profile'<>'PlatformPublishingRequestV1' OR q->>'operation'<>NEW.operation_code OR q->>'operationReference'<>NEW.operation_id::text OR q->>'templateReference'<>NEW.family_id::text OR q->>'templateVersionReference'!~'^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' OR q->>'reasonCode'<>NEW.reason_code OR q->>'templateSourceDigest'!~'^sha256:[a-f0-9]{64}$' OR q->>'contentDigest'!~'^sha256:[a-f0-9]{64}$' OR q->>'templateSourceDigest'<>s->>'templateSourceDigest'
 OR jsonb_typeof(c)<>'object' OR (SELECT count(*) FROM jsonb_object_keys(c))<>13 OR NOT c ?& ARRAY['profile','operation','operationReference','currentActorReference','expectedVersion','current','next','validationEvidence','approvalEvidence','release','previousRelease','rollbackTarget','occurredAt'] OR c->>'profile'<>'PlatformPublishingCommandV1' OR c->>'operation'<>NEW.operation_code OR c->>'operationReference'<>NEW.operation_id::text OR c->>'currentActorReference'<>NEW.actor_id::text OR c->>'occurredAt'<>r->>'occurredAt' OR c->'rollbackTarget' IS DISTINCT FROM 'null'::jsonb
 OR jsonb_typeof(n)<>'object' OR (SELECT count(*) FROM jsonb_object_keys(n))<>16 OR NOT n ?& ARRAY['lifecycleId','familyReference','configurationType','purposeCode','snapshotReference','snapshotDigest','scope','version','state','validationEvidenceReference','approvalEvidenceReference','createdAt','changedAt','authoredActorReference','submittedActorReference','reviewValidUntil'] OR n->>'lifecycleId'<>NEW.lifecycle_id::text OR n->>'familyReference'<>NEW.family_id::text OR n->>'configurationType'<>'PLATFORM_BRAND_TEMPLATE' OR n->>'purposeCode'<>'PLATFORM_BRAND_TEMPLATE' OR n->'scope' IS DISTINCT FROM jsonb_build_object('kind','Platform','brandReference',NULL,'storeReference',NULL) OR n->>'snapshotReference'<>q->>'templateVersionReference' OR n->>'snapshotDigest'<>q->>'contentDigest' OR jsonb_typeof(n->'version')<>'number' OR n->>'version'<>NEW.lifecycle_version::text OR jsonb_typeof(n->'createdAt')<>'string' OR NOT bop_publishing.platform_template_publishing_canonical_instant(n->>'createdAt') OR n->>'createdAt'>r->>'occurredAt' OR n->>'changedAt'<>r->>'occurredAt' OR n->>'state'<>(CASE NEW.operation_code WHEN 'CreateDraft' THEN 'Draft' WHEN 'SubmitReview' THEN 'InReview' WHEN 'Approve' THEN 'Approved' WHEN 'Publish' THEN 'Published' ELSE 'Archived' END)) IS NOT FALSE THEN RAISE EXCEPTION 'Platform publishing source invalid' USING ERRCODE='23514';END IF;
 IF NEW.operation_code='CreateDraft' THEN
 IF cur='null'::jsonb THEN
 IF h.family_id IS NULL THEN IF expected IS DISTINCT FROM 'null'::jsonb THEN RAISE EXCEPTION 'Platform publishing initial CAS invalid' USING ERRCODE='23514';END IF;
 ELSE SELECT * INTO prior FROM bop_publishing.platform_template_publishing_operation WHERE record_id=h.selected_record_id;prior_source:=prior.receipt_text::jsonb->'source';prior_next:=prior_source->'command'->'next';IF (prior_next->>'state'='Draft' OR expected IS DISTINCT FROM jsonb_build_object('lifecycleReference',prior_next->>'lifecycleId','version',prior.lifecycle_version,'sourceDigest',prior.source_digest) OR n->>'lifecycleId'=prior_next->>'lifecycleId') IS NOT FALSE THEN RAISE EXCEPTION 'Platform publishing new lifecycle CAS invalid' USING ERRCODE='23514';END IF;END IF;
 IF (NEW.lifecycle_version<>1 OR jsonb_typeof(c->'expectedVersion')<>'number' OR c->>'expectedVersion'<>'1' OR n->>'createdAt'<>r->>'occurredAt') IS NOT FALSE THEN RAISE EXCEPTION 'Platform publishing new lifecycle invalid' USING ERRCODE='23514';END IF;
 ELSE SELECT * INTO prior FROM bop_publishing.platform_template_publishing_operation WHERE record_id=h.selected_record_id;END IF;
 ELSE SELECT * INTO prior FROM bop_publishing.platform_template_publishing_operation WHERE family_id=NEW.family_id AND lifecycle_id=NEW.lifecycle_id AND outcome='Committed' ORDER BY sequence DESC LIMIT 1;IF NOT FOUND THEN RAISE EXCEPTION 'Platform publishing lifecycle absent' USING ERRCODE='23514';END IF;END IF;
 IF cur IS DISTINCT FROM 'null'::jsonb THEN
 prior_source:=prior.receipt_text::jsonb->'source';prior_next:=prior_source->'command'->'next';
 IF (prior.record_id IS NULL OR cur IS DISTINCT FROM prior_next OR NEW.lifecycle_version<>prior.lifecycle_version+1 OR jsonb_typeof(c->'expectedVersion')<>'number' OR c->>'expectedVersion'<>prior.lifecycle_version::text OR expected IS DISTINCT FROM jsonb_build_object('lifecycleReference',prior.lifecycle_id::text,'version',prior.lifecycle_version,'sourceDigest',prior.source_digest) OR n->>'lifecycleId'<>prior.lifecycle_id::text OR n->>'createdAt'<>prior_next->>'createdAt' OR NEW.occurred_at<prior.occurred_at OR (NEW.operation_code<>'CreateDraft' AND (n->>'snapshotReference'<>prior_next->>'snapshotReference' OR n->>'snapshotDigest'<>prior_next->>'snapshotDigest' OR s->>'templateSourceDigest'<>prior_source->>'templateSourceDigest' OR n->>'authoredActorReference'<>prior_next->>'authoredActorReference')) OR (NEW.operation_code='CreateDraft' AND prior_next->>'state'<>'Draft') OR (NEW.operation_code='SubmitReview' AND prior_next->>'state'<>'Draft') OR (NEW.operation_code='Approve' AND prior_next->>'state'<>'InReview') OR (NEW.operation_code='Publish' AND prior_next->>'state'<>'Approved') OR (NEW.operation_code='Archive' AND prior_next->>'state'<>'Published')) IS NOT FALSE THEN RAISE EXCEPTION 'Platform publishing prior/CAS invalid' USING ERRCODE='23514';END IF;
 END IF;
 IF NEW.operation_code='CreateDraft' THEN
 IF (n->>'authoredActorReference'<>NEW.actor_id::text OR n->'submittedActorReference' IS DISTINCT FROM 'null'::jsonb OR n->'reviewValidUntil' IS DISTINCT FROM 'null'::jsonb OR n->'validationEvidenceReference' IS DISTINCT FROM 'null'::jsonb OR n->'approvalEvidenceReference' IS DISTINCT FROM 'null'::jsonb OR v IS DISTINCT FROM 'null'::jsonb OR a IS DISTINCT FROM 'null'::jsonb OR rel IS DISTINCT FROM 'null'::jsonb OR c->'previousRelease' IS DISTINCT FROM 'null'::jsonb OR q->'reviewValidUntil' IS DISTINCT FROM 'null'::jsonb OR (cur<>'null'::jsonb AND n->>'snapshotReference'=cur->>'snapshotReference' AND (n->>'snapshotDigest'<>cur->>'snapshotDigest' OR n->>'authoredActorReference'<>cur->>'authoredActorReference'))) IS NOT FALSE THEN RAISE EXCEPTION 'Platform publishing Draft invalid' USING ERRCODE='23514';END IF;
 ELSE
 IF (cur='null'::jsonb OR jsonb_typeof(v)<>'object' OR (SELECT count(*) FROM jsonb_object_keys(v))<>8 OR NOT v ?& ARRAY['evidenceReference','snapshotReference','snapshotDigest','scope','result','checkedAt','validUntil','checkCodes'] OR EXISTS(SELECT 1 FROM jsonb_each(v) WHERE key NOT IN ('scope','checkCodes') AND jsonb_typeof(value)<>'string') OR NOT bop_publishing.platform_template_publishing_canonical_instant(v->>'checkedAt') OR NOT bop_publishing.platform_template_publishing_canonical_instant(v->>'validUntil') OR v->>'checkedAt'>=v->>'validUntil' OR jsonb_typeof(n->'reviewValidUntil')<>'string' OR NOT bop_publishing.platform_template_publishing_canonical_instant(n->>'reviewValidUntil') OR jsonb_typeof(n->'submittedActorReference')<>'string' OR n->>'submittedActorReference'!~'^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' OR jsonb_typeof(n->'validationEvidenceReference')<>'string' OR v->>'evidenceReference'!~'^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' OR v->>'result'<>'Pass' OR v->>'evidenceReference'<>n->>'validationEvidenceReference' OR v->>'snapshotReference'<>n->>'snapshotReference' OR v->>'snapshotDigest'<>n->>'snapshotDigest' OR v->'scope' IS DISTINCT FROM n->'scope' OR v->>'validUntil'<>n->>'reviewValidUntil' OR jsonb_typeof(v->'checkCodes')<>'array' OR jsonb_array_length(v->'checkCodes') NOT BETWEEN 1 AND 128 OR EXISTS(SELECT 1 FROM jsonb_array_elements(v->'checkCodes') WHERE jsonb_typeof(value)<>'string' OR (value#>>'{}')!~'^[A-Z][A-Z0-9_.:-]{0,63}$') OR (SELECT count(DISTINCT value) FROM jsonb_array_elements(v->'checkCodes'))<>jsonb_array_length(v->'checkCodes') OR v->>'checkedAt'>r->>'occurredAt') IS NOT FALSE THEN RAISE EXCEPTION 'Platform publishing validation invalid' USING ERRCODE='23514';END IF;
 IF NEW.operation_code='SubmitReview' THEN
 IF (n->>'submittedActorReference'<>NEW.actor_id::text OR n->>'reviewValidUntil'<>q->>'reviewValidUntil' OR n->>'reviewValidUntil'<=r->>'occurredAt' OR v->>'checkedAt'<cur->>'changedAt' OR a IS DISTINCT FROM 'null'::jsonb OR n->'approvalEvidenceReference' IS DISTINCT FROM 'null'::jsonb OR rel IS DISTINCT FROM 'null'::jsonb OR c->'previousRelease' IS DISTINCT FROM 'null'::jsonb) IS NOT FALSE THEN RAISE EXCEPTION 'Platform publishing Submit invalid' USING ERRCODE='23514';END IF;
 ELSE
 IF (v IS DISTINCT FROM prior_source->'command'->'validationEvidence' OR n->>'submittedActorReference'<>cur->>'submittedActorReference' OR n->>'reviewValidUntil'<>cur->>'reviewValidUntil' OR q->'reviewValidUntil' IS DISTINCT FROM 'null'::jsonb OR jsonb_typeof(a)<>'object' OR (SELECT count(*) FROM jsonb_object_keys(a))<>12 OR NOT a ?& ARRAY['evidenceReference','reviewLifecycleId','reviewVersion','snapshotReference','snapshotDigest','scope','decision','approvedActorReference','approvedAt','validUntil','authoredActorReference','submittedActorReference'] OR EXISTS(SELECT 1 FROM jsonb_each(a) WHERE key NOT IN ('scope','reviewVersion') AND jsonb_typeof(value)<>'string') OR jsonb_typeof(a->'reviewVersion')<>'number' OR NOT bop_publishing.platform_template_publishing_canonical_instant(a->>'approvedAt') OR NOT bop_publishing.platform_template_publishing_canonical_instant(a->>'validUntil') OR a->>'approvedAt'>=a->>'validUntil' OR a->>'evidenceReference'!~'^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' OR a->>'approvedActorReference'!~'^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' OR a->>'evidenceReference'<>n->>'approvalEvidenceReference' OR a->>'decision'<>'Accepted' OR a->>'reviewLifecycleId'<>NEW.lifecycle_id::text OR a->>'snapshotReference'<>n->>'snapshotReference' OR a->>'snapshotDigest'<>n->>'snapshotDigest' OR a->'scope' IS DISTINCT FROM n->'scope' OR a->>'authoredActorReference'<>n->>'authoredActorReference' OR a->>'submittedActorReference'<>n->>'submittedActorReference' OR a->>'approvedActorReference'=n->>'authoredActorReference' OR a->>'approvedActorReference'=n->>'submittedActorReference' OR a->>'validUntil'<>n->>'reviewValidUntil' OR a->>'approvedAt'>r->>'occurredAt' OR (NEW.operation_code<>'Archive' AND n->>'reviewValidUntil'<=r->>'occurredAt')) IS NOT FALSE THEN RAISE EXCEPTION 'Platform publishing original review invalid' USING ERRCODE='23514';END IF;
 IF NEW.operation_code='Approve' THEN IF (a->>'approvedActorReference'<>NEW.actor_id::text OR a->>'approvedAt'<>r->>'occurredAt' OR a->>'approvedAt'<cur->>'changedAt' OR jsonb_typeof(a->'reviewVersion')<>'number' OR a->>'reviewVersion'<>prior.lifecycle_version::text OR rel IS DISTINCT FROM 'null'::jsonb OR c->'previousRelease' IS DISTINCT FROM 'null'::jsonb) IS NOT FALSE THEN RAISE EXCEPTION 'Platform publishing independent approval invalid' USING ERRCODE='23514';END IF;
 ELSE IF a IS DISTINCT FROM prior_source->'command'->'approvalEvidence' THEN RAISE EXCEPTION 'Platform publishing original approval invalid' USING ERRCODE='23514';END IF;END IF;
 END IF;
 END IF;
 IF NEW.operation_code='Publish' THEN
 IF h.release_record_id IS NOT NULL THEN SELECT receipt_text::jsonb->'source'->'command'->'release' INTO last_release FROM bop_publishing.platform_template_publishing_operation WHERE record_id=h.release_record_id;ELSE last_release:='null'::jsonb;END IF;
 IF (jsonb_typeof(rel)<>'object' OR (SELECT count(*) FROM jsonb_object_keys(rel))<>12 OR NOT rel ?& ARRAY['releaseId','familyReference','configurationType','purposeCode','snapshotReference','snapshotDigest','scope','sequence','sourceLifecycleId','kind','previousReleaseId','createdAt'] OR EXISTS(SELECT 1 FROM jsonb_each(rel) WHERE key NOT IN ('scope','sequence','previousReleaseId') AND jsonb_typeof(value)<>'string') OR rel->>'releaseId'!~'^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' OR (last_release<>'null'::jsonb AND rel->>'releaseId'=last_release->>'releaseId') OR rel->>'kind'<>'Publish' OR rel->>'familyReference'<>NEW.family_id::text OR rel->>'configurationType'<>'PLATFORM_BRAND_TEMPLATE' OR rel->>'purposeCode'<>'PLATFORM_BRAND_TEMPLATE' OR rel->>'snapshotReference'<>n->>'snapshotReference' OR rel->>'snapshotDigest'<>n->>'snapshotDigest' OR rel->'scope' IS DISTINCT FROM n->'scope' OR rel->>'sourceLifecycleId'<>NEW.lifecycle_id::text OR rel->>'createdAt'<>r->>'occurredAt' OR jsonb_typeof(rel->'sequence')<>'number' OR (rel->>'sequence')::bigint<>COALESCE((last_release->>'sequence')::bigint,0)+1 OR c->'previousRelease' IS DISTINCT FROM last_release OR rel->'previousReleaseId' IS DISTINCT FROM COALESCE(last_release->'releaseId','null'::jsonb)) IS NOT FALSE THEN RAISE EXCEPTION 'Platform publishing release conflict' USING ERRCODE='23514';END IF;
 ELSE IF rel IS DISTINCT FROM 'null'::jsonb OR c->'previousRelease' IS DISTINCT FROM 'null'::jsonb THEN RAISE EXCEPTION 'Platform publishing unexpected release' USING ERRCODE='23514';END IF;END IF;
 RETURN NEW;
END; $$;
CREATE FUNCTION bop_publishing.platform_template_publishing_head_advance(p_actor uuid,p_family uuid,p_record uuid,p_expected integer,p_select boolean,p_publish boolean,p_active boolean) RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE r bop_publishing.platform_template_publishing_operation%ROWTYPE;h bop_publishing.platform_template_publishing_head%ROWTYPE;selected_lifecycle uuid;release_lifecycle uuid;expected_select boolean;expected_active boolean;
BEGIN
 IF (p_actor IS NULL OR p_family IS NULL OR p_record IS NULL OR p_expected IS NULL OR p_select IS NULL OR p_publish IS NULL OR p_active IS NULL OR p_actor::text IS DISTINCT FROM current_setting('bop.platform_actor_id',true) OR current_setting('bop.platform_purpose',true) IS DISTINCT FROM 'PLATFORM_BRAND_TEMPLATE') IS NOT FALSE THEN RAISE EXCEPTION 'Platform publishing head unavailable' USING ERRCODE='23514';END IF;
 SELECT * INTO r FROM bop_publishing.platform_template_publishing_operation WHERE record_id=p_record;
 SELECT * INTO h FROM bop_publishing.platform_template_publishing_head WHERE family_id=p_family;
 IF (r.record_id IS NULL OR r.actor_id<>p_actor OR r.family_id<>p_family OR r.outcome<>'Committed' OR r.writer_transaction_id<>txid_current() OR COALESCE(h.sequence,0)<>p_expected OR r.sequence<>p_expected+1) IS NOT FALSE THEN RAISE EXCEPTION 'Platform publishing head CAS invalid' USING ERRCODE='23514';END IF;
 IF h.selected_record_id IS NOT NULL THEN SELECT lifecycle_id INTO selected_lifecycle FROM bop_publishing.platform_template_publishing_operation WHERE record_id=h.selected_record_id;END IF;
 IF h.release_record_id IS NOT NULL THEN SELECT lifecycle_id INTO release_lifecycle FROM bop_publishing.platform_template_publishing_operation WHERE record_id=h.release_record_id;END IF;
 expected_select:=r.operation_code='CreateDraft' OR r.lifecycle_id=selected_lifecycle;
 expected_active:=CASE WHEN r.operation_code='Publish' THEN true WHEN r.operation_code='Archive' AND r.lifecycle_id=release_lifecycle THEN false ELSE COALESCE(h.release_active,false) END;
 IF (p_select IS DISTINCT FROM expected_select OR p_publish IS DISTINCT FROM (r.operation_code='Publish') OR p_active IS DISTINCT FROM expected_active) THEN RAISE EXCEPTION 'Platform publishing head pointers invalid' USING ERRCODE='23514';END IF;
 IF h.family_id IS NULL THEN INSERT INTO bop_publishing.platform_template_publishing_head VALUES(p_family,r.sequence,p_record,NULL,false);
 ELSE UPDATE bop_publishing.platform_template_publishing_head SET sequence=r.sequence,selected_record_id=CASE WHEN p_select THEN p_record ELSE selected_record_id END,release_record_id=CASE WHEN p_publish THEN p_record ELSE release_record_id END,release_active=p_active WHERE family_id=p_family;END IF;
 RETURN true;
END; $$;
CREATE FUNCTION bop_publishing.platform_template_publishing_head_guard() RETURNS trigger LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
DECLARE r bop_publishing.platform_template_publishing_operation%ROWTYPE;selected bop_publishing.platform_template_publishing_operation%ROWTYPE;released bop_publishing.platform_template_publishing_operation%ROWTYPE;
BEGIN
 IF (current_setting('bop.platform_actor_id',true) IS NULL OR current_setting('bop.platform_purpose',true) IS DISTINCT FROM 'PLATFORM_BRAND_TEMPLATE') IS NOT FALSE THEN RAISE EXCEPTION 'Platform publishing head denied' USING ERRCODE='23514';END IF;
 SELECT * INTO r FROM bop_publishing.platform_template_publishing_operation WHERE family_id=NEW.family_id AND sequence=NEW.sequence;
 SELECT * INTO selected FROM bop_publishing.platform_template_publishing_operation WHERE record_id=NEW.selected_record_id;
 IF (r.record_id IS NULL OR r.writer_transaction_id<>txid_current() OR r.actor_id::text IS DISTINCT FROM current_setting('bop.platform_actor_id',true) OR selected.family_id IS DISTINCT FROM NEW.family_id OR selected.sequence>NEW.sequence OR (TG_OP='INSERT' AND (NEW.sequence<>1 OR selected.record_id<>r.record_id OR NEW.release_record_id IS NOT NULL OR NEW.release_active)) OR (TG_OP='UPDATE' AND (NEW.family_id IS DISTINCT FROM OLD.family_id OR NEW.sequence<>OLD.sequence+1))) IS NOT FALSE THEN RAISE EXCEPTION 'Platform publishing head revision invalid' USING ERRCODE='23514';END IF;
 IF TG_OP='UPDATE' THEN
 IF (NEW.selected_record_id IS DISTINCT FROM (CASE WHEN r.operation_code='CreateDraft' OR r.lifecycle_id=(SELECT lifecycle_id FROM bop_publishing.platform_template_publishing_operation WHERE record_id=OLD.selected_record_id) THEN r.record_id ELSE OLD.selected_record_id END) OR NEW.release_record_id IS DISTINCT FROM (CASE WHEN r.operation_code='Publish' THEN r.record_id ELSE OLD.release_record_id END) OR NEW.release_active IS DISTINCT FROM (CASE WHEN r.operation_code='Publish' THEN true WHEN r.operation_code='Archive' AND r.lifecycle_id=(SELECT lifecycle_id FROM bop_publishing.platform_template_publishing_operation WHERE record_id=OLD.release_record_id) THEN false ELSE OLD.release_active END)) THEN RAISE EXCEPTION 'Platform publishing head alteration invalid' USING ERRCODE='23514';END IF;
 END IF;
 IF NEW.release_record_id IS NOT NULL THEN SELECT * INTO released FROM bop_publishing.platform_template_publishing_operation WHERE record_id=NEW.release_record_id;IF (released.family_id IS DISTINCT FROM NEW.family_id OR released.operation_code IS DISTINCT FROM 'Publish' OR released.sequence>NEW.sequence) IS NOT FALSE THEN RAISE EXCEPTION 'Platform publishing release head invalid' USING ERRCODE='23514';END IF;END IF;
 RETURN NEW;
END; $$;
CREATE FUNCTION bop_publishing.platform_template_publishing_complete() RETURNS trigger LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
BEGIN
 IF platform_audit.matches_platform_template_publishing_audit(NEW.audit_id,NEW.actor_id,'PLATFORM_BRAND_TEMPLATE',NEW.record_id,NEW.operation_id,NEW.intent_digest,NEW.occurred_at,NEW.reason_code) IS NOT TRUE THEN RAISE EXCEPTION 'Platform publishing Audit unavailable' USING ERRCODE='23514';END IF;
 IF NEW.outcome='Committed' AND NOT EXISTS(SELECT 1 FROM bop_publishing.platform_template_publishing_head WHERE family_id=NEW.family_id AND sequence>=NEW.sequence) THEN RAISE EXCEPTION 'Platform publishing head incomplete' USING ERRCODE='23514';END IF;
 RETURN NULL;
END; $$;
CREATE TRIGGER platform_template_publishing_operation_guard BEFORE INSERT ON bop_publishing.platform_template_publishing_operation FOR EACH ROW EXECUTE FUNCTION bop_publishing.platform_template_publishing_operation_guard();
CREATE TRIGGER platform_template_publishing_head_guard BEFORE INSERT OR UPDATE ON bop_publishing.platform_template_publishing_head FOR EACH ROW EXECUTE FUNCTION bop_publishing.platform_template_publishing_head_guard();
CREATE CONSTRAINT TRIGGER platform_template_publishing_complete AFTER INSERT ON bop_publishing.platform_template_publishing_operation DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION bop_publishing.platform_template_publishing_complete();
CREATE TRIGGER platform_template_publishing_operation_immutable BEFORE UPDATE OR DELETE ON bop_publishing.platform_template_publishing_operation FOR EACH ROW EXECUTE FUNCTION bop_publishing.platform_template_publishing_immutable();
CREATE TRIGGER platform_template_publishing_operation_no_truncate BEFORE TRUNCATE ON bop_publishing.platform_template_publishing_operation FOR EACH STATEMENT EXECUTE FUNCTION bop_publishing.platform_template_publishing_immutable();
CREATE TRIGGER platform_template_publishing_head_no_delete BEFORE DELETE ON bop_publishing.platform_template_publishing_head FOR EACH ROW EXECUTE FUNCTION bop_publishing.platform_template_publishing_immutable();
CREATE TRIGGER platform_template_publishing_head_no_truncate BEFORE TRUNCATE ON bop_publishing.platform_template_publishing_head FOR EACH STATEMENT EXECUTE FUNCTION bop_publishing.platform_template_publishing_immutable();
ALTER TABLE bop_publishing.platform_template_publishing_head ENABLE ROW LEVEL SECURITY;
ALTER TABLE bop_publishing.platform_template_publishing_head FORCE ROW LEVEL SECURITY;
ALTER TABLE bop_publishing.platform_template_publishing_operation ENABLE ROW LEVEL SECURITY;
ALTER TABLE bop_publishing.platform_template_publishing_operation FORCE ROW LEVEL SECURITY;
CREATE POLICY platform_template_publishing_head_read ON bop_publishing.platform_template_publishing_head FOR SELECT USING(current_setting('bop.platform_purpose',true)='PLATFORM_BRAND_TEMPLATE' AND current_setting('bop.platform_actor_id',true) ~ '^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$');
CREATE POLICY platform_template_publishing_head_insert ON bop_publishing.platform_template_publishing_head FOR INSERT WITH CHECK(current_setting('bop.platform_purpose',true)='PLATFORM_BRAND_TEMPLATE' AND current_setting('bop.platform_actor_id',true) ~ '^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$');
CREATE POLICY platform_template_publishing_head_update ON bop_publishing.platform_template_publishing_head FOR UPDATE USING(current_setting('bop.platform_purpose',true)='PLATFORM_BRAND_TEMPLATE' AND current_setting('bop.platform_actor_id',true) ~ '^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$') WITH CHECK(current_setting('bop.platform_purpose',true)='PLATFORM_BRAND_TEMPLATE' AND current_setting('bop.platform_actor_id',true) ~ '^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$');
CREATE POLICY platform_template_publishing_operation_read ON bop_publishing.platform_template_publishing_operation FOR SELECT USING(current_setting('bop.platform_purpose',true)='PLATFORM_BRAND_TEMPLATE' AND current_setting('bop.platform_actor_id',true) ~ '^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' AND (outcome='Committed' OR actor_id::text=current_setting('bop.platform_actor_id',true)));
CREATE POLICY platform_template_publishing_operation_insert ON bop_publishing.platform_template_publishing_operation FOR INSERT WITH CHECK(current_setting('bop.platform_purpose',true)='PLATFORM_BRAND_TEMPLATE' AND actor_id::text=current_setting('bop.platform_actor_id',true));
REVOKE ALL ON TABLE bop_publishing.platform_template_publishing_head,bop_publishing.platform_template_publishing_operation FROM PUBLIC;
REVOKE ALL ON FUNCTION bop_publishing.platform_template_publishing_operation_admit(uuid,uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION bop_publishing.platform_template_publishing_family_admit(uuid,uuid,boolean) FROM PUBLIC;
REVOKE ALL ON FUNCTION bop_publishing.platform_template_publishing_head_advance(uuid,uuid,uuid,integer,boolean,boolean,boolean) FROM PUBLIC;
REVOKE ALL ON FUNCTION bop_publishing.platform_template_publishing_immutable() FROM PUBLIC;
REVOKE ALL ON FUNCTION bop_publishing.platform_template_publishing_operation_guard() FROM PUBLIC;
REVOKE ALL ON FUNCTION bop_publishing.platform_template_publishing_head_guard() FROM PUBLIC;
REVOKE ALL ON FUNCTION bop_publishing.platform_template_publishing_complete() FROM PUBLIC;
REVOKE ALL ON FUNCTION bop_publishing.platform_template_publishing_canonical_instant(text) FROM PUBLIC;
