-- bop-rms-migration: 1
-- owner: @rms/dining
-- schema: rms_dining
-- phase: expand
-- risk: medium
-- transaction: required
-- lock-timeout-ms: 5000
-- statement-timeout-ms: 60000
-- recovery: forward-fix
-- WP-2423 (DEC-DINING-GUEST-INVITATION, 2026-10-17; Handoff 6.11 and 87.4.1): the Order Host
-- invites the next guest from their own phone. Each invitation is the Session's next one-time
-- join code (a new dining_join_capability generation, the same capability staff issue), written
-- with this append-only record of which Host issued it. The record never holds the code itself,
-- only the capability snapshot (selector hash). It also bounds guest issuance: at most 10 per
-- Session in any 10 minutes (the trigger re-checks what the store enforces under the Session
-- lock). Grants: api SELECT/INSERT (Owner standing approval 2026-10-14, WP-2423).
CREATE TABLE rms_dining.dining_guest_invitation_operation (
 tenant_id platform_helpers.uuid_v7 NOT NULL,
 brand_id platform_helpers.uuid_v7 NOT NULL,
 store_id platform_helpers.uuid_v7 NOT NULL,
 operation_id platform_helpers.uuid_v7 NOT NULL,
 session_id platform_helpers.uuid_v7 NOT NULL,
 participant_id platform_helpers.uuid_v7 NOT NULL,
 capability_id platform_helpers.uuid_v7 NOT NULL,
 intent_hash text NOT NULL CHECK (intent_hash ~ '^[0-9a-f]{64}$'),
 occurred_at timestamptz NOT NULL CHECK (isfinite(occurred_at) AND occurred_at=date_trunc('milliseconds',occurred_at)),
 record_json jsonb NOT NULL,
 PRIMARY KEY (brand_id,store_id,operation_id),
 CONSTRAINT dining_guest_invitation_operation_capability UNIQUE (capability_id),
 CONSTRAINT dining_guest_invitation_operation_session_fk FOREIGN KEY (tenant_id,brand_id,store_id,session_id)
  REFERENCES rms_dining.dining_session(tenant_id,brand_id,store_id,session_id),
 CONSTRAINT dining_guest_invitation_operation_participant_fk FOREIGN KEY (tenant_id,brand_id,store_id,session_id,participant_id)
  REFERENCES rms_dining.dining_participant(tenant_id,brand_id,store_id,session_id,participant_id),
 CONSTRAINT dining_guest_invitation_operation_capability_fk FOREIGN KEY (capability_id)
  REFERENCES rms_dining.dining_join_capability(capability_id),
 CONSTRAINT dining_guest_invitation_operation_shape CHECK ((
  jsonb_typeof(record_json)='object' AND octet_length(record_json::text)<=32768
  AND record_json ?& ARRAY['operationReference','diningSessionReference','participantReference','capability']
  AND record_json - ARRAY['operationReference','diningSessionReference','participantReference','capability']='{}'::jsonb
  AND record_json->>'operationReference'=operation_id::text
  AND record_json->>'diningSessionReference'=session_id::text
  AND record_json->>'participantReference'=participant_id::text
  AND jsonb_typeof(record_json->'capability')='object'
  AND record_json->'capability' ?& ARRAY['capabilityReference','purpose','kind','storeReference','tableReference','diningSessionReference','selectorHash','pepperVersion','assignmentVersion','generation','status','version','issuedAt','expiresAt','consumedAt','revokedAt']
  AND (record_json->'capability') - ARRAY['capabilityReference','purpose','kind','storeReference','tableReference','diningSessionReference','selectorHash','pepperVersion','assignmentVersion','generation','status','version','issuedAt','expiresAt','consumedAt','revokedAt']='{}'::jsonb
  AND record_json->'capability'->>'capabilityReference'=capability_id::text
  AND record_json->'capability'->>'diningSessionReference'=session_id::text
  AND record_json->'capability'->>'storeReference'=store_id::text
  AND record_json->'capability'->>'purpose'='DiningJoin' AND record_json->'capability'->>'kind' IN ('Invitation','HumanCode')
  AND record_json->'capability'->>'status'='Active' AND record_json->'capability'->'version'='1'::jsonb
  AND record_json->'capability'->'consumedAt'='null'::jsonb AND record_json->'capability'->'revokedAt'='null'::jsonb
  AND record_json->'capability'->>'selectorHash' ~ '^[0-9a-f]{64}$'
  AND jsonb_typeof(record_json->'capability'->'generation')='number'
  AND (record_json->'capability'->>'generation')::numeric BETWEEN 2 AND 9007199254740991
  AND (record_json->'capability'->>'issuedAt')::timestamptz=occurred_at
  AND record_json->'capability'->>'issuedAt' ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{3}Z$'
  AND (record_json->'capability'->>'expiresAt')::timestamptz=occurred_at+interval '15 minutes'
 ) IS TRUE)
);
CREATE INDEX dining_guest_invitation_operation_window_idx
 ON rms_dining.dining_guest_invitation_operation (tenant_id,brand_id,store_id,session_id,occurred_at);

-- Defense in depth for what the store proves under its Table/Session/participant locks: the
-- issuer is the Session's current Host and an Active participant of the Active Session, the
-- capability row is exactly the recorded one, and the Session's guest issuance budget holds.
CREATE FUNCTION rms_dining.validate_guest_invitation_insert() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
BEGIN
 IF NOT EXISTS(SELECT 1 FROM rms_dining.dining_session WHERE tenant_id=NEW.tenant_id AND brand_id=NEW.brand_id AND store_id=NEW.store_id AND session_id=NEW.session_id AND phase='Active' AND session_snapshot->>'hostParticipantReference'=NEW.participant_id::text)
 OR NOT EXISTS(SELECT 1 FROM rms_dining.dining_participant WHERE tenant_id=NEW.tenant_id AND brand_id=NEW.brand_id AND store_id=NEW.store_id AND session_id=NEW.session_id AND participant_id=NEW.participant_id AND status='Active')
 OR NOT EXISTS(SELECT 1 FROM rms_dining.dining_join_capability WHERE tenant_id=NEW.tenant_id AND brand_id=NEW.brand_id AND store_id=NEW.store_id AND session_id=NEW.session_id AND capability_id=NEW.capability_id AND status='Active' AND version=1 AND capability_snapshot=NEW.record_json->'capability') THEN
  RAISE EXCEPTION 'guest invitation source mismatch' USING ERRCODE='23514';
 END IF;
 IF (SELECT count(*) FROM rms_dining.dining_guest_invitation_operation WHERE tenant_id=NEW.tenant_id AND brand_id=NEW.brand_id AND store_id=NEW.store_id AND session_id=NEW.session_id AND occurred_at>NEW.occurred_at-interval '10 minutes' AND occurred_at<=NEW.occurred_at)>=10 THEN
  RAISE EXCEPTION 'guest invitation budget exceeded' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION rms_dining.validate_guest_invitation_insert() FROM PUBLIC;
CREATE TRIGGER dining_guest_invitation_source BEFORE INSERT ON rms_dining.dining_guest_invitation_operation
 FOR EACH ROW EXECUTE FUNCTION rms_dining.validate_guest_invitation_insert();
CREATE FUNCTION rms_dining.reject_guest_invitation_mutation() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
BEGIN
 RAISE EXCEPTION 'append-only guest invitation history' USING ERRCODE='55000';
END;
$$;
REVOKE ALL ON FUNCTION rms_dining.reject_guest_invitation_mutation() FROM PUBLIC;
CREATE TRIGGER dining_guest_invitation_no_mutation BEFORE UPDATE OR DELETE ON rms_dining.dining_guest_invitation_operation
 FOR EACH ROW EXECUTE FUNCTION rms_dining.reject_guest_invitation_mutation();
CREATE TRIGGER dining_guest_invitation_no_truncate BEFORE TRUNCATE ON rms_dining.dining_guest_invitation_operation
 FOR EACH STATEMENT EXECUTE FUNCTION rms_dining.reject_guest_invitation_mutation();
ALTER TABLE rms_dining.dining_guest_invitation_operation ENABLE ROW LEVEL SECURITY;
ALTER TABLE rms_dining.dining_guest_invitation_operation FORCE ROW LEVEL SECURITY;
CREATE POLICY dining_guest_invitation_operation_scope ON rms_dining.dining_guest_invitation_operation
 USING (brand_id=platform_helpers.current_brand_id() AND store_id=platform_helpers.current_store_id())
 WITH CHECK (brand_id=platform_helpers.current_brand_id() AND store_id=platform_helpers.current_store_id());
REVOKE ALL ON TABLE rms_dining.dining_guest_invitation_operation FROM PUBLIC;
