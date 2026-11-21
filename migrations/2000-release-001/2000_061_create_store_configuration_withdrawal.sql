-- bop-rms-migration: 1
-- owner: @rms/store
-- schema: rms_store
-- phase: expand
-- risk: medium
-- transaction: required
-- lock-timeout-ms: 5000
-- statement-timeout-ms: 60000
-- recovery: forward-fix
-- WP-2423 (v15 live check of 48093a71, D2/D3): a Store configuration that is not published yet
-- (being prepared, waiting for approval, or approved) is withdrawn by the person who made it, or
-- declined by someone who may approve it. The record is append-only; the configuration itself is
-- kept. A withdrawn configuration can no longer be checked, sent, approved or published; the next
-- change builds on it. A new change never silently replaces another person's change that is still
-- open: it must be approved and published, withdrawn or declined first (the database checks both).
CREATE FUNCTION rms_store.reject_store_configuration_withdrawal_mutation() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
BEGIN
  RAISE EXCEPTION 'append-only store configuration withdrawal' USING ERRCODE='55000';
END;
$$;
REVOKE ALL ON FUNCTION rms_store.reject_store_configuration_withdrawal_mutation() FROM PUBLIC;

-- The checks below read the exact rows they name as the migration owner (SECURITY DEFINER,
-- row_security off: fails closed if the owner cannot bypass forced RLS).
CREATE TABLE rms_store.store_configuration_withdrawal (
  brand_id platform_helpers.uuid_v7 NOT NULL,
  store_id platform_helpers.uuid_v7 NOT NULL,
  configuration_id platform_helpers.uuid_v7 NOT NULL,
  configuration_version bigint NOT NULL CHECK (configuration_version > 0),
  withdrawn_lifecycle text NOT NULL CHECK (withdrawn_lifecycle IN ('Draft','PendingApproval','Approved')),
  withdrawal_kind text NOT NULL CHECK (withdrawal_kind IN ('Withdrawn','Declined')),
  actor_id platform_helpers.uuid_v7 NOT NULL,
  reason_code text NOT NULL CHECK (reason_code ~ '^[A-Z][A-Z0-9_]{0,63}$'),
  audit_id platform_helpers.uuid_v7 NOT NULL,
  withdrawn_at timestamptz NOT NULL CHECK (isfinite(withdrawn_at) AND withdrawn_at=date_trunc('milliseconds',withdrawn_at)),
  data_classification text NOT NULL CHECK (data_classification='ConfigurationMetadata'),
  CONSTRAINT store_configuration_withdrawal_pkey PRIMARY KEY (brand_id,store_id,configuration_id),
  CONSTRAINT store_configuration_withdrawal_audit_unique UNIQUE (brand_id,store_id,audit_id)
);
CREATE TRIGGER store_configuration_withdrawal_no_mutation BEFORE UPDATE OR DELETE ON rms_store.store_configuration_withdrawal
  FOR EACH ROW EXECUTE FUNCTION rms_store.reject_store_configuration_withdrawal_mutation();
CREATE TRIGGER store_configuration_withdrawal_no_truncate BEFORE TRUNCATE ON rms_store.store_configuration_withdrawal
  FOR EACH STATEMENT EXECUTE FUNCTION rms_store.reject_store_configuration_withdrawal_mutation();
ALTER TABLE rms_store.store_configuration_withdrawal ENABLE ROW LEVEL SECURITY;
ALTER TABLE rms_store.store_configuration_withdrawal FORCE ROW LEVEL SECURITY;
CREATE POLICY store_configuration_withdrawal_scope ON rms_store.store_configuration_withdrawal
  USING (brand_id=platform_helpers.current_brand_id() AND store_id=platform_helpers.current_store_id())
  WITH CHECK (brand_id=platform_helpers.current_brand_id() AND store_id=platform_helpers.current_store_id());
REVOKE ALL ON TABLE rms_store.store_configuration_withdrawal FROM PUBLIC;

-- Only the Store's latest recorded configuration, while it is not published, at its recorded
-- state; "Withdrawn" by the person who made it, "Declined" by someone else.
CREATE FUNCTION rms_store.check_store_configuration_withdrawal() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog
SET row_security = off
AS $$
DECLARE
  head rms_store.store_configuration_authoring_operation%ROWTYPE;
BEGIN
  PERFORM 1 FROM rms_store.store_configuration_authoring_operation a
    WHERE a.brand_id=NEW.brand_id AND a.store_id=NEW.store_id FOR SHARE;
  SELECT a.* INTO head FROM rms_store.store_configuration_authoring_operation a
    WHERE a.brand_id=NEW.brand_id AND a.store_id=NEW.store_id
    ORDER BY a.sequence_number DESC LIMIT 1;
  IF head.operation_id IS NULL OR head.configuration_id<>NEW.configuration_id
    OR head.configuration_version<>NEW.configuration_version OR head.lifecycle<>NEW.withdrawn_lifecycle
    OR head.lifecycle NOT IN ('Draft','PendingApproval','Approved')
    OR NEW.withdrawn_at<head.occurred_at
    OR ((head.configuration_json->>'authoredByReference'=NEW.actor_id::text)<>(NEW.withdrawal_kind='Withdrawn')) THEN
    RAISE EXCEPTION 'only the latest configuration that is not published can be withdrawn or declined' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION rms_store.check_store_configuration_withdrawal() FROM PUBLIC;
CREATE TRIGGER store_configuration_withdrawal_latest BEFORE INSERT ON rms_store.store_configuration_withdrawal
  FOR EACH ROW EXECUTE FUNCTION rms_store.check_store_configuration_withdrawal();

-- The authoring history: a withdrawn configuration takes no further step, and a new version never
-- replaces another person's open change that was not withdrawn or declined.
CREATE FUNCTION rms_store.check_store_configuration_authoring_open_change() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog
SET row_security = off
AS $$
DECLARE
  head rms_store.store_configuration_authoring_operation%ROWTYPE;
BEGIN
  IF NEW.command_type<>'SaveDraft' THEN
    IF EXISTS (SELECT 1 FROM rms_store.store_configuration_withdrawal w
      WHERE w.brand_id=NEW.brand_id AND w.store_id=NEW.store_id AND w.configuration_id=NEW.configuration_id) THEN
      RAISE EXCEPTION 'store configuration was withdrawn' USING ERRCODE='23514';
    END IF;
    RETURN NEW;
  END IF;
  SELECT a.* INTO head FROM rms_store.store_configuration_authoring_operation a
    WHERE a.brand_id=NEW.brand_id AND a.store_id=NEW.store_id
    ORDER BY a.sequence_number DESC LIMIT 1;
  IF head.operation_id IS NOT NULL AND head.lifecycle IN ('Draft','PendingApproval','Approved')
    AND head.configuration_id<>NEW.configuration_id
    AND head.configuration_json->>'authoredByReference'<>NEW.actor_reference::text
    AND NOT EXISTS (SELECT 1 FROM rms_store.store_configuration_withdrawal w
      WHERE w.brand_id=head.brand_id AND w.store_id=head.store_id AND w.configuration_id=head.configuration_id) THEN
    RAISE EXCEPTION 'another person''s store configuration change is still open' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION rms_store.check_store_configuration_authoring_open_change() FROM PUBLIC;
CREATE TRIGGER store_authoring_open_change BEFORE INSERT ON rms_store.store_configuration_authoring_operation
  FOR EACH ROW EXECUTE FUNCTION rms_store.check_store_configuration_authoring_open_change();
