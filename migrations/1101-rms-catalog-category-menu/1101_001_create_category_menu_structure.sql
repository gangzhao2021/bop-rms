-- bop-rms-migration: 1
-- owner: @rms/catalog
-- schema: rms_catalog
-- phase: expand
-- risk: medium
-- transaction: required
-- lock-timeout-ms: 5000
-- statement-timeout-ms: 60000
-- recovery: forward-fix
CREATE TABLE rms_catalog.category (
  category_id platform_helpers.uuid_v7 PRIMARY KEY,
  brand_id platform_helpers.uuid_v7 NOT NULL,
  internal_code text NOT NULL CHECK (internal_code ~ '^[A-Z][A-Z0-9_-]{0,63}$'),
  lifecycle text NOT NULL CHECK (lifecycle IN ('Draft', 'Active', 'Inactive', 'Archived')),
  aggregate_version integer NOT NULL CHECK (aggregate_version > 0),
  default_locale text NOT NULL CHECK (char_length(default_locale) BETWEEN 2 AND 35),
  localized_names_json jsonb NOT NULL CHECK (jsonb_typeof(localized_names_json) = 'object'),
  localized_descriptions_json jsonb NOT NULL CHECK (
    jsonb_typeof(localized_descriptions_json) = 'object'
  ),
  parent_category_id platform_helpers.uuid_v7,
  tree_level smallint NOT NULL CHECK (tree_level BETWEEN 1 AND 3),
  sort_order integer NOT NULL CHECK (sort_order >= 0),
  store_ids_json jsonb NOT NULL CHECK (jsonb_typeof(store_ids_json) = 'array'),
  created_at timestamp with time zone NOT NULL,
  created_by_actor_id platform_helpers.uuid_v7 NOT NULL,
  updated_at timestamp with time zone NOT NULL,
  CONSTRAINT category_brand_code_unique UNIQUE (brand_id, internal_code),
  CONSTRAINT category_brand_identity_unique UNIQUE (category_id, brand_id),
  CONSTRAINT category_parent_not_self CHECK (parent_category_id IS DISTINCT FROM category_id),
  CONSTRAINT category_time_order_check CHECK (updated_at >= created_at),
  CONSTRAINT category_parent_fk
    FOREIGN KEY (parent_category_id, brand_id)
    REFERENCES rms_catalog.category (category_id, brand_id)
);

CREATE UNIQUE INDEX category_root_sort_unique
  ON rms_catalog.category (brand_id, sort_order)
  WHERE parent_category_id IS NULL;
CREATE UNIQUE INDEX category_child_sort_unique
  ON rms_catalog.category (brand_id, parent_category_id, sort_order)
  WHERE parent_category_id IS NOT NULL;

CREATE TABLE rms_catalog.category_operation_record (
  operation_id platform_helpers.uuid_v7 PRIMARY KEY,
  brand_id platform_helpers.uuid_v7 NOT NULL,
  category_id platform_helpers.uuid_v7 NOT NULL,
  action_code text NOT NULL CHECK (action_code IN ('Create', 'Move', 'ChangeLifecycle')),
  intent_digest text NOT NULL CHECK (intent_digest ~ '^sha256:[0-9a-f]{64}$'),
  result_aggregate_version integer NOT NULL CHECK (result_aggregate_version > 0),
  occurred_at timestamp with time zone NOT NULL,
  CONSTRAINT category_operation_category_fk
    FOREIGN KEY (category_id, brand_id)
    REFERENCES rms_catalog.category (category_id, brand_id)
);

CREATE TABLE rms_catalog.menu (
  menu_id platform_helpers.uuid_v7 PRIMARY KEY,
  brand_id platform_helpers.uuid_v7 NOT NULL,
  internal_code text NOT NULL CHECK (internal_code ~ '^[A-Z][A-Z0-9_-]{0,63}$'),
  aggregate_version integer NOT NULL CHECK (aggregate_version > 0),
  created_at timestamp with time zone NOT NULL,
  created_by_actor_id platform_helpers.uuid_v7 NOT NULL,
  updated_at timestamp with time zone NOT NULL,
  CONSTRAINT menu_brand_code_unique UNIQUE (brand_id, internal_code),
  CONSTRAINT menu_brand_identity_unique UNIQUE (menu_id, brand_id),
  CONSTRAINT menu_time_order_check CHECK (updated_at >= created_at)
);

CREATE TABLE rms_catalog.menu_version (
  menu_version_id platform_helpers.uuid_v7 PRIMARY KEY,
  menu_id platform_helpers.uuid_v7 NOT NULL,
  brand_id platform_helpers.uuid_v7 NOT NULL,
  status text NOT NULL CHECK (status = 'Draft'),
  base_menu_id platform_helpers.uuid_v7,
  default_locale text NOT NULL CHECK (char_length(default_locale) BETWEEN 2 AND 35),
  localized_names_json jsonb NOT NULL CHECK (jsonb_typeof(localized_names_json) = 'object'),
  created_at timestamp with time zone NOT NULL,
  updated_at timestamp with time zone NOT NULL,
  CONSTRAINT menu_version_menu_fk
    FOREIGN KEY (menu_id, brand_id)
    REFERENCES rms_catalog.menu (menu_id, brand_id),
  CONSTRAINT menu_version_base_fk
    FOREIGN KEY (base_menu_id, brand_id)
    REFERENCES rms_catalog.menu (menu_id, brand_id),
  CONSTRAINT menu_version_not_self CHECK (base_menu_id IS DISTINCT FROM menu_id),
  CONSTRAINT menu_version_identity_unique UNIQUE (menu_version_id, menu_id, brand_id),
  CONSTRAINT menu_one_draft_unique UNIQUE (menu_id, status),
  CONSTRAINT menu_version_time_order_check CHECK (updated_at >= created_at)
);

CREATE TABLE rms_catalog.menu_version_store (
  menu_version_id platform_helpers.uuid_v7 NOT NULL,
  menu_id platform_helpers.uuid_v7 NOT NULL,
  brand_id platform_helpers.uuid_v7 NOT NULL,
  store_id platform_helpers.uuid_v7 NOT NULL,
  PRIMARY KEY (menu_version_id, store_id),
  CONSTRAINT menu_version_store_version_fk
    FOREIGN KEY (menu_version_id, menu_id, brand_id)
    REFERENCES rms_catalog.menu_version (menu_version_id, menu_id, brand_id)
);

CREATE TABLE rms_catalog.menu_version_channel (
  menu_version_id platform_helpers.uuid_v7 NOT NULL,
  menu_id platform_helpers.uuid_v7 NOT NULL,
  brand_id platform_helpers.uuid_v7 NOT NULL,
  channel_code text NOT NULL CHECK (channel_code ~ '^[A-Z][A-Z0-9_-]{0,63}$'),
  PRIMARY KEY (menu_version_id, channel_code),
  CONSTRAINT menu_version_channel_version_fk
    FOREIGN KEY (menu_version_id, menu_id, brand_id)
    REFERENCES rms_catalog.menu_version (menu_version_id, menu_id, brand_id)
);

CREATE TABLE rms_catalog.menu_version_order_type (
  menu_version_id platform_helpers.uuid_v7 NOT NULL,
  menu_id platform_helpers.uuid_v7 NOT NULL,
  brand_id platform_helpers.uuid_v7 NOT NULL,
  order_type_code text NOT NULL CHECK (order_type_code ~ '^[A-Z][A-Z0-9_-]{0,63}$'),
  PRIMARY KEY (menu_version_id, order_type_code),
  CONSTRAINT menu_version_order_type_version_fk
    FOREIGN KEY (menu_version_id, menu_id, brand_id)
    REFERENCES rms_catalog.menu_version (menu_version_id, menu_id, brand_id)
);

CREATE TABLE rms_catalog.menu_section (
  menu_section_id platform_helpers.uuid_v7 PRIMARY KEY,
  menu_version_id platform_helpers.uuid_v7 NOT NULL,
  menu_id platform_helpers.uuid_v7 NOT NULL,
  brand_id platform_helpers.uuid_v7 NOT NULL,
  internal_code text NOT NULL CHECK (internal_code ~ '^[A-Z][A-Z0-9_-]{0,63}$'),
  localized_names_json jsonb NOT NULL CHECK (jsonb_typeof(localized_names_json) = 'object'),
  sort_order integer NOT NULL CHECK (sort_order >= 0),
  CONSTRAINT menu_section_version_fk
    FOREIGN KEY (menu_version_id, menu_id, brand_id)
    REFERENCES rms_catalog.menu_version (menu_version_id, menu_id, brand_id),
  CONSTRAINT menu_section_identity_unique UNIQUE (menu_section_id, menu_id, brand_id),
  CONSTRAINT menu_section_code_unique UNIQUE (menu_id, internal_code),
  CONSTRAINT menu_section_sort_unique UNIQUE (menu_id, sort_order)
);

CREATE TABLE rms_catalog.menu_section_category (
  menu_section_id platform_helpers.uuid_v7 NOT NULL,
  menu_id platform_helpers.uuid_v7 NOT NULL,
  brand_id platform_helpers.uuid_v7 NOT NULL,
  category_id platform_helpers.uuid_v7 NOT NULL,
  PRIMARY KEY (menu_section_id, category_id),
  CONSTRAINT menu_section_category_section_fk
    FOREIGN KEY (menu_section_id, menu_id, brand_id)
    REFERENCES rms_catalog.menu_section (menu_section_id, menu_id, brand_id),
  CONSTRAINT menu_section_category_category_fk
    FOREIGN KEY (category_id, brand_id)
    REFERENCES rms_catalog.category (category_id, brand_id)
);

CREATE UNIQUE INDEX sku_brand_identity_for_placement_unique
  ON rms_catalog.sku (sku_id, brand_id);

CREATE TABLE rms_catalog.sellable_placement (
  placement_id platform_helpers.uuid_v7 PRIMARY KEY,
  menu_section_id platform_helpers.uuid_v7 NOT NULL,
  menu_id platform_helpers.uuid_v7 NOT NULL,
  brand_id platform_helpers.uuid_v7 NOT NULL,
  sku_id platform_helpers.uuid_v7 NOT NULL,
  sellable_type text NOT NULL CHECK (sellable_type = 'Sku'),
  presentation_role text NOT NULL CHECK (
    presentation_role IN ('Standard', 'Featured', 'Promotional', 'Sponsored', 'Hidden')
  ),
  sort_order integer NOT NULL CHECK (sort_order >= 0),
  pinned boolean NOT NULL,
  localized_name_overrides_json jsonb NOT NULL CHECK (
    jsonb_typeof(localized_name_overrides_json) = 'object'
  ),
  created_at timestamp with time zone NOT NULL,
  created_by_actor_id platform_helpers.uuid_v7 NOT NULL,
  CONSTRAINT sellable_placement_section_fk
    FOREIGN KEY (menu_section_id, menu_id, brand_id)
    REFERENCES rms_catalog.menu_section (menu_section_id, menu_id, brand_id),
  CONSTRAINT sellable_placement_sku_fk
    FOREIGN KEY (sku_id, brand_id)
    REFERENCES rms_catalog.sku (sku_id, brand_id),
  CONSTRAINT sellable_placement_identity_unique UNIQUE (placement_id, menu_id, brand_id),
  CONSTRAINT sellable_placement_tuple_unique
    UNIQUE (menu_section_id, sku_id, presentation_role),
  CONSTRAINT sellable_placement_sort_unique UNIQUE (menu_section_id, sort_order)
);

CREATE TABLE rms_catalog.menu_operation_record (
  operation_id platform_helpers.uuid_v7 PRIMARY KEY,
  brand_id platform_helpers.uuid_v7 NOT NULL,
  menu_id platform_helpers.uuid_v7 NOT NULL,
  action_code text NOT NULL CHECK (action_code IN ('Create', 'ReplaceDraft')),
  intent_digest text NOT NULL CHECK (intent_digest ~ '^sha256:[0-9a-f]{64}$'),
  result_aggregate_version integer NOT NULL CHECK (result_aggregate_version > 0),
  occurred_at timestamp with time zone NOT NULL,
  CONSTRAINT menu_operation_menu_fk
    FOREIGN KEY (menu_id, brand_id)
    REFERENCES rms_catalog.menu (menu_id, brand_id)
);

CREATE FUNCTION rms_catalog.enforce_category_tree() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
DECLARE
  parent_level smallint;
  cycle_found boolean;
BEGIN
  IF NEW.parent_category_id IS NULL THEN
    IF NEW.tree_level <> 1 THEN RAISE EXCEPTION 'invalid category root level'; END IF;
    RETURN NEW;
  END IF;
  WITH RECURSIVE ancestors(category_id, parent_category_id) AS (
    SELECT category_id, parent_category_id FROM rms_catalog.category
      WHERE category_id = NEW.parent_category_id AND brand_id = NEW.brand_id
    UNION ALL
    SELECT candidate.category_id, candidate.parent_category_id
      FROM rms_catalog.category AS candidate
      JOIN ancestors ON candidate.category_id = ancestors.parent_category_id
      WHERE candidate.brand_id = NEW.brand_id
  )
  SELECT EXISTS (SELECT 1 FROM ancestors WHERE category_id = NEW.category_id) INTO cycle_found;
  IF cycle_found THEN RAISE EXCEPTION 'category cycle'; END IF;
  SELECT tree_level INTO parent_level
    FROM rms_catalog.category
    WHERE category_id = NEW.parent_category_id AND brand_id = NEW.brand_id;
  IF parent_level IS NULL OR NEW.tree_level <> parent_level + 1 OR NEW.tree_level > 3 THEN
    RAISE EXCEPTION 'invalid category parent or depth';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER category_tree_guard
BEFORE INSERT OR UPDATE OF parent_category_id, tree_level, brand_id
ON rms_catalog.category
FOR EACH ROW EXECUTE FUNCTION rms_catalog.enforce_category_tree();

CREATE FUNCTION rms_catalog.enforce_menu_inheritance() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
BEGIN
  IF NEW.base_menu_id IS NULL THEN RETURN NEW; END IF;
  IF EXISTS (
    SELECT 1 FROM rms_catalog.menu_version
    WHERE menu_id = NEW.base_menu_id AND base_menu_id IS NOT NULL
  ) OR EXISTS (
    SELECT 1 FROM rms_catalog.menu_version
    WHERE base_menu_id = NEW.menu_id
  ) THEN
    RAISE EXCEPTION 'multi-level menu inheritance is forbidden';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER menu_inheritance_guard
BEFORE INSERT OR UPDATE OF base_menu_id
ON rms_catalog.menu_version
FOR EACH ROW EXECUTE FUNCTION rms_catalog.enforce_menu_inheritance();

CREATE RULE category_operation_no_update AS
  ON UPDATE TO rms_catalog.category_operation_record DO INSTEAD NOTHING;
CREATE RULE category_operation_no_delete AS
  ON DELETE TO rms_catalog.category_operation_record DO INSTEAD NOTHING;
CREATE RULE menu_operation_no_update AS
  ON UPDATE TO rms_catalog.menu_operation_record DO INSTEAD NOTHING;
CREATE RULE menu_operation_no_delete AS
  ON DELETE TO rms_catalog.menu_operation_record DO INSTEAD NOTHING;
CREATE RULE category_identity_no_update AS
  ON UPDATE TO rms_catalog.category
  WHERE (
    OLD.category_id IS DISTINCT FROM NEW.category_id
    OR OLD.brand_id IS DISTINCT FROM NEW.brand_id
    OR OLD.internal_code IS DISTINCT FROM NEW.internal_code
    OR OLD.created_at IS DISTINCT FROM NEW.created_at
    OR OLD.created_by_actor_id IS DISTINCT FROM NEW.created_by_actor_id
  ) DO INSTEAD NOTHING;
CREATE RULE menu_identity_no_update AS
  ON UPDATE TO rms_catalog.menu
  WHERE (
    OLD.menu_id IS DISTINCT FROM NEW.menu_id
    OR OLD.brand_id IS DISTINCT FROM NEW.brand_id
    OR OLD.internal_code IS DISTINCT FROM NEW.internal_code
    OR OLD.created_at IS DISTINCT FROM NEW.created_at
    OR OLD.created_by_actor_id IS DISTINCT FROM NEW.created_by_actor_id
  ) DO INSTEAD NOTHING;
CREATE RULE menu_version_identity_no_update AS
  ON UPDATE TO rms_catalog.menu_version
  WHERE (
    OLD.menu_version_id IS DISTINCT FROM NEW.menu_version_id
    OR OLD.menu_id IS DISTINCT FROM NEW.menu_id
    OR OLD.brand_id IS DISTINCT FROM NEW.brand_id
    OR OLD.status IS DISTINCT FROM NEW.status
    OR OLD.created_at IS DISTINCT FROM NEW.created_at
  ) DO INSTEAD NOTHING;
CREATE RULE menu_section_identity_no_update AS
  ON UPDATE TO rms_catalog.menu_section
  WHERE (
    OLD.menu_section_id IS DISTINCT FROM NEW.menu_section_id
    OR OLD.menu_id IS DISTINCT FROM NEW.menu_id
    OR OLD.brand_id IS DISTINCT FROM NEW.brand_id
    OR OLD.internal_code IS DISTINCT FROM NEW.internal_code
  ) DO INSTEAD NOTHING;
CREATE RULE placement_identity_no_update AS
  ON UPDATE TO rms_catalog.sellable_placement
  WHERE (
    OLD.placement_id IS DISTINCT FROM NEW.placement_id
    OR OLD.menu_section_id IS DISTINCT FROM NEW.menu_section_id
    OR OLD.menu_id IS DISTINCT FROM NEW.menu_id
    OR OLD.brand_id IS DISTINCT FROM NEW.brand_id
    OR OLD.sku_id IS DISTINCT FROM NEW.sku_id
    OR OLD.created_at IS DISTINCT FROM NEW.created_at
    OR OLD.created_by_actor_id IS DISTINCT FROM NEW.created_by_actor_id
  ) DO INSTEAD NOTHING;

ALTER TABLE rms_catalog.category ENABLE ROW LEVEL SECURITY;
ALTER TABLE rms_catalog.category FORCE ROW LEVEL SECURITY;
ALTER TABLE rms_catalog.category_operation_record ENABLE ROW LEVEL SECURITY;
ALTER TABLE rms_catalog.category_operation_record FORCE ROW LEVEL SECURITY;
ALTER TABLE rms_catalog.menu ENABLE ROW LEVEL SECURITY;
ALTER TABLE rms_catalog.menu FORCE ROW LEVEL SECURITY;
ALTER TABLE rms_catalog.menu_version ENABLE ROW LEVEL SECURITY;
ALTER TABLE rms_catalog.menu_version FORCE ROW LEVEL SECURITY;
ALTER TABLE rms_catalog.menu_version_store ENABLE ROW LEVEL SECURITY;
ALTER TABLE rms_catalog.menu_version_store FORCE ROW LEVEL SECURITY;
ALTER TABLE rms_catalog.menu_version_channel ENABLE ROW LEVEL SECURITY;
ALTER TABLE rms_catalog.menu_version_channel FORCE ROW LEVEL SECURITY;
ALTER TABLE rms_catalog.menu_version_order_type ENABLE ROW LEVEL SECURITY;
ALTER TABLE rms_catalog.menu_version_order_type FORCE ROW LEVEL SECURITY;
ALTER TABLE rms_catalog.menu_section ENABLE ROW LEVEL SECURITY;
ALTER TABLE rms_catalog.menu_section FORCE ROW LEVEL SECURITY;
ALTER TABLE rms_catalog.menu_section_category ENABLE ROW LEVEL SECURITY;
ALTER TABLE rms_catalog.menu_section_category FORCE ROW LEVEL SECURITY;
ALTER TABLE rms_catalog.sellable_placement ENABLE ROW LEVEL SECURITY;
ALTER TABLE rms_catalog.sellable_placement FORCE ROW LEVEL SECURITY;
ALTER TABLE rms_catalog.menu_operation_record ENABLE ROW LEVEL SECURITY;
ALTER TABLE rms_catalog.menu_operation_record FORCE ROW LEVEL SECURITY;

CREATE POLICY category_brand_scope_policy ON rms_catalog.category
  USING (brand_id = platform_helpers.current_brand_id() AND platform_helpers.current_store_id() IS NULL)
  WITH CHECK (brand_id = platform_helpers.current_brand_id() AND platform_helpers.current_store_id() IS NULL);
CREATE POLICY category_operation_brand_scope_policy ON rms_catalog.category_operation_record
  USING (brand_id = platform_helpers.current_brand_id() AND platform_helpers.current_store_id() IS NULL)
  WITH CHECK (brand_id = platform_helpers.current_brand_id() AND platform_helpers.current_store_id() IS NULL);
CREATE POLICY menu_brand_scope_policy ON rms_catalog.menu
  USING (brand_id = platform_helpers.current_brand_id() AND platform_helpers.current_store_id() IS NULL)
  WITH CHECK (brand_id = platform_helpers.current_brand_id() AND platform_helpers.current_store_id() IS NULL);
CREATE POLICY menu_version_brand_scope_policy ON rms_catalog.menu_version
  USING (brand_id = platform_helpers.current_brand_id() AND platform_helpers.current_store_id() IS NULL)
  WITH CHECK (brand_id = platform_helpers.current_brand_id() AND platform_helpers.current_store_id() IS NULL);
CREATE POLICY menu_version_store_brand_scope_policy ON rms_catalog.menu_version_store
  USING (brand_id = platform_helpers.current_brand_id() AND platform_helpers.current_store_id() IS NULL)
  WITH CHECK (brand_id = platform_helpers.current_brand_id() AND platform_helpers.current_store_id() IS NULL);
CREATE POLICY menu_version_channel_brand_scope_policy ON rms_catalog.menu_version_channel
  USING (brand_id = platform_helpers.current_brand_id() AND platform_helpers.current_store_id() IS NULL)
  WITH CHECK (brand_id = platform_helpers.current_brand_id() AND platform_helpers.current_store_id() IS NULL);
CREATE POLICY menu_version_order_type_brand_scope_policy ON rms_catalog.menu_version_order_type
  USING (brand_id = platform_helpers.current_brand_id() AND platform_helpers.current_store_id() IS NULL)
  WITH CHECK (brand_id = platform_helpers.current_brand_id() AND platform_helpers.current_store_id() IS NULL);
CREATE POLICY menu_section_brand_scope_policy ON rms_catalog.menu_section
  USING (brand_id = platform_helpers.current_brand_id() AND platform_helpers.current_store_id() IS NULL)
  WITH CHECK (brand_id = platform_helpers.current_brand_id() AND platform_helpers.current_store_id() IS NULL);
CREATE POLICY menu_section_category_brand_scope_policy ON rms_catalog.menu_section_category
  USING (brand_id = platform_helpers.current_brand_id() AND platform_helpers.current_store_id() IS NULL)
  WITH CHECK (brand_id = platform_helpers.current_brand_id() AND platform_helpers.current_store_id() IS NULL);
CREATE POLICY sellable_placement_brand_scope_policy ON rms_catalog.sellable_placement
  USING (brand_id = platform_helpers.current_brand_id() AND platform_helpers.current_store_id() IS NULL)
  WITH CHECK (brand_id = platform_helpers.current_brand_id() AND platform_helpers.current_store_id() IS NULL);
CREATE POLICY menu_operation_brand_scope_policy ON rms_catalog.menu_operation_record
  USING (brand_id = platform_helpers.current_brand_id() AND platform_helpers.current_store_id() IS NULL)
  WITH CHECK (brand_id = platform_helpers.current_brand_id() AND platform_helpers.current_store_id() IS NULL);

REVOKE ALL ON TABLE rms_catalog.category FROM PUBLIC;
REVOKE ALL ON TABLE rms_catalog.category_operation_record FROM PUBLIC;
REVOKE ALL ON TABLE rms_catalog.menu FROM PUBLIC;
REVOKE ALL ON TABLE rms_catalog.menu_version FROM PUBLIC;
REVOKE ALL ON TABLE rms_catalog.menu_version_store FROM PUBLIC;
REVOKE ALL ON TABLE rms_catalog.menu_version_channel FROM PUBLIC;
REVOKE ALL ON TABLE rms_catalog.menu_version_order_type FROM PUBLIC;
REVOKE ALL ON TABLE rms_catalog.menu_section FROM PUBLIC;
REVOKE ALL ON TABLE rms_catalog.menu_section_category FROM PUBLIC;
REVOKE ALL ON TABLE rms_catalog.sellable_placement FROM PUBLIC;
REVOKE ALL ON TABLE rms_catalog.menu_operation_record FROM PUBLIC;
