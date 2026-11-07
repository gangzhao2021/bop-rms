-- bop-rms-migration: 1
-- owner: @rms/payment
-- schema: rms_payment
-- phase: expand
-- risk: medium
-- transaction: required
-- lock-timeout-ms: 5000
-- statement-timeout-ms: 60000
-- recovery: forward-fix
-- WP-2423 Q6 step 2a: staff cancel some items of a paid batch before the kitchen starts them.
-- The refund for exactly those items is an ordinary refund request of claim kind Cancellation,
-- bound to one Ordering item-cancellation record. Records without a 'claim' key stay Ordinary
-- (legacy encoding unchanged). A Cancellation claim is exactly {kind, cancellationReference,
-- cancellationDigest}; one refund request per cancellation record.
ALTER TABLE rms_payment.ordinary_refund_request
  ADD CONSTRAINT ordinary_refund_request_claim_kind CHECK (
    NOT (record_json ? 'claim') OR (
      jsonb_typeof(record_json->'claim')='object' AND
      ((record_json->'claim') - 'kind' - 'cancellationReference' - 'cancellationDigest')='{}'::jsonb AND
      (record_json->'claim'->>'kind') IS NOT DISTINCT FROM 'Cancellation' AND
      coalesce((record_json->'claim'->>'cancellationReference') ~ '^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$',false) AND
      coalesce((record_json->'claim'->>'cancellationDigest') ~ '^sha256:[0-9a-f]{64}$',false)
    )
  );
CREATE UNIQUE INDEX ordinary_refund_request_cancellation_unique
  ON rms_payment.ordinary_refund_request (brand_id, store_id, ((record_json->'claim'->>'cancellationReference')))
  WHERE record_json ? 'claim';
