-- bop-rms-migration: 1
-- owner: shared-infrastructure/security
-- schema: security
-- phase: expand
-- risk: medium
-- transaction: required
-- lock-timeout-ms: 5000
-- statement-timeout-ms: 60000
-- recovery: forward-fix
-- WP-2423 取舍 18 DEC-MEMBER-POINTS: budgets for sending and checking member phone codes.
ALTER TABLE security.abuse_bucket DROP CONSTRAINT abuse_bucket_bucket_class_check;
ALTER TABLE security.abuse_bucket ADD CONSTRAINT abuse_bucket_bucket_class_check CHECK (bucket_class IN (
 'DINING_JOIN_FAILURE','GUEST_SESSION','MERCHANT_LOGIN_FAILURE','ORDER_RESUME','PICKUP_PROOF_FAILURE',
 'TRANSACTION_CREATE','MEMBER_CODE_SEND','MEMBER_CODE_CHECK'
));
CREATE OR REPLACE FUNCTION security.consume_abuse_budget(
  p_bucket_class text,
  p_key_hash bytea,
  p_window_started_at timestamp with time zone,
  p_window_seconds integer,
  p_limit_count integer,
  p_observed_at timestamp with time zone
)
RETURNS TABLE (allowed boolean, remaining integer, retry_after_seconds integer)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
  v_attempt_count integer;
BEGIN
  IF p_bucket_class NOT IN (
      'DINING_JOIN_FAILURE', 'GUEST_SESSION', 'MERCHANT_LOGIN_FAILURE',
      'ORDER_RESUME', 'PICKUP_PROOF_FAILURE', 'TRANSACTION_CREATE',
      'MEMBER_CODE_SEND', 'MEMBER_CODE_CHECK'
    )
    OR p_key_hash IS NULL OR octet_length(p_key_hash) <> 32
    OR p_window_seconds <= 0 OR p_window_seconds > 86400
    OR p_limit_count <= 0
    OR p_observed_at < p_window_started_at
    OR p_observed_at >= p_window_started_at + make_interval(secs => p_window_seconds)
  THEN
    RAISE EXCEPTION 'ABUSE_BUCKET_INPUT_INVALID' USING ERRCODE = '22023';
  END IF;

  INSERT INTO security.abuse_bucket (
    bucket_class, key_hash, window_started_at, window_seconds,
    limit_count, attempt_count, expires_at, last_attempt_at
  ) VALUES (
    p_bucket_class, p_key_hash, p_window_started_at, p_window_seconds,
    p_limit_count, 1, p_window_started_at + interval '24 hours', p_observed_at
  )
  ON CONFLICT (bucket_class, key_hash, window_started_at, window_seconds)
  DO UPDATE SET
    attempt_count = security.abuse_bucket.attempt_count + 1,
    last_attempt_at = EXCLUDED.last_attempt_at
  WHERE security.abuse_bucket.limit_count = EXCLUDED.limit_count
  RETURNING attempt_count INTO v_attempt_count;

  IF v_attempt_count IS NULL THEN
    RAISE EXCEPTION 'ABUSE_BUCKET_POLICY_CONFLICT' USING ERRCODE = '22023';
  END IF;

  RETURN QUERY SELECT
    v_attempt_count <= p_limit_count,
    GREATEST(0, p_limit_count - v_attempt_count),
    CASE WHEN v_attempt_count <= p_limit_count THEN 0 ELSE
      GREATEST(1, CEIL(EXTRACT(EPOCH FROM (
        p_window_started_at + make_interval(secs => p_window_seconds) - p_observed_at
      )))::integer)
    END;
END;
$$;
REVOKE ALL ON FUNCTION security.consume_abuse_budget(
  text, bytea, timestamp with time zone, integer, integer, timestamp with time zone
) FROM PUBLIC;
