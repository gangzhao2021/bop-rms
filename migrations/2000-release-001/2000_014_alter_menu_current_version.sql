-- bop-rms-migration: 1
-- owner: @rms/catalog
-- schema: rms_catalog
-- phase: expand
-- risk: medium
-- transaction: required
-- lock-timeout-ms: 5000
-- statement-timeout-ms: 60000
-- recovery: forward-fix
-- WP-2423 / DEC-MENU-REVISION: a Menu keeps every version it has published. A Menu points at its current
-- version (the one being edited, reviewed or last published); revising a submitted or published
-- version starts a new version copied from it. Once a version has been submitted for review its
-- content (sections, placements, Stores, channels, order types) can no longer change, so the
-- published Menu customers order from is exactly what was reviewed.
ALTER TABLE rms_catalog.menu ADD COLUMN current_version_id platform_helpers.uuid_v7;
UPDATE rms_catalog.menu m SET current_version_id = v.menu_version_id
  FROM rms_catalog.menu_version v WHERE v.menu_id = m.menu_id AND v.brand_id = m.brand_id;
ALTER TABLE rms_catalog.menu
  ADD CONSTRAINT menu_current_version_fk
  FOREIGN KEY (current_version_id, menu_id, brand_id)
  REFERENCES rms_catalog.menu_version (menu_version_id, menu_id, brand_id)
  DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE rms_catalog.menu_version DROP CONSTRAINT menu_one_draft_unique;
-- Section codes and order are unique within a version (each version has its own sections).
ALTER TABLE rms_catalog.menu_section DROP CONSTRAINT menu_section_code_unique;
ALTER TABLE rms_catalog.menu_section DROP CONSTRAINT menu_section_sort_unique;
ALTER TABLE rms_catalog.menu_section
  ADD CONSTRAINT menu_section_code_unique UNIQUE (menu_version_id, internal_code);
ALTER TABLE rms_catalog.menu_section
  ADD CONSTRAINT menu_section_sort_unique UNIQUE (menu_version_id, sort_order);
ALTER TABLE rms_catalog.menu_version ADD COLUMN revision_of_version_id platform_helpers.uuid_v7;
ALTER TABLE rms_catalog.menu_version
  ADD CONSTRAINT menu_version_revision_of_fk
  FOREIGN KEY (revision_of_version_id, menu_id, brand_id)
  REFERENCES rms_catalog.menu_version (menu_version_id, menu_id, brand_id);
ALTER TABLE rms_catalog.menu_operation_record DROP CONSTRAINT menu_operation_record_action_code_check;
ALTER TABLE rms_catalog.menu_operation_record
  ADD CONSTRAINT menu_operation_record_action_code_check
  CHECK (action_code IN ('Create', 'ReplaceDraft', 'Revise'));

-- A Menu's first version becomes its current version (existing writers insert the Menu first).
CREATE FUNCTION rms_catalog.default_menu_current_version() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog
AS $$
BEGIN
  UPDATE rms_catalog.menu SET current_version_id = NEW.menu_version_id
   WHERE menu_id = NEW.menu_id AND brand_id = NEW.brand_id AND current_version_id IS NULL;
  RETURN NULL;
END;
$$;
REVOKE ALL ON FUNCTION rms_catalog.default_menu_current_version() FROM PUBLIC;
CREATE TRIGGER menu_version_default_current
  AFTER INSERT ON rms_catalog.menu_version
  FOR EACH ROW EXECUTE FUNCTION rms_catalog.default_menu_current_version();

-- Submitted versions are frozen.
CREATE FUNCTION rms_catalog.menu_version_submitted(version_id uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = pg_catalog
AS $$
  SELECT EXISTS (SELECT 1 FROM rms_catalog.menu_review_content c WHERE c.menu_version_id = version_id)
      OR EXISTS (SELECT 1 FROM rms_catalog.menu_publication_revision r WHERE r.menu_version_id = version_id)
$$;
REVOKE ALL ON FUNCTION rms_catalog.menu_version_submitted(uuid) FROM PUBLIC;
CREATE FUNCTION rms_catalog.reject_submitted_menu_version_change() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
  row_value jsonb := to_jsonb(CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END);
  version_id uuid;
BEGIN
  IF TG_TABLE_NAME = 'sellable_placement' THEN
    SELECT s.menu_version_id INTO version_id FROM rms_catalog.menu_section s
     WHERE s.menu_section_id = (row_value->>'menu_section_id')::uuid;
  ELSIF TG_TABLE_NAME = 'menu_section_category' THEN
    SELECT s.menu_version_id INTO version_id FROM rms_catalog.menu_section s
     WHERE s.menu_section_id = (row_value->>'menu_section_id')::uuid;
  ELSE
    version_id := (row_value->>'menu_version_id')::uuid;
  END IF;
  IF version_id IS NOT NULL AND rms_catalog.menu_version_submitted(version_id) THEN
    RAISE EXCEPTION 'A submitted Menu version cannot change; revise the Menu instead'
      USING ERRCODE = '55000';
  END IF;
  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END;
$$;
REVOKE ALL ON FUNCTION rms_catalog.reject_submitted_menu_version_change() FROM PUBLIC;
CREATE TRIGGER menu_version_submitted_frozen
  BEFORE UPDATE ON rms_catalog.menu_version
  FOR EACH ROW EXECUTE FUNCTION rms_catalog.reject_submitted_menu_version_change();
CREATE TRIGGER menu_section_submitted_frozen
  BEFORE INSERT OR UPDATE OR DELETE ON rms_catalog.menu_section
  FOR EACH ROW EXECUTE FUNCTION rms_catalog.reject_submitted_menu_version_change();
CREATE TRIGGER sellable_placement_submitted_frozen
  BEFORE INSERT OR UPDATE OR DELETE ON rms_catalog.sellable_placement
  FOR EACH ROW EXECUTE FUNCTION rms_catalog.reject_submitted_menu_version_change();
CREATE TRIGGER menu_section_category_submitted_frozen
  BEFORE INSERT OR UPDATE OR DELETE ON rms_catalog.menu_section_category
  FOR EACH ROW EXECUTE FUNCTION rms_catalog.reject_submitted_menu_version_change();
CREATE TRIGGER menu_version_store_submitted_frozen
  BEFORE INSERT OR UPDATE OR DELETE ON rms_catalog.menu_version_store
  FOR EACH ROW EXECUTE FUNCTION rms_catalog.reject_submitted_menu_version_change();
CREATE TRIGGER menu_version_channel_submitted_frozen
  BEFORE INSERT OR UPDATE OR DELETE ON rms_catalog.menu_version_channel
  FOR EACH ROW EXECUTE FUNCTION rms_catalog.reject_submitted_menu_version_change();
CREATE TRIGGER menu_version_order_type_submitted_frozen
  BEFORE INSERT OR UPDATE OR DELETE ON rms_catalog.menu_version_order_type
  FOR EACH ROW EXECUTE FUNCTION rms_catalog.reject_submitted_menu_version_change();

-- The exact Menu aggregate each operation produced, for replay of a retried operation.
CREATE TABLE rms_catalog.menu_operation_snapshot (
  operation_id platform_helpers.uuid_v7 PRIMARY KEY
    REFERENCES rms_catalog.menu_operation_record (operation_id),
  brand_id platform_helpers.uuid_v7 NOT NULL,
  menu_id platform_helpers.uuid_v7 NOT NULL,
  result_aggregate_version integer NOT NULL CHECK (result_aggregate_version > 0),
  occurred_at timestamp with time zone NOT NULL
    CHECK (date_trunc('milliseconds', occurred_at) = occurred_at),
  snapshot_json jsonb NOT NULL CHECK (
    jsonb_typeof(snapshot_json) = 'object' AND octet_length(snapshot_json::text) <= 4194304
  ),
  CONSTRAINT menu_operation_snapshot_menu_fk
    FOREIGN KEY (menu_id, brand_id) REFERENCES rms_catalog.menu (menu_id, brand_id)
);
CREATE RULE menu_operation_snapshot_no_update AS
  ON UPDATE TO rms_catalog.menu_operation_snapshot DO INSTEAD NOTHING;
CREATE RULE menu_operation_snapshot_no_delete AS
  ON DELETE TO rms_catalog.menu_operation_snapshot DO INSTEAD NOTHING;
ALTER TABLE rms_catalog.menu_operation_snapshot ENABLE ROW LEVEL SECURITY;
ALTER TABLE rms_catalog.menu_operation_snapshot FORCE ROW LEVEL SECURITY;
CREATE POLICY menu_operation_snapshot_brand_scope_policy ON rms_catalog.menu_operation_snapshot
  USING (brand_id::uuid = platform_helpers.current_brand_id() AND platform_helpers.current_store_id() IS NULL)
  WITH CHECK (brand_id::uuid = platform_helpers.current_brand_id() AND platform_helpers.current_store_id() IS NULL);
REVOKE ALL ON TABLE rms_catalog.menu_operation_snapshot FROM PUBLIC;
