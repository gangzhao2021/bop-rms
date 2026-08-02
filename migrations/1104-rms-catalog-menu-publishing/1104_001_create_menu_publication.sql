-- bop-rms-migration: 1
-- owner: @rms/catalog
-- schema: rms_catalog
-- phase: expand
-- risk: medium
-- transaction: required
-- lock-timeout-ms: 5000
-- statement-timeout-ms: 60000
-- recovery: forward-fix
CREATE TABLE rms_catalog.menu_publication_revision (
  lifecycle_id platform_helpers.uuid_v7 NOT NULL,
  lifecycle_version integer NOT NULL CHECK (lifecycle_version > 0),
  menu_id platform_helpers.uuid_v7 NOT NULL,
  menu_version_id platform_helpers.uuid_v7 NOT NULL,
  brand_id platform_helpers.uuid_v7 NOT NULL,
  snapshot_digest text NOT NULL CHECK (snapshot_digest ~ '^sha256:[0-9a-f]{64}$'),
  state text NOT NULL CHECK (state IN ('Draft', 'InReview', 'Approved', 'Published', 'Archived', 'Superseded')),
  validation_evidence_id platform_helpers.uuid_v7,
  approval_evidence_id platform_helpers.uuid_v7,
  changed_at timestamp with time zone NOT NULL,
  PRIMARY KEY (lifecycle_id, lifecycle_version),
  CONSTRAINT menu_publication_version_fk
    FOREIGN KEY (menu_version_id, menu_id, brand_id)
    REFERENCES rms_catalog.menu_version (menu_version_id, menu_id, brand_id),
  CONSTRAINT menu_publication_state_evidence_check CHECK (
    (state = 'Draft' AND validation_evidence_id IS NULL AND approval_evidence_id IS NULL)
    OR (state = 'InReview' AND validation_evidence_id IS NOT NULL AND approval_evidence_id IS NULL)
    OR (state IN ('Approved', 'Published', 'Archived', 'Superseded')
      AND validation_evidence_id IS NOT NULL AND approval_evidence_id IS NOT NULL)
  )
);

CREATE TABLE rms_catalog.menu_publication_release (
  release_id platform_helpers.uuid_v7 PRIMARY KEY,
  lifecycle_id platform_helpers.uuid_v7 NOT NULL,
  lifecycle_version integer NOT NULL,
  menu_id platform_helpers.uuid_v7 NOT NULL,
  menu_version_id platform_helpers.uuid_v7 NOT NULL,
  brand_id platform_helpers.uuid_v7 NOT NULL,
  release_sequence integer NOT NULL CHECK (release_sequence > 0),
  previous_release_id platform_helpers.uuid_v7,
  release_kind text NOT NULL CHECK (release_kind IN ('Publish', 'Roll' || 'back')),
  snapshot_digest text NOT NULL CHECK (snapshot_digest ~ '^sha256:[0-9a-f]{64}$'),
  created_at timestamp with time zone NOT NULL,
  CONSTRAINT menu_release_revision_fk
    FOREIGN KEY (lifecycle_id, lifecycle_version)
    REFERENCES rms_catalog.menu_publication_revision (lifecycle_id, lifecycle_version),
  CONSTRAINT menu_release_version_fk
    FOREIGN KEY (menu_version_id, menu_id, brand_id)
    REFERENCES rms_catalog.menu_version (menu_version_id, menu_id, brand_id),
  CONSTRAINT menu_release_previous_fk
    FOREIGN KEY (previous_release_id)
    REFERENCES rms_catalog.menu_publication_release (release_id),
  CONSTRAINT menu_release_sequence_unique UNIQUE (menu_id, release_sequence),
  CONSTRAINT menu_release_version_unique UNIQUE (release_id, menu_id, brand_id)
);

CREATE TABLE rms_catalog.menu_release_effective_period (
  timing_version_id platform_helpers.uuid_v7 PRIMARY KEY,
  release_id platform_helpers.uuid_v7 NOT NULL,
  menu_id platform_helpers.uuid_v7 NOT NULL,
  brand_id platform_helpers.uuid_v7 NOT NULL,
  time_zone text NOT NULL CHECK (char_length(time_zone) BETWEEN 1 AND 63),
  effective_from timestamp with time zone NOT NULL,
  effective_until timestamp with time zone,
  period_digest text NOT NULL CHECK (period_digest ~ '^sha256:[0-9a-f]{64}$'),
  approval_evidence_id platform_helpers.uuid_v7 NOT NULL,
  created_at timestamp with time zone NOT NULL,
  CONSTRAINT menu_effective_release_fk
    FOREIGN KEY (release_id, menu_id, brand_id)
    REFERENCES rms_catalog.menu_publication_release (release_id, menu_id, brand_id),
  CONSTRAINT menu_effective_time_order CHECK (
    effective_until IS NULL OR effective_until > effective_from
  )
);

CREATE FUNCTION rms_catalog.reject_menu_effective_overlap() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM rms_catalog.menu_release_effective_period AS current
    WHERE current.menu_id = NEW.menu_id
      AND current.brand_id = NEW.brand_id
      AND current.timing_version_id <> NEW.timing_version_id
      AND tstzrange(current.effective_from, current.effective_until, '[)')
        && tstzrange(NEW.effective_from, NEW.effective_until, '[)')
  ) THEN
    RAISE EXCEPTION 'overlapping menu effective period';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER menu_effective_overlap_guard
BEFORE INSERT OR UPDATE OF effective_from, effective_until, menu_id, brand_id
ON rms_catalog.menu_release_effective_period
FOR EACH ROW EXECUTE FUNCTION rms_catalog.reject_menu_effective_overlap();

CREATE TABLE rms_catalog.menu_publication_operation_record (
  operation_id platform_helpers.uuid_v7 PRIMARY KEY,
  brand_id platform_helpers.uuid_v7 NOT NULL,
  menu_id platform_helpers.uuid_v7 NOT NULL,
  menu_version_id platform_helpers.uuid_v7 NOT NULL,
  action_code text NOT NULL CHECK (action_code IN ('SubmitReview', 'Approve', 'Publish', 'Archive')),
  intent_digest text NOT NULL CHECK (intent_digest ~ '^sha256:[0-9a-f]{64}$'),
  result_lifecycle_version integer NOT NULL CHECK (result_lifecycle_version > 0),
  occurred_at timestamp with time zone NOT NULL,
  CONSTRAINT menu_publication_operation_version_fk
    FOREIGN KEY (menu_version_id, menu_id, brand_id)
    REFERENCES rms_catalog.menu_version (menu_version_id, menu_id, brand_id)
);

CREATE RULE menu_publication_revision_no_update AS
  ON UPDATE TO rms_catalog.menu_publication_revision DO INSTEAD NOTHING;
CREATE RULE menu_publication_revision_no_delete AS
  ON DELETE TO rms_catalog.menu_publication_revision DO INSTEAD NOTHING;
CREATE RULE menu_publication_release_no_update AS
  ON UPDATE TO rms_catalog.menu_publication_release DO INSTEAD NOTHING;
CREATE RULE menu_publication_release_no_delete AS
  ON DELETE TO rms_catalog.menu_publication_release DO INSTEAD NOTHING;
CREATE RULE menu_release_effective_no_update AS
  ON UPDATE TO rms_catalog.menu_release_effective_period DO INSTEAD NOTHING;
CREATE RULE menu_release_effective_no_delete AS
  ON DELETE TO rms_catalog.menu_release_effective_period DO INSTEAD NOTHING;
CREATE RULE menu_publication_operation_no_update AS
  ON UPDATE TO rms_catalog.menu_publication_operation_record DO INSTEAD NOTHING;
CREATE RULE menu_publication_operation_no_delete AS
  ON DELETE TO rms_catalog.menu_publication_operation_record DO INSTEAD NOTHING;

ALTER TABLE rms_catalog.menu_publication_revision ENABLE ROW LEVEL SECURITY;
ALTER TABLE rms_catalog.menu_publication_revision FORCE ROW LEVEL SECURITY;
ALTER TABLE rms_catalog.menu_publication_release ENABLE ROW LEVEL SECURITY;
ALTER TABLE rms_catalog.menu_publication_release FORCE ROW LEVEL SECURITY;
ALTER TABLE rms_catalog.menu_release_effective_period ENABLE ROW LEVEL SECURITY;
ALTER TABLE rms_catalog.menu_release_effective_period FORCE ROW LEVEL SECURITY;
ALTER TABLE rms_catalog.menu_publication_operation_record ENABLE ROW LEVEL SECURITY;
ALTER TABLE rms_catalog.menu_publication_operation_record FORCE ROW LEVEL SECURITY;

CREATE POLICY menu_publication_revision_brand_policy ON rms_catalog.menu_publication_revision
  USING (brand_id = platform_helpers.current_brand_id() AND platform_helpers.current_store_id() IS NULL)
  WITH CHECK (brand_id = platform_helpers.current_brand_id() AND platform_helpers.current_store_id() IS NULL);
CREATE POLICY menu_publication_release_brand_policy ON rms_catalog.menu_publication_release
  USING (brand_id = platform_helpers.current_brand_id() AND platform_helpers.current_store_id() IS NULL)
  WITH CHECK (brand_id = platform_helpers.current_brand_id() AND platform_helpers.current_store_id() IS NULL);
CREATE POLICY menu_release_effective_brand_policy ON rms_catalog.menu_release_effective_period
  USING (brand_id = platform_helpers.current_brand_id() AND platform_helpers.current_store_id() IS NULL)
  WITH CHECK (brand_id = platform_helpers.current_brand_id() AND platform_helpers.current_store_id() IS NULL);
CREATE POLICY menu_publication_operation_brand_policy ON rms_catalog.menu_publication_operation_record
  USING (brand_id = platform_helpers.current_brand_id() AND platform_helpers.current_store_id() IS NULL)
  WITH CHECK (brand_id = platform_helpers.current_brand_id() AND platform_helpers.current_store_id() IS NULL);

REVOKE ALL ON TABLE rms_catalog.menu_publication_revision FROM PUBLIC;
REVOKE ALL ON TABLE rms_catalog.menu_publication_release FROM PUBLIC;
REVOKE ALL ON TABLE rms_catalog.menu_release_effective_period FROM PUBLIC;
REVOKE ALL ON TABLE rms_catalog.menu_publication_operation_record FROM PUBLIC;
