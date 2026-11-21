-- bop-rms-migration: 1
-- owner: @bop/media
-- schema: bop_media
-- phase: expand
-- risk: low
-- transaction: required
-- lock-timeout-ms: 5000
-- statement-timeout-ms: 60000
-- recovery: forward-fix
-- WP-2423 menu descriptions and photos; Owner standing approval 2026-10-14. Media records one
-- append-only row per processed product photo: the six public renditions (JPEG and WebP at 320,
-- 640 and 1280 px, content-addressed /media/images/<sha256>.<ext> paths) written to the pilot
-- local-filesystem storage profile before the row is inserted. Brand scoped; product_id is the
-- Catalog owner reference (no cross-domain foreign key). Public data only: no raw source bytes and
-- no checksum of the original upload (the original can carry EXIF/GPS); no personal data.
CREATE TABLE bop_media.product_image (
  image_id platform_helpers.uuid_v7 NOT NULL PRIMARY KEY,
  tenant_id platform_helpers.uuid_v7 NOT NULL,
  brand_id platform_helpers.uuid_v7 NOT NULL,
  product_id platform_helpers.uuid_v7 NOT NULL,
  storage_profile text NOT NULL CHECK (storage_profile = 'PilotLocalFilesystemV1'),
  source_content_type text NOT NULL
    CHECK (source_content_type IN ('image/jpeg', 'image/png', 'image/webp')),
  source_byte_size integer NOT NULL CHECK (source_byte_size BETWEEN 1 AND 10485760),
  width integer NOT NULL CHECK (width > 0),
  height integer NOT NULL CHECK (height > 0),
  renditions_json jsonb NOT NULL CHECK (
    jsonb_typeof(renditions_json) = 'array'
    AND jsonb_array_length(renditions_json) = 6
    AND octet_length(renditions_json::text) <= 4096
  ),
  data_classification text NOT NULL CHECK (data_classification = 'Public'),
  created_by_actor_id platform_helpers.uuid_v7 NOT NULL,
  created_at timestamp with time zone NOT NULL
    CHECK (isfinite(created_at) AND created_at = date_trunc('milliseconds', created_at)),
  CONSTRAINT product_image_brand_image_unique UNIQUE (brand_id, image_id)
);

CREATE RULE product_image_no_update AS
  ON UPDATE TO bop_media.product_image DO INSTEAD NOTHING;
CREATE RULE product_image_no_delete AS
  ON DELETE TO bop_media.product_image DO INSTEAD NOTHING;

ALTER TABLE bop_media.product_image ENABLE ROW LEVEL SECURITY;
ALTER TABLE bop_media.product_image FORCE ROW LEVEL SECURITY;
CREATE POLICY product_image_brand_scope_policy
  ON bop_media.product_image
  USING (brand_id = platform_helpers.current_brand_id() AND platform_helpers.current_store_id() IS NULL)
  WITH CHECK (brand_id = platform_helpers.current_brand_id() AND platform_helpers.current_store_id() IS NULL);
REVOKE ALL ON TABLE bop_media.product_image FROM PUBLIC;
