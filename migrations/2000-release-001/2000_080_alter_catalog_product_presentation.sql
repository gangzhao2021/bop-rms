-- bop-rms-migration: 1
-- owner: @rms/catalog
-- schema: rms_catalog
-- phase: expand
-- risk: low
-- transaction: required
-- lock-timeout-ms: 5000
-- statement-timeout-ms: 60000
-- recovery: forward-fix
-- WP-2423 menu descriptions and photos; Owner standing approval 2026-10-14. A Product draft may carry
-- what customers read about it: a short plain-text description per language and a reference to one
-- photo recorded by Media, with its alternative text. NULL keeps the meaning "not set" for every
-- existing version. The published menu projection keeps the reviewed description and photo
-- renditions of each sellable; NULL when the reviewed snapshot carried none. Public menu content
-- only: no personal, payment or health data.
ALTER TABLE rms_catalog.product_version ADD COLUMN customer_presentation_json jsonb;
ALTER TABLE rms_catalog.product_version ADD CONSTRAINT product_version_customer_presentation_check
CHECK (customer_presentation_json IS NULL OR (
  jsonb_typeof(customer_presentation_json) = 'object'
  AND octet_length(customer_presentation_json::text) <= 16384
));
ALTER TABLE rms_catalog.published_menu_projection_sellable ADD COLUMN presentation_json jsonb;
ALTER TABLE rms_catalog.published_menu_projection_sellable
  ADD CONSTRAINT published_menu_projection_sellable_presentation_check
CHECK (presentation_json IS NULL OR (
  jsonb_typeof(presentation_json) = 'object'
  AND octet_length(presentation_json::text) <= 16384
));
