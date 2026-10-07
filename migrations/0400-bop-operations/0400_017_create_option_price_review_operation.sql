-- bop-rms-migration: 1
-- owner: @bop/publishing
-- schema: bop_publishing
-- phase: expand
-- risk: medium
-- transaction: required
-- lock-timeout-ms: 5000
-- statement-timeout-ms: 60000
-- recovery: forward-fix
CREATE TABLE bop_publishing.option_price_review_operation (
 tenant_id platform_helpers.uuid_v7 NOT NULL,
 brand_id platform_helpers.uuid_v7 NOT NULL,
 selected_store_id platform_helpers.uuid_v7 NOT NULL,
 actor_id platform_helpers.uuid_v7 NOT NULL,
 operation_id platform_helpers.uuid_v7 NOT NULL,
 action_code text NOT NULL CHECK(action_code IN ('SubmitReview','Approve')),
 outcome_code text NOT NULL CHECK(outcome_code IN ('Committed','Abandoned')),
 command_digest text NOT NULL CHECK(command_digest ~ '^sha256:[0-9a-f]{64}$'),
 command_json jsonb NOT NULL CHECK(octet_length(command_json::text)<=65536),
 recorded_at timestamptz NOT NULL CHECK(isfinite(recorded_at) AND recorded_at=date_trunc('milliseconds',recorded_at)),
 audit_id platform_helpers.uuid_v7 NOT NULL,
 mutation_json jsonb CHECK(octet_length(mutation_json::text)<=1048576),
 mutation_digest text CHECK(mutation_digest ~ '^sha256:[0-9a-f]{64}$'),
 PRIMARY KEY(tenant_id,brand_id,operation_id),
 UNIQUE(tenant_id,brand_id,audit_id),
 CHECK((outcome_code='Committed')=(mutation_json IS NOT NULL) AND (mutation_json IS NULL)=(mutation_digest IS NULL)),
 CHECK(coalesce(jsonb_typeof(command_json)='object'
  AND command_json ?& ARRAY['profile','tenantReference','brandReference','selectedStoreReference','actorReference','reasonCode','action','operationReference','ruleReference','draftVersionReference','draftSnapshotDigest','expectedAggregateVersion','validationValidUntil','approvalValidUntil','expectedLifecycle']
  AND (command_json - ARRAY['profile','tenantReference','brandReference','selectedStoreReference','actorReference','reasonCode','action','operationReference','ruleReference','draftVersionReference','draftSnapshotDigest','expectedAggregateVersion','validationValidUntil','approvalValidUntil','expectedLifecycle'])='{}'::jsonb
  AND command_json->>'profile'='PublishingOptionPriceReviewOperationV1'
  AND command_json->>'tenantReference'=tenant_id::text AND command_json->>'brandReference'=brand_id::text
  AND command_json->>'selectedStoreReference'=selected_store_id::text AND command_json->>'actorReference'=actor_id::text
  AND command_json->>'operationReference'=operation_id::text AND command_json->>'action'=action_code
  AND command_json->>'reasonCode'='AUTHORIZED_OPERATION'
  AND command_json->>'draftSnapshotDigest' ~ '^sha256:[0-9a-f]{64}$'
  AND ((command_json->>'ruleReference')::platform_helpers.uuid_v7 IS NOT NULL)
  AND ((command_json->>'draftVersionReference')::platform_helpers.uuid_v7 IS NOT NULL)
  AND jsonb_typeof(command_json->'expectedAggregateVersion')='number'
  AND (command_json->>'expectedAggregateVersion')::numeric>=1
  AND (command_json->>'expectedAggregateVersion')::numeric=trunc((command_json->>'expectedAggregateVersion')::numeric)
  AND (command_json->'expectedLifecycle'='null'::jsonb OR
    (jsonb_typeof(command_json->'expectedLifecycle')='object'
     AND command_json->'expectedLifecycle' ?& ARRAY['lifecycleReference','version','state','latestMutationOperationReference']
     AND ((command_json->'expectedLifecycle') - ARRAY['lifecycleReference','version','state','latestMutationOperationReference'])='{}'::jsonb
     AND ((command_json#>>'{expectedLifecycle,lifecycleReference}')::platform_helpers.uuid_v7 IS NOT NULL)
     AND ((command_json#>>'{expectedLifecycle,latestMutationOperationReference}')::platform_helpers.uuid_v7 IS NOT NULL)
     AND jsonb_typeof(command_json#>'{expectedLifecycle,version}')='number'
     AND (command_json#>>'{expectedLifecycle,version}')::numeric>=1
     AND (command_json#>>'{expectedLifecycle,version}')::numeric=trunc((command_json#>>'{expectedLifecycle,version}')::numeric)))
  AND command_json->>'validationValidUntil' ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{3}Z$'
  AND isfinite((command_json->>'validationValidUntil')::timestamptz)
  AND ((action_code='SubmitReview' AND command_json->'approvalValidUntil'='null'::jsonb
    AND (command_json->'expectedLifecycle'='null'::jsonb OR command_json#>>'{expectedLifecycle,state}'='Draft'))
   OR (action_code='Approve' AND command_json#>>'{expectedLifecycle,state}'='InReview'
    AND command_json->>'approvalValidUntil' ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{3}Z$'
    AND isfinite((command_json->>'approvalValidUntil')::timestamptz)
    AND (command_json->>'approvalValidUntil')::timestamptz<=(command_json->>'validationValidUntil')::timestamptz)),false))
);
ALTER TABLE bop_publishing.option_price_review_operation ENABLE ROW LEVEL SECURITY;
ALTER TABLE bop_publishing.option_price_review_operation FORCE ROW LEVEL SECURITY;
CREATE POLICY option_price_review_operation_scope ON bop_publishing.option_price_review_operation
 USING(tenant_id=current_setting('bop.tenant_id',true)::uuid AND brand_id=platform_helpers.current_brand_id() AND selected_store_id=platform_helpers.current_store_id())
 WITH CHECK(tenant_id=current_setting('bop.tenant_id',true)::uuid AND brand_id=platform_helpers.current_brand_id() AND selected_store_id=platform_helpers.current_store_id());
REVOKE ALL ON TABLE bop_publishing.option_price_review_operation FROM PUBLIC;
-- Owning boolean only: protects Brand-wide operation uniqueness from a Store-hidden collision.
CREATE FUNCTION bop_publishing.option_price_review_operation_available(operation_reference uuid) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog
SET row_security = off
AS $$
DECLARE tenant uuid; brand uuid;
BEGIN
 tenant:=nullif(current_setting('bop.tenant_id',true),'')::uuid;
 brand:=platform_helpers.current_brand_id();
 IF tenant IS NULL OR brand IS NULL OR platform_helpers.current_store_id() IS NULL THEN
  RAISE EXCEPTION 'Publishing operation scope is required' USING ERRCODE='23514';
 END IF;
 RETURN NOT EXISTS(SELECT 1 FROM bop_publishing.publishing_mutation_record WHERE tenant_id=tenant AND brand_id=brand AND operation_id=operation_reference)
 AND NOT EXISTS(SELECT 1 FROM bop_publishing.option_price_review_operation WHERE tenant_id=tenant AND brand_id=brand AND operation_id=operation_reference)
 AND NOT EXISTS(SELECT 1 FROM bop_publishing.option_set_publication_operation WHERE tenant_id=tenant AND brand_id=brand AND operation_id=operation_reference);
END;
$$;
REVOKE ALL ON FUNCTION bop_publishing.option_price_review_operation_available(uuid) FROM PUBLIC;
CREATE FUNCTION bop_publishing.option_price_review_terminal_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog
SET row_security = off
AS $$
DECLARE source bop_publishing.publishing_mutation_record%ROWTYPE; source_xmin xid;
BEGIN
 IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'Publishing terminal history is append-only' USING ERRCODE='55000'; END IF;
 IF TG_TABLE_SCHEMA<>'bop_publishing' OR TG_TABLE_NAME<>'option_price_review_operation'
  OR current_setting('transaction_isolation')<>'read committed'
  OR NEW.tenant_id::text IS DISTINCT FROM nullif(current_setting('bop.tenant_id',true),'')
  OR NEW.brand_id IS DISTINCT FROM platform_helpers.current_brand_id()
  OR NEW.selected_store_id IS DISTINCT FROM platform_helpers.current_store_id() THEN
  RAISE EXCEPTION 'Publishing terminal scope is invalid' USING ERRCODE='23514';
 END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended('PublishingOperation:'||NEW.tenant_id::text||':'||NEW.brand_id::text||':'||NEW.operation_id::text,0));
 IF EXISTS(SELECT 1 FROM bop_publishing.option_set_publication_operation WHERE tenant_id=NEW.tenant_id AND brand_id=NEW.brand_id AND operation_id=NEW.operation_id) THEN
  RAISE EXCEPTION 'Publishing operation belongs to another terminal' USING ERRCODE='23514';
 END IF;
 SELECT xmin INTO source_xmin FROM bop_publishing.publishing_mutation_record WHERE tenant_id=NEW.tenant_id AND brand_id=NEW.brand_id AND operation_id=NEW.operation_id;
 SELECT * INTO source FROM bop_publishing.publishing_mutation_record WHERE tenant_id=NEW.tenant_id AND brand_id=NEW.brand_id AND operation_id=NEW.operation_id;
 IF NEW.outcome_code='Abandoned' THEN
  IF FOUND THEN RAISE EXCEPTION 'Publishing operation is already committed' USING ERRCODE='23514'; END IF;
 ELSE
  IF NOT FOUND OR source_xmin IS DISTINCT FROM mod(pg_current_xact_id()::text::numeric,4294967296)::text::xid
   OR source.store_id IS NOT NULL OR source.operation_code<>NEW.action_code
   OR source.actor_id<>NEW.actor_id OR source.audit_id<>NEW.audit_id
   OR source.intent_hash<>NEW.mutation_digest OR source.mutation_json IS DISTINCT FROM NEW.mutation_json
   OR source.family_id::text IS DISTINCT FROM NEW.command_json->>'ruleReference'
   OR source.mutation_json#>>'{next,configurationType}' IS DISTINCT FROM 'OPTION_PRICE_RULE'
   OR source.mutation_json#>>'{next,purposeCode}' IS DISTINCT FROM 'OPTION_PRICE_RULE_PUBLICATION'
   OR source.mutation_json#>>'{audit,occurredAt}' IS DISTINCT FROM to_char(NEW.recorded_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
   OR source.mutation_json#>>'{audit,reasonCode}' IS DISTINCT FROM (CASE NEW.action_code WHEN 'SubmitReview' THEN 'PUBLISHING_REVIEW_SUBMITTED' ELSE 'PUBLISHING_REVIEW_APPROVED' END)
   OR source.mutation_json#>>'{next,snapshotReference}' IS DISTINCT FROM NEW.command_json->>'draftVersionReference'
   OR source.mutation_json#>>'{next,snapshotDigest}' IS DISTINCT FROM NEW.command_json->>'draftSnapshotDigest'
   OR source.mutation_json#>>'{audit,correlationId}' IS DISTINCT FROM NEW.operation_id::text
   OR source.mutation_json#>>'{audit,actor,reference}' IS DISTINCT FROM NEW.actor_id::text
   OR (NEW.action_code='SubmitReview' AND (source.mutation_json#>>'{validationEvidence,validUntil}' IS DISTINCT FROM NEW.command_json->>'validationValidUntil'
       OR (NEW.command_json->>'validationValidUntil')::timestamptz<=NEW.recorded_at
       OR source.mutation_json#>>'{next,state}' IS DISTINCT FROM 'InReview'))
   OR (NEW.action_code='Approve' AND (source.mutation_json#>>'{approvalEvidence,validUntil}' IS DISTINCT FROM NEW.command_json->>'approvalValidUntil'
       OR (NEW.command_json->>'approvalValidUntil')::timestamptz<=NEW.recorded_at
       OR source.mutation_json#>>'{next,state}' IS DISTINCT FROM 'Approved'
       OR NOT EXISTS(SELECT 1 FROM bop_publishing.publishing_mutation_record original_review
          WHERE original_review.tenant_id=NEW.tenant_id AND original_review.brand_id=NEW.brand_id
          AND original_review.store_id IS NULL AND original_review.lifecycle_id=source.lifecycle_id
          AND original_review.operation_code='SubmitReview'
          AND original_review.mutation_json#>>'{validationEvidence,evidenceReference}'=source.mutation_json#>>'{current,validationEvidenceReference}'
          AND original_review.mutation_json#>>'{validationEvidence,validUntil}'=NEW.command_json->>'validationValidUntil')))
   OR (NEW.command_json->'expectedLifecycle'<>'null'::jsonb AND (source.lifecycle_id::text IS DISTINCT FROM NEW.command_json#>>'{expectedLifecycle,lifecycleReference}'
       OR source.mutation_json#>>'{current,version}' IS DISTINCT FROM NEW.command_json#>>'{expectedLifecycle,version}'
       OR source.mutation_json#>>'{current,state}' IS DISTINCT FROM NEW.command_json#>>'{expectedLifecycle,state}'
       OR NOT EXISTS(SELECT 1 FROM bop_publishing.publishing_mutation_record predecessor
          WHERE predecessor.tenant_id=NEW.tenant_id AND predecessor.brand_id=NEW.brand_id
          AND predecessor.store_id IS NULL AND predecessor.lifecycle_id=source.lifecycle_id
          AND predecessor.lifecycle_version=(NEW.command_json#>>'{expectedLifecycle,version}')::integer
          AND predecessor.operation_id::text=NEW.command_json#>>'{expectedLifecycle,latestMutationOperationReference}'))) THEN
   RAISE EXCEPTION 'Publishing terminal has no original transaction source' USING ERRCODE='23514';
  END IF;
 END IF;
 RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION bop_publishing.option_price_review_terminal_guard() FROM PUBLIC;
CREATE TRIGGER option_price_review_terminal_guard BEFORE INSERT OR UPDATE OR DELETE ON bop_publishing.option_price_review_operation
 FOR EACH ROW EXECUTE FUNCTION bop_publishing.option_price_review_terminal_guard();
CREATE TRIGGER option_price_review_terminal_truncate_guard BEFORE TRUNCATE ON bop_publishing.option_price_review_operation
 FOR EACH STATEMENT EXECUTE FUNCTION bop_publishing.option_price_review_terminal_guard();
CREATE FUNCTION bop_publishing.option_price_review_mutation_fence() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog
SET row_security = off
AS $$
BEGIN
 IF TG_OP<>'INSERT' OR TG_TABLE_SCHEMA<>'bop_publishing' OR TG_TABLE_NAME<>'publishing_mutation_record'
  OR NEW.tenant_id::text IS DISTINCT FROM nullif(current_setting('bop.tenant_id',true),'')
  OR NEW.brand_id IS DISTINCT FROM platform_helpers.current_brand_id() THEN
  RAISE EXCEPTION 'Publishing mutation fence scope is invalid' USING ERRCODE='23514';
 END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended('PublishingOperation:'||NEW.tenant_id::text||':'||NEW.brand_id::text||':'||NEW.operation_id::text,0));
 IF EXISTS(SELECT 1 FROM bop_publishing.option_price_review_operation WHERE tenant_id=NEW.tenant_id AND brand_id=NEW.brand_id AND operation_id=NEW.operation_id) THEN
  RAISE EXCEPTION 'Publishing operation is terminal' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION bop_publishing.option_price_review_mutation_fence() FROM PUBLIC;
CREATE TRIGGER option_price_review_mutation_fence BEFORE INSERT ON bop_publishing.publishing_mutation_record
 FOR EACH ROW EXECUTE FUNCTION bop_publishing.option_price_review_mutation_fence();
CREATE FUNCTION bop_publishing.option_price_review_mutation_linkage() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog
SET row_security = off
AS $$
DECLARE terminal bop_publishing.option_price_review_operation%ROWTYPE; terminal_xmin xid;
BEGIN
 IF NEW.mutation_json#>>'{next,configurationType}'='OPTION_PRICE_RULE' AND NEW.mutation_json#>>'{next,purposeCode}'='OPTION_PRICE_RULE_PUBLICATION' AND NEW.operation_code IN ('SubmitReview','Approve') THEN
  SELECT xmin INTO terminal_xmin FROM bop_publishing.option_price_review_operation WHERE tenant_id=NEW.tenant_id AND brand_id=NEW.brand_id AND operation_id=NEW.operation_id;
  SELECT * INTO terminal FROM bop_publishing.option_price_review_operation WHERE tenant_id=NEW.tenant_id AND brand_id=NEW.brand_id AND operation_id=NEW.operation_id;
  IF NOT FOUND OR terminal.outcome_code<>'Committed' OR terminal.actor_id<>NEW.actor_id OR terminal.audit_id<>NEW.audit_id
   OR terminal.mutation_json IS DISTINCT FROM NEW.mutation_json OR terminal.mutation_digest<>NEW.intent_hash
   OR terminal_xmin IS DISTINCT FROM mod(pg_current_xact_id()::text::numeric,4294967296)::text::xid THEN
   RAISE EXCEPTION 'OptionPrice review requires its same-transaction original terminal identity' USING ERRCODE='23514';
  END IF;
 END IF;
 RETURN NULL;
END;
$$;
REVOKE ALL ON FUNCTION bop_publishing.option_price_review_mutation_linkage() FROM PUBLIC;
CREATE CONSTRAINT TRIGGER option_price_review_mutation_linkage AFTER INSERT ON bop_publishing.publishing_mutation_record
 DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION bop_publishing.option_price_review_mutation_linkage();
