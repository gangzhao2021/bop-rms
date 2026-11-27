-- bop-rms-migration: 1
-- owner: @rms/kitchen
-- schema: rms_kitchen
-- phase: expand
-- risk: medium
-- transaction: required
-- lock-timeout-ms: 5000
-- statement-timeout-ms: 60000
-- recovery: forward-fix
-- WP-2423 (Handoff Section 26.1/26.4, DEC-KITCHEN-STALE-TICKETS): a kitchen ticket left open from an
-- earlier business day is closed by a manager with a reason (already served, cancelled elsewhere,
-- not made). The closure is one append-only row per ticket; the work items keep the state the
-- kitchen recorded. A closed ticket leaves the live board and no later kitchen step (accept, start,
-- completion, ready, remake) may be recorded for it. Ordering, Payment and refunds are unchanged.
CREATE FUNCTION rms_kitchen.reject_kitchen_ticket_closure_mutation() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
BEGIN
 RAISE EXCEPTION 'append-only kitchen ticket closure' USING ERRCODE='55000';
END;
$$;
REVOKE ALL ON FUNCTION rms_kitchen.reject_kitchen_ticket_closure_mutation() FROM PUBLIC;

CREATE TABLE rms_kitchen.kitchen_ticket_closure (
 kitchen_ticket_closure_id platform_helpers.uuid_v7 NOT NULL,
 brand_id platform_helpers.uuid_v7 NOT NULL,
 store_id platform_helpers.uuid_v7 NOT NULL,
 kitchen_ticket_id platform_helpers.uuid_v7 NOT NULL,
 order_id platform_helpers.uuid_v7 NOT NULL,
 order_batch_id platform_helpers.uuid_v7 NOT NULL,
 ticket_version bigint NOT NULL CHECK (ticket_version > 0),
 reason_code text NOT NULL CHECK (
  reason_code IN ('ALREADY_SERVED','CANCELLED_ELSEWHERE','NOT_MADE_ABANDONED')
 ),
 food_made boolean NOT NULL,
 order_business_date date NOT NULL,
 closing_business_date date NOT NULL,
 open_work_item_count integer NOT NULL CHECK (open_work_item_count BETWEEN 0 AND 100),
 open_rework_count integer NOT NULL CHECK (open_rework_count BETWEEN 0 AND 2000),
 evidence_digest text NOT NULL CHECK (evidence_digest ~ '^sha256:[0-9a-f]{64}$'),
 actor_type text NOT NULL CHECK (actor_type = 'User'),
 actor_id platform_helpers.uuid_v7 NOT NULL,
 idempotency_key platform_helpers.uuid_v7 NOT NULL,
 request_digest text NOT NULL CHECK (request_digest ~ '^sha256:[0-9a-f]{64}$'),
 correlation_id platform_helpers.uuid_v7 NOT NULL,
 audit_id platform_helpers.uuid_v7 NOT NULL,
 event_id platform_helpers.uuid_v7 NOT NULL,
 closed_at timestamptz NOT NULL CHECK (isfinite(closed_at) AND closed_at=date_trunc('milliseconds',closed_at)),
 PRIMARY KEY (brand_id,store_id,kitchen_ticket_closure_id),
 UNIQUE (brand_id,store_id,kitchen_ticket_id),
 UNIQUE (brand_id,store_id,actor_id,idempotency_key),
 UNIQUE (brand_id,store_id,audit_id),
 UNIQUE (brand_id,store_id,event_id),
 FOREIGN KEY (brand_id,store_id,kitchen_ticket_id)
  REFERENCES rms_kitchen.kitchen_ticket (brand_id,store_id,kitchen_ticket_id),
 CONSTRAINT kitchen_ticket_closure_food_made_check CHECK (food_made = (reason_code = 'ALREADY_SERVED')),
 -- Only an earlier business day's ticket is closed this way; today's work stays on the board.
 CONSTRAINT kitchen_ticket_closure_earlier_day_check CHECK (order_business_date < closing_business_date),
 CONSTRAINT kitchen_ticket_closure_open_work_check CHECK (open_work_item_count + open_rework_count > 0),
 CHECK (
  kitchen_ticket_closure_id <> audit_id
  AND kitchen_ticket_closure_id <> event_id
  AND audit_id <> event_id
 )
);

-- The ticket closed is the one locked by the command: same Order, batch and current version.
CREATE FUNCTION rms_kitchen.check_kitchen_ticket_closure() RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog
AS $$
BEGIN
 IF NOT EXISTS (
  SELECT 1 FROM rms_kitchen.kitchen_ticket t
   WHERE t.brand_id=NEW.brand_id AND t.store_id=NEW.store_id AND t.kitchen_ticket_id=NEW.kitchen_ticket_id
     AND t.order_id=NEW.order_id AND t.order_batch_id=NEW.order_batch_id AND t.status='Open'
     AND t.aggregate_version=NEW.ticket_version AND t.updated_at <= NEW.closed_at
 ) THEN
  RAISE EXCEPTION 'kitchen ticket closure does not match the ticket' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION rms_kitchen.check_kitchen_ticket_closure() FROM PUBLIC;
CREATE TRIGGER kitchen_ticket_closure_check BEFORE INSERT ON rms_kitchen.kitchen_ticket_closure
 FOR EACH ROW EXECUTE FUNCTION rms_kitchen.check_kitchen_ticket_closure();

-- No kitchen step may be recorded for a closed ticket. Definer rights: the writers need not read
-- closures; the caller's Store scope still applies through the policies.
CREATE FUNCTION rms_kitchen.reject_kitchen_work_for_closed_ticket() RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
BEGIN
 IF EXISTS (
  SELECT 1 FROM rms_kitchen.kitchen_ticket_closure c
   WHERE c.brand_id=NEW.brand_id AND c.store_id=NEW.store_id AND c.kitchen_ticket_id=NEW.kitchen_ticket_id
 ) THEN
  RAISE EXCEPTION 'a closed kitchen ticket cannot change' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION rms_kitchen.reject_kitchen_work_for_closed_ticket() FROM PUBLIC;
CREATE TRIGGER kitchen_work_lifecycle_operation_closed_ticket_trigger
 BEFORE INSERT ON rms_kitchen.kitchen_work_lifecycle_operation
 FOR EACH ROW EXECUTE FUNCTION rms_kitchen.reject_kitchen_work_for_closed_ticket();
CREATE TRIGGER kitchen_rework_item_closed_ticket_trigger
 BEFORE INSERT OR UPDATE ON rms_kitchen.kitchen_rework_item
 FOR EACH ROW EXECUTE FUNCTION rms_kitchen.reject_kitchen_work_for_closed_ticket();

CREATE TRIGGER kitchen_ticket_closure_no_mutation BEFORE UPDATE OR DELETE ON rms_kitchen.kitchen_ticket_closure
 FOR EACH ROW EXECUTE FUNCTION rms_kitchen.reject_kitchen_ticket_closure_mutation();
CREATE TRIGGER kitchen_ticket_closure_no_truncate BEFORE TRUNCATE ON rms_kitchen.kitchen_ticket_closure
 FOR EACH STATEMENT EXECUTE FUNCTION rms_kitchen.reject_kitchen_ticket_closure_mutation();
ALTER TABLE rms_kitchen.kitchen_ticket_closure ENABLE ROW LEVEL SECURITY;
ALTER TABLE rms_kitchen.kitchen_ticket_closure FORCE ROW LEVEL SECURITY;
CREATE POLICY kitchen_ticket_closure_scope ON rms_kitchen.kitchen_ticket_closure
 USING (brand_id=platform_helpers.current_brand_id() AND store_id=platform_helpers.current_store_id())
 WITH CHECK (brand_id=platform_helpers.current_brand_id() AND store_id=platform_helpers.current_store_id());
REVOKE ALL ON TABLE rms_kitchen.kitchen_ticket_closure FROM PUBLIC;
