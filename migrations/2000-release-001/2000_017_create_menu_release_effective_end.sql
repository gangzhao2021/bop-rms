-- bop-rms-migration: 1
-- owner: @rms/catalog
-- schema: rms_catalog
-- phase: expand
-- risk: medium
-- transaction: required
-- lock-timeout-ms: 5000
-- statement-timeout-ms: 60000
-- recovery: forward-fix
-- WP-2423 / DEC-MENU-REVISION: publishing a revised Menu ends the release in effect at the moment the new
-- release takes effect. Release effective periods stay immutable; the end is recorded here, append-only,
-- and every reader of effective periods applies it.
CREATE TABLE rms_catalog.menu_release_effective_end (
  release_id platform_helpers.uuid_v7 PRIMARY KEY
    REFERENCES rms_catalog.menu_publication_release (release_id),
  brand_id platform_helpers.uuid_v7 NOT NULL,
  menu_id platform_helpers.uuid_v7 NOT NULL,
  ended_at timestamp with time zone NOT NULL
    CHECK (date_trunc('milliseconds', ended_at) = ended_at),
  superseded_by_release_id platform_helpers.uuid_v7 NOT NULL
    REFERENCES rms_catalog.menu_publication_release (release_id),
  operation_id platform_helpers.uuid_v7 NOT NULL,
  CHECK (superseded_by_release_id <> release_id)
);
CREATE RULE menu_release_effective_end_no_update AS
  ON UPDATE TO rms_catalog.menu_release_effective_end DO INSTEAD NOTHING;
CREATE RULE menu_release_effective_end_no_delete AS
  ON DELETE TO rms_catalog.menu_release_effective_end DO INSTEAD NOTHING;
-- The end lies within the ended release's period and is the start of the superseding release.
CREATE FUNCTION rms_catalog.check_menu_release_effective_end() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog
AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM rms_catalog.menu_release_effective_period p
     WHERE p.release_id = NEW.release_id AND p.brand_id = NEW.brand_id AND p.menu_id = NEW.menu_id
       AND p.effective_from < NEW.ended_at
       AND (p.effective_until IS NULL OR p.effective_until > NEW.ended_at))
  OR NOT EXISTS (
    SELECT 1 FROM rms_catalog.menu_release_effective_period s
     WHERE s.release_id = NEW.superseded_by_release_id AND s.brand_id = NEW.brand_id
       AND s.menu_id = NEW.menu_id AND s.effective_from = NEW.ended_at) THEN
    RAISE EXCEPTION 'A menu release ends where its superseding release takes effect'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION rms_catalog.check_menu_release_effective_end() FROM PUBLIC;
CREATE TRIGGER menu_release_effective_end_matches
  BEFORE INSERT ON rms_catalog.menu_release_effective_end
  FOR EACH ROW EXECUTE FUNCTION rms_catalog.check_menu_release_effective_end();
ALTER TABLE rms_catalog.menu_release_effective_end ENABLE ROW LEVEL SECURITY;
ALTER TABLE rms_catalog.menu_release_effective_end FORCE ROW LEVEL SECURITY;
CREATE POLICY menu_release_effective_end_brand_scope ON rms_catalog.menu_release_effective_end
  USING (brand_id::uuid = platform_helpers.current_brand_id() AND platform_helpers.current_store_id() IS NULL)
  WITH CHECK (brand_id::uuid = platform_helpers.current_brand_id() AND platform_helpers.current_store_id() IS NULL);
REVOKE ALL ON TABLE rms_catalog.menu_release_effective_end FROM PUBLIC;
-- A superseding release's period starts inside the open period it ends, so overlap is judged at commit,
-- after the end row is recorded in the same transaction, against each period truncated by its end.
CREATE OR REPLACE FUNCTION rms_catalog.reject_menu_effective_overlap() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM rms_catalog.menu_release_effective_period AS current
    LEFT JOIN rms_catalog.menu_release_effective_end AS ended ON ended.release_id = current.release_id
    LEFT JOIN rms_catalog.menu_release_effective_end AS own ON own.release_id = NEW.release_id
    WHERE current.menu_id = NEW.menu_id
      AND current.brand_id = NEW.brand_id
      AND current.timing_version_id <> NEW.timing_version_id
      AND tstzrange(current.effective_from,
            CASE WHEN ended.ended_at IS NULL THEN current.effective_until
                 ELSE LEAST(coalesce(current.effective_until, 'infinity'), ended.ended_at) END, '[)')
        && tstzrange(NEW.effective_from,
            CASE WHEN own.ended_at IS NULL THEN NEW.effective_until
                 ELSE LEAST(coalesce(NEW.effective_until, 'infinity'), own.ended_at) END, '[)')
  ) THEN
    RAISE EXCEPTION 'overlapping menu effective period';
  END IF;
  RETURN NULL;
END;
$$;
DROP TRIGGER menu_effective_overlap_guard ON rms_catalog.menu_release_effective_period;
CREATE CONSTRAINT TRIGGER menu_effective_overlap_guard
AFTER INSERT OR UPDATE OF effective_from, effective_until, menu_id, brand_id
ON rms_catalog.menu_release_effective_period
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION rms_catalog.reject_menu_effective_overlap();
