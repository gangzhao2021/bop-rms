-- bop-rms-migration: 1
-- owner: @bop/task
-- schema: bop_task
-- phase: expand
-- risk: medium
-- transaction: required
-- lock-timeout-ms: 5000
-- statement-timeout-ms: 60000
-- recovery: forward-fix
CREATE TABLE bop_task.task_version (
 task_id platform_helpers.uuid_v7 NOT NULL,
 brand_id platform_helpers.uuid_v7 NOT NULL,
 store_id platform_helpers.uuid_v7,
 scope_store_key text GENERATED ALWAYS AS (COALESCE(store_id::text,'brand')) STORED,
 version integer NOT NULL CHECK(version>0),
 expected_version integer NOT NULL CHECK(expected_version>0),
 operation_code text NOT NULL CHECK(operation_code IN ('Create','Assign','Claim','Complete','Fail','Cancel','Escalate')),
 idempotency_key platform_helpers.uuid_v7 NOT NULL,
 request_digest text NOT NULL CHECK(request_digest ~ '^sha256:[0-9a-f]{64}$'),
 mutation_digest text NOT NULL CHECK(mutation_digest ~ '^sha256:[0-9a-f]{64}$'),
 audit_id platform_helpers.uuid_v7 NOT NULL,
 source_type text NOT NULL,
 source_id platform_helpers.uuid_v7 NOT NULL,
 task_type text NOT NULL,
 status text NOT NULL CHECK(status IN ('Open','Assigned','Claimed','Completed','Failed','Cancelled')),
 occurred_at timestamptz NOT NULL CHECK(isfinite(occurred_at) AND occurred_at=date_trunc('milliseconds',occurred_at)),
 record_json jsonb NOT NULL,
 PRIMARY KEY(task_id,version),
 UNIQUE(brand_id,scope_store_key,idempotency_key),
 UNIQUE(brand_id,scope_store_key,audit_id),
 CHECK((operation_code='Create' AND version=1 AND expected_version=1 AND status='Open') OR (operation_code<>'Create' AND version::bigint=expected_version::bigint+1)),
 CHECK((jsonb_typeof(record_json)='object'
  AND record_json->>'taskReference'=task_id::text
  AND record_json#>>'{scope,brandReference}'=brand_id::text
  AND record_json#>'{scope,storeReference}'=COALESCE(to_jsonb(store_id::text),'null'::jsonb)
  AND record_json#>>'{scope,kind}'=CASE WHEN store_id IS NULL THEN 'Brand' ELSE 'Store' END
  AND record_json->'version'=to_jsonb(version)
  AND record_json->>'status'=status
  AND record_json->>'taskType'=task_type
  AND record_json#>>'{source,sourceType}'=source_type
  AND record_json#>>'{source,sourceReference}'=source_id::text
  AND record_json->>'updatedAt'=to_char(occurred_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
  AND jsonb_typeof(record_json->'assignmentHistory')='array'
  AND jsonb_typeof(record_json->'claimHistory')='array'
  AND jsonb_typeof(record_json->'escalationHistory')='array') IS TRUE)
);
CREATE INDEX task_version_source_idx ON bop_task.task_version(brand_id,store_id,source_type,source_id,task_id,version DESC);
CREATE FUNCTION bop_task.guard_task_version() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
DECLARE prior bop_task.task_version%ROWTYPE; history_key text; previous_length integer; prefix jsonb;
BEGIN
 IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'Task history is immutable' USING ERRCODE='55000'; END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended('TaskSource:'||NEW.brand_id::text||':'||COALESCE(NEW.store_id::text,'brand')||':'||NEW.source_type||':'||NEW.source_id::text,0));
 PERFORM pg_advisory_xact_lock(hashtextextended('TaskVersion:'||NEW.task_id::text,0));
 SELECT * INTO prior FROM bop_task.task_version WHERE task_id=NEW.task_id ORDER BY version DESC LIMIT 1;
 IF NOT FOUND THEN
  IF NEW.operation_code<>'Create' OR NEW.version<>1 OR NEW.record_json->>'createdAt' IS DISTINCT FROM NEW.record_json->>'updatedAt'
   OR NEW.record_json->'assignmentHistory'<>'[]'::jsonb OR NEW.record_json->'claimHistory'<>'[]'::jsonb OR NEW.record_json->'escalationHistory'<>'[]'::jsonb
   THEN RAISE EXCEPTION 'Task creation is invalid' USING ERRCODE='23514'; END IF;
 ELSE
  IF NEW.brand_id<>prior.brand_id OR NEW.store_id IS DISTINCT FROM prior.store_id OR NEW.version::bigint<>prior.version::bigint+1 OR NEW.expected_version<>prior.version
   OR NEW.occurred_at<prior.occurred_at OR prior.status IN ('Completed','Failed','Cancelled')
   OR NEW.record_json - ARRAY['status','assignmentHistory','currentAssignment','claimHistory','currentClaim','escalationHistory','terminalOutcome','version','updatedAt']
      IS DISTINCT FROM prior.record_json - ARRAY['status','assignmentHistory','currentAssignment','claimHistory','currentClaim','escalationHistory','terminalOutcome','version','updatedAt']
   OR NOT ((NEW.operation_code='Assign' AND NEW.status='Assigned') OR (NEW.operation_code='Claim' AND prior.status='Assigned' AND NEW.status='Claimed')
     OR (NEW.operation_code='Complete' AND prior.status='Claimed' AND NEW.status='Completed') OR (NEW.operation_code='Fail' AND prior.status='Claimed' AND NEW.status='Failed')
     OR (NEW.operation_code='Cancel' AND NEW.status='Cancelled') OR (NEW.operation_code='Escalate' AND NEW.status=prior.status))
   THEN RAISE EXCEPTION 'Task version is invalid' USING ERRCODE='23514'; END IF;
  FOREACH history_key IN ARRAY ARRAY['assignmentHistory','claimHistory','escalationHistory'] LOOP
   previous_length:=jsonb_array_length(prior.record_json->history_key);
   SELECT COALESCE(jsonb_agg(value ORDER BY ordinal),'[]'::jsonb) INTO prefix
    FROM jsonb_array_elements(NEW.record_json->history_key) WITH ORDINALITY AS entries(value,ordinal) WHERE ordinal<=previous_length;
   IF jsonb_array_length(NEW.record_json->history_key)<previous_length OR prefix IS DISTINCT FROM prior.record_json->history_key THEN
    RAISE EXCEPTION 'Task history prefix is immutable' USING ERRCODE='23514'; END IF;
  END LOOP;
 END IF;
 RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION bop_task.guard_task_version() FROM PUBLIC;
CREATE TRIGGER task_version_validate BEFORE INSERT ON bop_task.task_version FOR EACH ROW EXECUTE FUNCTION bop_task.guard_task_version();
CREATE TRIGGER task_version_no_mutation BEFORE UPDATE OR DELETE ON bop_task.task_version FOR EACH ROW EXECUTE FUNCTION bop_task.guard_task_version();
CREATE TRIGGER task_version_no_truncate BEFORE TRUNCATE ON bop_task.task_version FOR EACH STATEMENT EXECUTE FUNCTION bop_task.guard_task_version();
ALTER TABLE bop_task.task_version ENABLE ROW LEVEL SECURITY;
ALTER TABLE bop_task.task_version FORCE ROW LEVEL SECURITY;
CREATE POLICY task_version_tenant_scope ON bop_task.task_version
 USING(brand_id=platform_helpers.current_brand_id() AND ((store_id IS NULL AND platform_helpers.current_store_id() IS NULL) OR store_id=platform_helpers.current_store_id()))
 WITH CHECK(brand_id=platform_helpers.current_brand_id() AND ((store_id IS NULL AND platform_helpers.current_store_id() IS NULL) OR store_id=platform_helpers.current_store_id()));
REVOKE ALL ON TABLE bop_task.task_version FROM PUBLIC;
