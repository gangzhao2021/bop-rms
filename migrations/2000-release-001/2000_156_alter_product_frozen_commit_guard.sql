-- bop-rms-migration: 1
-- owner: @rms/catalog
-- schema: rms_catalog
-- phase: expand
-- risk: low
-- transaction: required
-- lock-timeout-ms: 5000
-- statement-timeout-ms: 60000
-- recovery: forward-fix
-- WP-2423 (three TEST merchants, 2026-11-04): saving a dish failed at random at COMMIT with
-- "permission denied for table product_publication_content". This guard runs for every product
-- version, as whoever wrote it. While a connection plans it per row, a Draft row folds the check
-- away; once the plan cache switches to a generic plan the tables are checked and the API role has
-- no grant on them. Decide the status first, as option_set_frozen_commit_guard does, so the tables
-- are read only for a Frozen version. The check itself is unchanged.
CREATE OR REPLACE FUNCTION rms_catalog.product_frozen_commit_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW.status<>'Frozen' THEN RETURN NEW; END IF;
 IF NOT EXISTS(SELECT 1 FROM rms_catalog.product_publication_content c JOIN rms_catalog.product_publication_revision r ON r.operation_id=c.publication_operation_id WHERE c.product_version_id=NEW.product_version_id AND c.brand_id=NEW.brand_id AND c.product_id=NEW.product_id AND r.state='Published') THEN RAISE EXCEPTION 'PRODUCT_PUBLICATION_CONTENT_MISSING' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END;
$$;
