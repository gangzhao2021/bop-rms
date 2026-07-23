-- bop-rms-migration: 1
-- owner: shared-infrastructure/eventing
-- schema: platform_eventing
-- phase: expand
-- risk: medium
-- transaction: required
-- lock-timeout-ms: 5000
-- statement-timeout-ms: 60000
-- recovery: forward-fix
ALTER TABLE platform_eventing.outbox_event
  ADD COLUMN lease_token platform_helpers.uuid_v7,
  ADD COLUMN lease_owner text,
  ADD COLUMN lease_expires_at timestamp with time zone,
  ADD CONSTRAINT outbox_event_lease_shape_check CHECK (
    (
      lease_token IS NULL
      AND lease_owner IS NULL
      AND lease_expires_at IS NULL
    )
    OR (
      lease_token IS NOT NULL
      AND lease_owner IS NOT NULL
      AND lease_owner ~ '^[a-z][a-z0-9_-]{0,63}$'
      AND lease_expires_at IS NOT NULL
    )
  );

CREATE INDEX outbox_event_dispatch_claim_idx
  ON platform_eventing.outbox_event (
    brand_id,
    available_at,
    lease_expires_at,
    recorded_at,
    event_id
  )
  WHERE published_at IS NULL AND last_error_code IS NULL;
