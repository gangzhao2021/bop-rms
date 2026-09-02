-- bop-rms-migration: 1
-- owner: shared-infrastructure/security
-- schema: security
-- phase: expand
-- risk: medium
-- transaction: required
-- lock-timeout-ms: 5000
-- statement-timeout-ms: 60000
-- recovery: forward-fix
CREATE SCHEMA IF NOT EXISTS security;
REVOKE ALL ON SCHEMA security FROM PUBLIC;

CREATE TABLE security.abuse_bucket (
  bucket_class text NOT NULL CHECK (bucket_class IN (
    'DINING_JOIN_FAILURE',
    'GUEST_SESSION',
    'MERCHANT_LOGIN_FAILURE',
    'ORDER_RESUME',
    'PICKUP_PROOF_FAILURE',
    'TRANSACTION_CREATE'
  )),
  key_hash bytea NOT NULL CHECK (octet_length(key_hash) = 32),
  window_started_at timestamp with time zone NOT NULL,
  window_seconds integer NOT NULL CHECK (window_seconds > 0 AND window_seconds <= 86400),
  limit_count integer NOT NULL CHECK (limit_count > 0),
  attempt_count integer NOT NULL CHECK (attempt_count > 0),
  expires_at timestamp with time zone NOT NULL,
  last_attempt_at timestamp with time zone NOT NULL,
  CONSTRAINT abuse_bucket_primary_key
    PRIMARY KEY (bucket_class, key_hash, window_started_at, window_seconds),
  CONSTRAINT abuse_bucket_expiry_check CHECK (
    expires_at = window_started_at + interval '24 hours'
  ),
  CONSTRAINT abuse_bucket_attempt_time_check CHECK (
    last_attempt_at >= window_started_at
    AND last_attempt_at < expires_at
  )
);

CREATE INDEX abuse_bucket_expiry_idx ON security.abuse_bucket (expires_at);
REVOKE ALL ON TABLE security.abuse_bucket FROM PUBLIC;

CREATE FUNCTION security.consume_abuse_budget(
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
      'ORDER_RESUME', 'PICKUP_PROOF_FAILURE', 'TRANSACTION_CREATE'
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

CREATE FUNCTION security.delete_expired_abuse_buckets(
  p_observed_at timestamp with time zone
)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
  v_deleted integer;
BEGIN
  DELETE FROM security.abuse_bucket WHERE expires_at <= p_observed_at;
  GET DIAGNOSTICS v_deleted = ROW_COUNT;
  RETURN v_deleted;
END;
$$;
REVOKE ALL ON FUNCTION security.delete_expired_abuse_buckets(timestamp with time zone) FROM PUBLIC;
