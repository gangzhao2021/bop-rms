-- bop-rms-migration: 1
-- owner: @rms/pricing
-- schema: rms_pricing
-- phase: expand
-- risk: medium
-- transaction: required
-- lock-timeout-ms: 5000
-- statement-timeout-ms: 60000
-- recovery: forward-fix
-- WP-2423 item 8 ⑥ DEC-SINGLE-STORE-MENU (Owner 2026-10-28 decision 7; coordinator 2026-10-28
-- condition 4): at a single store a price change takes effect with "List it", no review. The
-- publication of a price book or an option price by its own draft author is still the existing
-- operation record; these append-only companion records mark it SingleStoreListing. Each is
-- refused unless it marks that author's own committed publication and the Brand has exactly one
-- store (not archived), this one, at that moment (Organization read, 2000_108, held to commit).
-- Grants: api SELECT/INSERT (Owner standing approval 2026-10-14, WP-2423).
CREATE FUNCTION rms_pricing.reject_pricing_single_store_listing_mutation() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
BEGIN
 RAISE EXCEPTION 'append-only pricing single store listing' USING ERRCODE='55000';
END;
$$;
REVOKE ALL ON FUNCTION rms_pricing.reject_pricing_single_store_listing_mutation() FROM PUBLIC;

CREATE TABLE rms_pricing.price_book_single_store_listing (
 operation_id platform_helpers.uuid_v7 PRIMARY KEY
  REFERENCES rms_pricing.price_book_operation_record (operation_id),
 brand_id platform_helpers.uuid_v7 NOT NULL,
 price_book_id platform_helpers.uuid_v7 NOT NULL,
 approval_mode text NOT NULL CHECK (approval_mode='SingleStoreListing'),
 listing_store_id platform_helpers.uuid_v7 NOT NULL,
 actor_id platform_helpers.uuid_v7 NOT NULL,
 listed_at timestamptz NOT NULL CHECK (isfinite(listed_at) AND listed_at=date_trunc('milliseconds',listed_at)),
 audit_id platform_helpers.uuid_v7 NOT NULL UNIQUE
);
CREATE TABLE rms_pricing.option_price_single_store_listing (
 operation_id platform_helpers.uuid_v7 PRIMARY KEY
  REFERENCES rms_pricing.option_price_authoring_operation (operation_id),
 brand_id platform_helpers.uuid_v7 NOT NULL,
 option_price_rule_id platform_helpers.uuid_v7 NOT NULL,
 approval_mode text NOT NULL CHECK (approval_mode='SingleStoreListing'),
 listing_store_id platform_helpers.uuid_v7 NOT NULL,
 actor_id platform_helpers.uuid_v7 NOT NULL,
 listed_at timestamptz NOT NULL CHECK (isfinite(listed_at) AND listed_at=date_trunc('milliseconds',listed_at)),
 audit_id platform_helpers.uuid_v7 NOT NULL UNIQUE
);

-- Marks only a Publish of the same price book and Brand.
CREATE FUNCTION rms_pricing.check_price_book_single_store_listing() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
BEGIN
 IF NOT EXISTS (
  SELECT 1 FROM rms_pricing.price_book_operation_record o
  WHERE o.operation_id=NEW.operation_id AND o.brand_id=NEW.brand_id
   AND o.price_book_id=NEW.price_book_id AND o.action_code='Publish'
 ) THEN
  RAISE EXCEPTION 'price book single store listing must mark a publication' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION rms_pricing.check_price_book_single_store_listing() FROM PUBLIC;
CREATE TRIGGER price_book_single_store_listing_publication BEFORE INSERT ON rms_pricing.price_book_single_store_listing
 FOR EACH ROW EXECUTE FUNCTION rms_pricing.check_price_book_single_store_listing();

-- Marks only the author's own committed Publish of the same rule, at the same instant.
CREATE FUNCTION rms_pricing.check_option_price_single_store_listing() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog
SET row_security = off
AS $$
BEGIN
 IF NOT EXISTS (
  SELECT 1 FROM rms_pricing.option_price_authoring_operation o
  WHERE o.operation_id=NEW.operation_id AND o.brand_id=NEW.brand_id
   AND o.option_price_rule_id=NEW.option_price_rule_id AND o.action_code='Publish'
   AND o.outcome='Committed' AND o.actor_id=NEW.actor_id AND o.occurred_at=NEW.listed_at
   AND o.audit_id=NEW.audit_id
   AND o.receipt_json->'publicationAuthorization'->>'approvedActorReference'=NEW.actor_id::text
   AND o.receipt_json->'publicationAuthorization'->>'draftAuthorActorReference'=NEW.actor_id::text
 ) THEN
  RAISE EXCEPTION 'option price single store listing must mark its author''s own publication' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION rms_pricing.check_option_price_single_store_listing() FROM PUBLIC;
CREATE TRIGGER option_price_single_store_listing_publication BEFORE INSERT ON rms_pricing.option_price_single_store_listing
 FOR EACH ROW EXECUTE FUNCTION rms_pricing.check_option_price_single_store_listing();

-- The Brand has exactly one store (not archived) and it is the one named; held to commit.
CREATE FUNCTION rms_pricing.check_pricing_single_store() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog
SET row_security = off
AS $$
BEGIN
 IF bop_tenant.brand_has_single_store(NEW.brand_id, NEW.listing_store_id) IS NOT TRUE THEN
  RAISE EXCEPTION 'pricing single store listing needs a brand with one store' USING ERRCODE='23514';
 END IF;
 RETURN NULL;
END;
$$;
REVOKE ALL ON FUNCTION rms_pricing.check_pricing_single_store() FROM PUBLIC;
CREATE TRIGGER price_book_single_store_listing_one_store AFTER INSERT ON rms_pricing.price_book_single_store_listing
 FOR EACH ROW EXECUTE FUNCTION rms_pricing.check_pricing_single_store();
CREATE TRIGGER option_price_single_store_listing_one_store AFTER INSERT ON rms_pricing.option_price_single_store_listing
 FOR EACH ROW EXECUTE FUNCTION rms_pricing.check_pricing_single_store();

CREATE TRIGGER price_book_single_store_listing_no_mutation BEFORE UPDATE OR DELETE ON rms_pricing.price_book_single_store_listing
 FOR EACH ROW EXECUTE FUNCTION rms_pricing.reject_pricing_single_store_listing_mutation();
CREATE TRIGGER price_book_single_store_listing_no_truncate BEFORE TRUNCATE ON rms_pricing.price_book_single_store_listing
 FOR EACH STATEMENT EXECUTE FUNCTION rms_pricing.reject_pricing_single_store_listing_mutation();
CREATE TRIGGER option_price_single_store_listing_no_mutation BEFORE UPDATE OR DELETE ON rms_pricing.option_price_single_store_listing
 FOR EACH ROW EXECUTE FUNCTION rms_pricing.reject_pricing_single_store_listing_mutation();
CREATE TRIGGER option_price_single_store_listing_no_truncate BEFORE TRUNCATE ON rms_pricing.option_price_single_store_listing
 FOR EACH STATEMENT EXECUTE FUNCTION rms_pricing.reject_pricing_single_store_listing_mutation();

-- An option price published by its own draft author stands with either mark (2000_074 accepted
-- only the sole-operator one); publications approved by another person are unchanged.
CREATE OR REPLACE FUNCTION rms_pricing.check_option_price_self_publication_marked() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog
SET row_security = off
AS $$
BEGIN
 IF NEW.action_code='Publish' AND NEW.outcome='Committed'
  AND NEW.receipt_json->'publicationAuthorization'->>'approvedActorReference'
   = NEW.receipt_json->'publicationAuthorization'->>'draftAuthorActorReference'
  AND NOT EXISTS (
   SELECT 1 FROM rms_pricing.option_price_sole_operator_approval m
   WHERE m.operation_id=NEW.operation_id AND m.brand_id=NEW.brand_id
  )
  AND NOT EXISTS (
   SELECT 1 FROM rms_pricing.option_price_single_store_listing l
   WHERE l.operation_id=NEW.operation_id AND l.brand_id=NEW.brand_id
  ) THEN
  RAISE EXCEPTION 'option price published by its own author needs a sole operator approval' USING ERRCODE='23514';
 END IF;
 RETURN NULL;
END;
$$;
REVOKE ALL ON FUNCTION rms_pricing.check_option_price_self_publication_marked() FROM PUBLIC;

ALTER TABLE rms_pricing.price_book_single_store_listing ENABLE ROW LEVEL SECURITY;
ALTER TABLE rms_pricing.price_book_single_store_listing FORCE ROW LEVEL SECURITY;
CREATE POLICY price_book_single_store_listing_brand_scope ON rms_pricing.price_book_single_store_listing
 USING (brand_id=platform_helpers.current_brand_id())
 WITH CHECK (brand_id=platform_helpers.current_brand_id());
ALTER TABLE rms_pricing.option_price_single_store_listing ENABLE ROW LEVEL SECURITY;
ALTER TABLE rms_pricing.option_price_single_store_listing FORCE ROW LEVEL SECURITY;
CREATE POLICY option_price_single_store_listing_brand_scope ON rms_pricing.option_price_single_store_listing
 USING (brand_id=platform_helpers.current_brand_id())
 WITH CHECK (brand_id=platform_helpers.current_brand_id());
REVOKE ALL ON TABLE rms_pricing.price_book_single_store_listing FROM PUBLIC;
REVOKE ALL ON TABLE rms_pricing.option_price_single_store_listing FROM PUBLIC;
