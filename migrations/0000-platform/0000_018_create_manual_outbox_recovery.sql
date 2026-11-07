-- bop-rms-migration: 1
-- owner: shared-infrastructure/eventing
-- schema: platform_eventing
-- phase: expand
-- risk: medium
-- transaction: required
-- lock-timeout-ms: 5000
-- statement-timeout-ms: 60000
-- recovery: forward-fix
CREATE TABLE platform_eventing.manual_outbox_recovery (
  recovery_id platform_helpers.uuid_v7 PRIMARY KEY,
  brand_id platform_helpers.uuid_v7 NOT NULL,
  store_id platform_helpers.uuid_v7,
  scope_store_key text GENERATED ALWAYS AS (COALESCE(store_id::text, 'brand')) STORED,
  dead_letter_id platform_helpers.uuid_v7 NOT NULL REFERENCES platform_eventing.dead_letter_item(dead_letter_id),
  event_id platform_helpers.uuid_v7 NOT NULL REFERENCES platform_eventing.outbox_event(event_id),
  actor_id platform_helpers.uuid_v7 NOT NULL,
  action_id platform_helpers.uuid_v7 NOT NULL UNIQUE,
  idempotency_key platform_helpers.uuid_v7 NOT NULL,
  expected_dead_letter_version bigint NOT NULL CHECK(expected_dead_letter_version>=0),
  purpose_code text NOT NULL CHECK(purpose_code='RELIABILITY_RECOVERY'),
  reason_code text NOT NULL CHECK(reason_code IN ('DEPENDENCY_RECOVERED','TRANSIENT_RECOVERED')),
  permission_code text NOT NULL CHECK(permission_code='EVENTING_DEAD_LETTER_RETRY'),
  policy_name text NOT NULL CHECK(policy_name='eventing_manual_single_handoff'),
  policy_version integer NOT NULL CHECK(policy_version=1),
  original_automatic_attempt_count integer NOT NULL CHECK(original_automatic_attempt_count=8),
  maximum_handoffs integer NOT NULL CHECK(maximum_handoffs=1),
  intent_digest text NOT NULL CHECK(intent_digest ~ '^sha256:[0-9a-f]{64}$'),
  registry_digest text NOT NULL CHECK(registry_digest ~ '^sha256:[0-9a-f]{64}$'),
  requested_at timestamptz NOT NULL,
  start_deadline_at timestamptz NOT NULL,
  UNIQUE(brand_id,scope_store_key,idempotency_key),
  UNIQUE(recovery_id,brand_id,scope_store_key,event_id),
  CHECK(isfinite(requested_at) AND requested_at=date_trunc('milliseconds',requested_at)),
  CHECK(start_deadline_at=requested_at+interval '5 minutes')
);
CREATE FUNCTION platform_eventing.validate_manual_outbox_recovery() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM platform_eventing.dead_letter_item d
    JOIN platform_eventing.outbox_event e ON e.event_id=d.event_id
    WHERE d.dead_letter_id=NEW.dead_letter_id AND d.event_id=NEW.event_id
      AND d.brand_id=NEW.brand_id AND d.store_id IS NOT DISTINCT FROM NEW.store_id
      AND e.brand_id=NEW.brand_id AND e.store_id IS NOT DISTINCT FROM NEW.store_id
      AND d.delivery_path='outbox' AND d.status='open' AND d.failure_class='exhausted'
      AND d.safe_code IN ('TRANSPORT_UNAVAILABLE','TRANSPORT_TIMEOUT')
      AND d.version=NEW.expected_dead_letter_version AND d.attempt_count=8
      AND e.attempt_count=8 AND e.published_at IS NULL AND e.lease_token IS NULL
      AND e.ordering_released_at IS NULL AND e.last_error_code=d.safe_code
      AND NOT EXISTS (
        SELECT 1 FROM platform_eventing.outbox_event earlier
        WHERE earlier.brand_id=e.brand_id AND earlier.aggregate_type=e.aggregate_type
          AND earlier.aggregate_id=e.aggregate_id AND earlier.published_at IS NULL
          AND earlier.ordering_released_at IS NULL
          AND (earlier.aggregate_version,earlier.event_id)<(e.aggregate_version,e.event_id)
      )
  ) THEN RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='MANUAL_OUTBOX_RECOVERY_INELIGIBLE'; END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION platform_eventing.validate_manual_outbox_recovery() FROM PUBLIC;
CREATE TRIGGER manual_outbox_recovery_validate BEFORE INSERT ON platform_eventing.manual_outbox_recovery
 FOR EACH ROW EXECUTE FUNCTION platform_eventing.validate_manual_outbox_recovery();

CREATE TABLE platform_eventing.manual_outbox_recovery_execution (
  recovery_id platform_helpers.uuid_v7 PRIMARY KEY,
  brand_id platform_helpers.uuid_v7 NOT NULL,
  store_id platform_helpers.uuid_v7,
  scope_store_key text GENERATED ALWAYS AS (COALESCE(store_id::text, 'brand')) STORED,
  event_id platform_helpers.uuid_v7 NOT NULL,
  state text NOT NULL CHECK(state IN ('scheduled','claimed','acknowledged','failed','unknown','expired')),
  version bigint NOT NULL CHECK(version>0),
  lease_token platform_helpers.uuid_v7,
  lease_owner text CHECK(lease_owner ~ '^[A-Za-z0-9_-]{1,64}$'),
  lease_expires_at timestamptz,
  FOREIGN KEY(recovery_id,brand_id,scope_store_key,event_id)
    REFERENCES platform_eventing.manual_outbox_recovery(recovery_id,brand_id,scope_store_key,event_id),
  CHECK((state='claimed' AND lease_token IS NOT NULL AND lease_owner IS NOT NULL AND lease_expires_at IS NOT NULL)
     OR (state<>'claimed' AND lease_token IS NULL AND lease_owner IS NULL AND lease_expires_at IS NULL))
);
CREATE UNIQUE INDEX manual_outbox_recovery_one_active
 ON platform_eventing.manual_outbox_recovery_execution(brand_id,scope_store_key,event_id)
 WHERE state IN ('scheduled','claimed','unknown');

CREATE TABLE platform_eventing.manual_outbox_recovery_attempt (
  recovery_id platform_helpers.uuid_v7 PRIMARY KEY,
  brand_id platform_helpers.uuid_v7 NOT NULL,
  store_id platform_helpers.uuid_v7,
  scope_store_key text GENERATED ALWAYS AS (COALESCE(store_id::text, 'brand')) STORED,
  event_id platform_helpers.uuid_v7 NOT NULL,
  lease_token platform_helpers.uuid_v7 NOT NULL UNIQUE,
  started_at timestamptz NOT NULL,
  deadline_at timestamptz NOT NULL,
  FOREIGN KEY(recovery_id,brand_id,scope_store_key,event_id)
    REFERENCES platform_eventing.manual_outbox_recovery(recovery_id,brand_id,scope_store_key,event_id),
  UNIQUE(recovery_id,brand_id,scope_store_key,event_id,lease_token),
  CHECK(isfinite(started_at) AND started_at=date_trunc('milliseconds',started_at)),
  CHECK(deadline_at>started_at AND deadline_at<=started_at+interval '30 seconds')
);
CREATE TABLE platform_eventing.manual_outbox_recovery_outcome (
  recovery_id platform_helpers.uuid_v7 PRIMARY KEY,
  brand_id platform_helpers.uuid_v7 NOT NULL,
  store_id platform_helpers.uuid_v7,
  scope_store_key text GENERATED ALWAYS AS (COALESCE(store_id::text, 'brand')) STORED,
  event_id platform_helpers.uuid_v7 NOT NULL,
  lease_token platform_helpers.uuid_v7 NOT NULL,
  outcome text NOT NULL CHECK(outcome IN ('acknowledged','failed','unknown')),
  safe_code text NOT NULL CHECK(safe_code IN ('ACKNOWLEDGED','TRANSPORT_UNAVAILABLE','TRANSPORT_TIMEOUT','TRANSPORT_REJECTED','COMMIT_OUTCOME_UNKNOWN')),
  recorded_at timestamptz NOT NULL,
  FOREIGN KEY(recovery_id,brand_id,scope_store_key,event_id,lease_token)
    REFERENCES platform_eventing.manual_outbox_recovery_attempt(recovery_id,brand_id,scope_store_key,event_id,lease_token),
  CHECK(isfinite(recorded_at) AND recorded_at=date_trunc('milliseconds',recorded_at)),
  CHECK((outcome='acknowledged' AND safe_code='ACKNOWLEDGED') OR
        (outcome='unknown' AND safe_code='COMMIT_OUTCOME_UNKNOWN') OR
        (outcome='failed' AND safe_code IN ('TRANSPORT_UNAVAILABLE','TRANSPORT_TIMEOUT','TRANSPORT_REJECTED')))
);
CREATE FUNCTION platform_eventing.validate_manual_outbox_recovery_evidence() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
BEGIN
  IF TG_TABLE_NAME='manual_outbox_recovery_attempt' THEN
    IF NOT EXISTS (
      SELECT 1 FROM platform_eventing.manual_outbox_recovery r
      JOIN platform_eventing.manual_outbox_recovery_execution x USING(recovery_id)
      WHERE r.recovery_id=NEW.recovery_id AND r.brand_id=NEW.brand_id
        AND r.store_id IS NOT DISTINCT FROM NEW.store_id AND r.event_id=NEW.event_id
        AND NEW.started_at>=r.requested_at AND NEW.started_at<r.start_deadline_at
        AND x.state='claimed' AND x.lease_token=NEW.lease_token AND x.lease_expires_at=NEW.deadline_at
    ) THEN RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='MANUAL_OUTBOX_RECOVERY_ATTEMPT_INVALID'; END IF;
  ELSE
    IF NOT EXISTS (
      SELECT 1 FROM platform_eventing.manual_outbox_recovery_attempt a
      WHERE a.recovery_id=NEW.recovery_id AND a.brand_id=NEW.brand_id
        AND a.store_id IS NOT DISTINCT FROM NEW.store_id AND a.event_id=NEW.event_id
        AND a.lease_token=NEW.lease_token AND NEW.recorded_at>=a.started_at
        AND (NEW.outcome<>'acknowledged' OR NEW.recorded_at<=a.deadline_at)
    ) THEN RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='MANUAL_OUTBOX_RECOVERY_OUTCOME_INVALID'; END IF;
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION platform_eventing.validate_manual_outbox_recovery_evidence() FROM PUBLIC;
CREATE TRIGGER manual_outbox_recovery_attempt_validate BEFORE INSERT ON platform_eventing.manual_outbox_recovery_attempt
 FOR EACH ROW EXECUTE FUNCTION platform_eventing.validate_manual_outbox_recovery_evidence();
CREATE TRIGGER manual_outbox_recovery_outcome_validate BEFORE INSERT ON platform_eventing.manual_outbox_recovery_outcome
 FOR EACH ROW EXECUTE FUNCTION platform_eventing.validate_manual_outbox_recovery_evidence();

CREATE FUNCTION platform_eventing.reject_manual_outbox_recovery_mutation() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
BEGIN RAISE EXCEPTION USING ERRCODE='55000',MESSAGE='MANUAL_OUTBOX_RECOVERY_APPEND_ONLY'; END $$;
REVOKE ALL ON FUNCTION platform_eventing.reject_manual_outbox_recovery_mutation() FROM PUBLIC;
CREATE TRIGGER manual_outbox_recovery_no_mutation BEFORE UPDATE OR DELETE ON platform_eventing.manual_outbox_recovery
 FOR EACH ROW EXECUTE FUNCTION platform_eventing.reject_manual_outbox_recovery_mutation();
CREATE TRIGGER manual_outbox_recovery_no_truncate BEFORE TRUNCATE ON platform_eventing.manual_outbox_recovery
 FOR EACH STATEMENT EXECUTE FUNCTION platform_eventing.reject_manual_outbox_recovery_mutation();
ALTER TABLE platform_eventing.manual_outbox_recovery ENABLE ROW LEVEL SECURITY;
ALTER TABLE platform_eventing.manual_outbox_recovery FORCE ROW LEVEL SECURITY;
CREATE POLICY manual_outbox_recovery_tenant_scope ON platform_eventing.manual_outbox_recovery
 USING(brand_id=platform_helpers.current_brand_id() AND
   ((store_id IS NULL AND platform_helpers.current_store_id() IS NULL) OR store_id=platform_helpers.current_store_id()))
 WITH CHECK(brand_id=platform_helpers.current_brand_id() AND
   ((store_id IS NULL AND platform_helpers.current_store_id() IS NULL) OR store_id=platform_helpers.current_store_id()));
REVOKE ALL ON TABLE platform_eventing.manual_outbox_recovery FROM PUBLIC;
CREATE TRIGGER manual_outbox_recovery_execution_no_truncate BEFORE TRUNCATE ON platform_eventing.manual_outbox_recovery_execution
 FOR EACH STATEMENT EXECUTE FUNCTION platform_eventing.reject_manual_outbox_recovery_mutation();
ALTER TABLE platform_eventing.manual_outbox_recovery_execution ENABLE ROW LEVEL SECURITY;
ALTER TABLE platform_eventing.manual_outbox_recovery_execution FORCE ROW LEVEL SECURITY;
CREATE POLICY manual_outbox_recovery_execution_tenant_scope ON platform_eventing.manual_outbox_recovery_execution
 USING(brand_id=platform_helpers.current_brand_id() AND
   ((store_id IS NULL AND platform_helpers.current_store_id() IS NULL) OR store_id=platform_helpers.current_store_id()))
 WITH CHECK(brand_id=platform_helpers.current_brand_id() AND
   ((store_id IS NULL AND platform_helpers.current_store_id() IS NULL) OR store_id=platform_helpers.current_store_id()));
REVOKE ALL ON TABLE platform_eventing.manual_outbox_recovery_execution FROM PUBLIC;
CREATE TRIGGER manual_outbox_recovery_attempt_no_mutation BEFORE UPDATE OR DELETE ON platform_eventing.manual_outbox_recovery_attempt
 FOR EACH ROW EXECUTE FUNCTION platform_eventing.reject_manual_outbox_recovery_mutation();
CREATE TRIGGER manual_outbox_recovery_attempt_no_truncate BEFORE TRUNCATE ON platform_eventing.manual_outbox_recovery_attempt
 FOR EACH STATEMENT EXECUTE FUNCTION platform_eventing.reject_manual_outbox_recovery_mutation();
ALTER TABLE platform_eventing.manual_outbox_recovery_attempt ENABLE ROW LEVEL SECURITY;
ALTER TABLE platform_eventing.manual_outbox_recovery_attempt FORCE ROW LEVEL SECURITY;
CREATE POLICY manual_outbox_recovery_attempt_tenant_scope ON platform_eventing.manual_outbox_recovery_attempt
 USING(brand_id=platform_helpers.current_brand_id() AND
   ((store_id IS NULL AND platform_helpers.current_store_id() IS NULL) OR store_id=platform_helpers.current_store_id()))
 WITH CHECK(brand_id=platform_helpers.current_brand_id() AND
   ((store_id IS NULL AND platform_helpers.current_store_id() IS NULL) OR store_id=platform_helpers.current_store_id()));
REVOKE ALL ON TABLE platform_eventing.manual_outbox_recovery_attempt FROM PUBLIC;
CREATE TRIGGER manual_outbox_recovery_outcome_no_mutation BEFORE UPDATE OR DELETE ON platform_eventing.manual_outbox_recovery_outcome
 FOR EACH ROW EXECUTE FUNCTION platform_eventing.reject_manual_outbox_recovery_mutation();
CREATE TRIGGER manual_outbox_recovery_outcome_no_truncate BEFORE TRUNCATE ON platform_eventing.manual_outbox_recovery_outcome
 FOR EACH STATEMENT EXECUTE FUNCTION platform_eventing.reject_manual_outbox_recovery_mutation();
ALTER TABLE platform_eventing.manual_outbox_recovery_outcome ENABLE ROW LEVEL SECURITY;
ALTER TABLE platform_eventing.manual_outbox_recovery_outcome FORCE ROW LEVEL SECURITY;
CREATE POLICY manual_outbox_recovery_outcome_tenant_scope ON platform_eventing.manual_outbox_recovery_outcome
 USING(brand_id=platform_helpers.current_brand_id() AND
   ((store_id IS NULL AND platform_helpers.current_store_id() IS NULL) OR store_id=platform_helpers.current_store_id()))
 WITH CHECK(brand_id=platform_helpers.current_brand_id() AND
   ((store_id IS NULL AND platform_helpers.current_store_id() IS NULL) OR store_id=platform_helpers.current_store_id()));
REVOKE ALL ON TABLE platform_eventing.manual_outbox_recovery_outcome FROM PUBLIC;
CREATE TRIGGER manual_outbox_recovery_execution_no_delete BEFORE DELETE ON platform_eventing.manual_outbox_recovery_execution
 FOR EACH ROW EXECUTE FUNCTION platform_eventing.reject_manual_outbox_recovery_mutation();
