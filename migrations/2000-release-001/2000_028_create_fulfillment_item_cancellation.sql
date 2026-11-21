-- bop-rms-migration: 1
-- owner: @rms/fulfillment
-- schema: rms_fulfillment
-- phase: expand
-- risk: medium
-- transaction: required
-- lock-timeout-ms: 5000
-- statement-timeout-ms: 60000
-- recovery: forward-fix
-- WP-2423 Q6 step 2: store staff cancel some lines of a paid pickup order before the kitchen starts
-- them. Each cancelled line keeps one append-only fact that advances the pickup aggregate by one
-- version, in the same version sequence as the ready facts. A cancelled line no longer counts
-- toward Ready, the pickup proof or the handoff; when every remaining line was already ready the
-- last cancellation fact moves the pickup to Ready. Cancellation is only possible while the pickup
-- is Pending and the line has no ready result.
CREATE TABLE rms_fulfillment.fulfillment_item_cancellation (
  fulfillment_item_cancellation_id platform_helpers.uuid_v7 NOT NULL,
  operation_id platform_helpers.uuid_v7 NOT NULL,
  brand_id platform_helpers.uuid_v7 NOT NULL,
  store_id platform_helpers.uuid_v7 NOT NULL,
  fulfillment_id platform_helpers.uuid_v7 NOT NULL,
  fulfillment_item_id platform_helpers.uuid_v7 NOT NULL,
  order_id platform_helpers.uuid_v7 NOT NULL,
  order_batch_id platform_helpers.uuid_v7 NOT NULL,
  order_item_id platform_helpers.uuid_v7 NOT NULL,
  order_cancellation_id platform_helpers.uuid_v7 NOT NULL,
  actor_type text NOT NULL CHECK (actor_type = 'User'),
  actor_id platform_helpers.uuid_v7 NOT NULL,
  reason_code text NOT NULL CHECK (reason_code = 'ORDER_CANCELLED_BEFORE_PREPARATION'),
  aggregate_version_before bigint NOT NULL CHECK (aggregate_version_before > 0),
  aggregate_version_after bigint NOT NULL,
  phase_before text NOT NULL CHECK (phase_before = 'Pending'),
  phase_after text NOT NULL CHECK (phase_after IN ('Pending', 'Ready')),
  evidence_digest text NOT NULL CHECK (evidence_digest ~ '^sha256:[0-9a-f]{64}$'),
  audit_id platform_helpers.uuid_v7 NOT NULL,
  cancelled_at timestamp with time zone NOT NULL
    CHECK (isfinite(cancelled_at) AND cancelled_at = date_trunc('milliseconds', cancelled_at)),
  data_classification text NOT NULL CHECK (data_classification = 'IndirectIdentifier'),
  CONSTRAINT fulfillment_item_cancellation_pkey
    PRIMARY KEY (brand_id, store_id, fulfillment_item_cancellation_id),
  CONSTRAINT fulfillment_item_cancellation_parent_fkey
    FOREIGN KEY (brand_id, store_id, fulfillment_id)
    REFERENCES rms_fulfillment.fulfillment (brand_id, store_id, fulfillment_id),
  CONSTRAINT fulfillment_item_cancellation_item_fkey
    FOREIGN KEY (brand_id, store_id, fulfillment_item_id)
    REFERENCES rms_fulfillment.fulfillment_item (brand_id, store_id, fulfillment_item_id),
  CONSTRAINT fulfillment_item_cancellation_item_unique
    UNIQUE (brand_id, store_id, fulfillment_item_id),
  CONSTRAINT fulfillment_item_cancellation_version_unique
    UNIQUE (brand_id, store_id, fulfillment_id, aggregate_version_after),
  CONSTRAINT fulfillment_item_cancellation_version_check
    CHECK (aggregate_version_after = aggregate_version_before + 1),
  CONSTRAINT fulfillment_item_cancellation_distinct_check CHECK (
    fulfillment_item_cancellation_id::uuid <> operation_id::uuid
    AND fulfillment_item_cancellation_id::uuid <> audit_id::uuid
    AND fulfillment_item_cancellation_id::uuid <> order_cancellation_id::uuid
    AND operation_id::uuid <> audit_id::uuid
    AND operation_id::uuid <> order_cancellation_id::uuid
    AND audit_id::uuid <> order_cancellation_id::uuid
  )
);
CREATE INDEX fulfillment_item_cancellation_history_idx
  ON rms_fulfillment.fulfillment_item_cancellation (
    brand_id, store_id, fulfillment_id, aggregate_version_after
  );
CREATE INDEX fulfillment_item_cancellation_operation_idx
  ON rms_fulfillment.fulfillment_item_cancellation (brand_id, store_id, operation_id);

-- The cancelled line belongs to this pickup and Order, has no ready result, the pickup is not yet
-- Ready, and the version is not already taken by a ready fact.
CREATE FUNCTION rms_fulfillment.check_fulfillment_item_cancellation() RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog
AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM rms_fulfillment.fulfillment f
    JOIN rms_fulfillment.fulfillment_item i
      ON i.brand_id = f.brand_id AND i.store_id = f.store_id AND i.fulfillment_id = f.fulfillment_id
    WHERE f.brand_id = NEW.brand_id AND f.store_id = NEW.store_id
      AND f.fulfillment_id = NEW.fulfillment_id AND f.order_id = NEW.order_id
      AND f.order_batch_id = NEW.order_batch_id
      AND i.fulfillment_item_id = NEW.fulfillment_item_id AND i.order_item_id = NEW.order_item_id
  ) THEN
    RAISE EXCEPTION 'fulfillment item cancellation does not match the pickup line' USING ERRCODE = '23514';
  END IF;
  IF EXISTS (
    SELECT 1 FROM rms_fulfillment.fulfillment_item_ready_result r
    WHERE r.brand_id = NEW.brand_id AND r.store_id = NEW.store_id
      AND r.fulfillment_id = NEW.fulfillment_id AND r.fulfillment_item_id = NEW.fulfillment_item_id
  ) OR EXISTS (
    SELECT 1 FROM rms_fulfillment.fulfillment_ready_operation o
    WHERE o.brand_id = NEW.brand_id AND o.store_id = NEW.store_id
      AND o.fulfillment_id = NEW.fulfillment_id
      AND (o.phase_after = 'Ready' OR o.aggregate_version_after = NEW.aggregate_version_after)
  ) OR EXISTS (
    SELECT 1 FROM rms_fulfillment.fulfillment_item_cancellation c
    WHERE c.brand_id = NEW.brand_id AND c.store_id = NEW.store_id
      AND c.fulfillment_id = NEW.fulfillment_id AND c.phase_after = 'Ready'
  ) THEN
    RAISE EXCEPTION 'only a pending pickup line can be cancelled' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION rms_fulfillment.check_fulfillment_item_cancellation() FROM PUBLIC;
CREATE TRIGGER fulfillment_item_cancellation_check_trigger
  BEFORE INSERT ON rms_fulfillment.fulfillment_item_cancellation
  FOR EACH ROW EXECUTE FUNCTION rms_fulfillment.check_fulfillment_item_cancellation();

-- A cancelled line never becomes ready, and a ready fact never reuses a cancellation version.
-- Definer rights: ready writers need not read cancellations; the caller's Store scope still applies.
CREATE FUNCTION rms_fulfillment.reject_ready_for_cancelled_fulfillment_item() RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
BEGIN
  IF TG_TABLE_NAME = 'fulfillment_item_ready_result' THEN
    IF EXISTS (
      SELECT 1 FROM rms_fulfillment.fulfillment_item_cancellation c
      WHERE c.brand_id = NEW.brand_id AND c.store_id = NEW.store_id
        AND c.fulfillment_item_id = NEW.fulfillment_item_id
    ) THEN
      RAISE EXCEPTION 'a cancelled pickup line cannot become ready' USING ERRCODE = '23514';
    END IF;
  ELSIF EXISTS (
    SELECT 1 FROM rms_fulfillment.fulfillment_item_cancellation c
    WHERE c.brand_id = NEW.brand_id AND c.store_id = NEW.store_id
      AND c.fulfillment_id = NEW.fulfillment_id
      AND (c.fulfillment_item_id = NEW.fulfillment_item_id
        OR c.aggregate_version_after = NEW.aggregate_version_after)
  ) THEN
    RAISE EXCEPTION 'a cancelled pickup line cannot become ready' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION rms_fulfillment.reject_ready_for_cancelled_fulfillment_item() FROM PUBLIC;
CREATE TRIGGER fulfillment_item_ready_result_cancelled_item_trigger
  BEFORE INSERT ON rms_fulfillment.fulfillment_item_ready_result
  FOR EACH ROW EXECUTE FUNCTION rms_fulfillment.reject_ready_for_cancelled_fulfillment_item();
CREATE TRIGGER fulfillment_ready_operation_cancelled_item_trigger
  BEFORE INSERT ON rms_fulfillment.fulfillment_ready_operation
  FOR EACH ROW EXECUTE FUNCTION rms_fulfillment.reject_ready_for_cancelled_fulfillment_item();

CREATE TRIGGER fulfillment_item_cancellation_no_update_trigger
  BEFORE UPDATE ON rms_fulfillment.fulfillment_item_cancellation
  FOR EACH ROW EXECUTE FUNCTION rms_fulfillment.reject_fulfillment_append_only_update();
CREATE RULE fulfillment_item_cancellation_no_delete AS
  ON DELETE TO rms_fulfillment.fulfillment_item_cancellation DO INSTEAD NOTHING;
ALTER TABLE rms_fulfillment.fulfillment_item_cancellation ENABLE ROW LEVEL SECURITY;
ALTER TABLE rms_fulfillment.fulfillment_item_cancellation FORCE ROW LEVEL SECURITY;
CREATE POLICY fulfillment_item_cancellation_store_scope_policy
  ON rms_fulfillment.fulfillment_item_cancellation
  USING (brand_id = platform_helpers.current_brand_id() AND store_id = platform_helpers.current_store_id())
  WITH CHECK (brand_id = platform_helpers.current_brand_id() AND store_id = platform_helpers.current_store_id());
REVOKE ALL ON TABLE rms_fulfillment.fulfillment_item_cancellation FROM PUBLIC;
