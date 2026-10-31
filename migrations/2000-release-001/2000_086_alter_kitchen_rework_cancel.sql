-- bop-rms-migration: 1
-- owner: @rms/kitchen
-- schema: rms_kitchen
-- phase: expand
-- risk: medium
-- transaction: required
-- lock-timeout-ms: 5000
-- statement-timeout-ms: 60000
-- recovery: forward-fix
-- WP-2423 (2026-10-18, DEC-KITCHEN-REWORK cancel): an open remake (Queued or In Progress) can be
-- cancelled when it will not be made after all: the guest no longer wants it (GUEST_DECLINED), or
-- it was opened on the wrong dish or by accident (OPENED_BY_MISTAKE). Cancelled is a final state
-- reached in one step from an open state; the remake keeps its creation and start facts and gains
-- who cancelled it, when, why and the KitchenReworkCancelled event it published. A cancelled
-- remake is no longer open: it leaves the board, pickup, order and table screens, and a dish whose
-- "not ready yet" correction was cancelled may be corrected again. Every change is still explained
-- by one append-only operation row (new action Cancel). Existing rows are never Cancelled and
-- satisfy every new constraint. No new table or grant (api already has SELECT/INSERT/UPDATE on
-- kitchen_rework_item and SELECT/INSERT on kitchen_rework_operation).
ALTER TABLE rms_kitchen.kitchen_rework_item
 ADD COLUMN cancelled_by_actor_id platform_helpers.uuid_v7,
 ADD COLUMN cancelled_at timestamptz,
 ADD COLUMN cancel_reason_code text CHECK (
  cancel_reason_code IS NULL OR cancel_reason_code IN ('GUEST_DECLINED','OPENED_BY_MISTAKE')
 ),
 ADD COLUMN cancel_event_id platform_helpers.uuid_v7;
ALTER TABLE rms_kitchen.kitchen_rework_item
 ADD CONSTRAINT kitchen_rework_item_cancel_event_unique UNIQUE (brand_id,store_id,cancel_event_id);
ALTER TABLE rms_kitchen.kitchen_rework_item DROP CONSTRAINT kitchen_rework_item_status_check;
ALTER TABLE rms_kitchen.kitchen_rework_item
 ADD CONSTRAINT kitchen_rework_item_status_check
 CHECK (status IN ('Queued','In Progress','Completed','Cancelled'));
ALTER TABLE rms_kitchen.kitchen_rework_item DROP CONSTRAINT kitchen_rework_item_time_check;
ALTER TABLE rms_kitchen.kitchen_rework_item
 ADD CONSTRAINT kitchen_rework_item_time_check CHECK (
  isfinite(created_at) AND created_at = date_trunc('milliseconds',created_at)
  AND (started_at IS NULL OR (isfinite(started_at) AND started_at >= created_at))
  AND (completed_at IS NULL OR (started_at IS NOT NULL AND completed_at >= started_at))
  AND (cancelled_at IS NULL OR (isfinite(cancelled_at)
   AND cancelled_at = date_trunc('milliseconds',cancelled_at)
   AND cancelled_at >= COALESCE(started_at,created_at)))
 );
ALTER TABLE rms_kitchen.kitchen_rework_item DROP CONSTRAINT kitchen_rework_item_state_check;
ALTER TABLE rms_kitchen.kitchen_rework_item
 ADD CONSTRAINT kitchen_rework_item_state_check CHECK (
  ((status = 'Queued' AND started_at IS NULL AND started_by_actor_id IS NULL
    AND completed_at IS NULL AND completed_by_actor_id IS NULL)
   OR (status = 'In Progress' AND started_at IS NOT NULL AND started_by_actor_id IS NOT NULL
    AND completed_at IS NULL AND completed_by_actor_id IS NULL)
   OR (status = 'Completed' AND started_at IS NOT NULL AND started_by_actor_id IS NOT NULL
    AND completed_at IS NOT NULL AND completed_by_actor_id IS NOT NULL)
   OR (status = 'Cancelled' AND (started_at IS NULL) = (started_by_actor_id IS NULL)
    AND completed_at IS NULL AND completed_by_actor_id IS NULL))
  AND (status = 'Cancelled') = (cancelled_at IS NOT NULL)
  AND (status = 'Cancelled') = (cancelled_by_actor_id IS NOT NULL)
  AND (status = 'Cancelled') = (cancel_reason_code IS NOT NULL)
  AND (status = 'Cancelled') = (cancel_event_id IS NOT NULL)
 );
ALTER TABLE rms_kitchen.kitchen_rework_item
 ADD CONSTRAINT kitchen_rework_item_cancel_event_check CHECK (
  cancel_event_id IS NULL
  OR (cancel_event_id <> event_id AND cancel_event_id <> kitchen_rework_item_id
   AND cancel_event_id <> created_operation_id)
 );
DROP INDEX rms_kitchen.kitchen_rework_item_open_idx;
CREATE INDEX kitchen_rework_item_open_idx
 ON rms_kitchen.kitchen_rework_item (brand_id,store_id,created_at)
 WHERE status IN ('Queued','In Progress');

ALTER TABLE rms_kitchen.kitchen_rework_operation DROP CONSTRAINT kitchen_rework_operation_action_check;
ALTER TABLE rms_kitchen.kitchen_rework_operation
 ADD CONSTRAINT kitchen_rework_operation_action_check
 CHECK (action IN ('Create','Start','Complete','Cancel'));
ALTER TABLE rms_kitchen.kitchen_rework_operation
 DROP CONSTRAINT kitchen_rework_operation_after_status_check;
ALTER TABLE rms_kitchen.kitchen_rework_operation
 ADD CONSTRAINT kitchen_rework_operation_after_status_check
 CHECK (after_status IN ('Queued','In Progress','Completed','Cancelled'));
ALTER TABLE rms_kitchen.kitchen_rework_operation DROP CONSTRAINT kitchen_rework_operation_check;
ALTER TABLE rms_kitchen.kitchen_rework_operation
 ADD CONSTRAINT kitchen_rework_operation_check CHECK (
  (action = 'Create' AND before_status IS NULL AND result_version = 1)
  OR (action = 'Start' AND before_status = 'Queued' AND after_status = 'In Progress')
  OR (action = 'Complete' AND before_status = 'In Progress' AND after_status = 'Completed')
  OR (action = 'Cancel' AND before_status IN ('Queued','In Progress') AND after_status = 'Cancelled')
 );

-- A dish is back in progress at most once at a time: a cancelled "not ready yet" correction is no
-- longer open (otherwise unchanged from 2000_046).
CREATE OR REPLACE FUNCTION rms_kitchen.check_kitchen_rework_item_insert() RETURNS trigger
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
      AND r.reason_code='NOT_READY' AND r.status IN ('Queued','In Progress')
  ) THEN
   RAISE EXCEPTION 'this dish is already back in progress' USING ERRCODE='23514';
  END IF;
 END IF;
 RETURN NEW;
END;
$$;

-- Identity, reason and creation facts never change; status only moves forward one step at a time,
-- and an open remake may be cancelled once (cancellation facts are set only by that step).
CREATE OR REPLACE FUNCTION rms_kitchen.enforce_kitchen_rework_item_transition() RETURNS trigger
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
    (OLD.status = 'Queued' AND NEW.status = 'In Progress' AND NEW.cancelled_at IS NULL)
    OR (OLD.status = 'In Progress' AND NEW.status = 'Completed' AND NEW.cancelled_at IS NULL
     AND OLD.started_at IS NOT DISTINCT FROM NEW.started_at
     AND OLD.started_by_actor_id IS NOT DISTINCT FROM NEW.started_by_actor_id)
    OR (OLD.status IN ('Queued','In Progress') AND NEW.status = 'Cancelled'
     AND OLD.started_at IS NOT DISTINCT FROM NEW.started_at
     AND OLD.started_by_actor_id IS NOT DISTINCT FROM NEW.started_by_actor_id)
   ) THEN
  RAISE EXCEPTION 'kitchen rework only moves forward' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END;
$$;

-- Every committed rework state is explained by its operation row (same version, actor and time).
CREATE OR REPLACE FUNCTION rms_kitchen.require_kitchen_rework_operation() RETURNS trigger
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
 ELSIF NEW.status = 'Cancelled' THEN
  expected_at := NEW.cancelled_at;
  expected_actor := NEW.cancelled_by_actor_id;
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
