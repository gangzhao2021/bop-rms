-- bop-rms-migration: 1
-- owner: @rms/ordering
-- schema: rms_ordering
-- phase: expand
-- risk: medium
-- transaction: required
-- lock-timeout-ms: 5000
-- statement-timeout-ms: 60000
-- recovery: forward-fix
-- WP-2423 shared-table-checkout (c) (sim M36, triage M36/M138): staff take a dish out of a table's
-- shared cart (nothing ordered yet) when a guest asks, the guest left, or the kitchen can't make
-- it. The guest cart's own operation record names a Guest Session (NOT NULL), so a staff removal
-- is recorded here instead: who (the staff member), why, which line, what it was (dish, quantity,
-- whose phone added it) and the cart version it produced. One row per removed line, append-only,
-- Store RLS. Not a sale: no order exists for the line; the cart history keeps the removal
-- attributed (AGENTS.md: no unrecorded change).
-- Grants: api SELECT, INSERT (Owner standing approval 2026-10-14 「我都批准，之后不需要问我」;
-- WP-2423 shared-table-checkout).
CREATE TABLE rms_ordering.cart_staff_line_removal (
 operation_id platform_helpers.uuid_v7 NOT NULL,
 brand_id platform_helpers.uuid_v7 NOT NULL,
 store_id platform_helpers.uuid_v7 NOT NULL,
 cart_id platform_helpers.uuid_v7 NOT NULL,
 dining_session_id platform_helpers.uuid_v7 NOT NULL,
 cart_line_id platform_helpers.uuid_v7 NOT NULL,
 sellable_id platform_helpers.uuid_v7 NOT NULL,
 quantity integer NOT NULL CHECK (quantity BETWEEN 1 AND 999),
 added_by_participant_id platform_helpers.uuid_v7,
 reason_code text NOT NULL CHECK (reason_code IN ('GuestAsked','GuestLeft','CantMake')),
 result_aggregate_version integer NOT NULL CHECK (result_aggregate_version > 1),
 intent_digest text NOT NULL CHECK (intent_digest ~ '^sha256:[0-9a-f]{64}$'),
 actor_id platform_helpers.uuid_v7 NOT NULL,
 occurred_at timestamptz NOT NULL CHECK (isfinite(occurred_at) AND occurred_at=date_trunc('milliseconds',occurred_at)),
 audit_id platform_helpers.uuid_v7 NOT NULL,
 PRIMARY KEY (brand_id,store_id,operation_id),
 CONSTRAINT cart_staff_line_removal_line_once UNIQUE (cart_line_id),
 CONSTRAINT cart_staff_line_removal_version_once UNIQUE (cart_id,result_aggregate_version),
 CONSTRAINT cart_staff_line_removal_cart_fk FOREIGN KEY (cart_id,brand_id,store_id)
  REFERENCES rms_ordering.cart(cart_id,brand_id,store_id)
);
CREATE INDEX cart_staff_line_removal_session_idx
 ON rms_ordering.cart_staff_line_removal (brand_id,store_id,dining_session_id,occurred_at);

-- A staff removal is of a table cart (never pickup), for that cart's own dining session, at the
-- cart version it produced, and the line is gone from the cart in the same transaction.
CREATE FUNCTION rms_ordering.validate_cart_staff_line_removal() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
BEGIN
 IF NOT EXISTS (SELECT 1 FROM rms_ordering.cart c WHERE c.cart_id=NEW.cart_id
   AND c.brand_id=NEW.brand_id AND c.store_id=NEW.store_id AND c.order_type='DineIn'
   AND c.dining_session_id=NEW.dining_session_id AND c.aggregate_version=NEW.result_aggregate_version) THEN
  RAISE EXCEPTION 'a staff removal is of a table cart at the version it produced' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END;
$$;
CREATE TRIGGER cart_staff_line_removal_validate BEFORE INSERT ON rms_ordering.cart_staff_line_removal
 FOR EACH ROW EXECUTE FUNCTION rms_ordering.validate_cart_staff_line_removal();
CREATE FUNCTION rms_ordering.check_cart_staff_line_removed() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
BEGIN
 IF EXISTS (SELECT 1 FROM rms_ordering.cart_line l WHERE l.cart_line_id=NEW.cart_line_id) THEN
  RAISE EXCEPTION 'a line staff removed must be gone from the cart' USING ERRCODE='23514';
 END IF;
 RETURN NULL;
END;
$$;
CREATE CONSTRAINT TRIGGER cart_staff_line_removal_gone AFTER INSERT ON rms_ordering.cart_staff_line_removal
 DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION rms_ordering.check_cart_staff_line_removed();

CREATE FUNCTION rms_ordering.reject_cart_staff_line_removal_mutation() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
BEGIN
 RAISE EXCEPTION 'append-only staff cart removal' USING ERRCODE='55000';
END;
$$;
CREATE TRIGGER cart_staff_line_removal_no_mutation BEFORE UPDATE OR DELETE ON rms_ordering.cart_staff_line_removal
 FOR EACH ROW EXECUTE FUNCTION rms_ordering.reject_cart_staff_line_removal_mutation();
CREATE TRIGGER cart_staff_line_removal_no_truncate BEFORE TRUNCATE ON rms_ordering.cart_staff_line_removal
 FOR EACH STATEMENT EXECUTE FUNCTION rms_ordering.reject_cart_staff_line_removal_mutation();

ALTER TABLE rms_ordering.cart_staff_line_removal ENABLE ROW LEVEL SECURITY;
ALTER TABLE rms_ordering.cart_staff_line_removal FORCE ROW LEVEL SECURITY;
CREATE POLICY cart_staff_line_removal_scope ON rms_ordering.cart_staff_line_removal
 USING (brand_id=platform_helpers.current_brand_id() AND store_id=platform_helpers.current_store_id())
 WITH CHECK (brand_id=platform_helpers.current_brand_id() AND store_id=platform_helpers.current_store_id());
REVOKE ALL ON TABLE rms_ordering.cart_staff_line_removal FROM PUBLIC;
REVOKE ALL ON FUNCTION rms_ordering.validate_cart_staff_line_removal() FROM PUBLIC;
REVOKE ALL ON FUNCTION rms_ordering.check_cart_staff_line_removed() FROM PUBLIC;
REVOKE ALL ON FUNCTION rms_ordering.reject_cart_staff_line_removal_mutation() FROM PUBLIC;
