-- bop-rms-migration: 1
-- owner: @rms/pricing
-- schema: rms_pricing
-- phase: expand
-- risk: medium
-- transaction: required
-- lock-timeout-ms: 5000
-- statement-timeout-ms: 60000
-- recovery: forward-fix

-- Preparation records immutable content and identity reservations. It does not
-- establish registration applicability, professional approval or publication.
CREATE TABLE rms_pricing.tax_config_publication_candidate (
  target_version_id platform_helpers.uuid_v7 PRIMARY KEY,
  tenant_id platform_helpers.uuid_v7 NOT NULL,
  brand_id platform_helpers.uuid_v7 NOT NULL,
  store_id platform_helpers.uuid_v7 NOT NULL,
  configuration_id platform_helpers.uuid_v7 NOT NULL,
  actor_id platform_helpers.uuid_v7 NOT NULL,
  operation_id platform_helpers.uuid_v7 NOT NULL UNIQUE,
  base_version_id platform_helpers.uuid_v7 NOT NULL,
  base_snapshot_digest text NOT NULL CHECK (base_snapshot_digest ~ '^sha256:[a-f0-9]{64}$'),
  base_aggregate_version integer NOT NULL CHECK (base_aggregate_version BETWEEN 1 AND 2147483646),
  base_version_number integer NOT NULL CHECK (base_version_number BETWEEN 1 AND 2147483646),
  target_aggregate_version integer NOT NULL CHECK (target_aggregate_version=base_aggregate_version+1),
  target_version_number integer NOT NULL CHECK (target_version_number=base_version_number+1),
  registration_material_id platform_helpers.uuid_v7 NOT NULL,
  registration_version_id platform_helpers.uuid_v7 NOT NULL,
  registration_content_digest text NOT NULL CHECK (registration_content_digest ~ '^sha256:[a-f0-9]{64}$'),
  content_digest text NOT NULL CHECK (content_digest ~ '^sha256:[a-f0-9]{64}$'),
  record_json jsonb NOT NULL CHECK (jsonb_typeof(record_json)='object' AND octet_length(record_json::text)<=524288),
  record_text text NOT NULL CHECK (octet_length(record_text)<=270336 AND record_text::jsonb=record_json),
  record_digest text NOT NULL CHECK (record_digest='sha256:'||encode(sha256(convert_to(record_text,'UTF8')),'hex')),
  audit_id platform_helpers.uuid_v7 NOT NULL UNIQUE,
  event_id platform_helpers.uuid_v7 NOT NULL UNIQUE,
  prepared_at timestamptz NOT NULL CHECK (isfinite(prepared_at) AND date_trunc('milliseconds',prepared_at)=prepared_at),
  data_classification text NOT NULL CHECK (data_classification='Confidential'),
  CONSTRAINT tax_config_candidate_distinct_version CHECK (target_version_id<>base_version_id),
  CONSTRAINT tax_config_candidate_scope_unique UNIQUE (target_version_id,tenant_id,brand_id,store_id,configuration_id),
  CONSTRAINT tax_config_candidate_base_scope_unique UNIQUE (target_version_id,tenant_id,brand_id,store_id,configuration_id,base_version_id),
  CONSTRAINT tax_config_candidate_base_fk FOREIGN KEY (base_version_id,configuration_id,brand_id,store_id)
    REFERENCES rms_pricing.tax_configuration_version(tax_configuration_version_id,tax_configuration_id,brand_id,store_id),
  CONSTRAINT tax_config_candidate_registration_fk FOREIGN KEY (registration_version_id)
    REFERENCES rms_pricing.tax_config_material_version(version_id)
);
CREATE TABLE rms_pricing.tax_config_candidate_operation (
  operation_id platform_helpers.uuid_v7 PRIMARY KEY,
  tenant_id platform_helpers.uuid_v7 NOT NULL,
  brand_id platform_helpers.uuid_v7 NOT NULL,
  store_id platform_helpers.uuid_v7 NOT NULL,
  actor_id platform_helpers.uuid_v7 NOT NULL,
  action_code text NOT NULL CHECK (action_code='PrepareCandidate'),
  configuration_id platform_helpers.uuid_v7 NOT NULL,
  expected_base_version_id platform_helpers.uuid_v7 NOT NULL,
  expected_base_snapshot_digest text NOT NULL CHECK (expected_base_snapshot_digest ~ '^sha256:[a-f0-9]{64}$'),
  expected_base_aggregate_version integer NOT NULL CHECK (expected_base_aggregate_version BETWEEN 1 AND 2147483646),
  expected_base_version_number integer NOT NULL CHECK (expected_base_version_number BETWEEN 1 AND 2147483646),
  registration_material_id platform_helpers.uuid_v7 NOT NULL,
  registration_version_id platform_helpers.uuid_v7 NOT NULL,
  registration_content_digest text NOT NULL CHECK (registration_content_digest ~ '^sha256:[a-f0-9]{64}$'),
  intent_digest text NOT NULL CHECK (intent_digest ~ '^sha256:[a-f0-9]{64}$'),
  outcome text NOT NULL CHECK (outcome IN ('Committed','Abandoned')),
  result_target_version_id platform_helpers.uuid_v7,
  receipt_json jsonb NOT NULL CHECK (jsonb_typeof(receipt_json)='object' AND octet_length(receipt_json::text)<=1048576),
  receipt_text text NOT NULL CHECK (octet_length(receipt_text)<=278528 AND receipt_text::jsonb=receipt_json),
  receipt_digest text NOT NULL CHECK (receipt_digest='sha256:'||encode(sha256(convert_to(receipt_text,'UTF8')),'hex')),
  audit_id platform_helpers.uuid_v7 NOT NULL UNIQUE,
  audit_json jsonb NOT NULL CHECK (jsonb_typeof(audit_json)='object' AND octet_length(audit_json::text)<=65536),
  event_id platform_helpers.uuid_v7 UNIQUE,
  occurred_at timestamptz NOT NULL CHECK (isfinite(occurred_at) AND date_trunc('milliseconds',occurred_at)=occurred_at),
  data_classification text NOT NULL CHECK (data_classification='Confidential'),
  CONSTRAINT tax_config_candidate_operation_terminal CHECK (
    (outcome='Committed' AND result_target_version_id IS NOT NULL AND event_id IS NOT NULL)
    OR (outcome='Abandoned' AND result_target_version_id IS NULL AND event_id IS NULL)),
  CONSTRAINT tax_config_candidate_operation_result_fk FOREIGN KEY (result_target_version_id,tenant_id,brand_id,store_id,configuration_id)
    REFERENCES rms_pricing.tax_config_publication_candidate(target_version_id,tenant_id,brand_id,store_id,configuration_id)
    DEFERRABLE INITIALLY DEFERRED
);
ALTER TABLE rms_pricing.tax_config_publication_candidate ADD CONSTRAINT tax_config_candidate_operation_fk
  FOREIGN KEY (operation_id) REFERENCES rms_pricing.tax_config_candidate_operation(operation_id) DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE rms_pricing.tax_configuration_rule ADD CONSTRAINT tax_configuration_rule_source_identity_unique
  UNIQUE (tax_configuration_rule_id,tax_configuration_version_id,tax_configuration_id,brand_id,store_id);
CREATE TABLE rms_pricing.tax_config_candidate_rule (
  tenant_id platform_helpers.uuid_v7 NOT NULL,
  brand_id platform_helpers.uuid_v7 NOT NULL,
  store_id platform_helpers.uuid_v7 NOT NULL,
  configuration_id platform_helpers.uuid_v7 NOT NULL,
  base_version_id platform_helpers.uuid_v7 NOT NULL,
  target_version_id platform_helpers.uuid_v7 NOT NULL,
  source_rule_id platform_helpers.uuid_v7 NOT NULL,
  target_rule_id platform_helpers.uuid_v7 PRIMARY KEY,
  rule_ordinal integer NOT NULL CHECK (rule_ordinal BETWEEN 1 AND 256),
  CONSTRAINT tax_config_candidate_rule_source_unique UNIQUE (target_version_id,source_rule_id),
  CONSTRAINT tax_config_candidate_rule_order_unique UNIQUE (target_version_id,rule_ordinal),
  CONSTRAINT tax_config_candidate_rule_distinct_identity CHECK (source_rule_id<>target_rule_id AND target_rule_id<>target_version_id),
  CONSTRAINT tax_config_candidate_rule_candidate_fk FOREIGN KEY (target_version_id,tenant_id,brand_id,store_id,configuration_id,base_version_id)
    REFERENCES rms_pricing.tax_config_publication_candidate(target_version_id,tenant_id,brand_id,store_id,configuration_id,base_version_id),
  CONSTRAINT tax_config_candidate_rule_source_fk FOREIGN KEY (source_rule_id,base_version_id,configuration_id,brand_id,store_id)
    REFERENCES rms_pricing.tax_configuration_rule(tax_configuration_rule_id,tax_configuration_version_id,tax_configuration_id,brand_id,store_id)
);
CREATE INDEX tax_config_candidate_roster_idx ON rms_pricing.tax_config_publication_candidate(tenant_id,brand_id,store_id,configuration_id,target_version_id);

-- New-profile publication must explicitly name the owning candidate and Tenant.
-- All-null preserves the original interpretation of historical versions.
ALTER TABLE rms_pricing.tax_configuration_version
  ADD COLUMN publication_candidate_version_id platform_helpers.uuid_v7,
  ADD COLUMN publication_candidate_profile text,
  ADD COLUMN publication_candidate_tenant_id platform_helpers.uuid_v7,
  ADD CONSTRAINT tax_configuration_candidate_profile_check CHECK (
    (publication_candidate_version_id IS NULL AND publication_candidate_profile IS NULL AND publication_candidate_tenant_id IS NULL)
    OR (publication_candidate_version_id IS NOT NULL AND publication_candidate_profile IS NOT NULL AND publication_candidate_tenant_id IS NOT NULL
      AND publication_candidate_profile='TaxPublicationCandidateV1' AND lifecycle='Published'
      AND publication_candidate_version_id=tax_configuration_version_id)),
  ADD CONSTRAINT tax_configuration_publication_candidate_fk FOREIGN KEY
    (publication_candidate_version_id,publication_candidate_tenant_id,brand_id,store_id,tax_configuration_id)
    REFERENCES rms_pricing.tax_config_publication_candidate(target_version_id,tenant_id,brand_id,store_id,configuration_id);

CREATE FUNCTION rms_pricing.tax_config_candidate_scope_guard() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
DECLARE original uuid;
BEGIN
  IF NEW.tenant_id::text IS DISTINCT FROM nullif(current_setting('bop.tenant_id',true),'') OR NEW.brand_id IS DISTINCT FROM platform_helpers.current_brand_id() OR NEW.store_id IS DISTINCT FROM platform_helpers.current_store_id() OR current_setting('transaction_isolation') IS DISTINCT FROM 'read committed' THEN RAISE EXCEPTION 'Tax candidate scope unavailable' USING ERRCODE='42501'; END IF;
  IF TG_TABLE_NAME='tax_config_candidate_operation' OR TG_TABLE_NAME='tax_config_publication_candidate' THEN
    original:=NEW.operation_id;
    PERFORM pg_advisory_xact_lock(hashtextextended('PricingTaxCandidateOriginal:'||original::text,0));
    PERFORM pg_advisory_xact_lock(hashtextextended('PricingTaxConfigRoot:'||NEW.brand_id::text||':'||NEW.store_id::text||':'||NEW.configuration_id::text,0));
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION rms_pricing.tax_config_candidate_scope_guard() FROM PUBLIC;
CREATE TRIGGER tax_config_candidate_record_scope BEFORE INSERT ON rms_pricing.tax_config_publication_candidate FOR EACH ROW EXECUTE FUNCTION rms_pricing.tax_config_candidate_scope_guard();
CREATE TRIGGER tax_config_candidate_operation_scope BEFORE INSERT ON rms_pricing.tax_config_candidate_operation FOR EACH ROW EXECUTE FUNCTION rms_pricing.tax_config_candidate_scope_guard();
CREATE TRIGGER tax_config_candidate_rule_scope BEFORE INSERT ON rms_pricing.tax_config_candidate_rule FOR EACH ROW EXECUTE FUNCTION rms_pricing.tax_config_candidate_scope_guard();

-- Identity admission examines only Pricing's own UUID namespace. The definer
-- sees hidden reservations but returns no record, scope or content to a caller.
-- Try locks avoid an identity wait cycle with older version-then-rule writers.
CREATE FUNCTION rms_pricing.tax_config_candidate_reservation_guard() RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
SET row_security = off
AS $$
DECLARE identity uuid; parent record;
BEGIN
  IF NEW.tenant_id::text IS DISTINCT FROM nullif(current_setting('bop.tenant_id',true),'') OR NEW.brand_id IS DISTINCT FROM platform_helpers.current_brand_id() OR NEW.store_id IS DISTINCT FROM platform_helpers.current_store_id() OR current_setting('transaction_isolation') IS DISTINCT FROM 'read committed' THEN RAISE EXCEPTION 'Tax reservation scope unavailable' USING ERRCODE='42501'; END IF;
  IF TG_TABLE_NAME='tax_config_publication_candidate' THEN identity:=NEW.target_version_id;
  ELSE
    identity:=NEW.target_rule_id;
    SELECT c.*,c.xmin::text AS held_xmin INTO parent FROM rms_pricing.tax_config_publication_candidate c WHERE c.target_version_id=NEW.target_version_id;
    IF parent.target_version_id IS NULL OR parent.tenant_id IS DISTINCT FROM NEW.tenant_id OR parent.brand_id IS DISTINCT FROM NEW.brand_id OR parent.store_id IS DISTINCT FROM NEW.store_id OR parent.configuration_id IS DISTINCT FROM NEW.configuration_id OR parent.base_version_id IS DISTINCT FROM NEW.base_version_id OR parent.held_xmin IS DISTINCT FROM mod(pg_current_xact_id()::text::numeric,4294967296)::text THEN
      -- xmin is checked again by the deferred source guard; no borrowed parent.
      RAISE EXCEPTION 'Tax reservation parent unavailable' USING ERRCODE='23514';
    END IF;
  END IF;
  IF NOT pg_try_advisory_xact_lock(hashtextextended('PricingTaxCandidateIdentity:'||identity::text,0)) THEN RAISE EXCEPTION 'Tax identity contention' USING ERRCODE='55P03'; END IF;
  IF EXISTS(SELECT 1 FROM rms_pricing.tax_configuration_version WHERE tax_configuration_version_id=identity) OR EXISTS(SELECT 1 FROM rms_pricing.tax_configuration_rule WHERE tax_configuration_rule_id=identity) OR EXISTS(SELECT 1 FROM rms_pricing.tax_config_publication_candidate WHERE target_version_id=identity) OR EXISTS(SELECT 1 FROM rms_pricing.tax_config_candidate_rule WHERE target_rule_id=identity) THEN RAISE EXCEPTION 'Tax identity reserved' USING ERRCODE='23505'; END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION rms_pricing.tax_config_candidate_reservation_guard() FROM PUBLIC;
CREATE TRIGGER tax_config_candidate_record_identity BEFORE INSERT ON rms_pricing.tax_config_publication_candidate FOR EACH ROW EXECUTE FUNCTION rms_pricing.tax_config_candidate_reservation_guard();
CREATE TRIGGER tax_config_candidate_rule_identity BEFORE INSERT ON rms_pricing.tax_config_candidate_rule FOR EACH ROW EXECUTE FUNCTION rms_pricing.tax_config_candidate_reservation_guard();

CREATE FUNCTION rms_pricing.tax_config_candidate_published_identity_guard() RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
SET row_security = off
AS $$
DECLARE identity uuid; candidate record; reservation record; parent record; target_rule jsonb; actual_rule jsonb;
BEGIN
  IF TG_TABLE_NAME='tax_configuration_version' THEN identity:=NEW.tax_configuration_version_id; ELSE identity:=NEW.tax_configuration_rule_id; END IF;
  IF NOT pg_try_advisory_xact_lock(hashtextextended('PricingTaxCandidateIdentity:'||identity::text,0)) THEN RAISE EXCEPTION 'Tax identity contention' USING ERRCODE='55P03'; END IF;
  IF TG_TABLE_NAME='tax_configuration_version' THEN
    IF EXISTS(SELECT 1 FROM rms_pricing.tax_config_candidate_rule WHERE target_rule_id=identity) THEN RAISE EXCEPTION 'Tax identity reserved for rule' USING ERRCODE='23505'; END IF;
    SELECT * INTO candidate FROM rms_pricing.tax_config_publication_candidate WHERE target_version_id=identity;
    IF candidate.target_version_id IS NULL THEN
      IF NEW.publication_candidate_version_id IS NOT NULL OR NEW.publication_candidate_profile IS NOT NULL OR NEW.publication_candidate_tenant_id IS NOT NULL THEN RAISE EXCEPTION 'Tax candidate provenance unavailable' USING ERRCODE='23514'; END IF;
      RETURN NEW;
    END IF;
    IF candidate.tenant_id::text IS DISTINCT FROM nullif(current_setting('bop.tenant_id',true),'') OR candidate.brand_id IS DISTINCT FROM NEW.brand_id OR candidate.store_id IS DISTINCT FROM NEW.store_id OR candidate.configuration_id IS DISTINCT FROM NEW.tax_configuration_id OR NEW.brand_id IS DISTINCT FROM platform_helpers.current_brand_id() OR NEW.store_id IS DISTINCT FROM platform_helpers.current_store_id() OR NEW.publication_candidate_tenant_id IS DISTINCT FROM candidate.tenant_id OR NEW.publication_candidate_version_id IS DISTINCT FROM identity OR NEW.publication_candidate_profile IS DISTINCT FROM 'TaxPublicationCandidateV1' OR NEW.lifecycle IS DISTINCT FROM 'Published' OR NEW.version_number IS DISTINCT FROM candidate.target_version_number OR NEW.snapshot_digest IS DISTINCT FROM candidate.content_digest OR NEW.authoring_operation_id IS NOT NULL THEN RAISE EXCEPTION 'Tax candidate publication identity invalid' USING ERRCODE='23514'; END IF;
    RETURN NEW;
  END IF;
  IF EXISTS(SELECT 1 FROM rms_pricing.tax_config_publication_candidate WHERE target_version_id=identity) THEN RAISE EXCEPTION 'Tax identity reserved for version' USING ERRCODE='23505'; END IF;
  SELECT * INTO reservation FROM rms_pricing.tax_config_candidate_rule WHERE target_rule_id=identity;
  SELECT * INTO parent FROM rms_pricing.tax_configuration_version WHERE tax_configuration_version_id=NEW.tax_configuration_version_id;
  IF reservation.target_rule_id IS NULL THEN
    IF parent.publication_candidate_version_id IS NOT NULL THEN RAISE EXCEPTION 'Tax candidate extra rule invalid' USING ERRCODE='23514'; END IF;
    RETURN NEW;
  END IF;
  SELECT * INTO candidate FROM rms_pricing.tax_config_publication_candidate WHERE target_version_id=reservation.target_version_id;
  IF candidate.tenant_id::text IS DISTINCT FROM nullif(current_setting('bop.tenant_id',true),'') OR candidate.brand_id IS DISTINCT FROM NEW.brand_id OR candidate.store_id IS DISTINCT FROM NEW.store_id OR candidate.configuration_id IS DISTINCT FROM NEW.tax_configuration_id OR NEW.brand_id IS DISTINCT FROM platform_helpers.current_brand_id() OR NEW.store_id IS DISTINCT FROM platform_helpers.current_store_id() OR parent.publication_candidate_version_id IS DISTINCT FROM reservation.target_version_id OR parent.publication_candidate_tenant_id IS DISTINCT FROM candidate.tenant_id OR parent.publication_candidate_profile IS DISTINCT FROM 'TaxPublicationCandidateV1' OR NEW.tax_configuration_version_id IS DISTINCT FROM reservation.target_version_id THEN RAISE EXCEPTION 'Tax reserved rule publication invalid' USING ERRCODE='23514'; END IF;
  target_rule:=candidate.record_json->'candidate'->'content'->'rules'->(reservation.rule_ordinal-1);
  actual_rule:=jsonb_build_object('ruleReference',NEW.tax_configuration_rule_id,'taxClassificationReference',NEW.tax_classification_id,'orderType',NEW.order_type,'chargeType',NEW.charge_type,'taxComponentCode',NEW.tax_component_code,'treatment',NEW.treatment,'rate',trim_scale(NEW.tax_rate)::text,'priceInclusion',NEW.price_inclusion,'roundingMode',NEW.rounding_mode,'calculationOrder',NEW.calculation_order,'compoundOnPriorTax',NEW.compound_on_prior_tax,'exceptionEvidenceReference',NEW.exception_evidence_id,'receiptPresentationCode',NEW.receipt_presentation_code);
  IF target_rule IS DISTINCT FROM actual_rule THEN RAISE EXCEPTION 'Tax reserved rule content invalid' USING ERRCODE='23514'; END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION rms_pricing.tax_config_candidate_published_identity_guard() FROM PUBLIC;
CREATE TRIGGER tax_configuration_candidate_identity BEFORE INSERT ON rms_pricing.tax_configuration_version FOR EACH ROW EXECUTE FUNCTION rms_pricing.tax_config_candidate_published_identity_guard();
CREATE TRIGGER tax_configuration_rule_candidate_identity BEFORE INSERT ON rms_pricing.tax_configuration_rule FOR EACH ROW EXECUTE FUNCTION rms_pricing.tax_config_candidate_published_identity_guard();

CREATE FUNCTION rms_pricing.reject_tax_config_candidate_mutation() RETURNS trigger LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$ BEGIN RAISE EXCEPTION 'immutable Tax candidate history' USING ERRCODE='55000'; END; $$;
REVOKE ALL ON FUNCTION rms_pricing.reject_tax_config_candidate_mutation() FROM PUBLIC;
CREATE TRIGGER tax_config_publication_candidate_no_mutation BEFORE UPDATE OR DELETE ON rms_pricing.tax_config_publication_candidate FOR EACH ROW EXECUTE FUNCTION rms_pricing.reject_tax_config_candidate_mutation();
CREATE TRIGGER tax_config_publication_candidate_no_truncate BEFORE TRUNCATE ON rms_pricing.tax_config_publication_candidate FOR EACH STATEMENT EXECUTE FUNCTION rms_pricing.reject_tax_config_candidate_mutation();
CREATE TRIGGER tax_config_candidate_operation_no_mutation BEFORE UPDATE OR DELETE ON rms_pricing.tax_config_candidate_operation FOR EACH ROW EXECUTE FUNCTION rms_pricing.reject_tax_config_candidate_mutation();
CREATE TRIGGER tax_config_candidate_operation_no_truncate BEFORE TRUNCATE ON rms_pricing.tax_config_candidate_operation FOR EACH STATEMENT EXECUTE FUNCTION rms_pricing.reject_tax_config_candidate_mutation();
CREATE TRIGGER tax_config_candidate_rule_no_mutation BEFORE UPDATE OR DELETE ON rms_pricing.tax_config_candidate_rule FOR EACH ROW EXECUTE FUNCTION rms_pricing.reject_tax_config_candidate_mutation();
CREATE TRIGGER tax_config_candidate_rule_no_truncate BEFORE TRUNCATE ON rms_pricing.tax_config_candidate_rule FOR EACH STATEMENT EXECUTE FUNCTION rms_pricing.reject_tax_config_candidate_mutation();

CREATE FUNCTION rms_pricing.tax_config_candidate_coherent() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
DECLARE candidate record; original record; base_version record; base_original record; material record; root_row record; rule_row record; binding record;
  body jsonb; content jsonb; receipt jsonb; expected_base jsonb; expected_registration jsonb; expected_command jsonb; base_snapshot jsonb; source_rule jsonb; target_rule jsonb; mapping jsonb;
  target_id uuid; top_xid text:=mod(pg_current_xact_id()::text::numeric,4294967296)::text; at_text text; count_rules integer;
BEGIN
  IF NEW.tenant_id::text IS DISTINCT FROM nullif(current_setting('bop.tenant_id',true),'') OR NEW.brand_id IS DISTINCT FROM platform_helpers.current_brand_id() OR NEW.store_id IS DISTINCT FROM platform_helpers.current_store_id() THEN RAISE EXCEPTION 'Tax candidate coherence scope unavailable' USING ERRCODE='42501'; END IF;
  IF TG_TABLE_NAME='tax_config_candidate_operation' THEN
    SELECT o.*,o.xmin::text AS held_xmin INTO original FROM rms_pricing.tax_config_candidate_operation o WHERE o.operation_id=NEW.operation_id;
    target_id:=original.result_target_version_id;
  ELSE
    target_id:=NEW.target_version_id;
    SELECT c.*,c.xmin::text AS held_xmin INTO candidate FROM rms_pricing.tax_config_publication_candidate c WHERE c.target_version_id=target_id;
    SELECT o.*,o.xmin::text AS held_xmin INTO original FROM rms_pricing.tax_config_candidate_operation o WHERE o.operation_id=candidate.operation_id;
  END IF;
  IF original.operation_id IS NULL OR original.held_xmin IS DISTINCT FROM top_xid THEN RAISE EXCEPTION 'Tax candidate original unavailable' USING ERRCODE='23514'; END IF;
  receipt:=original.receipt_json;
  at_text:=to_char(original.occurred_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"');
  expected_base:=jsonb_build_object('versionReference',original.expected_base_version_id,'snapshotDigest',original.expected_base_snapshot_digest,'aggregateVersion',original.expected_base_aggregate_version,'versionNumber',original.expected_base_version_number);
  expected_registration:=jsonb_build_object('materialReference',original.registration_material_id,'versionReference',original.registration_version_id,'contentDigest',original.registration_content_digest);
  expected_command:=jsonb_build_object('action','PrepareCandidate','operationReference',original.operation_id,'configurationReference',original.configuration_id,'expectedDraft',expected_base,'registrationMaterial',expected_registration);
  IF (receipt ?& ARRAY['profile','tenantReference','brandReference','storeReference','actorReference','action','operationReference','configurationReference','expectedDraft','registrationMaterial','command','intentDigest','outcome','result','auditReference','eventReference','occurredAt'] AND (SELECT count(*) FROM jsonb_object_keys(receipt))=17) IS NOT TRUE
    OR receipt->>'profile' IS DISTINCT FROM 'TaxConfigCandidateOperationV1'
    OR receipt->>'tenantReference' IS DISTINCT FROM original.tenant_id::text OR receipt->>'brandReference' IS DISTINCT FROM original.brand_id::text OR receipt->>'storeReference' IS DISTINCT FROM original.store_id::text OR receipt->>'actorReference' IS DISTINCT FROM original.actor_id::text
    OR receipt->>'action' IS DISTINCT FROM original.action_code OR receipt->>'operationReference' IS DISTINCT FROM original.operation_id::text OR receipt->>'configurationReference' IS DISTINCT FROM original.configuration_id::text
    OR receipt->'expectedDraft' IS DISTINCT FROM expected_base OR receipt->'registrationMaterial' IS DISTINCT FROM expected_registration OR receipt->>'intentDigest' IS DISTINCT FROM original.intent_digest OR receipt->>'outcome' IS DISTINCT FROM original.outcome
    OR receipt->>'auditReference' IS DISTINCT FROM original.audit_id::text OR receipt->'eventReference' IS DISTINCT FROM COALESCE(to_jsonb(original.event_id::text),'null'::jsonb) OR receipt->>'occurredAt' IS DISTINCT FROM at_text
    OR original.audit_json->>'auditId' IS DISTINCT FROM original.audit_id::text OR original.audit_json->>'brandId' IS DISTINCT FROM original.brand_id::text OR original.audit_json->>'storeId' IS DISTINCT FROM original.store_id::text
    OR original.audit_json->'actor'->>'type' IS DISTINCT FROM 'User' OR original.audit_json->'actor'->>'reference' IS DISTINCT FROM original.actor_id::text OR original.audit_json->>'correlationId' IS DISTINCT FROM original.operation_id::text OR original.audit_json->>'occurredAt' IS DISTINCT FROM at_text OR original.audit_json->>'dataClassification' IS DISTINCT FROM 'Confidential' OR original.audit_json->>'reasonCode' IS DISTINCT FROM 'AUTHORIZED_OPERATION' THEN
    RAISE EXCEPTION 'Tax candidate original identity incoherent' USING ERRCODE='23514';
  END IF;
  IF original.outcome='Abandoned' THEN
    IF receipt->'command' IS DISTINCT FROM 'null'::jsonb OR receipt->'result' IS DISTINCT FROM 'null'::jsonb OR original.audit_json->>'targetType' IS DISTINCT FROM 'PricingTaxCandidateOperation' OR original.audit_json->>'targetId' IS DISTINCT FROM original.operation_id::text OR original.audit_json->>'actionCode' IS DISTINCT FROM 'PRICING_TAX_CANDIDATE_RESOLVE' OR EXISTS(SELECT 1 FROM rms_pricing.tax_config_publication_candidate WHERE operation_id=original.operation_id) THEN RAISE EXCEPTION 'Tax abandoned candidate original incoherent' USING ERRCODE='23514'; END IF;
    RETURN NEW;
  END IF;
  SELECT c.*,c.xmin::text AS held_xmin INTO candidate FROM rms_pricing.tax_config_publication_candidate c WHERE c.target_version_id=target_id;
  IF candidate.target_version_id IS NULL OR candidate.held_xmin IS DISTINCT FROM top_xid OR candidate.operation_id IS DISTINCT FROM original.operation_id OR candidate.tenant_id IS DISTINCT FROM original.tenant_id OR candidate.brand_id IS DISTINCT FROM original.brand_id OR candidate.store_id IS DISTINCT FROM original.store_id OR candidate.actor_id IS DISTINCT FROM original.actor_id OR candidate.configuration_id IS DISTINCT FROM original.configuration_id
    OR candidate.base_version_id IS DISTINCT FROM original.expected_base_version_id OR candidate.base_snapshot_digest IS DISTINCT FROM original.expected_base_snapshot_digest OR candidate.base_aggregate_version IS DISTINCT FROM original.expected_base_aggregate_version OR candidate.base_version_number IS DISTINCT FROM original.expected_base_version_number
    OR candidate.registration_material_id IS DISTINCT FROM original.registration_material_id OR candidate.registration_version_id IS DISTINCT FROM original.registration_version_id OR candidate.registration_content_digest IS DISTINCT FROM original.registration_content_digest
    OR candidate.audit_id IS DISTINCT FROM original.audit_id OR candidate.event_id IS DISTINCT FROM original.event_id OR candidate.prepared_at IS DISTINCT FROM original.occurred_at
    OR receipt->'command' IS DISTINCT FROM expected_command OR receipt->'result' IS DISTINCT FROM candidate.record_json
    OR original.audit_json->>'targetType' IS DISTINCT FROM 'PricingTaxConfigCandidate' OR original.audit_json->>'targetId' IS DISTINCT FROM target_id::text OR original.audit_json->>'actionCode' IS DISTINCT FROM 'PRICING_TAX_CANDIDATE_PREPARE' THEN RAISE EXCEPTION 'Tax candidate terminal source incoherent' USING ERRCODE='23514'; END IF;
  body:=candidate.record_json;
  IF (body ?& ARRAY['profile','tenantReference','brandReference','storeReference','preparedByActorReference','operationReference','candidate','auditReference','eventReference','preparedAt','dataClassification','status','qualification'] AND (SELECT count(*) FROM jsonb_object_keys(body))=13) IS NOT TRUE
    OR body->>'profile' IS DISTINCT FROM 'TaxConfigCandidateRecordV1' OR body->>'tenantReference' IS DISTINCT FROM candidate.tenant_id::text OR body->>'brandReference' IS DISTINCT FROM candidate.brand_id::text OR body->>'storeReference' IS DISTINCT FROM candidate.store_id::text OR body->>'preparedByActorReference' IS DISTINCT FROM candidate.actor_id::text OR body->>'operationReference' IS DISTINCT FROM candidate.operation_id::text
    OR body->>'auditReference' IS DISTINCT FROM candidate.audit_id::text OR body->>'eventReference' IS DISTINCT FROM candidate.event_id::text OR body->>'preparedAt' IS DISTINCT FROM at_text OR body->>'dataClassification' IS DISTINCT FROM 'Confidential' OR body->>'status' IS DISTINCT FROM 'Recorded' OR body->>'qualification' IS DISTINCT FROM 'NotEvaluated' THEN RAISE EXCEPTION 'Tax candidate record closed identity invalid' USING ERRCODE='23514'; END IF;
  IF jsonb_typeof(body->'candidate') IS DISTINCT FROM 'object' THEN RAISE EXCEPTION 'Tax candidate envelope invalid' USING ERRCODE='23514'; END IF;
  IF (body->'candidate' ?& ARRAY['profile','content','contentDigest'] AND (SELECT count(*) FROM jsonb_object_keys(body->'candidate'))=3) IS NOT TRUE OR body->'candidate'->>'profile' IS DISTINCT FROM 'TaxPublicationCandidateV1' OR body->'candidate'->>'contentDigest' IS DISTINCT FROM candidate.content_digest OR jsonb_typeof(body->'candidate'->'content') IS DISTINCT FROM 'object' THEN RAISE EXCEPTION 'Tax candidate envelope invalid' USING ERRCODE='23514'; END IF;
  content:=body->'candidate'->'content';
  IF (content ?& ARRAY['profile','tenantReference','brandReference','storeReference','configurationReference','baseDraft','targetVersionReference','targetAggregateVersion','targetVersionNumber','stableCode','jurisdictionCode','currencyMetadata','effectivePeriod','rules','sourceRuleBindings','registrationMaterial'] AND (SELECT count(*) FROM jsonb_object_keys(content))=16) IS NOT TRUE
    OR content->>'profile' IS DISTINCT FROM 'TaxPublicationCandidateContentV1' OR content->>'tenantReference' IS DISTINCT FROM candidate.tenant_id::text OR content->>'brandReference' IS DISTINCT FROM candidate.brand_id::text OR content->>'storeReference' IS DISTINCT FROM candidate.store_id::text OR content->>'configurationReference' IS DISTINCT FROM candidate.configuration_id::text
    OR content->'baseDraft' IS DISTINCT FROM expected_base OR content->'registrationMaterial' IS DISTINCT FROM expected_registration OR content->>'targetVersionReference' IS DISTINCT FROM target_id::text OR content->'targetAggregateVersion' IS DISTINCT FROM to_jsonb(candidate.target_aggregate_version) OR content->'targetVersionNumber' IS DISTINCT FROM to_jsonb(candidate.target_version_number) THEN RAISE EXCEPTION 'Tax candidate content identity invalid' USING ERRCODE='23514'; END IF;
  SELECT * INTO base_version FROM rms_pricing.tax_configuration_version WHERE tax_configuration_version_id=candidate.base_version_id;
  SELECT * INTO base_original FROM rms_pricing.tax_config_authoring_operation WHERE operation_id=base_version.authoring_operation_id;
  SELECT * INTO root_row FROM rms_pricing.tax_configuration WHERE tax_configuration_id=candidate.configuration_id;
  SELECT * INTO material FROM rms_pricing.tax_config_material_version WHERE version_id=candidate.registration_version_id;
  base_snapshot:=base_original.receipt_json->'snapshot';
  IF base_version.tax_configuration_version_id IS NULL OR base_version.lifecycle IS DISTINCT FROM 'Draft' OR base_version.tax_configuration_id IS DISTINCT FROM candidate.configuration_id OR base_version.brand_id IS DISTINCT FROM candidate.brand_id OR base_version.store_id IS DISTINCT FROM candidate.store_id OR base_version.snapshot_digest IS DISTINCT FROM candidate.base_snapshot_digest OR base_version.version_number IS DISTINCT FROM candidate.base_version_number OR base_version.created_at>candidate.prepared_at
    OR base_original.operation_id IS NULL OR base_original.outcome IS DISTINCT FROM 'Committed' OR base_original.tenant_id IS DISTINCT FROM candidate.tenant_id OR base_original.brand_id IS DISTINCT FROM candidate.brand_id OR base_original.store_id IS DISTINCT FROM candidate.store_id OR base_original.result_configuration_id IS DISTINCT FROM candidate.configuration_id OR base_original.result_version_id IS DISTINCT FROM candidate.base_version_id OR base_original.result_aggregate_version IS DISTINCT FROM candidate.base_aggregate_version
    OR root_row.tax_configuration_id IS NULL OR root_row.brand_id IS DISTINCT FROM candidate.brand_id OR root_row.store_id IS DISTINCT FROM candidate.store_id OR root_row.current_version_id IS DISTINCT FROM candidate.base_version_id OR root_row.aggregate_version IS DISTINCT FROM candidate.base_aggregate_version
    OR material.version_id IS NULL OR material.tenant_id IS DISTINCT FROM candidate.tenant_id OR material.brand_id IS DISTINCT FROM candidate.brand_id OR material.store_id IS DISTINCT FROM candidate.store_id OR material.material_id IS DISTINCT FROM candidate.registration_material_id OR material.material_kind IS DISTINCT FROM 'RegistrationApplicability' OR material.content_digest IS DISTINCT FROM candidate.registration_content_digest OR material.recorded_at>candidate.prepared_at
    OR content->'stableCode' IS DISTINCT FROM base_snapshot->'stableCode' OR content->'jurisdictionCode' IS DISTINCT FROM base_snapshot->'jurisdictionCode' OR content->'currencyMetadata' IS DISTINCT FROM base_snapshot->'currencyMetadata' OR content->'effectivePeriod' IS DISTINCT FROM base_snapshot->'effectivePeriod' THEN RAISE EXCEPTION 'Tax candidate actual source or current CAS incoherent' USING ERRCODE='23514'; END IF;
  IF jsonb_typeof(content->'rules') IS DISTINCT FROM 'array' OR jsonb_typeof(content->'sourceRuleBindings') IS DISTINCT FROM 'array' OR jsonb_typeof(base_snapshot->'rules') IS DISTINCT FROM 'array' THEN RAISE EXCEPTION 'Tax candidate rules invalid' USING ERRCODE='23514'; END IF;
  count_rules:=jsonb_array_length(content->'rules');
  IF count_rules NOT BETWEEN 1 AND 256 OR jsonb_array_length(content->'sourceRuleBindings')<>count_rules OR jsonb_array_length(base_snapshot->'rules')<>count_rules OR (SELECT count(*) FROM rms_pricing.tax_config_candidate_rule WHERE target_version_id=target_id)<>count_rules OR (SELECT count(*) FROM rms_pricing.tax_configuration_rule WHERE tax_configuration_version_id=candidate.base_version_id)<>count_rules THEN RAISE EXCEPTION 'Tax candidate complete rule set invalid' USING ERRCODE='23514'; END IF;
  FOR binding IN SELECT b.*,b.xmin::text AS held_xmin FROM rms_pricing.tax_config_candidate_rule b WHERE b.target_version_id=target_id ORDER BY b.rule_ordinal LOOP
    IF binding.held_xmin IS DISTINCT FROM top_xid OR binding.tenant_id IS DISTINCT FROM candidate.tenant_id OR binding.brand_id IS DISTINCT FROM candidate.brand_id OR binding.store_id IS DISTINCT FROM candidate.store_id OR binding.configuration_id IS DISTINCT FROM candidate.configuration_id OR binding.base_version_id IS DISTINCT FROM candidate.base_version_id OR binding.rule_ordinal>count_rules THEN RAISE EXCEPTION 'Tax candidate rule reservation source invalid' USING ERRCODE='23514'; END IF;
    SELECT * INTO rule_row FROM rms_pricing.tax_configuration_rule WHERE tax_configuration_rule_id=binding.source_rule_id;
    source_rule:=jsonb_build_object('ruleReference',rule_row.tax_configuration_rule_id,'taxClassificationReference',rule_row.tax_classification_id,'orderType',rule_row.order_type,'chargeType',rule_row.charge_type,'taxComponentCode',rule_row.tax_component_code,'treatment',rule_row.treatment,'rate',trim_scale(rule_row.tax_rate)::text,'priceInclusion',rule_row.price_inclusion,'roundingMode',rule_row.rounding_mode,'calculationOrder',rule_row.calculation_order,'compoundOnPriorTax',rule_row.compound_on_prior_tax,'exceptionEvidenceReference',rule_row.exception_evidence_id,'receiptPresentationCode',rule_row.receipt_presentation_code);
    mapping:=jsonb_build_object('sourceRuleReference',binding.source_rule_id,'targetRuleReference',binding.target_rule_id);
    target_rule:=jsonb_set(source_rule,'{ruleReference}',to_jsonb(binding.target_rule_id::text));
    IF source_rule IS DISTINCT FROM base_snapshot->'rules'->(binding.rule_ordinal-1) OR mapping IS DISTINCT FROM content->'sourceRuleBindings'->(binding.rule_ordinal-1) OR target_rule IS DISTINCT FROM content->'rules'->(binding.rule_ordinal-1) THEN RAISE EXCEPTION 'Tax candidate complete ordered source rule parity invalid' USING ERRCODE='23514'; END IF;
  END LOOP;
  -- The owning source checks RFC8785 canonicality and the nonrecursive content
  -- digest with the public parser. SQL hashes the actual supplied canonical
  -- bytes; jsonb::text is deliberately not represented as RFC8785.
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION rms_pricing.tax_config_candidate_coherent() FROM PUBLIC;
CREATE CONSTRAINT TRIGGER tax_config_candidate_record_coherence AFTER INSERT ON rms_pricing.tax_config_publication_candidate DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION rms_pricing.tax_config_candidate_coherent();
CREATE CONSTRAINT TRIGGER tax_config_candidate_operation_coherence AFTER INSERT ON rms_pricing.tax_config_candidate_operation DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION rms_pricing.tax_config_candidate_coherent();
CREATE CONSTRAINT TRIGGER tax_config_candidate_rule_coherence AFTER INSERT ON rms_pricing.tax_config_candidate_rule DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION rms_pricing.tax_config_candidate_coherent();

-- This owning SQL guard compares persisted new-profile publication to the
-- frozen candidate. Professional and Core approval are acquired by the actual
-- publishing source; SQL does not read another Domain's private evidence.
CREATE FUNCTION rms_pricing.tax_config_candidate_published_coherent() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
DECLARE candidate record; root_row record; version_row record; content jsonb; stored_rules jsonb; frozen_rules jsonb;
BEGIN
  IF TG_TABLE_NAME='tax_configuration_version' THEN
    IF NEW.publication_candidate_version_id IS NULL THEN RETURN NEW; END IF;
    SELECT * INTO version_row FROM rms_pricing.tax_configuration_version WHERE tax_configuration_version_id=NEW.tax_configuration_version_id;
  ELSE
    SELECT * INTO version_row FROM rms_pricing.tax_configuration_version WHERE tax_configuration_version_id=NEW.tax_configuration_version_id;
    IF version_row.publication_candidate_version_id IS NULL THEN RETURN NEW; END IF;
  END IF;
  SELECT * INTO candidate FROM rms_pricing.tax_config_publication_candidate WHERE target_version_id=version_row.publication_candidate_version_id;
  SELECT * INTO root_row FROM rms_pricing.tax_configuration WHERE tax_configuration_id=version_row.tax_configuration_id;
  content:=candidate.record_json->'candidate'->'content';
  IF candidate.target_version_id IS NULL OR candidate.tenant_id::text IS DISTINCT FROM nullif(current_setting('bop.tenant_id',true),'') OR candidate.brand_id IS DISTINCT FROM platform_helpers.current_brand_id() OR candidate.store_id IS DISTINCT FROM platform_helpers.current_store_id()
    OR version_row.publication_candidate_tenant_id IS DISTINCT FROM candidate.tenant_id OR version_row.publication_candidate_profile IS DISTINCT FROM 'TaxPublicationCandidateV1' OR version_row.tax_configuration_version_id IS DISTINCT FROM candidate.target_version_id OR version_row.tax_configuration_id IS DISTINCT FROM candidate.configuration_id OR version_row.brand_id IS DISTINCT FROM candidate.brand_id OR version_row.store_id IS DISTINCT FROM candidate.store_id
    OR version_row.lifecycle IS DISTINCT FROM 'Published' OR version_row.version_number IS DISTINCT FROM candidate.target_version_number OR version_row.snapshot_digest IS DISTINCT FROM candidate.content_digest OR version_row.authoring_operation_id IS NOT NULL
    OR root_row.current_version_id IS DISTINCT FROM candidate.target_version_id OR root_row.aggregate_version IS DISTINCT FROM candidate.target_aggregate_version OR root_row.stable_code IS DISTINCT FROM content->>'stableCode'
    OR NOT isfinite(version_row.created_at) OR date_trunc('milliseconds',version_row.created_at) IS DISTINCT FROM version_row.created_at OR version_row.created_at<candidate.prepared_at
    OR version_row.jurisdiction_code IS DISTINCT FROM content->>'jurisdictionCode' OR version_row.currency_code IS DISTINCT FROM content->'currencyMetadata'->>'currencyCode' OR to_jsonb(version_row.currency_metadata_version) IS DISTINCT FROM content->'currencyMetadata'->'metadataVersion' OR version_row.currency_metadata_version_id::text IS DISTINCT FROM content->'currencyMetadata'->>'metadataVersionReference' OR version_row.currency_metadata_digest IS DISTINCT FROM content->'currencyMetadata'->>'metadataDigest'
    OR version_row.effective_time_zone IS DISTINCT FROM content->'effectivePeriod'->>'timeZone'
    OR content->'effectivePeriod'->'effectiveFrom' IS DISTINCT FROM jsonb_build_object('instant',to_char(version_row.effective_from AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),'localDateTime',to_char(version_row.effective_from AT TIME ZONE version_row.effective_time_zone,'YYYY-MM-DD"T"HH24:MI:SS.MS'),'utcOffsetMinutes',extract(epoch FROM ((version_row.effective_from AT TIME ZONE version_row.effective_time_zone)-(version_row.effective_from AT TIME ZONE 'UTC')))/60)
    OR content->'effectivePeriod'->'effectiveUntil' IS DISTINCT FROM (CASE WHEN version_row.effective_until IS NULL THEN 'null'::jsonb ELSE jsonb_build_object('instant',to_char(version_row.effective_until AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),'localDateTime',to_char(version_row.effective_until AT TIME ZONE version_row.effective_time_zone,'YYYY-MM-DD"T"HH24:MI:SS.MS'),'utcOffsetMinutes',extract(epoch FROM ((version_row.effective_until AT TIME ZONE version_row.effective_time_zone)-(version_row.effective_until AT TIME ZONE 'UTC')))/60) END) THEN
    RAISE EXCEPTION 'Tax published candidate full content incoherent' USING ERRCODE='23514';
  END IF;
  SELECT COALESCE(jsonb_agg(jsonb_build_object('ruleReference',r.tax_configuration_rule_id,'taxClassificationReference',r.tax_classification_id,'orderType',r.order_type,'chargeType',r.charge_type,'taxComponentCode',r.tax_component_code,'treatment',r.treatment,'rate',trim_scale(r.tax_rate)::text,'priceInclusion',r.price_inclusion,'roundingMode',r.rounding_mode,'calculationOrder',r.calculation_order,'compoundOnPriorTax',r.compound_on_prior_tax,'exceptionEvidenceReference',r.exception_evidence_id,'receiptPresentationCode',r.receipt_presentation_code) ORDER BY r.tax_configuration_rule_id),'[]'::jsonb)
    INTO stored_rules FROM rms_pricing.tax_configuration_rule r WHERE r.tax_configuration_version_id=candidate.target_version_id;
  SELECT COALESCE(jsonb_agg(value ORDER BY value->>'ruleReference'),'[]'::jsonb) INTO frozen_rules FROM jsonb_array_elements(content->'rules');
  IF stored_rules IS DISTINCT FROM frozen_rules THEN RAISE EXCEPTION 'Tax published candidate complete rules incoherent' USING ERRCODE='23514'; END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION rms_pricing.tax_config_candidate_published_coherent() FROM PUBLIC;
CREATE CONSTRAINT TRIGGER tax_configuration_candidate_coherence AFTER INSERT ON rms_pricing.tax_configuration_version DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION rms_pricing.tax_config_candidate_published_coherent();
CREATE CONSTRAINT TRIGGER tax_configuration_rule_candidate_coherence AFTER INSERT ON rms_pricing.tax_configuration_rule DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION rms_pricing.tax_config_candidate_published_coherent();

ALTER TABLE rms_pricing.tax_config_publication_candidate ENABLE ROW LEVEL SECURITY;
ALTER TABLE rms_pricing.tax_config_publication_candidate FORCE ROW LEVEL SECURITY;
CREATE POLICY tax_config_publication_candidate_scope ON rms_pricing.tax_config_publication_candidate
  USING ((tenant_id::text=current_setting('bop.tenant_id',true) AND brand_id=platform_helpers.current_brand_id() AND store_id=platform_helpers.current_store_id()) IS TRUE)
  WITH CHECK ((tenant_id::text=current_setting('bop.tenant_id',true) AND brand_id=platform_helpers.current_brand_id() AND store_id=platform_helpers.current_store_id()) IS TRUE);
REVOKE ALL ON rms_pricing.tax_config_publication_candidate FROM PUBLIC;

ALTER TABLE rms_pricing.tax_config_candidate_operation ENABLE ROW LEVEL SECURITY;
ALTER TABLE rms_pricing.tax_config_candidate_operation FORCE ROW LEVEL SECURITY;
CREATE POLICY tax_config_candidate_operation_scope ON rms_pricing.tax_config_candidate_operation
  USING ((tenant_id::text=current_setting('bop.tenant_id',true) AND brand_id=platform_helpers.current_brand_id() AND store_id=platform_helpers.current_store_id()) IS TRUE)
  WITH CHECK ((tenant_id::text=current_setting('bop.tenant_id',true) AND brand_id=platform_helpers.current_brand_id() AND store_id=platform_helpers.current_store_id()) IS TRUE);
REVOKE ALL ON rms_pricing.tax_config_candidate_operation FROM PUBLIC;

ALTER TABLE rms_pricing.tax_config_candidate_rule ENABLE ROW LEVEL SECURITY;
ALTER TABLE rms_pricing.tax_config_candidate_rule FORCE ROW LEVEL SECURITY;
CREATE POLICY tax_config_candidate_rule_scope ON rms_pricing.tax_config_candidate_rule
  USING ((tenant_id::text=current_setting('bop.tenant_id',true) AND brand_id=platform_helpers.current_brand_id() AND store_id=platform_helpers.current_store_id()) IS TRUE)
  WITH CHECK ((tenant_id::text=current_setting('bop.tenant_id',true) AND brand_id=platform_helpers.current_brand_id() AND store_id=platform_helpers.current_store_id()) IS TRUE);
REVOKE ALL ON rms_pricing.tax_config_candidate_rule FROM PUBLIC;

-- Scope-safe original arbitration is confined to this new Pricing namespace.
-- It exposes no hidden tuple and makes no cross-domain original claim.
CREATE FUNCTION rms_pricing.tax_config_candidate_operation_available(original_operation platform_helpers.uuid_v7) RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
SET row_security = off
AS $$
BEGIN
  IF original_operation IS NULL OR nullif(current_setting('bop.tenant_id',true),'') IS NULL OR platform_helpers.current_brand_id() IS NULL OR platform_helpers.current_store_id() IS NULL OR current_setting('transaction_isolation') IS DISTINCT FROM 'read committed' THEN RAISE EXCEPTION 'Tax candidate original scope unavailable' USING ERRCODE='42501'; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('PricingTaxCandidateOriginal:'||original_operation::text,0));
  RETURN NOT EXISTS(SELECT 1 FROM rms_pricing.tax_config_candidate_operation WHERE operation_id=original_operation) AND NOT EXISTS(SELECT 1 FROM rms_pricing.tax_config_publication_candidate WHERE operation_id=original_operation);
END;
$$;
REVOKE ALL ON FUNCTION rms_pricing.tax_config_candidate_operation_available(platform_helpers.uuid_v7) FROM PUBLIC;
