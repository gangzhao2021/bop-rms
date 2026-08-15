-- bop-rms-migration: 1
-- owner: @bop/tenant
-- schema: bop_tenant
-- phase: expand
-- risk: high
-- transaction: required
-- lock-timeout-ms: 5000
-- statement-timeout-ms: 60000
-- recovery: forward-fix
CREATE FUNCTION bop_tenant.reject_brand_admin_history_update()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
BEGIN
  RAISE EXCEPTION 'Brand administration history is append-only' USING ERRCODE = '55000';
END;
$$;
REVOKE ALL ON FUNCTION bop_tenant.reject_brand_admin_history_update() FROM PUBLIC;

CREATE FUNCTION bop_tenant.enforce_organization_revision()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
BEGIN
  IF TG_TABLE_NAME = 'brand' AND (
    NEW.brand_id <> OLD.brand_id OR NEW.code <> OLD.code OR NEW.currency_code <> OLD.currency_code
    OR NEW.created_at <> OLD.created_at OR NEW.version <> OLD.version + 1
  ) THEN RAISE EXCEPTION 'Brand identity or revision is invalid' USING ERRCODE = '55000'; END IF;
  IF TG_TABLE_NAME = 'store' AND (
    NEW.store_id <> OLD.store_id OR NEW.brand_id <> OLD.brand_id OR NEW.code <> OLD.code
    OR NEW.currency_code <> OLD.currency_code OR NEW.created_at <> OLD.created_at
    OR NEW.version <> OLD.version + 1
  ) THEN RAISE EXCEPTION 'Store identity or revision is invalid' USING ERRCODE = '55000'; END IF;
  IF OLD.lifecycle = 'Archived' THEN
    RAISE EXCEPTION 'archived organization identity is terminal' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION bop_tenant.enforce_organization_revision() FROM PUBLIC;

CREATE FUNCTION bop_tenant.enforce_membership_sequence()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
DECLARE latest_action text;
BEGIN
  SELECT action INTO latest_action FROM bop_tenant.brand_store_membership_record
  WHERE brand_id = NEW.brand_id AND store_id = NEW.store_id
  ORDER BY recorded_at DESC, membership_record_id DESC LIMIT 1;
  IF latest_action = NEW.action OR (latest_action IS NULL AND NEW.action <> 'Added') THEN
    RAISE EXCEPTION 'Brand Store membership sequence is invalid' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION bop_tenant.enforce_membership_sequence() FROM PUBLIC;

CREATE TABLE bop_tenant.brand_configuration_version (
  configuration_version_id platform_helpers.uuid_v7 NOT NULL,
  brand_id platform_helpers.uuid_v7 NOT NULL REFERENCES bop_tenant.brand (brand_id),
  configuration_version bigint NOT NULL CHECK (configuration_version > 0),
  lifecycle text NOT NULL CHECK (lifecycle IN ('Draft','PendingApproval','Approved','Published','Superseded','Archived')),
  default_locale text NOT NULL CHECK (char_length(default_locale) BETWEEN 2 AND 35),
  supported_locales text[] NOT NULL CHECK (cardinality(supported_locales) BETWEEN 1 AND 20),
  media_theme_reference platform_helpers.uuid_v7,
  catalog_source_reference platform_helpers.uuid_v7 NOT NULL,
  platform_template_reference platform_helpers.uuid_v7 NOT NULL,
  override_allowed_field_codes text[] NOT NULL DEFAULT '{}'::text[] CHECK (cardinality(override_allowed_field_codes) <= 100),
  hard_requirement_field_codes text[] NOT NULL DEFAULT '{}'::text[] CHECK (cardinality(hard_requirement_field_codes) <= 100),
  effective_from timestamp with time zone NOT NULL,
  effective_until timestamp with time zone,
  supersedes_version_reference platform_helpers.uuid_v7,
  reason_code text NOT NULL CHECK (reason_code ~ '^[A-Z][A-Z0-9_.:-]{0,63}$'),
  authored_by_reference platform_helpers.uuid_v7 NOT NULL,
  approved_by_reference platform_helpers.uuid_v7,
  approval_evidence_reference platform_helpers.uuid_v7,
  publication_reference platform_helpers.uuid_v7,
  created_at timestamp with time zone NOT NULL,
  updated_at timestamp with time zone NOT NULL,
  data_classification text NOT NULL CHECK (data_classification = 'ConfigurationMetadata'),
  CONSTRAINT brand_configuration_version_pkey PRIMARY KEY (brand_id, configuration_version_id),
  CONSTRAINT brand_configuration_version_unique UNIQUE (brand_id, configuration_version),
  CONSTRAINT brand_configuration_period CHECK (effective_until IS NULL OR effective_until > effective_from),
  CONSTRAINT brand_configuration_time CHECK (updated_at >= created_at),
  CONSTRAINT brand_configuration_locale CHECK (default_locale = ANY(supported_locales)),
  CONSTRAINT brand_configuration_field_policy CHECK (
    NOT override_allowed_field_codes && hard_requirement_field_codes
  ),
  CONSTRAINT brand_configuration_supersession CHECK (
    (configuration_version = 1) = (supersedes_version_reference IS NULL)
  ),
  CONSTRAINT brand_configuration_approval_shape CHECK (
    (approved_by_reference IS NULL) = (approval_evidence_reference IS NULL)
    AND (approved_by_reference IS NULL OR approved_by_reference <> authored_by_reference)
    AND (lifecycle IN ('Draft','PendingApproval')) = (approved_by_reference IS NULL)
    AND ((lifecycle IN ('Published','Superseded','Archived')) = (publication_reference IS NOT NULL))
  )
);

CREATE TABLE bop_tenant.brand_store_membership_record (
  membership_record_id platform_helpers.uuid_v7 NOT NULL,
  brand_id platform_helpers.uuid_v7 NOT NULL,
  store_id platform_helpers.uuid_v7 NOT NULL,
  action text NOT NULL CHECK (action IN ('Added','Removed')),
  effective_at timestamp with time zone NOT NULL,
  brand_version bigint NOT NULL CHECK (brand_version > 0),
  actor_reference platform_helpers.uuid_v7 NOT NULL,
  approval_evidence_reference platform_helpers.uuid_v7 NOT NULL,
  operation_reference platform_helpers.uuid_v7 NOT NULL,
  recorded_at timestamp with time zone NOT NULL CHECK (recorded_at >= effective_at),
  data_classification text NOT NULL CHECK (data_classification = 'ConfigurationMetadata'),
  CONSTRAINT brand_store_membership_record_pkey PRIMARY KEY (brand_id, membership_record_id),
  CONSTRAINT brand_store_membership_store_fkey FOREIGN KEY (store_id,brand_id)
    REFERENCES bop_tenant.store (store_id,brand_id),
  CONSTRAINT brand_store_membership_operation_unique UNIQUE (brand_id,operation_reference)
);

CREATE TABLE bop_tenant.brand_admin_operation (
  operation_id platform_helpers.uuid_v7 NOT NULL,
  brand_id platform_helpers.uuid_v7 NOT NULL REFERENCES bop_tenant.brand (brand_id),
  command_type text NOT NULL CHECK (command_type IN (
    'CreateBrand','ActivateBrand','ArchiveBrand','SaveConfigurationDraft','SubmitConfiguration',
    'ApproveConfiguration','PublishConfiguration','AddStoreMembership','RemoveStoreMembership'
  )),
  intent_digest text NOT NULL CHECK (intent_digest ~ '^sha256:[0-9a-f]{64}$'),
  brand_version bigint NOT NULL CHECK (brand_version > 0),
  actor_reference platform_helpers.uuid_v7 NOT NULL,
  purpose_code text NOT NULL CHECK (purpose_code ~ '^[A-Z][A-Z0-9_.:-]{0,63}$'),
  audit_reference platform_helpers.uuid_v7 NOT NULL,
  occurred_at timestamp with time zone NOT NULL,
  data_classification text NOT NULL CHECK (data_classification = 'ConfigurationMetadata'),
  CONSTRAINT brand_admin_operation_pkey PRIMARY KEY (brand_id,operation_id)
);

CREATE INDEX brand_configuration_admin_idx ON bop_tenant.brand_configuration_version
  (brand_id,lifecycle,effective_from,configuration_version DESC);
CREATE INDEX brand_store_membership_admin_idx ON bop_tenant.brand_store_membership_record
  (brand_id,store_id,recorded_at DESC,membership_record_id DESC);

CREATE TRIGGER brand_revision_trigger BEFORE UPDATE ON bop_tenant.brand
  FOR EACH ROW EXECUTE FUNCTION bop_tenant.enforce_organization_revision();
CREATE RULE brand_no_delete AS ON DELETE TO bop_tenant.brand DO INSTEAD NOTHING;
CREATE TRIGGER store_revision_trigger BEFORE UPDATE ON bop_tenant.store
  FOR EACH ROW EXECUTE FUNCTION bop_tenant.enforce_organization_revision();
CREATE RULE store_no_delete AS ON DELETE TO bop_tenant.store DO INSTEAD NOTHING;
CREATE TRIGGER brand_configuration_no_update_trigger BEFORE UPDATE ON bop_tenant.brand_configuration_version
  FOR EACH ROW EXECUTE FUNCTION bop_tenant.reject_brand_admin_history_update();
CREATE RULE brand_configuration_no_delete AS ON DELETE TO bop_tenant.brand_configuration_version DO INSTEAD NOTHING;
CREATE TRIGGER brand_store_membership_sequence_trigger BEFORE INSERT ON bop_tenant.brand_store_membership_record
  FOR EACH ROW EXECUTE FUNCTION bop_tenant.enforce_membership_sequence();
CREATE TRIGGER brand_store_membership_no_update_trigger BEFORE UPDATE ON bop_tenant.brand_store_membership_record
  FOR EACH ROW EXECUTE FUNCTION bop_tenant.reject_brand_admin_history_update();
CREATE RULE brand_store_membership_no_delete AS ON DELETE TO bop_tenant.brand_store_membership_record DO INSTEAD NOTHING;
CREATE TRIGGER brand_admin_operation_no_update_trigger BEFORE UPDATE ON bop_tenant.brand_admin_operation
  FOR EACH ROW EXECUTE FUNCTION bop_tenant.reject_brand_admin_history_update();
CREATE RULE brand_admin_operation_no_delete AS ON DELETE TO bop_tenant.brand_admin_operation DO INSTEAD NOTHING;

ALTER TABLE bop_tenant.brand_configuration_version ENABLE ROW LEVEL SECURITY;
ALTER TABLE bop_tenant.brand_configuration_version FORCE ROW LEVEL SECURITY;
ALTER TABLE bop_tenant.brand_store_membership_record ENABLE ROW LEVEL SECURITY;
ALTER TABLE bop_tenant.brand_store_membership_record FORCE ROW LEVEL SECURITY;
ALTER TABLE bop_tenant.brand_admin_operation ENABLE ROW LEVEL SECURITY;
ALTER TABLE bop_tenant.brand_admin_operation FORCE ROW LEVEL SECURITY;
CREATE POLICY brand_configuration_scope_policy ON bop_tenant.brand_configuration_version
  USING (brand_id=platform_helpers.current_brand_id() AND platform_helpers.current_store_id() IS NULL)
  WITH CHECK (brand_id=platform_helpers.current_brand_id() AND platform_helpers.current_store_id() IS NULL);
CREATE POLICY brand_store_membership_scope_policy ON bop_tenant.brand_store_membership_record
  USING (brand_id=platform_helpers.current_brand_id() AND platform_helpers.current_store_id() IS NULL)
  WITH CHECK (brand_id=platform_helpers.current_brand_id() AND platform_helpers.current_store_id() IS NULL);
CREATE POLICY brand_admin_operation_scope_policy ON bop_tenant.brand_admin_operation
  USING (brand_id=platform_helpers.current_brand_id() AND platform_helpers.current_store_id() IS NULL)
  WITH CHECK (brand_id=platform_helpers.current_brand_id() AND platform_helpers.current_store_id() IS NULL);
REVOKE ALL ON TABLE bop_tenant.brand_configuration_version FROM PUBLIC;
REVOKE ALL ON TABLE bop_tenant.brand_store_membership_record FROM PUBLIC;
REVOKE ALL ON TABLE bop_tenant.brand_admin_operation FROM PUBLIC;
