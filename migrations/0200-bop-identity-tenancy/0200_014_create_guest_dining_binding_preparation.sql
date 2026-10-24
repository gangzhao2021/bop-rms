-- bop-rms-migration: 1
-- owner: @bop/identity
-- schema: bop_identity
-- phase: expand
-- risk: high
-- transaction: required
-- lock-timeout-ms: 5000
-- statement-timeout-ms: 60000
-- recovery: forward-fix
CREATE TABLE bop_identity.guest_dining_binding_preparation (
  operation_id platform_helpers.uuid_v7 NOT NULL,
  revision integer NOT NULL CHECK (revision BETWEEN 1 AND 3),
  prior_revision integer GENERATED ALWAYS AS (NULLIF(revision - 1, 0)) STORED,
  brand_id platform_helpers.uuid_v7 NOT NULL,
  store_id platform_helpers.uuid_v7 NOT NULL,
  predecessor_id platform_helpers.uuid_v7 NOT NULL,
  candidate_id platform_helpers.uuid_v7 NOT NULL CHECK (candidate_id <> predecessor_id),
  admission_id platform_helpers.uuid_v7 NOT NULL,
  status text NOT NULL CHECK (status = (ARRAY['Prepared','Acknowledged','Activated'])[revision]),
  record jsonb NOT NULL CHECK (octet_length(record::text) <= 16384),
  PRIMARY KEY (operation_id, revision),
  FOREIGN KEY (operation_id, prior_revision) REFERENCES bop_identity.guest_dining_binding_preparation (operation_id, revision),
  FOREIGN KEY (brand_id, store_id, predecessor_id) REFERENCES bop_identity.guest_session (brand_id, store_id, guest_session_id),
  CHECK ((
    jsonb_typeof(record) = 'object'
    AND record ?& ARRAY['purpose','operationReference','admissionReference','predecessor','candidate','recoverySelectorHash','revision','status','preparedAt','expiresAt','acknowledgedAt','activatedAt']
    AND record - ARRAY['purpose','operationReference','admissionReference','predecessor','candidate','recoverySelectorHash','revision','status','preparedAt','expiresAt','acknowledgedAt','activatedAt'] = '{}'::jsonb
    AND record->>'purpose' = 'DiningSessionBinding'
    AND record->>'operationReference' = operation_id::text
    AND record->>'admissionReference' = admission_id::text
    AND record->>'status' = status
    AND record->>'revision' = revision::text
    AND record->>'recoverySelectorHash' ~ '^[0-9a-f]{64}$'
    AND record->'predecessor'->'session'->>'sessionReference' = predecessor_id::text
    AND record->'candidate'->'session'->>'sessionReference' = candidate_id::text
    AND record->'predecessor'->'session'->>'brandReference' = brand_id::text
    AND record->'candidate'->'session'->>'brandReference' = brand_id::text
    AND record->'predecessor'->'session'->>'storeReference' = store_id::text
    AND record->'candidate'->'session'->>'storeReference' = store_id::text
    AND record->'predecessor'->'session'->>'channel' = 'DineIn'
    AND record->'candidate'->'session'->>'channel' = 'DineIn'
    AND record->'predecessor'->'session'->>'diningState' = 'ContextOnly'
    AND record->'candidate'->'session'->>'diningState' = 'DiningBound'
    AND record->'predecessor'->'session'->'diningSessionReference' = 'null'::jsonb
    AND record->'predecessor'->'session'->'diningParticipantReference' = 'null'::jsonb
    AND record->'candidate'->'session'->>'diningSessionReference' ~ '^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
    AND record->'candidate'->'session'->>'diningParticipantReference' ~ '^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
    AND record->'candidate'->'session'->>'publicTableReference' ~ '^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
    AND record->'candidate'->'session'->>'publicTableReference' = record->'predecessor'->'session'->>'publicTableReference'
    AND record->'candidate'->'session'->>'publicStoreReference' = record->'predecessor'->'session'->>'publicStoreReference'
    AND record->'candidate'->>'operationReference' = operation_id::text
    AND record->'candidate'->'session'->>'rotatedFromGuestSessionReference' = predecessor_id::text
  ) IS TRUE)
);

CREATE INDEX guest_dining_binding_preparation_scope_idx
  ON bop_identity.guest_dining_binding_preparation (brand_id, store_id, operation_id, revision DESC);
CREATE UNIQUE INDEX guest_dining_binding_preparation_candidate_idx
  ON bop_identity.guest_dining_binding_preparation (candidate_id) WHERE revision = 1;

CREATE FUNCTION bop_identity.validate_guest_dining_binding_preparation()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
DECLARE
  prior jsonb;
  item jsonb;
BEGIN
  FOREACH item IN ARRAY ARRAY[NEW.record->'predecessor', NEW.record->'candidate'] LOOP
    IF jsonb_typeof(item) IS DISTINCT FROM 'object'
      OR NOT (item ?& ARRAY['session','sessionSelectorHash','csrfSelectorHash','operationReference','operationIntentHash'])
      OR item - ARRAY['session','sessionSelectorHash','csrfSelectorHash','operationReference','operationIntentHash'] <> '{}'::jsonb
      OR (item->>'sessionSelectorHash' ~ '^[0-9a-f]{64}$') IS NOT TRUE
      OR (item->>'csrfSelectorHash' ~ '^[0-9a-f]{64}$') IS NOT TRUE
      OR (item->>'operationIntentHash' ~ '^[0-9a-f]{64}$') IS NOT TRUE
      OR jsonb_typeof(item->'session') IS DISTINCT FROM 'object'
      OR NOT (item->'session' ?& ARRAY['sessionReference','status','version','brandReference','storeReference','publicStoreReference','publicTableReference','channel','locale','qrReference','qrRevocationVersion','diningState','diningSessionReference','diningParticipantReference','createdAt','lastSeenAt','idleExpiresAt','absoluteExpiresAt','orderClosedAt','closureExpiresAt','rotatedFromGuestSessionReference','revocationReason','revokedAt'])
      OR (item->'session') - ARRAY['sessionReference','status','version','brandReference','storeReference','publicStoreReference','publicTableReference','channel','locale','qrReference','qrRevocationVersion','diningState','diningSessionReference','diningParticipantReference','createdAt','lastSeenAt','idleExpiresAt','absoluteExpiresAt','orderClosedAt','closureExpiresAt','rotatedFromGuestSessionReference','revocationReason','revokedAt'] <> '{}'::jsonb
    THEN
      RAISE EXCEPTION 'Guest binding snapshot is invalid' USING ERRCODE = '23514';
    END IF;
  END LOOP;
  IF NEW.revision = 1 THEN
    IF NEW.record->'acknowledgedAt' IS DISTINCT FROM 'null'::jsonb
      OR NEW.record->'activatedAt' IS DISTINCT FROM 'null'::jsonb THEN
      RAISE EXCEPTION 'Guest binding transition is invalid' USING ERRCODE = '23514';
    END IF;
  ELSE
    SELECT record INTO prior FROM bop_identity.guest_dining_binding_preparation
      WHERE operation_id = NEW.operation_id AND revision = NEW.revision - 1
        AND brand_id = NEW.brand_id AND store_id = NEW.store_id;
    IF prior IS NULL
      OR prior - ARRAY['revision','status','acknowledgedAt','activatedAt']
        IS DISTINCT FROM NEW.record - ARRAY['revision','status','acknowledgedAt','activatedAt']
      OR jsonb_typeof(NEW.record->'acknowledgedAt') IS DISTINCT FROM 'string'
      OR (NEW.revision = 2 AND NEW.record->'activatedAt' IS DISTINCT FROM 'null'::jsonb)
      OR (NEW.revision = 3 AND (NEW.record->'acknowledgedAt' IS DISTINCT FROM prior->'acknowledgedAt'
        OR jsonb_typeof(NEW.record->'activatedAt') IS DISTINCT FROM 'string')) THEN
      RAISE EXCEPTION 'Guest binding transition is invalid' USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION bop_identity.validate_guest_dining_binding_preparation() FROM PUBLIC;
CREATE TRIGGER guest_dining_binding_preparation_validate BEFORE INSERT ON bop_identity.guest_dining_binding_preparation
  FOR EACH ROW EXECUTE FUNCTION bop_identity.validate_guest_dining_binding_preparation();
CREATE TRIGGER guest_dining_binding_preparation_no_mutation BEFORE UPDATE OR DELETE ON bop_identity.guest_dining_binding_preparation
  FOR EACH ROW EXECUTE FUNCTION bop_identity.reject_guest_session_operation_mutation();
CREATE TRIGGER guest_dining_binding_preparation_no_truncate BEFORE TRUNCATE ON bop_identity.guest_dining_binding_preparation
  FOR EACH STATEMENT EXECUTE FUNCTION bop_identity.reject_guest_session_operation_mutation();
ALTER TABLE bop_identity.guest_dining_binding_preparation ENABLE ROW LEVEL SECURITY;
ALTER TABLE bop_identity.guest_dining_binding_preparation FORCE ROW LEVEL SECURITY;
CREATE POLICY guest_dining_binding_preparation_scope_policy ON bop_identity.guest_dining_binding_preparation
  USING (brand_id = platform_helpers.current_brand_id() AND store_id = platform_helpers.current_store_id())
  WITH CHECK (brand_id = platform_helpers.current_brand_id() AND store_id = platform_helpers.current_store_id());
REVOKE ALL ON TABLE bop_identity.guest_dining_binding_preparation FROM PUBLIC;
