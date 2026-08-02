-- bop-rms-migration: 1
-- owner: @rms/catalog
-- schema: rms_catalog
-- phase: expand
-- risk: medium
-- transaction: required
-- lock-timeout-ms: 5000
-- statement-timeout-ms: 60000
-- recovery: forward-fix
CREATE TABLE rms_catalog.published_menu_projection_generation (
  generation_id platform_helpers.uuid_v7 PRIMARY KEY,
  brand_id platform_helpers.uuid_v7 NOT NULL,
  menu_id platform_helpers.uuid_v7 NOT NULL,
  projection_name text NOT NULL CHECK (projection_name = 'catalog_published_menu_v1'),
  projection_version integer NOT NULL CHECK (projection_version = 1),
  generation_status text NOT NULL CHECK (generation_status IN ('Building', 'Active', 'Retired')),
  source_event_id platform_helpers.uuid_v7 NOT NULL,
  source_aggregate_version bigint NOT NULL CHECK (source_aggregate_version > 0),
  source_checkpoint platform_helpers.uuid_v7 NOT NULL,
  last_rebuilt_at timestamp with time zone NOT NULL,
  freshness_status text NOT NULL CHECK (freshness_status IN ('Fresh', 'Stale', 'Rebuilding', 'Failed')),
  CONSTRAINT published_menu_generation_menu_fk
    FOREIGN KEY (menu_id, brand_id) REFERENCES rms_catalog.menu (menu_id, brand_id),
  CONSTRAINT published_menu_generation_event_unique UNIQUE (source_event_id),
  CONSTRAINT published_menu_generation_identity_unique UNIQUE (generation_id, menu_id, brand_id)
);

CREATE UNIQUE INDEX published_menu_one_active_generation
  ON rms_catalog.published_menu_projection_generation (brand_id, menu_id)
  WHERE generation_status = 'Active';
CREATE UNIQUE INDEX published_menu_source_version_unique
  ON rms_catalog.published_menu_projection_generation (brand_id, menu_id, source_aggregate_version);

CREATE TABLE rms_catalog.published_menu_projection (
  generation_id platform_helpers.uuid_v7 PRIMARY KEY,
  brand_id platform_helpers.uuid_v7 NOT NULL,
  menu_id platform_helpers.uuid_v7 NOT NULL,
  menu_version_id platform_helpers.uuid_v7 NOT NULL,
  release_id platform_helpers.uuid_v7 NOT NULL,
  snapshot_digest text NOT NULL CHECK (snapshot_digest ~ '^sha256:[0-9a-f]{64}$'),
  default_locale text NOT NULL CHECK (char_length(default_locale) BETWEEN 2 AND 35),
  localized_names_json jsonb NOT NULL CHECK (jsonb_typeof(localized_names_json) = 'object'),
  store_ids_json jsonb NOT NULL CHECK (jsonb_typeof(store_ids_json) = 'array'),
  channel_codes_json jsonb NOT NULL CHECK (jsonb_typeof(channel_codes_json) = 'array'),
  order_type_codes_json jsonb NOT NULL CHECK (jsonb_typeof(order_type_codes_json) = 'array'),
  time_zone text NOT NULL CHECK (char_length(time_zone) BETWEEN 1 AND 63),
  effective_from timestamp with time zone NOT NULL,
  effective_until timestamp with time zone,
  CONSTRAINT published_menu_projection_generation_fk
    FOREIGN KEY (generation_id, menu_id, brand_id)
    REFERENCES rms_catalog.published_menu_projection_generation (generation_id, menu_id, brand_id),
  CONSTRAINT published_menu_projection_version_fk
    FOREIGN KEY (menu_version_id, menu_id, brand_id)
    REFERENCES rms_catalog.menu_version (menu_version_id, menu_id, brand_id),
  CONSTRAINT published_menu_projection_release_fk
    FOREIGN KEY (release_id, menu_id, brand_id)
    REFERENCES rms_catalog.menu_publication_release (release_id, menu_id, brand_id),
  CONSTRAINT published_menu_projection_period_check CHECK (
    effective_until IS NULL OR effective_until > effective_from
  )
);

CREATE TABLE rms_catalog.published_menu_projection_section (
  generation_id platform_helpers.uuid_v7 NOT NULL,
  brand_id platform_helpers.uuid_v7 NOT NULL,
  menu_id platform_helpers.uuid_v7 NOT NULL,
  section_id platform_helpers.uuid_v7 NOT NULL,
  internal_code text NOT NULL CHECK (internal_code ~ '^[A-Z][A-Z0-9_-]{0,63}$'),
  localized_names_json jsonb NOT NULL CHECK (jsonb_typeof(localized_names_json) = 'object'),
  sort_order integer NOT NULL CHECK (sort_order >= 0),
  PRIMARY KEY (generation_id, section_id),
  CONSTRAINT published_menu_section_projection_fk
    FOREIGN KEY (generation_id) REFERENCES rms_catalog.published_menu_projection (generation_id),
  CONSTRAINT published_menu_section_sort_unique UNIQUE (generation_id, sort_order),
  CONSTRAINT published_menu_section_identity_unique UNIQUE (generation_id, section_id, menu_id, brand_id)
);

CREATE TABLE rms_catalog.published_menu_projection_sellable (
  generation_id platform_helpers.uuid_v7 NOT NULL,
  brand_id platform_helpers.uuid_v7 NOT NULL,
  menu_id platform_helpers.uuid_v7 NOT NULL,
  section_id platform_helpers.uuid_v7 NOT NULL,
  placement_id platform_helpers.uuid_v7 NOT NULL,
  sellable_id platform_helpers.uuid_v7 NOT NULL,
  product_version_id platform_helpers.uuid_v7 NOT NULL,
  localized_names_json jsonb NOT NULL CHECK (jsonb_typeof(localized_names_json) = 'object'),
  presentation_role text NOT NULL CHECK (presentation_role IN ('Standard', 'Featured', 'Promotional', 'Sponsored', 'Hidden')),
  sort_order integer NOT NULL CHECK (sort_order >= 0),
  pinned boolean NOT NULL,
  configured_availability text NOT NULL CHECK (configured_availability IN ('Available', 'Unavailable')),
  option_rules_json jsonb NOT NULL CHECK (jsonb_typeof(option_rules_json) = 'array'),
  PRIMARY KEY (generation_id, placement_id),
  CONSTRAINT published_menu_sellable_section_fk
    FOREIGN KEY (generation_id, section_id, menu_id, brand_id)
    REFERENCES rms_catalog.published_menu_projection_section (generation_id, section_id, menu_id, brand_id),
  CONSTRAINT published_menu_sellable_sort_unique UNIQUE (generation_id, section_id, sort_order)
);

CREATE TABLE rms_catalog.published_menu_projection_checkpoint (
  consumer_name text NOT NULL CHECK (consumer_name = 'catalog.published-menu-projection'),
  brand_id platform_helpers.uuid_v7 NOT NULL,
  menu_id platform_helpers.uuid_v7 NOT NULL,
  active_generation_id platform_helpers.uuid_v7 NOT NULL,
  source_event_id platform_helpers.uuid_v7 NOT NULL,
  source_aggregate_version bigint NOT NULL CHECK (source_aggregate_version > 0),
  projected_at timestamp with time zone NOT NULL,
  PRIMARY KEY (consumer_name, brand_id, menu_id),
  CONSTRAINT published_menu_checkpoint_generation_fk
    FOREIGN KEY (active_generation_id, menu_id, brand_id)
    REFERENCES rms_catalog.published_menu_projection_generation (generation_id, menu_id, brand_id)
);

CREATE FUNCTION rms_catalog.enforce_published_menu_checkpoint_order() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
BEGIN
  IF OLD.source_aggregate_version >= NEW.source_aggregate_version THEN
    RAISE EXCEPTION 'published menu checkpoint must advance';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER published_menu_checkpoint_order_guard
BEFORE UPDATE OF active_generation_id, source_event_id, source_aggregate_version
ON rms_catalog.published_menu_projection_checkpoint
FOR EACH ROW EXECUTE FUNCTION rms_catalog.enforce_published_menu_checkpoint_order();

CREATE RULE published_menu_projection_no_update AS
  ON UPDATE TO rms_catalog.published_menu_projection DO INSTEAD NOTHING;
CREATE RULE published_menu_projection_no_delete AS
  ON DELETE TO rms_catalog.published_menu_projection DO INSTEAD NOTHING;
CREATE RULE published_menu_section_no_update AS
  ON UPDATE TO rms_catalog.published_menu_projection_section DO INSTEAD NOTHING;
CREATE RULE published_menu_section_no_delete AS
  ON DELETE TO rms_catalog.published_menu_projection_section DO INSTEAD NOTHING;
CREATE RULE published_menu_sellable_no_update AS
  ON UPDATE TO rms_catalog.published_menu_projection_sellable DO INSTEAD NOTHING;
CREATE RULE published_menu_sellable_no_delete AS
  ON DELETE TO rms_catalog.published_menu_projection_sellable DO INSTEAD NOTHING;

ALTER TABLE rms_catalog.published_menu_projection_generation ENABLE ROW LEVEL SECURITY;
ALTER TABLE rms_catalog.published_menu_projection_generation FORCE ROW LEVEL SECURITY;
ALTER TABLE rms_catalog.published_menu_projection ENABLE ROW LEVEL SECURITY;
ALTER TABLE rms_catalog.published_menu_projection FORCE ROW LEVEL SECURITY;
ALTER TABLE rms_catalog.published_menu_projection_section ENABLE ROW LEVEL SECURITY;
ALTER TABLE rms_catalog.published_menu_projection_section FORCE ROW LEVEL SECURITY;
ALTER TABLE rms_catalog.published_menu_projection_sellable ENABLE ROW LEVEL SECURITY;
ALTER TABLE rms_catalog.published_menu_projection_sellable FORCE ROW LEVEL SECURITY;
ALTER TABLE rms_catalog.published_menu_projection_checkpoint ENABLE ROW LEVEL SECURITY;
ALTER TABLE rms_catalog.published_menu_projection_checkpoint FORCE ROW LEVEL SECURITY;

CREATE POLICY published_menu_generation_brand_policy ON rms_catalog.published_menu_projection_generation
  USING (brand_id = platform_helpers.current_brand_id() AND platform_helpers.current_store_id() IS NULL)
  WITH CHECK (brand_id = platform_helpers.current_brand_id() AND platform_helpers.current_store_id() IS NULL);
CREATE POLICY published_menu_projection_brand_policy ON rms_catalog.published_menu_projection
  USING (brand_id = platform_helpers.current_brand_id() AND platform_helpers.current_store_id() IS NULL)
  WITH CHECK (brand_id = platform_helpers.current_brand_id() AND platform_helpers.current_store_id() IS NULL);
CREATE POLICY published_menu_section_brand_policy ON rms_catalog.published_menu_projection_section
  USING (brand_id = platform_helpers.current_brand_id() AND platform_helpers.current_store_id() IS NULL)
  WITH CHECK (brand_id = platform_helpers.current_brand_id() AND platform_helpers.current_store_id() IS NULL);
CREATE POLICY published_menu_sellable_brand_policy ON rms_catalog.published_menu_projection_sellable
  USING (brand_id = platform_helpers.current_brand_id() AND platform_helpers.current_store_id() IS NULL)
  WITH CHECK (brand_id = platform_helpers.current_brand_id() AND platform_helpers.current_store_id() IS NULL);
CREATE POLICY published_menu_checkpoint_brand_policy ON rms_catalog.published_menu_projection_checkpoint
  USING (brand_id = platform_helpers.current_brand_id() AND platform_helpers.current_store_id() IS NULL)
  WITH CHECK (brand_id = platform_helpers.current_brand_id() AND platform_helpers.current_store_id() IS NULL);

REVOKE ALL ON TABLE rms_catalog.published_menu_projection_generation FROM PUBLIC;
REVOKE ALL ON TABLE rms_catalog.published_menu_projection FROM PUBLIC;
REVOKE ALL ON TABLE rms_catalog.published_menu_projection_section FROM PUBLIC;
REVOKE ALL ON TABLE rms_catalog.published_menu_projection_sellable FROM PUBLIC;
REVOKE ALL ON TABLE rms_catalog.published_menu_projection_checkpoint FROM PUBLIC;

