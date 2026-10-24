-- bop-rms-migration: 1
-- owner: @rms/kitchen
-- schema: rms_kitchen
-- phase: expand
-- risk: medium
-- transaction: required
-- lock-timeout-ms: 5000
-- statement-timeout-ms: 60000
-- recovery: forward-fix
-- WP-2423 Q6: store staff cancel a paid batch before the kitchen starts it. Every work item of
-- the batch must still be Queued (accepted counts as not started) or Held, and no Start may have
-- been recorded. Each cancelled item keeps one append-only row that explains its Cancelled state;
-- the ticket advances one version per item in item order, so replay stays sequential.
CREATE FUNCTION rms_kitchen.reject_kitchen_work_cancellation_mutation() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
BEGIN
 RAISE EXCEPTION 'append-only kitchen work cancellation' USING ERRCODE='55000';
END;
$$;
REVOKE ALL ON FUNCTION rms_kitchen.reject_kitchen_work_cancellation_mutation() FROM PUBLIC;

CREATE TABLE rms_kitchen.kitchen_work_cancellation (
 kitchen_work_cancellation_id platform_helpers.uuid_v7 NOT NULL,
 operation_id platform_helpers.uuid_v7 NOT NULL,
 brand_id platform_helpers.uuid_v7 NOT NULL,
 store_id platform_helpers.uuid_v7 NOT NULL,
 kitchen_ticket_id platform_helpers.uuid_v7 NOT NULL,
 kitchen_work_item_id platform_helpers.uuid_v7 NOT NULL,
 order_id platform_helpers.uuid_v7 NOT NULL,
 order_batch_id platform_helpers.uuid_v7 NOT NULL,
 order_item_id platform_helpers.uuid_v7 NOT NULL,
 before_status text NOT NULL CHECK (before_status IN ('Queued','Held')),
 expected_ticket_version bigint NOT NULL CHECK (expected_ticket_version > 0),
 result_ticket_version bigint NOT NULL,
 expected_work_item_version bigint NOT NULL CHECK (expected_work_item_version > 0),
 result_work_item_version bigint NOT NULL,
 actor_type text NOT NULL CHECK (actor_type = 'User'),
 actor_id platform_helpers.uuid_v7 NOT NULL,
 reason_code text NOT NULL CHECK (reason_code = 'ORDER_CANCELLED_BEFORE_PREPARATION'),
 order_cancellation_id platform_helpers.uuid_v7 NOT NULL,
 evidence_digest text NOT NULL CHECK (evidence_digest ~ '^sha256:[0-9a-f]{64}$'),
 event_id platform_helpers.uuid_v7 NOT NULL,
 audit_id platform_helpers.uuid_v7 NOT NULL,
 cancelled_at timestamptz NOT NULL CHECK (isfinite(cancelled_at) AND cancelled_at=date_trunc('milliseconds',cancelled_at)),
 PRIMARY KEY (brand_id,store_id,kitchen_work_cancellation_id),
 UNIQUE (brand_id,store_id,kitchen_work_item_id),
 UNIQUE (brand_id,store_id,kitchen_ticket_id,result_ticket_version),
 FOREIGN KEY (brand_id,store_id,kitchen_ticket_id,kitchen_work_item_id,order_item_id)
  REFERENCES rms_kitchen.kitchen_work_item (brand_id,store_id,kitchen_ticket_id,kitchen_work_item_id,order_item_id),
 CHECK (result_ticket_version = expected_ticket_version + 1),
 CHECK (result_work_item_version = expected_work_item_version + 1),
 CHECK (
  kitchen_work_cancellation_id <> operation_id
  AND kitchen_work_cancellation_id <> event_id
  AND kitchen_work_cancellation_id <> audit_id
  AND kitchen_work_cancellation_id <> order_cancellation_id
  AND operation_id <> event_id
  AND operation_id <> audit_id
  AND operation_id <> order_cancellation_id
  AND event_id <> audit_id
  AND event_id <> order_cancellation_id
  AND audit_id <> order_cancellation_id
 )
);
CREATE INDEX kitchen_work_cancellation_operation_idx
 ON rms_kitchen.kitchen_work_cancellation (brand_id,store_id,operation_id);
CREATE INDEX kitchen_work_cancellation_batch_idx
 ON rms_kitchen.kitchen_work_cancellation (brand_id,store_id,order_batch_id);

-- The row is written after the item and ticket updates in the same transaction: the item must be
-- Cancelled at exactly this version, the ticket must be at this version, and nothing was started.
CREATE FUNCTION rms_kitchen.check_kitchen_work_cancellation() RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog
AS $$
BEGIN
 IF NOT EXISTS (
  SELECT 1 FROM rms_kitchen.kitchen_work_item w
  WHERE w.brand_id=NEW.brand_id AND w.store_id=NEW.store_id AND w.kitchen_ticket_id=NEW.kitchen_ticket_id
   AND w.kitchen_work_item_id=NEW.kitchen_work_item_id AND w.order_item_id=NEW.order_item_id
   AND w.order_id=NEW.order_id AND w.order_batch_id=NEW.order_batch_id
   AND w.status='Cancelled' AND w.version=NEW.result_work_item_version
   AND w.updated_at=NEW.cancelled_at AND w.updated_by_actor_type='User' AND w.updated_by_actor_id=NEW.actor_id
 ) OR NOT EXISTS (
  SELECT 1 FROM rms_kitchen.kitchen_ticket t
  WHERE t.brand_id=NEW.brand_id AND t.store_id=NEW.store_id AND t.kitchen_ticket_id=NEW.kitchen_ticket_id
   AND t.order_id=NEW.order_id AND t.order_batch_id=NEW.order_batch_id AND t.status='Open'
   AND t.aggregate_version=NEW.result_ticket_version AND t.updated_at=NEW.cancelled_at
 ) THEN
  RAISE EXCEPTION 'kitchen work cancellation does not match the cancelled work item' USING ERRCODE='23514';
 END IF;
 IF EXISTS (
  SELECT 1 FROM rms_kitchen.kitchen_work_lifecycle_operation o
  WHERE o.brand_id=NEW.brand_id AND o.store_id=NEW.store_id AND o.kitchen_ticket_id=NEW.kitchen_ticket_id
   AND o.kitchen_work_item_id=NEW.kitchen_work_item_id AND o.action_code='KITCHEN_WORK_ITEM_STARTED'
 ) THEN
  RAISE EXCEPTION 'started kitchen work cannot be cancelled' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION rms_kitchen.check_kitchen_work_cancellation() FROM PUBLIC;
CREATE TRIGGER kitchen_work_cancellation_check BEFORE INSERT ON rms_kitchen.kitchen_work_cancellation
 FOR EACH ROW EXECUTE FUNCTION rms_kitchen.check_kitchen_work_cancellation();

-- A Cancelled work item is terminal, may only be entered from Queued or Held, and must be
-- explained by its cancellation row when the transaction commits.
CREATE FUNCTION rms_kitchen.enforce_kitchen_work_item_cancellation_transition() RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog
AS $$
BEGIN
 IF OLD.status = 'Cancelled' THEN
  RAISE EXCEPTION 'cancelled kitchen work is terminal' USING ERRCODE='23514';
 END IF;
 IF NEW.status = 'Cancelled' AND OLD.status NOT IN ('Queued','Held') THEN
  RAISE EXCEPTION 'only kitchen work that has not started can be cancelled' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION rms_kitchen.enforce_kitchen_work_item_cancellation_transition() FROM PUBLIC;
CREATE TRIGGER kitchen_work_item_cancellation_transition_trigger
 BEFORE UPDATE ON rms_kitchen.kitchen_work_item
 FOR EACH ROW EXECUTE FUNCTION rms_kitchen.enforce_kitchen_work_item_cancellation_transition();

CREATE FUNCTION rms_kitchen.require_kitchen_work_cancellation_record() RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog
AS $$
BEGIN
 IF NOT EXISTS (
  SELECT 1 FROM rms_kitchen.kitchen_work_cancellation c
  WHERE c.brand_id=NEW.brand_id AND c.store_id=NEW.store_id AND c.kitchen_ticket_id=NEW.kitchen_ticket_id
   AND c.kitchen_work_item_id=NEW.kitchen_work_item_id AND c.result_work_item_version=NEW.version
 ) THEN
  RAISE EXCEPTION 'cancelled kitchen work needs its cancellation record' USING ERRCODE='23514';
 END IF;
 RETURN NULL;
END;
$$;
REVOKE ALL ON FUNCTION rms_kitchen.require_kitchen_work_cancellation_record() FROM PUBLIC;
CREATE CONSTRAINT TRIGGER kitchen_work_item_cancellation_record_trigger
 AFTER UPDATE ON rms_kitchen.kitchen_work_item
 DEFERRABLE INITIALLY DEFERRED
 FOR EACH ROW WHEN (NEW.status = 'Cancelled')
 EXECUTE FUNCTION rms_kitchen.require_kitchen_work_cancellation_record();

-- No lifecycle operation (accept, start, completion or ready) may be recorded for cancelled work.
-- Definer rights: lifecycle writers need not read work items; the caller's Store scope still applies.
CREATE FUNCTION rms_kitchen.reject_kitchen_lifecycle_for_cancelled_work() RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
BEGIN
 IF EXISTS (
  SELECT 1 FROM rms_kitchen.kitchen_work_item w
  WHERE w.brand_id=NEW.brand_id AND w.store_id=NEW.store_id AND w.kitchen_ticket_id=NEW.kitchen_ticket_id
   AND w.status='Cancelled'
   AND (w.kitchen_work_item_id=NEW.kitchen_work_item_id OR w.order_item_id=NEW.order_item_id)
 ) THEN
  RAISE EXCEPTION 'cancelled kitchen work cannot change' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION rms_kitchen.reject_kitchen_lifecycle_for_cancelled_work() FROM PUBLIC;
CREATE TRIGGER kitchen_work_lifecycle_operation_cancelled_work_trigger
 BEFORE INSERT ON rms_kitchen.kitchen_work_lifecycle_operation
 FOR EACH ROW EXECUTE FUNCTION rms_kitchen.reject_kitchen_lifecycle_for_cancelled_work();

CREATE TRIGGER kitchen_work_cancellation_no_mutation BEFORE UPDATE OR DELETE ON rms_kitchen.kitchen_work_cancellation
 FOR EACH ROW EXECUTE FUNCTION rms_kitchen.reject_kitchen_work_cancellation_mutation();
CREATE TRIGGER kitchen_work_cancellation_no_truncate BEFORE TRUNCATE ON rms_kitchen.kitchen_work_cancellation
 FOR EACH STATEMENT EXECUTE FUNCTION rms_kitchen.reject_kitchen_work_cancellation_mutation();
ALTER TABLE rms_kitchen.kitchen_work_cancellation ENABLE ROW LEVEL SECURITY;
ALTER TABLE rms_kitchen.kitchen_work_cancellation FORCE ROW LEVEL SECURITY;
CREATE POLICY kitchen_work_cancellation_scope ON rms_kitchen.kitchen_work_cancellation
 USING (brand_id=platform_helpers.current_brand_id() AND store_id=platform_helpers.current_store_id())
 WITH CHECK (brand_id=platform_helpers.current_brand_id() AND store_id=platform_helpers.current_store_id());
REVOKE ALL ON TABLE rms_kitchen.kitchen_work_cancellation FROM PUBLIC;
