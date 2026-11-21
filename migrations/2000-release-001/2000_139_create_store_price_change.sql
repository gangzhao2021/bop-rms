-- bop-rms-migration: 1
-- owner: @rms/pricing
-- schema: rms_pricing
-- phase: expand
-- risk: medium
-- transaction: required
-- lock-timeout-ms: 5000
-- statement-timeout-ms: 60000
-- recovery: forward-fix
-- WP-2423 DEC-BRAND-MULTI-STORE-ONE-INSTALLATION segment 9 (coordinator 2026-10-31 rule 1, a
-- revision of Owner trade-off 7 the Owner may overrule): at a Brand with several Stores, the
-- Store's manager, an area manager or the owner changes this Store's price directly, here only,
-- after confirming the old and new price; it is recorded with who changed it. A Store's price is a
-- Store-scope entry in the Store's own Published price book, so quotes, receipts and their evidence
-- read it exactly as before (Store scope outranks Brand scope). Each Store book is one of:
--   StorePrice: the Store's current book with one item's Store price set (or removed: back to the
--     Brand price);
--   BrandListing: a Brand book the Brand Owner listed, with this Store's own prices carried over.
-- These append-only records are refused unless the new book changes nothing but this Store's own
-- prices: its Brand entries equal its source book's, its other entries are this Store's, and the
-- Store prices it does not change are exactly the ones the Store charged before.
-- Pilot access: api SELECT/INSERT (Owner standing approval 2026-10-14, WP-2423).
CREATE TABLE rms_pricing.store_price_change (
 operation_id platform_helpers.uuid_v7 PRIMARY KEY,
 tenant_id platform_helpers.uuid_v7 NOT NULL,
 brand_id platform_helpers.uuid_v7 NOT NULL,
 store_id platform_helpers.uuid_v7 NOT NULL,
 change_kind text NOT NULL CHECK (change_kind IN ('StorePrice','BrandListing')),
 sellable_id platform_helpers.uuid_v7,
 previous_amount_minor bigint CHECK (previous_amount_minor >= 0),
 amount_minor bigint CHECK (amount_minor >= 0),
 currency_code text NOT NULL CHECK (currency_code ~ '^[A-Z]{3}$'),
 source_price_book_id platform_helpers.uuid_v7 NOT NULL,
 source_price_book_version_id platform_helpers.uuid_v7 NOT NULL,
 price_book_id platform_helpers.uuid_v7 NOT NULL,
 price_book_version_id platform_helpers.uuid_v7 NOT NULL,
 assignment_id platform_helpers.uuid_v7 NOT NULL UNIQUE
  REFERENCES rms_pricing.store_price_book_assignment (assignment_id),
 intent_hash text NOT NULL CHECK (intent_hash ~ '^sha256:[0-9a-f]{64}$'),
 actor_id platform_helpers.uuid_v7 NOT NULL,
 changed_at timestamptz NOT NULL
  CHECK (isfinite(changed_at) AND changed_at = date_trunc('milliseconds', changed_at)),
 audit_id platform_helpers.uuid_v7 NOT NULL UNIQUE,
 data_classification text NOT NULL DEFAULT 'ConfigurationMetadata'
  CHECK (data_classification = 'ConfigurationMetadata'),
 FOREIGN KEY (source_price_book_version_id, source_price_book_id, brand_id)
  REFERENCES rms_pricing.price_book_version (price_book_version_id, price_book_id, brand_id),
 FOREIGN KEY (price_book_version_id, price_book_id, brand_id)
  REFERENCES rms_pricing.price_book_version (price_book_version_id, price_book_id, brand_id),
 CHECK ((change_kind = 'StorePrice') = (sellable_id IS NOT NULL)),
 CHECK (change_kind = 'StorePrice' OR (previous_amount_minor IS NULL AND amount_minor IS NULL)),
 CHECK (change_kind = 'BrandListing' OR previous_amount_minor IS NOT NULL),
 CHECK (price_book_version_id <> source_price_book_version_id)
);
CREATE INDEX store_price_change_store
 ON rms_pricing.store_price_change (brand_id, store_id, changed_at DESC);

CREATE FUNCTION rms_pricing.reject_store_price_change_mutation() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
BEGIN
 RAISE EXCEPTION 'append-only store price change' USING ERRCODE = '55000';
END;
$$;
REVOKE ALL ON FUNCTION rms_pricing.reject_store_price_change_mutation() FROM PUBLIC;
CREATE TRIGGER store_price_change_append_only BEFORE UPDATE OR DELETE ON rms_pricing.store_price_change
 FOR EACH ROW EXECUTE FUNCTION rms_pricing.reject_store_price_change_mutation();
CREATE TRIGGER store_price_change_no_truncate BEFORE TRUNCATE ON rms_pricing.store_price_change
 FOR EACH STATEMENT EXECUTE FUNCTION rms_pricing.reject_store_price_change_mutation();

-- The entries of a version that a Store price may differ in, as comparable text: one line per
-- entry, without its own identity.
CREATE FUNCTION rms_pricing.store_price_entry_lines(target_version_id uuid, target_scope text, target_store_id uuid)
RETURNS text[]
LANGUAGE sql STABLE
SET search_path = pg_catalog
AS $$
 SELECT ARRAY(
  SELECT concat_ws('|', e.sellable_id::text, e.scope_kind, COALESCE(e.scope_id::text, '-'),
   COALESCE(e.channel_code, '-'), COALESCE(e.order_type, '-'), e.amount_minor::text,
   e.currency_code, e.effective_from::text, COALESCE(e.effective_until::text, '-'),
   e.effective_time_zone, e.reason_code)
  FROM rms_pricing.price_entry e
  WHERE e.price_book_version_id = target_version_id
   AND e.scope_kind = target_scope
   AND (target_store_id IS NULL OR e.scope_id = target_store_id)
  ORDER BY 1);
$$;
REVOKE ALL ON FUNCTION rms_pricing.store_price_entry_lines(uuid, text, uuid) FROM PUBLIC;

CREATE FUNCTION rms_pricing.check_store_price_change() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog
SET row_security = off
AS $$
DECLARE
 previous_version uuid;
 before_store text[];
 after_store text[];
 item_line text;
 own_count bigint;
 own_amount bigint;
 charged bigint;
BEGIN
 -- The new book is Published and is the Store's assignment this record names.
 IF NOT EXISTS (
  SELECT 1 FROM rms_pricing.store_price_book_assignment a
   JOIN rms_pricing.price_book_version v ON v.price_book_version_id = a.price_book_version_id
    AND v.price_book_id = a.price_book_id AND v.brand_id = a.brand_id
  WHERE a.assignment_id = NEW.assignment_id AND a.brand_id = NEW.brand_id
   AND a.store_id = NEW.store_id AND a.tenant_id = NEW.tenant_id
   AND a.price_book_id = NEW.price_book_id AND a.price_book_version_id = NEW.price_book_version_id
   AND a.effective_from = NEW.changed_at AND a.actor_id = NEW.actor_id
   AND v.lifecycle = 'Published')
  OR NOT EXISTS (
  SELECT 1 FROM rms_pricing.price_book_version v
  WHERE v.price_book_version_id = NEW.source_price_book_version_id AND v.brand_id = NEW.brand_id
   AND v.lifecycle = 'Published') THEN
  RAISE EXCEPTION 'store price change must name its Store''s new Published book' USING ERRCODE = '23514';
 END IF;
 -- Brand prices are the source book's; nothing priced for any other scope or Store.
 IF rms_pricing.store_price_entry_lines(NEW.price_book_version_id, 'Brand', NULL)
    IS DISTINCT FROM rms_pricing.store_price_entry_lines(NEW.source_price_book_version_id, 'Brand', NULL)
  OR EXISTS (
  SELECT 1 FROM rms_pricing.price_entry e
  WHERE e.price_book_version_id = NEW.price_book_version_id AND e.scope_kind <> 'Brand'
   AND (e.scope_kind <> 'Store' OR e.scope_id <> NEW.store_id)) THEN
  RAISE EXCEPTION 'store price change may change only this Store''s prices' USING ERRCODE = '23514';
 END IF;
 -- The book the Store charged until now (none for a Store's first book).
 SELECT a.price_book_version_id INTO previous_version
  FROM rms_pricing.store_price_book_assignment_end x
  JOIN rms_pricing.store_price_book_assignment a ON a.assignment_id = x.assignment_id
  WHERE x.superseded_by_assignment_id = NEW.assignment_id AND x.store_id = NEW.store_id;
 before_store := CASE WHEN previous_version IS NULL THEN ARRAY[]::text[]
  ELSE rms_pricing.store_price_entry_lines(previous_version, 'Store', NEW.store_id) END;
 after_store := rms_pricing.store_price_entry_lines(NEW.price_book_version_id, 'Store', NEW.store_id);
 IF NEW.change_kind = 'BrandListing' THEN
  -- The Store keeps exactly its own prices.
  IF after_store IS DISTINCT FROM before_store THEN
   RAISE EXCEPTION 'brand listing must carry the Store''s own prices unchanged' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
 END IF;
 -- StorePrice: built on the book the Store charged; only this item's Store price differs.
 IF previous_version IS DISTINCT FROM NEW.source_price_book_version_id THEN
  RAISE EXCEPTION 'store price change must build on the Store''s current book' USING ERRCODE = '23514';
 END IF;
 item_line := NEW.sellable_id::text || '|Store|' || NEW.store_id::text || '|-|-|';
 IF ARRAY(SELECT l FROM unnest(after_store) AS u(l) WHERE NOT starts_with(l, item_line) ORDER BY 1)
    IS DISTINCT FROM
    ARRAY(SELECT l FROM unnest(before_store) AS u(l) WHERE NOT starts_with(l, item_line) ORDER BY 1) THEN
  RAISE EXCEPTION 'store price change must change one item''s Store price' USING ERRCODE = '23514';
 END IF;
 SELECT count(*), max(e.amount_minor) INTO own_count, own_amount
  FROM rms_pricing.price_entry e
  WHERE e.price_book_version_id = NEW.price_book_version_id AND e.scope_kind = 'Store'
   AND e.scope_id = NEW.store_id AND e.sellable_id = NEW.sellable_id
   AND e.channel_code IS NULL AND e.order_type IS NULL AND e.currency_code = NEW.currency_code;
 IF (NEW.amount_minor IS NULL AND own_count <> 0)
  OR (NEW.amount_minor IS NOT NULL AND (own_count <> 1 OR own_amount IS DISTINCT FROM NEW.amount_minor)) THEN
  RAISE EXCEPTION 'store price change must change one item''s Store price' USING ERRCODE = '23514';
 END IF;
 -- The old price recorded is what the Store charged: its own price, else the Brand price.
 SELECT COALESCE(
  (SELECT e.amount_minor FROM rms_pricing.price_entry e
   WHERE e.price_book_version_id = previous_version AND e.scope_kind = 'Store'
    AND e.scope_id = NEW.store_id AND e.sellable_id = NEW.sellable_id
    AND e.channel_code IS NULL AND e.order_type IS NULL),
  (SELECT e.amount_minor FROM rms_pricing.price_entry e
   WHERE e.price_book_version_id = previous_version AND e.scope_kind = 'Brand'
    AND e.sellable_id = NEW.sellable_id AND e.channel_code IS NULL AND e.order_type IS NULL))
  INTO charged;
 IF charged IS DISTINCT FROM NEW.previous_amount_minor THEN
  RAISE EXCEPTION 'store price change must record the price the Store charged' USING ERRCODE = '23514';
 END IF;
 RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION rms_pricing.check_store_price_change() FROM PUBLIC;
CREATE TRIGGER store_price_change_only_this_store BEFORE INSERT ON rms_pricing.store_price_change
 FOR EACH ROW EXECUTE FUNCTION rms_pricing.check_store_price_change();

ALTER TABLE rms_pricing.store_price_change ENABLE ROW LEVEL SECURITY;
ALTER TABLE rms_pricing.store_price_change FORCE ROW LEVEL SECURITY;
CREATE POLICY store_price_change_store_scope ON rms_pricing.store_price_change
 USING (brand_id = platform_helpers.current_brand_id()
  AND store_id = platform_helpers.current_store_id())
 WITH CHECK (brand_id = platform_helpers.current_brand_id()
  AND store_id = platform_helpers.current_store_id());
REVOKE ALL ON TABLE rms_pricing.store_price_change FROM PUBLIC;
