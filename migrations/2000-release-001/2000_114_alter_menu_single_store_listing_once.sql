-- bop-rms-migration: 1
-- owner: @rms/catalog
-- schema: rms_catalog
-- phase: expand
-- risk: low
-- transaction: required
-- lock-timeout-ms: 5000
-- statement-timeout-ms: 60000
-- recovery: forward-fix
-- WP-2423 item 8 ⑥ (v15 2026-10-28 finding a): a menu version is listed at most once. A second
-- "List it" of a version guests already see records nothing (the command answers AlreadyListed);
-- the database refuses a second single-store listing record of the same version.
CREATE UNIQUE INDEX menu_single_store_listing_version_once
  ON rms_catalog.menu_single_store_listing (brand_id, menu_id, menu_version_id);
