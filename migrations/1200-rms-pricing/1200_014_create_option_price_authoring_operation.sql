-- bop-rms-migration: 1
-- owner: @rms/pricing
-- schema: rms_pricing
-- phase: expand
-- risk: medium
-- transaction: required
-- lock-timeout-ms: 5000
-- statement-timeout-ms: 60000
-- recovery: forward-fix
ALTER TABLE rms_pricing.option_price_rule
  ADD COLUMN draft_version_id platform_helpers.uuid_v7,
  ADD COLUMN draft_author_actor_id platform_helpers.uuid_v7,
  ADD CONSTRAINT option_price_rule_draft_version_fk
    FOREIGN KEY (draft_version_id, option_price_rule_id, brand_id, binding_id, option_id)
    REFERENCES rms_pricing.option_price_rule_version
      (option_price_rule_version_id, option_price_rule_id, brand_id, binding_id, option_id),
  ADD CONSTRAINT option_price_rule_draft_author_check
    CHECK ((draft_version_id IS NULL) = (draft_author_actor_id IS NULL)),
  ADD CONSTRAINT option_price_rule_distinct_heads
    CHECK (draft_version_id IS NULL OR current_version_id IS NULL OR draft_version_id <> current_version_id);

CREATE TABLE rms_pricing.option_price_authoring_operation (
  operation_id platform_helpers.uuid_v7 PRIMARY KEY,
  tenant_id platform_helpers.uuid_v7 NOT NULL,
  brand_id platform_helpers.uuid_v7 NOT NULL,
  selected_store_id platform_helpers.uuid_v7 NOT NULL,
  actor_id platform_helpers.uuid_v7 NOT NULL,
  option_price_rule_id platform_helpers.uuid_v7 NOT NULL,
  action_code text NOT NULL CHECK (action_code IN ('CreateDraft','ReplaceDraft','Publish','Archive')),
  intent_digest text NOT NULL CHECK (intent_digest ~ '^sha256:[a-f0-9]{64}$'),
  outcome text NOT NULL CHECK (outcome IN ('Committed','Abandoned')),
  result_version_id platform_helpers.uuid_v7,
  result_aggregate_version bigint,
  receipt_json jsonb NOT NULL CHECK (jsonb_typeof(receipt_json)='object' AND octet_length(receipt_json::text)<=131072),
  record_digest text NOT NULL CHECK (record_digest ~ '^sha256:[a-f0-9]{64}$'),
  audit_id platform_helpers.uuid_v7 NOT NULL UNIQUE,
  audit_json jsonb NOT NULL CHECK (jsonb_typeof(audit_json)='object' AND octet_length(audit_json::text)<=65536),
  event_id platform_helpers.uuid_v7 UNIQUE,
  occurred_at timestamp with time zone NOT NULL,
  CONSTRAINT option_price_authoring_terminal_check CHECK (
    (outcome='Committed' AND result_version_id IS NOT NULL AND result_aggregate_version BETWEEN 1 AND 2147483647 AND event_id IS NOT NULL)
    OR (outcome='Abandoned' AND result_version_id IS NULL AND result_aggregate_version IS NULL AND event_id IS NULL)
  )
);
ALTER TABLE rms_pricing.option_price_rule_version
  ADD COLUMN authoring_operation_id platform_helpers.uuid_v7,
  ADD CONSTRAINT option_price_version_original_operation_fk
    FOREIGN KEY (authoring_operation_id) REFERENCES rms_pricing.option_price_authoring_operation(operation_id)
    DEFERRABLE INITIALLY DEFERRED;

CREATE FUNCTION rms_pricing.option_price_version_original_coherent() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
DECLARE
  original_row record;
BEGIN
  IF NEW.authoring_operation_id IS NULL THEN RETURN NEW; END IF;
  SELECT o.*,o.xmin::text AS held_xmin INTO original_row
    FROM rms_pricing.option_price_authoring_operation o WHERE operation_id=NEW.authoring_operation_id;
  IF original_row.operation_id IS NULL OR original_row.held_xmin IS DISTINCT FROM pg_current_xact_id()::text
    OR original_row.outcome IS DISTINCT FROM 'Committed'
    OR original_row.brand_id IS DISTINCT FROM NEW.brand_id
    OR original_row.option_price_rule_id IS DISTINCT FROM NEW.option_price_rule_id
    OR original_row.result_version_id IS DISTINCT FROM NEW.option_price_rule_version_id
    OR original_row.result_aggregate_version IS DISTINCT FROM NEW.version_number
    OR original_row.occurred_at IS DISTINCT FROM NEW.created_at THEN
    RAISE EXCEPTION 'Option price version has no original terminal' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION rms_pricing.option_price_version_original_coherent() FROM PUBLIC;
CREATE CONSTRAINT TRIGGER option_price_version_original_check
  AFTER INSERT ON rms_pricing.option_price_rule_version
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION rms_pricing.option_price_version_original_coherent();

CREATE INDEX option_price_authoring_rule_history_idx
  ON rms_pricing.option_price_authoring_operation(brand_id,option_price_rule_id,result_aggregate_version);

CREATE FUNCTION rms_pricing.reject_option_price_authoring_mutation() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
BEGIN
  RAISE EXCEPTION 'immutable Option price original operation' USING ERRCODE='55000';
END;
$$;
REVOKE ALL ON FUNCTION rms_pricing.reject_option_price_authoring_mutation() FROM PUBLIC;
CREATE TRIGGER option_price_authoring_no_mutation BEFORE UPDATE OR DELETE ON rms_pricing.option_price_authoring_operation
  FOR EACH ROW EXECUTE FUNCTION rms_pricing.reject_option_price_authoring_mutation();
CREATE TRIGGER option_price_authoring_no_truncate BEFORE TRUNCATE ON rms_pricing.option_price_authoring_operation
  FOR EACH STATEMENT EXECUTE FUNCTION rms_pricing.reject_option_price_authoring_mutation();

CREATE FUNCTION rms_pricing.option_price_authoring_operation_available(scope_brand platform_helpers.uuid_v7, original_operation platform_helpers.uuid_v7) RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
BEGIN
  IF scope_brand IS NULL OR scope_brand IS DISTINCT FROM platform_helpers.current_brand_id() OR original_operation IS NULL OR nullif(current_setting('bop.tenant_id',true),'') IS NULL OR platform_helpers.current_store_id() IS NULL THEN
    RAISE EXCEPTION 'Option price original scope unavailable' USING ERRCODE='42501';
  END IF;
  RETURN NOT EXISTS (SELECT 1 FROM rms_pricing.option_price_authoring_operation WHERE operation_id=original_operation);
END;
$$;
REVOKE ALL ON FUNCTION rms_pricing.option_price_authoring_operation_available(platform_helpers.uuid_v7,platform_helpers.uuid_v7) FROM PUBLIC;

CREATE FUNCTION rms_pricing.option_price_authoring_terminal_coherent() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
DECLARE
  root_row record;
  version_row record;
  receipt jsonb;
  original_command jsonb;
  result_state jsonb;
  result_version jsonb;
BEGIN
  receipt := NEW.receipt_json;
  original_command := receipt->'command';
  IF NEW.tenant_id::text IS DISTINCT FROM nullif(current_setting('bop.tenant_id',true),'')
    OR NEW.brand_id IS DISTINCT FROM platform_helpers.current_brand_id()
    OR NEW.selected_store_id IS DISTINCT FROM platform_helpers.current_store_id()
    OR (SELECT count(*) FROM jsonb_object_keys(receipt))<>13 OR receipt->>'profile' IS DISTINCT FROM 'OptionPriceAuthoringOperationV1'
    OR receipt->>'tenantReference' IS DISTINCT FROM NEW.tenant_id::text
    OR receipt->>'brandReference' IS DISTINCT FROM NEW.brand_id::text
    OR receipt->>'selectedStoreReference' IS DISTINCT FROM NEW.selected_store_id::text
    OR receipt->>'actorReference' IS DISTINCT FROM NEW.actor_id::text
    OR receipt->>'intentDigest' IS DISTINCT FROM NEW.intent_digest
    OR receipt->>'outcome' IS DISTINCT FROM NEW.outcome
    OR receipt->>'auditReference' IS DISTINCT FROM NEW.audit_id::text
    OR receipt->>'eventReference' IS DISTINCT FROM NEW.event_id::text
    OR receipt->>'occurredAt' IS DISTINCT FROM to_char(NEW.occurred_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
    OR (SELECT count(*) FROM jsonb_object_keys(original_command))<>7
    OR original_command->>'operationReference' IS DISTINCT FROM NEW.operation_id::text
    OR original_command->>'ruleReference' IS DISTINCT FROM NEW.option_price_rule_id::text
    OR original_command->>'action' IS DISTINCT FROM NEW.action_code
    OR NEW.audit_json->>'auditId' IS DISTINCT FROM NEW.audit_id::text
    OR NEW.audit_json->>'brandId' IS DISTINCT FROM NEW.brand_id::text
    OR NEW.audit_json ? 'storeId'
    OR NEW.audit_json->'actor'->>'type' IS DISTINCT FROM 'User'
    OR NEW.audit_json->'actor'->>'reference' IS DISTINCT FROM NEW.actor_id::text
    OR NEW.audit_json->>'targetType' IS DISTINCT FROM 'PricingOptionPriceRule'
    OR NEW.audit_json->>'targetId' IS DISTINCT FROM NEW.option_price_rule_id::text
    OR NEW.audit_json->>'correlationId' IS DISTINCT FROM NEW.operation_id::text
    OR NEW.audit_json->>'occurredAt' IS DISTINCT FROM receipt->>'occurredAt'
    OR NEW.audit_json->>'reasonCode' IS DISTINCT FROM 'AUTHORIZED_OPERATION'
    OR date_trunc('milliseconds',NEW.occurred_at)<>NEW.occurred_at THEN
    RAISE EXCEPTION 'incoherent Option price original identity' USING ERRCODE='23514';
  END IF;
  IF NEW.outcome='Abandoned' THEN
    IF receipt->'state' IS DISTINCT FROM 'null'::jsonb OR receipt->'publicationAuthorization' IS DISTINCT FROM 'null'::jsonb
      OR NEW.audit_json->>'actionCode' IS DISTINCT FROM 'PRICING_OPTION_PRICE_RESOLVE' THEN
      RAISE EXCEPTION 'incoherent Option price abandoned original' USING ERRCODE='23514';
    END IF;
    RETURN NEW;
  END IF;
  SELECT r.*,r.xmin::text AS held_xmin INTO root_row FROM rms_pricing.option_price_rule r WHERE option_price_rule_id=NEW.option_price_rule_id AND brand_id=NEW.brand_id;
  SELECT v.*,v.xmin::text AS held_xmin INTO version_row FROM rms_pricing.option_price_rule_version v WHERE option_price_rule_version_id=NEW.result_version_id AND option_price_rule_id=NEW.option_price_rule_id AND brand_id=NEW.brand_id;
  result_state := receipt->'state';
  result_version := result_state->'latestVersion';
  IF root_row.option_price_rule_id IS NULL OR version_row.option_price_rule_version_id IS NULL
    OR root_row.held_xmin IS DISTINCT FROM pg_current_xact_id()::text
    OR version_row.held_xmin IS DISTINCT FROM pg_current_xact_id()::text
    OR root_row.aggregate_version IS DISTINCT FROM NEW.result_aggregate_version
    OR version_row.authoring_operation_id IS DISTINCT FROM NEW.operation_id
    OR version_row.version_number IS DISTINCT FROM NEW.result_aggregate_version
    OR root_row.updated_at IS DISTINCT FROM NEW.occurred_at OR version_row.created_at IS DISTINCT FROM NEW.occurred_at
    OR version_row.binding_id IS DISTINCT FROM root_row.binding_id OR version_row.option_id IS DISTINCT FROM root_row.option_id
    OR result_state->>'brandReference' IS DISTINCT FROM NEW.brand_id::text
    OR result_state->>'ruleReference' IS DISTINCT FROM NEW.option_price_rule_id::text
    OR result_state->>'bindingReference' IS DISTINCT FROM root_row.binding_id::text
    OR result_state->>'optionReference' IS DISTINCT FROM root_row.option_id::text
    OR result_state->'aggregateVersion' IS DISTINCT FROM to_jsonb(NEW.result_aggregate_version)
    OR result_state->>'updatedAt' IS DISTINCT FROM receipt->>'occurredAt'
    OR result_state->>'createdAt' IS DISTINCT FROM to_char(root_row.created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
    OR result_state->>'createdByActorReference' IS DISTINCT FROM root_row.created_by_actor_id::text
    OR result_state->>'draftAuthorActorReference' IS DISTINCT FROM root_row.draft_author_actor_id::text
    OR result_state->'draft'->>'versionReference' IS DISTINCT FROM root_row.draft_version_id::text
    OR result_state->'currentPublished'->>'versionReference' IS DISTINCT FROM root_row.current_version_id::text
    OR result_version->>'versionReference' IS DISTINCT FROM NEW.result_version_id::text
    OR result_version->>'snapshotDigest' IS DISTINCT FROM version_row.snapshot_digest
    OR result_version->>'lifecycle' IS DISTINCT FROM version_row.lifecycle
    OR NEW.result_aggregate_version IS DISTINCT FROM COALESCE((original_command->>'expectedAggregateVersion')::bigint,0)+1
    OR NEW.audit_json->>'actionCode' IS DISTINCT FROM 'PRICING_OPTION_PRICE_'||upper(NEW.action_code)
    OR (NEW.action_code IN ('CreateDraft','ReplaceDraft') AND (version_row.lifecycle<>'Draft' OR root_row.draft_version_id IS DISTINCT FROM NEW.result_version_id OR root_row.draft_author_actor_id IS DISTINCT FROM NEW.actor_id))
    OR (NEW.action_code='Publish' AND (version_row.lifecycle<>'Published' OR root_row.current_version_id IS DISTINCT FROM NEW.result_version_id OR root_row.draft_version_id IS NOT NULL OR receipt->'publicationAuthorization'='null'::jsonb))
    OR (NEW.action_code='Archive' AND (version_row.lifecycle<>'Archived' OR root_row.current_version_id IS NOT NULL)) THEN
    RAISE EXCEPTION 'incoherent Option price committed original' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION rms_pricing.option_price_authoring_terminal_coherent() FROM PUBLIC;
CREATE CONSTRAINT TRIGGER option_price_authoring_terminal_coherence
  AFTER INSERT ON rms_pricing.option_price_authoring_operation
  DEFERRABLE INITIALLY IMMEDIATE
  FOR EACH ROW EXECUTE FUNCTION rms_pricing.option_price_authoring_terminal_coherent();
ALTER TABLE rms_pricing.option_price_authoring_operation ENABLE ROW LEVEL SECURITY;
ALTER TABLE rms_pricing.option_price_authoring_operation FORCE ROW LEVEL SECURITY;
CREATE POLICY option_price_authoring_brand_scope ON rms_pricing.option_price_authoring_operation
  USING ((tenant_id::text=current_setting('bop.tenant_id',true) AND brand_id=platform_helpers.current_brand_id() AND selected_store_id=platform_helpers.current_store_id()) IS TRUE)
  WITH CHECK ((tenant_id::text=current_setting('bop.tenant_id',true) AND brand_id=platform_helpers.current_brand_id() AND selected_store_id=platform_helpers.current_store_id()) IS TRUE);
REVOKE ALL ON TABLE rms_pricing.option_price_authoring_operation FROM PUBLIC;
