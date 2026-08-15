-- bop-rms-migration: 1
-- owner: @rms/business-intelligence
-- schema: rms_reporting
-- phase: expand
-- risk: low
-- transaction: required
-- lock-timeout-ms: 5000
-- statement-timeout-ms: 60000
-- recovery: forward-fix
CREATE FUNCTION rms_reporting.reject_export_history_update()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
BEGIN
  RAISE EXCEPTION 'Export history is append-only' USING ERRCODE = '55000';
END;
$$;
REVOKE ALL ON FUNCTION rms_reporting.reject_export_history_update() FROM PUBLIC;

CREATE TABLE rms_reporting.export_job (
  job_id platform_helpers.uuid_v7 NOT NULL, tenant_id platform_helpers.uuid_v7 NOT NULL,
  brand_id platform_helpers.uuid_v7 NOT NULL, store_id platform_helpers.uuid_v7,
  source_screen_id text NOT NULL CHECK (source_screen_id ~ '^[A-Z][A-Z0-9_.:-]{2,63}$'),
  source_view_id platform_helpers.uuid_v7 NOT NULL,
  source_projection text NOT NULL CHECK (source_projection ~ '^[A-Z][A-Z0-9_.:-]{2,63}$'),
  source_checkpoint text NOT NULL CHECK (source_checkpoint ~ '^[A-Z][A-Z0-9_.:-]{2,63}$'),
  filter_snapshot_digest text NOT NULL CHECK (filter_snapshot_digest ~ '^sha256:[0-9a-f]{64}$'),
  column_snapshot_digest text NOT NULL CHECK (column_snapshot_digest ~ '^sha256:[0-9a-f]{64}$'),
  selected_field_keys jsonb NOT NULL CHECK (jsonb_typeof(selected_field_keys)='array' AND jsonb_array_length(selected_field_keys) BETWEEN 1 AND 200),
  format text NOT NULL CHECK (format IN ('Csv','CanonicalJson')),
  data_classification text NOT NULL CHECK (data_classification IN ('Public','Internal','Confidential','Restricted')),
  purpose_code text NOT NULL CHECK (purpose_code ~ '^[A-Z][A-Z0-9_.:-]{2,63}$'),
  requested_by_actor_id platform_helpers.uuid_v7 NOT NULL, requested_at timestamp with time zone NOT NULL,
  CONSTRAINT export_job_pkey PRIMARY KEY (tenant_id,brand_id,job_id),
  CONSTRAINT export_job_scope_unique UNIQUE (job_id,tenant_id,brand_id)
);
CREATE TABLE rms_reporting.export_job_state_record (
  state_id platform_helpers.uuid_v7 NOT NULL, job_id platform_helpers.uuid_v7 NOT NULL,
  tenant_id platform_helpers.uuid_v7 NOT NULL, brand_id platform_helpers.uuid_v7 NOT NULL, store_id platform_helpers.uuid_v7,
  sequence bigint NOT NULL CHECK (sequence>0), status text NOT NULL CHECK (status IN ('Queued','Running','Completed','Failed','Cancelled')),
  occurred_at timestamp with time zone NOT NULL, actor_id platform_helpers.uuid_v7 NOT NULL,
  row_count integer CHECK (row_count BETWEEN 0 AND 100000), artifact_byte_count bigint CHECK (artifact_byte_count BETWEEN 0 AND 104857600),
  error_code text CHECK (error_code IS NULL OR error_code ~ '^[A-Z][A-Z0-9_.:-]{2,63}$'),
  CONSTRAINT export_job_state_pkey PRIMARY KEY (tenant_id,brand_id,state_id),
  CONSTRAINT export_job_state_job_fkey FOREIGN KEY (job_id,tenant_id,brand_id) REFERENCES rms_reporting.export_job(job_id,tenant_id,brand_id),
  CONSTRAINT export_job_state_sequence_unique UNIQUE (job_id,sequence),
  CONSTRAINT export_job_state_shape CHECK ((status='Completed')=(row_count IS NOT NULL AND artifact_byte_count IS NOT NULL) AND (status='Failed')=(error_code IS NOT NULL))
);
CREATE TABLE rms_reporting.export_artifact (
  artifact_id platform_helpers.uuid_v7 NOT NULL, job_id platform_helpers.uuid_v7 NOT NULL,
  tenant_id platform_helpers.uuid_v7 NOT NULL, brand_id platform_helpers.uuid_v7 NOT NULL, store_id platform_helpers.uuid_v7,
  object_evidence_id platform_helpers.uuid_v7 NOT NULL UNIQUE, checksum text NOT NULL CHECK (checksum ~ '^sha256:[0-9a-f]{64}$'),
  format text NOT NULL CHECK (format IN ('Csv','CanonicalJson')), data_classification text NOT NULL CHECK (data_classification IN ('Public','Internal','Confidential','Restricted')),
  encrypted boolean NOT NULL CHECK (encrypted), row_count integer NOT NULL CHECK (row_count BETWEEN 0 AND 100000),
  byte_count bigint NOT NULL CHECK (byte_count BETWEEN 0 AND 104857600), created_at timestamp with time zone NOT NULL, expires_at timestamp with time zone NOT NULL,
  CONSTRAINT export_artifact_pkey PRIMARY KEY (tenant_id,brand_id,artifact_id),
  CONSTRAINT export_artifact_scope_unique UNIQUE (artifact_id,tenant_id,brand_id),
  CONSTRAINT export_artifact_job_fkey FOREIGN KEY (job_id,tenant_id,brand_id) REFERENCES rms_reporting.export_job(job_id,tenant_id,brand_id),
  CONSTRAINT export_artifact_job_unique UNIQUE (job_id),
  CONSTRAINT export_artifact_expiry CHECK (expires_at>created_at AND expires_at<=created_at+interval '24 hours')
);
CREATE TABLE rms_reporting.export_access_grant (
  grant_id platform_helpers.uuid_v7 NOT NULL, artifact_id platform_helpers.uuid_v7 NOT NULL,
  tenant_id platform_helpers.uuid_v7 NOT NULL, brand_id platform_helpers.uuid_v7 NOT NULL, store_id platform_helpers.uuid_v7,
  actor_id platform_helpers.uuid_v7 NOT NULL, issued_at timestamp with time zone NOT NULL, expires_at timestamp with time zone NOT NULL,
  CONSTRAINT export_access_grant_pkey PRIMARY KEY (tenant_id,brand_id,grant_id),
  CONSTRAINT export_access_grant_scope_unique UNIQUE (grant_id,tenant_id,brand_id),
  CONSTRAINT export_access_grant_artifact_fkey FOREIGN KEY (artifact_id,tenant_id,brand_id) REFERENCES rms_reporting.export_artifact(artifact_id,tenant_id,brand_id),
  CONSTRAINT export_access_grant_expiry CHECK (expires_at>issued_at AND expires_at<=issued_at+interval '5 minutes')
);
CREATE TABLE rms_reporting.export_grant_consumption (
  consumption_id platform_helpers.uuid_v7 NOT NULL, grant_id platform_helpers.uuid_v7 NOT NULL UNIQUE,
  artifact_id platform_helpers.uuid_v7 NOT NULL, tenant_id platform_helpers.uuid_v7 NOT NULL,
  brand_id platform_helpers.uuid_v7 NOT NULL, store_id platform_helpers.uuid_v7,
  actor_id platform_helpers.uuid_v7 NOT NULL, consumed_at timestamp with time zone NOT NULL,
  CONSTRAINT export_grant_consumption_pkey PRIMARY KEY (tenant_id,brand_id,consumption_id),
  CONSTRAINT export_grant_consumption_grant_fkey FOREIGN KEY (grant_id,tenant_id,brand_id) REFERENCES rms_reporting.export_access_grant(grant_id,tenant_id,brand_id),
  CONSTRAINT export_grant_consumption_artifact_fkey FOREIGN KEY (artifact_id,tenant_id,brand_id) REFERENCES rms_reporting.export_artifact(artifact_id,tenant_id,brand_id)
);
CREATE TABLE rms_reporting.export_revocation (
  revocation_id platform_helpers.uuid_v7 NOT NULL, job_id platform_helpers.uuid_v7 NOT NULL UNIQUE,
  artifact_id platform_helpers.uuid_v7, tenant_id platform_helpers.uuid_v7 NOT NULL,
  brand_id platform_helpers.uuid_v7 NOT NULL, store_id platform_helpers.uuid_v7,
  reason_code text NOT NULL CHECK (reason_code ~ '^[A-Z][A-Z0-9_.:-]{2,63}$'), revoked_by_actor_id platform_helpers.uuid_v7 NOT NULL, revoked_at timestamp with time zone NOT NULL,
  CONSTRAINT export_revocation_pkey PRIMARY KEY (tenant_id,brand_id,revocation_id),
  CONSTRAINT export_revocation_job_fkey FOREIGN KEY (job_id,tenant_id,brand_id) REFERENCES rms_reporting.export_job(job_id,tenant_id,brand_id),
  CONSTRAINT export_revocation_artifact_fkey FOREIGN KEY (artifact_id,tenant_id,brand_id) REFERENCES rms_reporting.export_artifact(artifact_id,tenant_id,brand_id)
);
CREATE TABLE rms_reporting.export_operation_record (
  operation_id platform_helpers.uuid_v7 NOT NULL, job_id platform_helpers.uuid_v7 NOT NULL,
  tenant_id platform_helpers.uuid_v7 NOT NULL, brand_id platform_helpers.uuid_v7 NOT NULL, store_id platform_helpers.uuid_v7,
  action_code text NOT NULL CHECK (action_code IN ('Queue','Transition','Revoke','IssueGrant','ConsumeGrant')),
  intent_digest text NOT NULL CHECK (intent_digest ~ '^sha256:[0-9a-f]{64}$'), result_reference platform_helpers.uuid_v7 NOT NULL,
  actor_id platform_helpers.uuid_v7 NOT NULL, audit_id platform_helpers.uuid_v7 NOT NULL UNIQUE, occurred_at timestamp with time zone NOT NULL,
  CONSTRAINT export_operation_pkey PRIMARY KEY (tenant_id,brand_id,operation_id),
  CONSTRAINT export_operation_job_fkey FOREIGN KEY (job_id,tenant_id,brand_id) REFERENCES rms_reporting.export_job(job_id,tenant_id,brand_id)
);

CREATE TRIGGER export_job_no_update BEFORE UPDATE ON rms_reporting.export_job FOR EACH ROW EXECUTE FUNCTION rms_reporting.reject_export_history_update();
CREATE TRIGGER export_job_state_no_update BEFORE UPDATE ON rms_reporting.export_job_state_record FOR EACH ROW EXECUTE FUNCTION rms_reporting.reject_export_history_update();
CREATE TRIGGER export_artifact_no_update BEFORE UPDATE ON rms_reporting.export_artifact FOR EACH ROW EXECUTE FUNCTION rms_reporting.reject_export_history_update();
CREATE TRIGGER export_access_grant_no_update BEFORE UPDATE ON rms_reporting.export_access_grant FOR EACH ROW EXECUTE FUNCTION rms_reporting.reject_export_history_update();
CREATE TRIGGER export_grant_consumption_no_update BEFORE UPDATE ON rms_reporting.export_grant_consumption FOR EACH ROW EXECUTE FUNCTION rms_reporting.reject_export_history_update();
CREATE TRIGGER export_revocation_no_update BEFORE UPDATE ON rms_reporting.export_revocation FOR EACH ROW EXECUTE FUNCTION rms_reporting.reject_export_history_update();
CREATE TRIGGER export_operation_no_update BEFORE UPDATE ON rms_reporting.export_operation_record FOR EACH ROW EXECUTE FUNCTION rms_reporting.reject_export_history_update();
CREATE RULE export_job_no_delete AS ON DELETE TO rms_reporting.export_job DO INSTEAD NOTHING;
CREATE RULE export_job_state_no_delete AS ON DELETE TO rms_reporting.export_job_state_record DO INSTEAD NOTHING;
CREATE RULE export_artifact_no_delete AS ON DELETE TO rms_reporting.export_artifact DO INSTEAD NOTHING;
CREATE RULE export_access_grant_no_delete AS ON DELETE TO rms_reporting.export_access_grant DO INSTEAD NOTHING;
CREATE RULE export_grant_consumption_no_delete AS ON DELETE TO rms_reporting.export_grant_consumption DO INSTEAD NOTHING;
CREATE RULE export_revocation_no_delete AS ON DELETE TO rms_reporting.export_revocation DO INSTEAD NOTHING;
CREATE RULE export_operation_no_delete AS ON DELETE TO rms_reporting.export_operation_record DO INSTEAD NOTHING;

ALTER TABLE rms_reporting.export_job ENABLE ROW LEVEL SECURITY; ALTER TABLE rms_reporting.export_job FORCE ROW LEVEL SECURITY;
ALTER TABLE rms_reporting.export_job_state_record ENABLE ROW LEVEL SECURITY; ALTER TABLE rms_reporting.export_job_state_record FORCE ROW LEVEL SECURITY;
ALTER TABLE rms_reporting.export_artifact ENABLE ROW LEVEL SECURITY; ALTER TABLE rms_reporting.export_artifact FORCE ROW LEVEL SECURITY;
ALTER TABLE rms_reporting.export_access_grant ENABLE ROW LEVEL SECURITY; ALTER TABLE rms_reporting.export_access_grant FORCE ROW LEVEL SECURITY;
ALTER TABLE rms_reporting.export_grant_consumption ENABLE ROW LEVEL SECURITY; ALTER TABLE rms_reporting.export_grant_consumption FORCE ROW LEVEL SECURITY;
ALTER TABLE rms_reporting.export_revocation ENABLE ROW LEVEL SECURITY; ALTER TABLE rms_reporting.export_revocation FORCE ROW LEVEL SECURITY;
ALTER TABLE rms_reporting.export_operation_record ENABLE ROW LEVEL SECURITY; ALTER TABLE rms_reporting.export_operation_record FORCE ROW LEVEL SECURITY;
CREATE POLICY export_job_scope ON rms_reporting.export_job USING (brand_id=platform_helpers.current_brand_id() AND (store_id IS NULL OR store_id=platform_helpers.current_store_id())) WITH CHECK (brand_id=platform_helpers.current_brand_id() AND (store_id IS NULL OR store_id=platform_helpers.current_store_id()));
CREATE POLICY export_job_state_scope ON rms_reporting.export_job_state_record USING (brand_id=platform_helpers.current_brand_id() AND (store_id IS NULL OR store_id=platform_helpers.current_store_id())) WITH CHECK (brand_id=platform_helpers.current_brand_id() AND (store_id IS NULL OR store_id=platform_helpers.current_store_id()));
CREATE POLICY export_artifact_scope ON rms_reporting.export_artifact USING (brand_id=platform_helpers.current_brand_id() AND (store_id IS NULL OR store_id=platform_helpers.current_store_id())) WITH CHECK (brand_id=platform_helpers.current_brand_id() AND (store_id IS NULL OR store_id=platform_helpers.current_store_id()));
CREATE POLICY export_access_grant_scope ON rms_reporting.export_access_grant USING (brand_id=platform_helpers.current_brand_id() AND (store_id IS NULL OR store_id=platform_helpers.current_store_id())) WITH CHECK (brand_id=platform_helpers.current_brand_id() AND (store_id IS NULL OR store_id=platform_helpers.current_store_id()));
CREATE POLICY export_grant_consumption_scope ON rms_reporting.export_grant_consumption USING (brand_id=platform_helpers.current_brand_id() AND (store_id IS NULL OR store_id=platform_helpers.current_store_id())) WITH CHECK (brand_id=platform_helpers.current_brand_id() AND (store_id IS NULL OR store_id=platform_helpers.current_store_id()));
CREATE POLICY export_revocation_scope ON rms_reporting.export_revocation USING (brand_id=platform_helpers.current_brand_id() AND (store_id IS NULL OR store_id=platform_helpers.current_store_id())) WITH CHECK (brand_id=platform_helpers.current_brand_id() AND (store_id IS NULL OR store_id=platform_helpers.current_store_id()));
CREATE POLICY export_operation_scope ON rms_reporting.export_operation_record USING (brand_id=platform_helpers.current_brand_id() AND (store_id IS NULL OR store_id=platform_helpers.current_store_id())) WITH CHECK (brand_id=platform_helpers.current_brand_id() AND (store_id IS NULL OR store_id=platform_helpers.current_store_id()));
REVOKE ALL ON TABLE rms_reporting.export_job,rms_reporting.export_job_state_record,rms_reporting.export_artifact,rms_reporting.export_access_grant,rms_reporting.export_grant_consumption,rms_reporting.export_revocation,rms_reporting.export_operation_record FROM PUBLIC;
