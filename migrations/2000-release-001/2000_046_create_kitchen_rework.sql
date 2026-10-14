-- bop-rms-migration: 1
-- owner: @rms/kitchen
-- schema: rms_kitchen
-- phase: expand
-- risk: medium
-- transaction: required
-- lock-timeout-ms: 5000
-- statement-timeout-ms: 60000
-- recovery: forward-fix
-- WP-2423 Q26 (Handoff Section 26.6, DEC-KITCHEN-REWORK): a dish that was made wrong, dropped,
-- returned by the guest or failed quality is remade as a new Rework work item. The original work
-- item keeps its result (never rolled back); the rework links the original work item, its ticket
-- and Order item, and records reason, actor and time. A dish marked done by mistake gets a rework
-- with reason NOT_READY, only within two minutes of being completed or marked ready; it continues
-- In Progress and nothing is wasted. Every change of a rework is explained by one append-only
-- operation row (create, start, complete).
CREATE FUNCTION rms_kitchen.reject_kitchen_rework_mutation() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
BEGIN
 RAISE EXCEPTION 'append-only kitchen rework history' USING ERRCODE='55000';
END;
$$;
REVOKE ALL ON FUNCTION rms_kitchen.reject_kitchen_rework_mutation() FROM PUBLIC;

CREATE TABLE rms_kitchen.kitchen_rework_item (
 kitchen_rework_item_id platform_helpers.uuid_v7 NOT NULL,
 brand_id platform_helpers.uuid_v7 NOT NULL,
 store_id platform_helpers.uuid_v7 NOT NULL,
 kitchen_ticket_id platform_helpers.uuid_v7 NOT NULL,
 original_kitchen_work_item_id platform_helpers.uuid_v7 NOT NULL,
 order_id platform_helpers.uuid_v7 NOT NULL,
 order_batch_id platform_helpers.uuid_v7 NOT NULL,
 order_item_id platform_helpers.uuid_v7 NOT NULL,
 rework_ordinal integer NOT NULL CHECK (rework_ordinal BETWEEN 1 AND 20),
 reason_code text NOT NULL CHECK (
  reason_code IN ('WRONG_ITEM','DROPPED','CUSTOMER_RETURNED','QUALITY_ISSUE','NOT_READY','OTHER')
 ),
 reason_note text,
 quantity integer NOT NULL CHECK (quantity BETWEEN 1 AND 999),
 waste_applies boolean NOT NULL,
 status text NOT NULL CHECK (status IN ('Queued','In Progress','Completed')),
 version bigint NOT NULL CHECK (version BETWEEN 1 AND 3),
 created_operation_id platform_helpers.uuid_v7 NOT NULL,
 created_by_actor_id platform_helpers.uuid_v7 NOT NULL,
 created_at timestamptz NOT NULL,
 started_by_actor_id platform_helpers.uuid_v7,
 started_at timestamptz,
 completed_by_actor_id platform_helpers.uuid_v7,
 completed_at timestamptz,
 event_id platform_helpers.uuid_v7 NOT NULL,
 PRIMARY KEY (brand_id,store_id,kitchen_rework_item_id),
 UNIQUE (brand_id,store_id,original_kitchen_work_item_id,rework_ordinal),
 UNIQUE (brand_id,store_id,created_operation_id),
 UNIQUE (brand_id,store_id,event_id),
 FOREIGN KEY (brand_id,store_id,kitchen_ticket_id,original_kitchen_work_item_id,order_item_id)
  REFERENCES rms_kitchen.kitchen_work_item (brand_id,store_id,kitchen_ticket_id,kitchen_work_item_id,order_item_id),
 CONSTRAINT kitchen_rework_item_note_check CHECK (
  reason_note IS NULL
  OR (
   char_length(reason_note) BETWEEN 1 AND 200
   AND reason_note = btrim(reason_note)
   AND reason_note !~ '[[:cntrl:]]'
  )
 ),
 CONSTRAINT kitchen_rework_item_other_note_check CHECK (reason_code <> 'OTHER' OR reason_note IS NOT NULL),
 CONSTRAINT kitchen_rework_item_waste_check CHECK (waste_applies = (reason_code <> 'NOT_READY')),
 CONSTRAINT kitchen_rework_item_time_check CHECK (
  isfinite(created_at) AND created_at = date_trunc('milliseconds',created_at)
  AND (started_at IS NULL OR (isfinite(started_at) AND started_at >= created_at))
  AND (completed_at IS NULL OR (started_at IS NOT NULL AND completed_at >= started_at))
 ),
 CONSTRAINT kitchen_rework_item_state_check CHECK (
  (status = 'Queued' AND started_at IS NULL AND started_by_actor_id IS NULL
   AND completed_at IS NULL AND completed_by_actor_id IS NULL)
  OR (status = 'In Progress' AND started_at IS NOT NULL AND started_by_actor_id IS NOT NULL
   AND completed_at IS NULL AND completed_by_actor_id IS NULL)
  OR (status = 'Completed' AND started_at IS NOT NULL AND started_by_actor_id IS NOT NULL
   AND completed_at IS NOT NULL AND completed_by_actor_id IS NOT NULL)
 ),
 CHECK (
  kitchen_rework_item_id <> created_operation_id
  AND kitchen_rework_item_id <> event_id
  AND created_operation_id <> event_id
 )
);
CREATE INDEX kitchen_rework_item_order_idx
 ON rms_kitchen.kitchen_rework_item (brand_id,store_id,order_id);
CREATE INDEX kitchen_rework_item_open_idx
 ON rms_kitchen.kitchen_rework_item (brand_id,store_id,created_at) WHERE status <> 'Completed';

CREATE TABLE rms_kitchen.kitchen_rework_operation (
 kitchen_rework_operation_id platform_helpers.uuid_v7 NOT NULL,
 brand_id platform_helpers.uuid_v7 NOT NULL,
 store_id platform_helpers.uuid_v7 NOT NULL,
 kitchen_rework_item_id platform_helpers.uuid_v7 NOT NULL,
 action text NOT NULL CHECK (action IN ('Create','Start','Complete')),
 actor_id platform_helpers.uuid_v7 NOT NULL,
 idempotency_key platform_helpers.uuid_v7 NOT NULL,
 request_digest text NOT NULL CHECK (request_digest ~ '^sha256:[0-9a-f]{64}$'),
 before_status text CHECK (before_status IS NULL OR before_status IN ('Queued','In Progress')),
 after_status text NOT NULL CHECK (after_status IN ('Queued','In Progress','Completed')),
 result_version bigint NOT NULL CHECK (result_version BETWEEN 1 AND 3),
 audit_id platform_helpers.uuid_v7 NOT NULL,
 correlation_id platform_helpers.uuid_v7 NOT NULL,
 occurred_at timestamptz NOT NULL CHECK (isfinite(occurred_at) AND occurred_at=date_trunc('milliseconds',occurred_at)),
 PRIMARY KEY (brand_id,store_id,kitchen_rework_operation_id),
 UNIQUE (brand_id,store_id,actor_id,idempotency_key),
 UNIQUE (brand_id,store_id,kitchen_rework_item_id,result_version),
 UNIQUE (brand_id,store_id,audit_id),
 FOREIGN KEY (brand_id,store_id,kitchen_rework_item_id)
  REFERENCES rms_kitchen.kitchen_rework_item (brand_id,store_id,kitchen_rework_item_id)
  DEFERRABLE INITIALLY DEFERRED,
 CHECK (
  (action = 'Create' AND before_status IS NULL AND result_version = 1)
  OR (action = 'Start' AND before_status = 'Queued' AND after_status = 'In Progress')
  OR (action = 'Complete' AND before_status = 'In Progress' AND after_status = 'Completed')
 ),
 CHECK (kitchen_rework_operation_id <> audit_id AND kitchen_rework_operation_id <> kitchen_rework_item_id)
);

-- A rework is created only for a Completed original work item of the same ticket and Order line,
-- for at most its quantity, as the next ordinal (at most 20 per original). NOT_READY continues the
-- same dish: it starts In Progress, only within two minutes of the original's completion or
-- ready mark, and never while another NOT_READY rework of that dish is still open.
CREATE FUNCTION rms_kitchen.check_kitchen_rework_item_insert() RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog
AS $$
DECLARE
 original record;
 finished_at timestamptz;
 prior_count integer;
BEGIN
 SELECT w.status, w.required_quantity, w.updated_at, w.order_id, w.order_batch_id
   INTO original
   FROM rms_kitchen.kitchen_work_item w
  WHERE w.brand_id=NEW.brand_id AND w.store_id=NEW.store_id AND w.kitchen_ticket_id=NEW.kitchen_ticket_id
    AND w.kitchen_work_item_id=NEW.original_kitchen_work_item_id AND w.order_item_id=NEW.order_item_id
  FOR SHARE;
 IF NOT FOUND OR original.status <> 'Completed' OR original.order_id <> NEW.order_id
   OR original.order_batch_id <> NEW.order_batch_id OR NEW.quantity > original.required_quantity THEN
  RAISE EXCEPTION 'kitchen rework needs a completed original work item' USING ERRCODE='23514';
 END IF;
 IF NEW.version <> 1 OR NEW.created_at < original.updated_at
   OR (NEW.reason_code = 'NOT_READY' AND NEW.status <> 'In Progress')
   OR (NEW.reason_code <> 'NOT_READY' AND NEW.status <> 'Queued')
   OR (NEW.reason_code = 'NOT_READY' AND (NEW.started_at IS DISTINCT FROM NEW.created_at
     OR NEW.started_by_actor_id IS DISTINCT FROM NEW.created_by_actor_id)) THEN
  RAISE EXCEPTION 'kitchen rework starts in its first state' USING ERRCODE='23514';
 END IF;
 SELECT count(*)::integer INTO prior_count FROM rms_kitchen.kitchen_rework_item r
  WHERE r.brand_id=NEW.brand_id AND r.store_id=NEW.store_id
    AND r.original_kitchen_work_item_id=NEW.original_kitchen_work_item_id;
 IF NEW.rework_ordinal <> prior_count + 1 THEN
  RAISE EXCEPTION 'kitchen rework ordinal must follow the previous rework' USING ERRCODE='23514';
 END IF;
 IF NEW.reason_code = 'NOT_READY' THEN
  SELECT GREATEST(original.updated_at, max(r.ready_at)) INTO finished_at
    FROM rms_kitchen.kitchen_order_item_ready_result r
   WHERE r.brand_id=NEW.brand_id AND r.store_id=NEW.store_id AND r.kitchen_ticket_id=NEW.kitchen_ticket_id
     AND r.order_item_id=NEW.order_item_id;
  IF NEW.created_at > COALESCE(finished_at, original.updated_at) + interval '2 minutes' THEN
   RAISE EXCEPTION 'a dish marked done by mistake is corrected within two minutes' USING ERRCODE='23514';
  END IF;
  IF EXISTS (
   SELECT 1 FROM rms_kitchen.kitchen_rework_item r
    WHERE r.brand_id=NEW.brand_id AND r.store_id=NEW.store_id
      AND r.original_kitchen_work_item_id=NEW.original_kitchen_work_item_id
      AND r.reason_code='NOT_READY' AND r.status <> 'Completed'
  ) THEN
   RAISE EXCEPTION 'this dish is already back in progress' USING ERRCODE='23514';
  END IF;
 END IF;
 RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION rms_kitchen.check_kitchen_rework_item_insert() FROM PUBLIC;
CREATE TRIGGER kitchen_rework_item_insert_check BEFORE INSERT ON rms_kitchen.kitchen_rework_item
 FOR EACH ROW EXECUTE FUNCTION rms_kitchen.check_kitchen_rework_item_insert();

-- Identity, reason and creation facts never change; status only moves forward one step at a time.
CREATE FUNCTION rms_kitchen.enforce_kitchen_rework_item_transition() RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog
AS $$
BEGIN
 IF OLD.kitchen_rework_item_id IS DISTINCT FROM NEW.kitchen_rework_item_id
   OR OLD.brand_id IS DISTINCT FROM NEW.brand_id
   OR OLD.store_id IS DISTINCT FROM NEW.store_id
   OR OLD.kitchen_ticket_id IS DISTINCT FROM NEW.kitchen_ticket_id
   OR OLD.original_kitchen_work_item_id IS DISTINCT FROM NEW.original_kitchen_work_item_id
   OR OLD.order_id IS DISTINCT FROM NEW.order_id
   OR OLD.order_batch_id IS DISTINCT FROM NEW.order_batch_id
   OR OLD.order_item_id IS DISTINCT FROM NEW.order_item_id
   OR OLD.rework_ordinal IS DISTINCT FROM NEW.rework_ordinal
   OR OLD.reason_code IS DISTINCT FROM NEW.reason_code
   OR OLD.reason_note IS DISTINCT FROM NEW.reason_note
   OR OLD.quantity IS DISTINCT FROM NEW.quantity
   OR OLD.waste_applies IS DISTINCT FROM NEW.waste_applies
   OR OLD.created_operation_id IS DISTINCT FROM NEW.created_operation_id
   OR OLD.created_by_actor_id IS DISTINCT FROM NEW.created_by_actor_id
   OR OLD.created_at IS DISTINCT FROM NEW.created_at
   OR OLD.event_id IS DISTINCT FROM NEW.event_id
   OR NEW.version <> OLD.version + 1
   OR NOT (
    (OLD.status = 'Queued' AND NEW.status = 'In Progress')
    OR (OLD.status = 'In Progress' AND NEW.status = 'Completed'
     AND OLD.started_at IS NOT DISTINCT FROM NEW.started_at
     AND OLD.started_by_actor_id IS NOT DISTINCT FROM NEW.started_by_actor_id)
   ) THEN
  RAISE EXCEPTION 'kitchen rework only moves forward' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION rms_kitchen.enforce_kitchen_rework_item_transition() FROM PUBLIC;
CREATE TRIGGER kitchen_rework_item_transition_check BEFORE UPDATE ON rms_kitchen.kitchen_rework_item
 FOR EACH ROW EXECUTE FUNCTION rms_kitchen.enforce_kitchen_rework_item_transition();

-- Every committed rework state is explained by its operation row (same version, actor and time).
CREATE FUNCTION rms_kitchen.require_kitchen_rework_operation() RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog
AS $$
DECLARE
 expected_at timestamptz := NEW.created_at;
 expected_actor uuid := NEW.created_by_actor_id;
BEGIN
 IF NEW.status = 'Completed' THEN
  expected_at := NEW.completed_at;
  expected_actor := NEW.completed_by_actor_id;
 ELSIF NEW.status = 'In Progress' AND NEW.version > 1 THEN
  expected_at := NEW.started_at;
  expected_actor := NEW.started_by_actor_id;
 END IF;
 IF NOT EXISTS (
  SELECT 1 FROM rms_kitchen.kitchen_rework_operation o
   WHERE o.brand_id=NEW.brand_id AND o.store_id=NEW.store_id
     AND o.kitchen_rework_item_id=NEW.kitchen_rework_item_id AND o.result_version=NEW.version
     AND o.after_status=NEW.status AND o.occurred_at=expected_at AND o.actor_id=expected_actor
 ) THEN
  RAISE EXCEPTION 'kitchen rework change needs its operation record' USING ERRCODE='23514';
 END IF;
 RETURN NULL;
END;
$$;
REVOKE ALL ON FUNCTION rms_kitchen.require_kitchen_rework_operation() FROM PUBLIC;
CREATE CONSTRAINT TRIGGER kitchen_rework_item_operation_record_trigger
 AFTER INSERT OR UPDATE ON rms_kitchen.kitchen_rework_item
 DEFERRABLE INITIALLY DEFERRED
 FOR EACH ROW EXECUTE FUNCTION rms_kitchen.require_kitchen_rework_operation();

CREATE TRIGGER kitchen_rework_item_no_delete BEFORE DELETE ON rms_kitchen.kitchen_rework_item
 FOR EACH ROW EXECUTE FUNCTION rms_kitchen.reject_kitchen_rework_mutation();
CREATE TRIGGER kitchen_rework_item_no_truncate BEFORE TRUNCATE ON rms_kitchen.kitchen_rework_item
 FOR EACH STATEMENT EXECUTE FUNCTION rms_kitchen.reject_kitchen_rework_mutation();
CREATE TRIGGER kitchen_rework_operation_no_mutation BEFORE UPDATE OR DELETE ON rms_kitchen.kitchen_rework_operation
 FOR EACH ROW EXECUTE FUNCTION rms_kitchen.reject_kitchen_rework_mutation();
CREATE TRIGGER kitchen_rework_operation_no_truncate BEFORE TRUNCATE ON rms_kitchen.kitchen_rework_operation
 FOR EACH STATEMENT EXECUTE FUNCTION rms_kitchen.reject_kitchen_rework_mutation();

ALTER TABLE rms_kitchen.kitchen_rework_item ENABLE ROW LEVEL SECURITY;
ALTER TABLE rms_kitchen.kitchen_rework_item FORCE ROW LEVEL SECURITY;
CREATE POLICY kitchen_rework_item_scope ON rms_kitchen.kitchen_rework_item
 USING (brand_id=platform_helpers.current_brand_id() AND store_id=platform_helpers.current_store_id())
 WITH CHECK (brand_id=platform_helpers.current_brand_id() AND store_id=platform_helpers.current_store_id());
REVOKE ALL ON TABLE rms_kitchen.kitchen_rework_item FROM PUBLIC;
ALTER TABLE rms_kitchen.kitchen_rework_operation ENABLE ROW LEVEL SECURITY;
ALTER TABLE rms_kitchen.kitchen_rework_operation FORCE ROW LEVEL SECURITY;
CREATE POLICY kitchen_rework_operation_scope ON rms_kitchen.kitchen_rework_operation
 USING (brand_id=platform_helpers.current_brand_id() AND store_id=platform_helpers.current_store_id())
 WITH CHECK (brand_id=platform_helpers.current_brand_id() AND store_id=platform_helpers.current_store_id());
REVOKE ALL ON TABLE rms_kitchen.kitchen_rework_operation FROM PUBLIC;
