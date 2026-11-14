-- bop-rms-migration: 1
-- owner: @rms/ordering
-- schema: rms_ordering
-- phase: expand
-- risk: medium
-- transaction: required
-- lock-timeout-ms: 5000
-- statement-timeout-ms: 60000
-- recovery: forward-fix
-- WP-2423 shared-table-checkout: the paying phone back on a later session (DEC-DINING-CHECKOUT-SCOPE
-- 11, 14). While a scope is live only the paying phone may quote, fill in checkout details, open a
-- checkout session or keep the dishes longer: its choosing session, or a later session of the same
-- participant. The API knew the later session from Identity, the 2000_520 triggers only from
-- Ordering's own cart operations, so a payer whose cookie was lost and who came back through the
-- continuity token (2000_523/2000_525) without editing the cart passed the API and was refused by
-- the database ("couldn't reach the store" instead of paying). The readmission now also records,
-- in Ordering and in the same transaction, that this later session carries the live scope of the
-- same participant; the fence accepts it. Each later session is carried from the paying one (its
-- choosing session, a session already carried, or one with its own cart operation for that
-- participant), at most once, while the scope is live. Append-only, Store RLS.
-- Grants: api SELECT, INSERT (Owner standing approval 2026-10-14 「我都批准，之后不需要问我」;
-- WP-2423 shared-table-checkout).

CREATE TABLE rms_ordering.dining_checkout_scope_payer_session (
 brand_id platform_helpers.uuid_v7 NOT NULL,
 store_id platform_helpers.uuid_v7 NOT NULL,
 scope_id platform_helpers.uuid_v7 NOT NULL,
 dining_session_id platform_helpers.uuid_v7 NOT NULL,
 participant_id platform_helpers.uuid_v7 NOT NULL,
 from_guest_session_id platform_helpers.uuid_v7 NOT NULL,
 guest_session_id platform_helpers.uuid_v7 NOT NULL,
 operation_id platform_helpers.uuid_v7 NOT NULL,
 recorded_at timestamptz NOT NULL CHECK (isfinite(recorded_at) AND recorded_at=date_trunc('milliseconds',recorded_at)),
 PRIMARY KEY (brand_id,store_id,scope_id,guest_session_id),
 CONSTRAINT dining_checkout_scope_payer_session_new CHECK (guest_session_id <> from_guest_session_id),
 CONSTRAINT dining_checkout_scope_payer_session_from_once UNIQUE (brand_id,store_id,scope_id,from_guest_session_id),
 CONSTRAINT dining_checkout_scope_payer_session_scope_fk FOREIGN KEY (brand_id,store_id,scope_id)
  REFERENCES rms_ordering.dining_checkout_scope(brand_id,store_id,scope_id)
);

CREATE FUNCTION rms_ordering.validate_dining_checkout_scope_payer_session() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
DECLARE
 s rms_ordering.dining_checkout_scope%ROWTYPE;
BEGIN
 SELECT * INTO s FROM rms_ordering.dining_checkout_scope x
  WHERE x.brand_id=NEW.brand_id AND x.store_id=NEW.store_id AND x.scope_id=NEW.scope_id;
 IF NOT FOUND OR NOT EXISTS (SELECT 1 FROM rms_ordering.cart c WHERE c.cart_id=s.cart_id
   AND c.brand_id=s.brand_id AND c.store_id=s.store_id AND c.aggregate_version=s.cart_version_to) THEN
  RAISE EXCEPTION 'only a live checkout scope goes with the paying phone' USING ERRCODE='23514';
 END IF;
 IF NEW.dining_session_id<>s.dining_session_id OR NEW.participant_id<>s.chooser_participant_id
  OR NOT (NEW.from_guest_session_id=s.chooser_guest_session_id
   OR EXISTS (SELECT 1 FROM rms_ordering.dining_checkout_scope_payer_session p
    WHERE p.brand_id=s.brand_id AND p.store_id=s.store_id AND p.scope_id=s.scope_id
     AND p.guest_session_id=NEW.from_guest_session_id)
   OR EXISTS (SELECT 1 FROM rms_ordering.dining_cart_operation o
    WHERE o.brand_id=s.brand_id AND o.store_id=s.store_id AND o.dining_session_id=s.dining_session_id
     AND o.guest_session_id=NEW.from_guest_session_id AND o.participant_id=s.chooser_participant_id)) THEN
  RAISE EXCEPTION 'a checkout scope goes only from the paying phone to its later session' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END;
$$;
CREATE TRIGGER dining_checkout_scope_payer_session_validate BEFORE INSERT ON rms_ordering.dining_checkout_scope_payer_session
 FOR EACH ROW EXECUTE FUNCTION rms_ordering.validate_dining_checkout_scope_payer_session();
CREATE TRIGGER dining_checkout_scope_payer_session_no_mutation BEFORE UPDATE OR DELETE ON rms_ordering.dining_checkout_scope_payer_session
 FOR EACH ROW EXECUTE FUNCTION rms_ordering.reject_dining_checkout_scope_mutation();
CREATE TRIGGER dining_checkout_scope_payer_session_no_truncate BEFORE TRUNCATE ON rms_ordering.dining_checkout_scope_payer_session
 FOR EACH STATEMENT EXECUTE FUNCTION rms_ordering.reject_dining_checkout_scope_mutation();

-- The fence and "Keep them" also accept a later session the scope went with.
CREATE OR REPLACE FUNCTION rms_ordering.validate_dining_checkout_scope_extension() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
DECLARE
 s rms_ordering.dining_checkout_scope%ROWTYPE;
BEGIN
 SELECT * INTO s FROM rms_ordering.dining_checkout_scope x
  WHERE x.brand_id=NEW.brand_id AND x.store_id=NEW.store_id AND x.scope_id=NEW.scope_id;
 IF NOT FOUND OR NOT EXISTS (SELECT 1 FROM rms_ordering.cart c WHERE c.cart_id=s.cart_id
   AND c.brand_id=s.brand_id AND c.store_id=s.store_id AND c.aggregate_version=s.cart_version_to) THEN
  RAISE EXCEPTION 'only a live checkout scope is kept longer' USING ERRCODE='23514';
 END IF;
 IF NEW.guest_session_id<>s.chooser_guest_session_id AND NOT EXISTS (
   SELECT 1 FROM rms_ordering.dining_cart_operation o WHERE o.brand_id=s.brand_id AND o.store_id=s.store_id
    AND o.dining_session_id=s.dining_session_id AND o.guest_session_id=NEW.guest_session_id
    AND o.participant_id=s.chooser_participant_id) AND NOT EXISTS (
   SELECT 1 FROM rms_ordering.dining_checkout_scope_payer_session p WHERE p.brand_id=s.brand_id
    AND p.store_id=s.store_id AND p.scope_id=s.scope_id AND p.guest_session_id=NEW.guest_session_id) THEN
  RAISE EXCEPTION 'only the paying phone keeps its dishes longer' USING ERRCODE='23514';
 END IF;
 IF NEW.expires_at <= GREATEST(s.expires_at, COALESCE((SELECT max(e.expires_at)
   FROM rms_ordering.dining_checkout_scope_extension e
   WHERE e.brand_id=NEW.brand_id AND e.store_id=NEW.store_id AND e.scope_id=NEW.scope_id), s.expires_at)) THEN
  RAISE EXCEPTION 'a checkout scope is only kept longer' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION rms_ordering.refuse_checkout_during_foreign_scope() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
BEGIN
 IF TG_WHEN <> 'BEFORE' OR TG_LEVEL <> 'ROW' OR TG_OP <> 'INSERT' OR TG_TABLE_SCHEMA <> 'rms_ordering'
  OR TG_TABLE_NAME NOT IN ('cart_quote_attachment','checkout_details_record','checkout_session_record') THEN
  RAISE EXCEPTION 'CHECKOUT_SCOPE_FENCE_MISUSED' USING ERRCODE='55000';
 END IF;
 IF EXISTS (SELECT 1 FROM rms_ordering.dining_checkout_scope s
   JOIN rms_ordering.cart c ON c.cart_id=s.cart_id AND c.brand_id=s.brand_id AND c.store_id=s.store_id
    AND c.aggregate_version=s.cart_version_to
   WHERE s.brand_id=NEW.brand_id AND s.store_id=NEW.store_id AND s.cart_id=NEW.cart_id
    AND s.chooser_guest_session_id<>NEW.guest_session_id
    AND NOT EXISTS (SELECT 1 FROM rms_ordering.dining_cart_operation o
     WHERE o.brand_id=s.brand_id AND o.store_id=s.store_id AND o.dining_session_id=s.dining_session_id
      AND o.guest_session_id=NEW.guest_session_id AND o.participant_id=s.chooser_participant_id)
    AND NOT EXISTS (SELECT 1 FROM rms_ordering.dining_checkout_scope_payer_session p
     WHERE p.brand_id=s.brand_id AND p.store_id=s.store_id AND p.scope_id=s.scope_id
      AND p.guest_session_id=NEW.guest_session_id)) THEN
  RAISE EXCEPTION 'CHECKOUT_SCOPE_HELD' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END;
$$;

ALTER TABLE rms_ordering.dining_checkout_scope_payer_session ENABLE ROW LEVEL SECURITY;
ALTER TABLE rms_ordering.dining_checkout_scope_payer_session FORCE ROW LEVEL SECURITY;
CREATE POLICY dining_checkout_scope_payer_session_store_scope ON rms_ordering.dining_checkout_scope_payer_session
 USING (brand_id=platform_helpers.current_brand_id() AND store_id=platform_helpers.current_store_id())
 WITH CHECK (brand_id=platform_helpers.current_brand_id() AND store_id=platform_helpers.current_store_id());

REVOKE ALL ON TABLE rms_ordering.dining_checkout_scope_payer_session FROM PUBLIC;
REVOKE ALL ON FUNCTION rms_ordering.validate_dining_checkout_scope_payer_session() FROM PUBLIC;
REVOKE ALL ON FUNCTION rms_ordering.validate_dining_checkout_scope_extension() FROM PUBLIC;
REVOKE ALL ON FUNCTION rms_ordering.refuse_checkout_during_foreign_scope() FROM PUBLIC;
