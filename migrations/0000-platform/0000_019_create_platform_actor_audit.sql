-- bop-rms-migration: 1
-- owner: shared-infrastructure/audit
-- schema: platform_audit
-- phase: expand
-- risk: high
-- transaction: required
-- lock-timeout-ms: 5000
-- statement-timeout-ms: 60000
-- recovery: forward-fix
-- Actor/purpose GUCs are supplied by the genuine Platform authority holder; SQL is not IAM.
CREATE TABLE platform_audit.platform_actor_audit_chain_head (
  actor_id platform_helpers.uuid_v7 NOT NULL,
  purpose_code text NOT NULL CHECK (purpose_code ~ '^[A-Z][A-Z0-9_]{0,127}$'),
  next_sequence bigint NOT NULL CHECK (next_sequence BETWEEN 1 AND 9007199254740991),
  last_record_hash bytea CHECK (last_record_hash IS NULL OR octet_length(last_record_hash)=32),
  PRIMARY KEY(actor_id,purpose_code),
  CHECK ((next_sequence=1 AND last_record_hash IS NULL) OR (next_sequence>1 AND last_record_hash IS NOT NULL))
);
CREATE TABLE platform_audit.platform_actor_audit_record (
  audit_id platform_helpers.uuid_v7 PRIMARY KEY,
  actor_id platform_helpers.uuid_v7 NOT NULL,
  purpose_code text NOT NULL CHECK (purpose_code ~ '^[A-Z][A-Z0-9_]{0,127}$'),
  action_code text NOT NULL CHECK (action_code ~ '^[A-Z][A-Z0-9_]{0,127}$'),
  target_type text NOT NULL CHECK (target_type ~ '^[A-Z][A-Za-z0-9]{0,127}$'),
  target_id platform_helpers.uuid_v7 NOT NULL,
  operation_id platform_helpers.uuid_v7 NOT NULL,
  intent_digest bytea NOT NULL CHECK (octet_length(intent_digest)=32),
  occurred_at timestamptz NOT NULL CHECK (isfinite(occurred_at) AND occurred_at>='0001-01-01T00:00:00Z'::timestamptz AND occurred_at<'10000-01-01T00:00:00Z'::timestamptz AND occurred_at=date_trunc('milliseconds',occurred_at)),
  reason_code text NOT NULL CHECK (reason_code ~ '^[A-Z][A-Z0-9_]{0,127}$'),
  retention_policy_code text NOT NULL CHECK (retention_policy_code='CONFIGURATION_AUDIT'),
  retention_policy_version integer NOT NULL CHECK (retention_policy_version>0),
  chain_profile text NOT NULL CHECK (chain_profile='PlatformAuditChainRecordV1'),
  chain_sequence bigint NOT NULL CHECK (chain_sequence BETWEEN 1 AND 9007199254740991),
  previous_record_hash bytea CHECK (previous_record_hash IS NULL OR octet_length(previous_record_hash)=32),
  record_hash bytea NOT NULL CHECK (octet_length(record_hash)=32),
  recorded_at timestamptz NOT NULL CHECK (isfinite(recorded_at) AND recorded_at>='0001-01-01T00:00:00Z'::timestamptz AND recorded_at<'10000-01-01T00:00:00Z'::timestamptz AND recorded_at=date_trunc('milliseconds',recorded_at)),
  writer_transaction_id bigint NOT NULL DEFAULT txid_current(),
  UNIQUE(actor_id,purpose_code,chain_sequence),
  UNIQUE(audit_id,actor_id,purpose_code),
  FOREIGN KEY(actor_id,purpose_code) REFERENCES platform_audit.platform_actor_audit_chain_head(actor_id,purpose_code),
  CHECK ((chain_sequence=1 AND previous_record_hash IS NULL) OR (chain_sequence>1 AND previous_record_hash IS NOT NULL)),
  CHECK (occurred_at<=recorded_at),
  CHECK (target_type<>'PlatformBrandTemplateOperation' OR target_id=operation_id)
);
CREATE INDEX platform_actor_audit_record_target_idx ON platform_audit.platform_actor_audit_record(actor_id,purpose_code,target_type,target_id,chain_sequence);
CREATE INDEX platform_actor_audit_record_operation_idx ON platform_audit.platform_actor_audit_record(actor_id,purpose_code,operation_id,chain_sequence);
ALTER TABLE platform_audit.platform_actor_audit_chain_head ENABLE ROW LEVEL SECURITY;
ALTER TABLE platform_audit.platform_actor_audit_chain_head FORCE ROW LEVEL SECURITY;
ALTER TABLE platform_audit.platform_actor_audit_record ENABLE ROW LEVEL SECURITY;
ALTER TABLE platform_audit.platform_actor_audit_record FORCE ROW LEVEL SECURITY;
CREATE POLICY platform_actor_audit_head_scope ON platform_audit.platform_actor_audit_chain_head
  USING (actor_id::text=current_setting('bop.platform_actor_id',true) AND purpose_code=current_setting('bop.platform_purpose',true))
  WITH CHECK (actor_id::text=current_setting('bop.platform_actor_id',true) AND purpose_code=current_setting('bop.platform_purpose',true));
CREATE POLICY platform_actor_audit_record_read ON platform_audit.platform_actor_audit_record FOR SELECT
  USING (actor_id::text=current_setting('bop.platform_actor_id',true) AND purpose_code=current_setting('bop.platform_purpose',true));
CREATE POLICY platform_actor_audit_record_insert ON platform_audit.platform_actor_audit_record FOR INSERT
  WITH CHECK (actor_id::text=current_setting('bop.platform_actor_id',true) AND purpose_code=current_setting('bop.platform_purpose',true));

CREATE FUNCTION platform_audit.platform_actor_audit_immutable() RETURNS trigger LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
BEGIN
  RAISE EXCEPTION 'Platform Audit history is immutable' USING ERRCODE='23514';
END;
$$;
CREATE FUNCTION platform_audit.platform_actor_audit_head_guard() RETURNS trigger LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
BEGIN
  IF NEW.actor_id::text IS DISTINCT FROM current_setting('bop.platform_actor_id',true)
    OR NEW.purpose_code IS DISTINCT FROM current_setting('bop.platform_purpose',true) THEN
    RAISE EXCEPTION 'Platform Audit scope is unavailable' USING ERRCODE='23514';
  END IF;
  IF TG_OP='INSERT' THEN
    IF NEW.next_sequence<>1 OR NEW.last_record_hash IS NOT NULL THEN
      RAISE EXCEPTION 'Platform Audit genesis is invalid' USING ERRCODE='23514';
    END IF;
  ELSE
    IF NEW.actor_id IS DISTINCT FROM OLD.actor_id OR NEW.purpose_code IS DISTINCT FROM OLD.purpose_code
      OR NEW.next_sequence<>OLD.next_sequence+1 OR NOT EXISTS (
        SELECT 1 FROM platform_audit.platform_actor_audit_record r
        WHERE r.actor_id=OLD.actor_id AND r.purpose_code=OLD.purpose_code
          AND r.chain_sequence=OLD.next_sequence AND r.previous_record_hash IS NOT DISTINCT FROM OLD.last_record_hash
          AND r.record_hash=NEW.last_record_hash AND r.writer_transaction_id=txid_current()
      ) THEN
      RAISE EXCEPTION 'Platform Audit head advance is invalid' USING ERRCODE='23514';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
CREATE FUNCTION platform_audit.platform_actor_audit_record_guard() RETURNS trigger LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
DECLARE h platform_audit.platform_actor_audit_chain_head%ROWTYPE;
BEGIN
  IF NEW.actor_id::text IS DISTINCT FROM current_setting('bop.platform_actor_id',true)
    OR NEW.purpose_code IS DISTINCT FROM current_setting('bop.platform_purpose',true)
    OR NEW.writer_transaction_id<>txid_current() OR NEW.recorded_at>clock_timestamp() THEN
    RAISE EXCEPTION 'Platform Audit record is unavailable' USING ERRCODE='23514';
  END IF;
  SELECT * INTO h FROM platform_audit.platform_actor_audit_chain_head
    WHERE actor_id=NEW.actor_id AND purpose_code=NEW.purpose_code FOR UPDATE;
  IF NOT FOUND OR NEW.chain_sequence<>h.next_sequence
    OR NEW.previous_record_hash IS DISTINCT FROM h.last_record_hash
    OR (NEW.chain_sequence>1 AND NOT EXISTS (
      SELECT 1 FROM platform_audit.platform_actor_audit_record r
      WHERE r.actor_id=NEW.actor_id AND r.purpose_code=NEW.purpose_code
        AND r.chain_sequence=NEW.chain_sequence-1 AND r.record_hash=NEW.previous_record_hash AND r.recorded_at<=NEW.recorded_at
    )) THEN
    RAISE EXCEPTION 'Platform Audit chain allocation is invalid' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE FUNCTION platform_audit.platform_actor_audit_record_complete() RETURNS trigger LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
DECLARE h platform_audit.platform_actor_audit_chain_head%ROWTYPE;
BEGIN
  SELECT * INTO h FROM platform_audit.platform_actor_audit_chain_head
    WHERE actor_id=NEW.actor_id AND purpose_code=NEW.purpose_code;
  IF NOT FOUND OR h.next_sequence<=NEW.chain_sequence
    OR (h.next_sequence=NEW.chain_sequence+1 AND h.last_record_hash IS DISTINCT FROM NEW.record_hash)
    OR (h.next_sequence>NEW.chain_sequence+1 AND NOT EXISTS (
      SELECT 1 FROM platform_audit.platform_actor_audit_record r
      WHERE r.actor_id=NEW.actor_id AND r.purpose_code=NEW.purpose_code
        AND r.chain_sequence=NEW.chain_sequence+1 AND r.previous_record_hash=NEW.record_hash
    )) THEN
    RAISE EXCEPTION 'Platform Audit chain is incomplete' USING ERRCODE='23514';
  END IF;
  RETURN NULL;
END;
$$;
CREATE TRIGGER platform_actor_audit_head_guard BEFORE INSERT OR UPDATE ON platform_audit.platform_actor_audit_chain_head FOR EACH ROW EXECUTE FUNCTION platform_audit.platform_actor_audit_head_guard();
CREATE TRIGGER platform_actor_audit_record_guard BEFORE INSERT ON platform_audit.platform_actor_audit_record FOR EACH ROW EXECUTE FUNCTION platform_audit.platform_actor_audit_record_guard();
CREATE CONSTRAINT TRIGGER platform_actor_audit_record_complete AFTER INSERT ON platform_audit.platform_actor_audit_record DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION platform_audit.platform_actor_audit_record_complete();
CREATE TRIGGER platform_actor_audit_record_immutable BEFORE UPDATE OR DELETE ON platform_audit.platform_actor_audit_record FOR EACH ROW EXECUTE FUNCTION platform_audit.platform_actor_audit_immutable();
CREATE TRIGGER platform_actor_audit_record_no_truncate BEFORE TRUNCATE ON platform_audit.platform_actor_audit_record FOR EACH STATEMENT EXECUTE FUNCTION platform_audit.platform_actor_audit_immutable();
CREATE TRIGGER platform_actor_audit_head_no_delete BEFORE DELETE ON platform_audit.platform_actor_audit_chain_head FOR EACH ROW EXECUTE FUNCTION platform_audit.platform_actor_audit_immutable();
CREATE TRIGGER platform_actor_audit_head_no_truncate BEFORE TRUNCATE ON platform_audit.platform_actor_audit_chain_head FOR EACH STATEMENT EXECUTE FUNCTION platform_audit.platform_actor_audit_immutable();
REVOKE ALL ON TABLE platform_audit.platform_actor_audit_record,platform_audit.platform_actor_audit_chain_head FROM PUBLIC;
REVOKE ALL ON FUNCTION platform_audit.platform_actor_audit_immutable(),platform_audit.platform_actor_audit_head_guard(),platform_audit.platform_actor_audit_record_guard(),platform_audit.platform_actor_audit_record_complete() FROM PUBLIC;
