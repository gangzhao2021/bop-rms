-- bop-rms-migration: 1
-- owner: @rms/pricing
-- schema: rms_pricing
-- phase: expand
-- risk: low
-- transaction: required
-- lock-timeout-ms: 5000
-- statement-timeout-ms: 60000
-- recovery: forward-fix
-- WP-2423 menu-authoring-and-prices (M71, M70): why a price book draft was started and what it was
-- started from. "List it" on the menu page goes on with the menu's own price draft
-- (MenuListing) only, never with a price change someone started on the Prices page (PriceChange).
-- source_brand_digest is the digest of the Brand prices the draft was copied from: a draft whose
-- Store's Brand prices have moved since (another change was listed) is refused at publication and
-- assignment, so a draft copied earlier never silently undoes a later price change. NULL only for
-- drafts that existed before this record (their start is unknown).
-- Grants: api SELECT/INSERT (Owner standing approval 2026-10-14, WP-2423).
CREATE FUNCTION rms_pricing.reject_price_book_draft_purpose_mutation() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
BEGIN
 RAISE EXCEPTION 'append-only price book draft purpose' USING ERRCODE='55000';
END;
$$;
REVOKE ALL ON FUNCTION rms_pricing.reject_price_book_draft_purpose_mutation() FROM PUBLIC;

CREATE TABLE rms_pricing.price_book_draft_purpose (
 price_book_id platform_helpers.uuid_v7 PRIMARY KEY,
 brand_id platform_helpers.uuid_v7 NOT NULL,
 purpose text NOT NULL CHECK (purpose IN ('MenuListing','PriceChange')),
 source_price_book_id platform_helpers.uuid_v7,
 source_brand_digest text CHECK (source_brand_digest ~ '^sha256:[0-9a-f]{64}$'),
 operation_id platform_helpers.uuid_v7 NOT NULL UNIQUE,
 actor_id platform_helpers.uuid_v7 NOT NULL,
 recorded_at timestamptz NOT NULL CHECK (isfinite(recorded_at)),
 CONSTRAINT price_book_draft_purpose_book_fk FOREIGN KEY (price_book_id, brand_id)
  REFERENCES rms_pricing.price_book (price_book_id, brand_id)
);

-- Open drafts made before this record: the menu page's own code is MENU-…; anything else came from
-- the Prices page. Their start is unknown (no digest).
INSERT INTO rms_pricing.price_book_draft_purpose
 (price_book_id,brand_id,purpose,source_price_book_id,source_brand_digest,operation_id,actor_id,recorded_at)
SELECT b.price_book_id,b.brand_id,
 CASE WHEN b.stable_code LIKE 'MENU-%' THEN 'MenuListing' ELSE 'PriceChange' END,
 NULL,NULL,o.operation_id,b.created_by_actor_id,b.created_at
FROM rms_pricing.price_book b
JOIN rms_pricing.price_book_version v ON v.price_book_version_id=b.current_version_id
JOIN rms_pricing.price_book_operation_record o
 ON o.price_book_id=b.price_book_id AND o.brand_id=b.brand_id AND o.action_code='CreateDraft'
WHERE v.lifecycle='Draft';

CREATE TRIGGER price_book_draft_purpose_no_mutation BEFORE UPDATE OR DELETE ON rms_pricing.price_book_draft_purpose
 FOR EACH ROW EXECUTE FUNCTION rms_pricing.reject_price_book_draft_purpose_mutation();
CREATE TRIGGER price_book_draft_purpose_no_truncate BEFORE TRUNCATE ON rms_pricing.price_book_draft_purpose
 FOR EACH STATEMENT EXECUTE FUNCTION rms_pricing.reject_price_book_draft_purpose_mutation();

ALTER TABLE rms_pricing.price_book_draft_purpose ENABLE ROW LEVEL SECURITY;
ALTER TABLE rms_pricing.price_book_draft_purpose FORCE ROW LEVEL SECURITY;
CREATE POLICY price_book_draft_purpose_brand_scope ON rms_pricing.price_book_draft_purpose
 USING (brand_id=platform_helpers.current_brand_id())
 WITH CHECK (brand_id=platform_helpers.current_brand_id());
REVOKE ALL ON TABLE rms_pricing.price_book_draft_purpose FROM PUBLIC;
