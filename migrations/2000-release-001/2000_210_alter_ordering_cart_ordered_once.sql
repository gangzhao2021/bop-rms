-- bop-rms-migration: 1
-- owner: @rms/ordering
-- schema: rms_ordering
-- phase: expand
-- risk: medium
-- transaction: required
-- lock-timeout-ms: 5000
-- statement-timeout-ms: 60000
-- recovery: forward-fix
-- WP-2423 M03: one Cart version produces at most one Order submission. A pickup guest was charged
-- twice for the same dishes because the pickup Cart kept its lines and version after its Order;
-- Ordering now empties it in the Order's transaction (as for a table) and refuses a second checkout
-- of the same version. This guard holds the rule for every writer of a submission (Initial and
-- Additional, pickup and dine-in, whose writers already lock the Cart at that version and move it
-- on). It checks new rows only: submissions recorded before it stay as history (append-only; no
-- rewrite, no backfill), which is why it is a trigger and not a unique index. It runs with the
-- writer's own rights and Row Level Security scope, which is the new row's Brand and Store. The
-- lookup uses order_submission_cart_idx (Brand, Store, Cart, version).

CREATE FUNCTION rms_ordering.refuse_cart_version_ordered_twice() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
BEGIN
 IF TG_WHEN <> 'BEFORE' OR TG_LEVEL <> 'ROW' OR TG_OP <> 'INSERT'
  OR TG_TABLE_SCHEMA <> 'rms_ordering' OR TG_TABLE_NAME <> 'order_submission_record'
 THEN RAISE EXCEPTION 'CART_ORDERED_ONCE_MISUSED' USING ERRCODE = '55000'; END IF;
 PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
  'ordering.cart-version-ordered-once:' || NEW.brand_id::text || ':' || NEW.store_id::text || ':'
  || NEW.source_cart_id::text, 0));
 IF EXISTS (SELECT 1 FROM rms_ordering.order_submission_record s
  WHERE s.brand_id = NEW.brand_id AND s.store_id = NEW.store_id
   AND s.source_cart_id = NEW.source_cart_id AND s.source_cart_version = NEW.source_cart_version)
 THEN RAISE EXCEPTION 'CART_VERSION_ALREADY_ORDERED' USING ERRCODE = '23505'; END IF;
 RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION rms_ordering.refuse_cart_version_ordered_twice() FROM PUBLIC;
CREATE TRIGGER b0_cart_version_ordered_once BEFORE INSERT ON rms_ordering.order_submission_record
 FOR EACH ROW EXECUTE FUNCTION rms_ordering.refuse_cart_version_ordered_twice();
