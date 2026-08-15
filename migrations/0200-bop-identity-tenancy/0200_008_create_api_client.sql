-- bop-rms-migration: 1
-- owner: @bop/identity
-- schema: bop_identity
-- phase: expand
-- risk: high
-- transaction: required
-- lock-timeout-ms: 5000
-- statement-timeout-ms: 60000
-- recovery: forward-fix
CREATE FUNCTION bop_identity.reject_api_client_history_update()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
BEGIN
  RAISE EXCEPTION 'API Client history is append-only' USING ERRCODE = '55000';
END;
$$;
REVOKE ALL ON FUNCTION bop_identity.reject_api_client_history_update() FROM PUBLIC;

CREATE FUNCTION bop_identity.enforce_api_client_revision()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
BEGIN
  IF NEW.brand_id <> OLD.brand_id
    OR NEW.store_id IS DISTINCT FROM OLD.store_id
    OR NEW.api_client_id <> OLD.api_client_id
    OR NEW.name_code <> OLD.name_code
    OR NEW.owner_reference <> OLD.owner_reference
    OR NEW.environment <> OLD.environment
    OR NEW.created_at <> OLD.created_at
    OR NEW.created_by_reference <> OLD.created_by_reference
    OR NEW.aggregate_version <> OLD.aggregate_version + 1 THEN
    RAISE EXCEPTION 'API Client identity or revision is invalid' USING ERRCODE = '55000';
  END IF;
  IF OLD.lifecycle = 'Revoked' THEN
    RAISE EXCEPTION 'revoked API Client is terminal' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION bop_identity.enforce_api_client_revision() FROM PUBLIC;

CREATE TABLE bop_identity.api_client (
  api_client_id platform_helpers.uuid_v7 NOT NULL,
  brand_id platform_helpers.uuid_v7 NOT NULL,
  store_id platform_helpers.uuid_v7,
  name_code text NOT NULL CHECK (name_code ~ '^[A-Z][A-Z0-9_.:-]{0,63}$'),
  owner_reference platform_helpers.uuid_v7 NOT NULL,
  environment text NOT NULL CHECK (environment IN ('Sandbox', 'Production')),
  lifecycle text NOT NULL CHECK (
    lifecycle IN ('Requested', 'PendingApproval', 'Active', 'Suspended', 'Revoked')
  ),
  aggregate_version bigint NOT NULL CHECK (aggregate_version > 0),
  current_access_version bigint NOT NULL CHECK (current_access_version > 0),
  current_credential_reference platform_helpers.uuid_v7,
  current_credential_version integer CHECK (
    current_credential_version IS NULL OR current_credential_version > 0
  ),
  credential_status text NOT NULL CHECK (
    credential_status IN ('NotIssued', 'Active', 'Revoked')
  ),
  last_used_at timestamp with time zone,
  audit_summary_reference platform_helpers.uuid_v7 NOT NULL,
  created_by_reference platform_helpers.uuid_v7 NOT NULL,
  created_at timestamp with time zone NOT NULL,
  updated_at timestamp with time zone NOT NULL CHECK (updated_at >= created_at),
  data_classification text NOT NULL CHECK (data_classification = 'CredentialMetadata'),
  CONSTRAINT api_client_pkey PRIMARY KEY (brand_id, api_client_id),
  CONSTRAINT api_client_scope_unique
    UNIQUE NULLS NOT DISTINCT (brand_id, store_id, api_client_id),
  CONSTRAINT api_client_name_unique UNIQUE (brand_id, environment, name_code),
  CONSTRAINT api_client_credential_shape CHECK (
    (current_credential_reference IS NULL) = (current_credential_version IS NULL)
    AND ((credential_status = 'NotIssued') = (current_credential_reference IS NULL))
    AND (lifecycle IN ('Requested', 'PendingApproval')) =
      (credential_status = 'NotIssued')
    AND (lifecycle = 'Revoked') = (credential_status = 'Revoked')
  ),
  CONSTRAINT api_client_last_use_check CHECK (
    last_used_at IS NULL OR (last_used_at >= created_at AND last_used_at <= updated_at)
  )
);

CREATE TABLE bop_identity.api_client_access_version (
  access_version_id platform_helpers.uuid_v7 NOT NULL,
  brand_id platform_helpers.uuid_v7 NOT NULL,
  store_id platform_helpers.uuid_v7,
  api_client_id platform_helpers.uuid_v7 NOT NULL,
  access_version bigint NOT NULL CHECK (access_version > 0),
  requested_scope_codes text[] NOT NULL CHECK (
    cardinality(requested_scope_codes) BETWEEN 1 AND 50
  ),
  requested_grant_codes text[] NOT NULL CHECK (
    cardinality(requested_grant_codes) BETWEEN 1 AND 50
  ),
  grant_set_reference platform_helpers.uuid_v7,
  approval_evidence_reference platform_helpers.uuid_v7,
  recorded_at timestamp with time zone NOT NULL,
  data_classification text NOT NULL CHECK (data_classification = 'Confidential'),
  CONSTRAINT api_client_access_version_pkey PRIMARY KEY (brand_id, access_version_id),
  CONSTRAINT api_client_access_version_client_fkey
    FOREIGN KEY (brand_id, store_id, api_client_id)
    REFERENCES bop_identity.api_client (brand_id, store_id, api_client_id),
  CONSTRAINT api_client_access_version_unique
    UNIQUE (brand_id, api_client_id, access_version),
  CONSTRAINT api_client_access_approval_shape CHECK (
    (grant_set_reference IS NULL) = (approval_evidence_reference IS NULL)
  )
);

CREATE TABLE bop_identity.api_client_credential_metadata (
  credential_metadata_id platform_helpers.uuid_v7 NOT NULL,
  brand_id platform_helpers.uuid_v7 NOT NULL,
  store_id platform_helpers.uuid_v7,
  api_client_id platform_helpers.uuid_v7 NOT NULL,
  credential_reference platform_helpers.uuid_v7 NOT NULL,
  credential_version integer NOT NULL CHECK (credential_version > 0),
  status text NOT NULL CHECK (status IN ('Active', 'Revoked')),
  issued_at timestamp with time zone NOT NULL,
  expires_at timestamp with time zone NOT NULL CHECK (expires_at > issued_at),
  revoked_at timestamp with time zone,
  supersedes_credential_reference platform_helpers.uuid_v7,
  recorded_at timestamp with time zone NOT NULL,
  data_classification text NOT NULL CHECK (data_classification = 'CredentialMetadata'),
  CONSTRAINT api_client_credential_metadata_pkey
    PRIMARY KEY (brand_id, credential_metadata_id),
  CONSTRAINT api_client_credential_metadata_client_fkey
    FOREIGN KEY (brand_id, store_id, api_client_id)
    REFERENCES bop_identity.api_client (brand_id, store_id, api_client_id),
  CONSTRAINT api_client_credential_version_unique
    UNIQUE (brand_id, api_client_id, credential_version),
  CONSTRAINT api_client_credential_reference_unique UNIQUE (brand_id, credential_reference),
  CONSTRAINT api_client_credential_status_shape CHECK (
    (status = 'Revoked') = (revoked_at IS NOT NULL)
    AND (revoked_at IS NULL OR revoked_at >= issued_at)
    AND (credential_version = 1) = (supersedes_credential_reference IS NULL)
  )
);

CREATE TABLE bop_identity.api_client_operation (
  operation_id platform_helpers.uuid_v7 NOT NULL,
  brand_id platform_helpers.uuid_v7 NOT NULL,
  store_id platform_helpers.uuid_v7,
  api_client_id platform_helpers.uuid_v7 NOT NULL,
  command_type text NOT NULL CHECK (command_type IN (
    'RequestApiClient', 'SubmitApiClientApproval', 'ActivateApiClient',
    'SuspendApiClient', 'RotateApiClientCredential', 'RevokeApiClient'
  )),
  intent_digest text NOT NULL CHECK (intent_digest ~ '^sha256:[0-9a-f]{64}$'),
  aggregate_version bigint NOT NULL CHECK (aggregate_version > 0),
  actor_reference platform_helpers.uuid_v7 NOT NULL,
  purpose_code text NOT NULL CHECK (purpose_code ~ '^[A-Z][A-Z0-9_.:-]{0,63}$'),
  audit_reference platform_helpers.uuid_v7 NOT NULL,
  occurred_at timestamp with time zone NOT NULL,
  data_classification text NOT NULL CHECK (data_classification = 'CredentialMetadata'),
  CONSTRAINT api_client_operation_pkey PRIMARY KEY (brand_id, operation_id),
  CONSTRAINT api_client_operation_client_fkey
    FOREIGN KEY (brand_id, store_id, api_client_id)
    REFERENCES bop_identity.api_client (brand_id, store_id, api_client_id),
  CONSTRAINT api_client_operation_version_unique
    UNIQUE (brand_id, api_client_id, aggregate_version)
);

CREATE INDEX api_client_admin_idx
  ON bop_identity.api_client (brand_id, lifecycle, environment, updated_at, api_client_id);
CREATE INDEX api_client_access_history_idx
  ON bop_identity.api_client_access_version (brand_id, api_client_id, access_version);
CREATE INDEX api_client_credential_history_idx
  ON bop_identity.api_client_credential_metadata
    (brand_id, api_client_id, credential_version);

CREATE TRIGGER api_client_revision_trigger BEFORE UPDATE ON bop_identity.api_client
  FOR EACH ROW EXECUTE FUNCTION bop_identity.enforce_api_client_revision();
CREATE RULE api_client_no_delete AS ON DELETE TO bop_identity.api_client DO INSTEAD NOTHING;
CREATE TRIGGER api_client_access_no_update_trigger
  BEFORE UPDATE ON bop_identity.api_client_access_version
  FOR EACH ROW EXECUTE FUNCTION bop_identity.reject_api_client_history_update();
CREATE RULE api_client_access_no_delete AS
  ON DELETE TO bop_identity.api_client_access_version DO INSTEAD NOTHING;
CREATE TRIGGER api_client_credential_no_update_trigger
  BEFORE UPDATE ON bop_identity.api_client_credential_metadata
  FOR EACH ROW EXECUTE FUNCTION bop_identity.reject_api_client_history_update();
CREATE RULE api_client_credential_no_delete AS
  ON DELETE TO bop_identity.api_client_credential_metadata DO INSTEAD NOTHING;
CREATE TRIGGER api_client_operation_no_update_trigger
  BEFORE UPDATE ON bop_identity.api_client_operation
  FOR EACH ROW EXECUTE FUNCTION bop_identity.reject_api_client_history_update();
CREATE RULE api_client_operation_no_delete AS
  ON DELETE TO bop_identity.api_client_operation DO INSTEAD NOTHING;

ALTER TABLE bop_identity.api_client ENABLE ROW LEVEL SECURITY;
ALTER TABLE bop_identity.api_client FORCE ROW LEVEL SECURITY;
ALTER TABLE bop_identity.api_client_access_version ENABLE ROW LEVEL SECURITY;
ALTER TABLE bop_identity.api_client_access_version FORCE ROW LEVEL SECURITY;
ALTER TABLE bop_identity.api_client_credential_metadata ENABLE ROW LEVEL SECURITY;
ALTER TABLE bop_identity.api_client_credential_metadata FORCE ROW LEVEL SECURITY;
ALTER TABLE bop_identity.api_client_operation ENABLE ROW LEVEL SECURITY;
ALTER TABLE bop_identity.api_client_operation FORCE ROW LEVEL SECURITY;

CREATE POLICY api_client_scope_policy ON bop_identity.api_client
  USING (
    brand_id = platform_helpers.current_brand_id()
    AND (store_id IS NULL OR store_id = platform_helpers.current_store_id())
  )
  WITH CHECK (
    brand_id = platform_helpers.current_brand_id()
    AND (store_id IS NULL OR store_id = platform_helpers.current_store_id())
  );
CREATE POLICY api_client_access_scope_policy ON bop_identity.api_client_access_version
  USING (
    brand_id = platform_helpers.current_brand_id()
    AND (store_id IS NULL OR store_id = platform_helpers.current_store_id())
  )
  WITH CHECK (
    brand_id = platform_helpers.current_brand_id()
    AND (store_id IS NULL OR store_id = platform_helpers.current_store_id())
  );
CREATE POLICY api_client_credential_scope_policy ON bop_identity.api_client_credential_metadata
  USING (
    brand_id = platform_helpers.current_brand_id()
    AND (store_id IS NULL OR store_id = platform_helpers.current_store_id())
  )
  WITH CHECK (
    brand_id = platform_helpers.current_brand_id()
    AND (store_id IS NULL OR store_id = platform_helpers.current_store_id())
  );
CREATE POLICY api_client_operation_scope_policy ON bop_identity.api_client_operation
  USING (
    brand_id = platform_helpers.current_brand_id()
    AND (store_id IS NULL OR store_id = platform_helpers.current_store_id())
  )
  WITH CHECK (
    brand_id = platform_helpers.current_brand_id()
    AND (store_id IS NULL OR store_id = platform_helpers.current_store_id())
  );

REVOKE ALL ON TABLE bop_identity.api_client FROM PUBLIC;
REVOKE ALL ON TABLE bop_identity.api_client_access_version FROM PUBLIC;
REVOKE ALL ON TABLE bop_identity.api_client_credential_metadata FROM PUBLIC;
REVOKE ALL ON TABLE bop_identity.api_client_operation FROM PUBLIC;
