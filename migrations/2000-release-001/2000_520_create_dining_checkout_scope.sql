-- bop-rms-migration: 1
-- owner: @rms/ordering
-- schema: rms_ordering
-- phase: expand
-- risk: medium
-- transaction: required
-- lock-timeout-ms: 5000
-- statement-timeout-ms: 60000
-- recovery: forward-fix
-- WP-2423 shared-table-checkout (a), pay first (DEC-OWNER-DEFAULTS-2026-11-06 同桌结账 M38: 默认付全桌,
-- 只付我加的, 选几道菜帮别人付; DEC-DINING-CHECKOUT-SCOPE). At a table that pays per round, the
-- guest who pays chooses which dishes this round is: the whole cart (unchanged, nothing here), only
-- what their phone added, or dishes they pick. A round is still exactly one cart version, quoted,
-- held, paid and ordered once (2000_210): the dishes NOT chosen leave the cart, as the cart's next
-- version, into this waiting list, and come back as new cart lines once the round is sent, the
-- payer goes back, or the 5-minute reservation runs out. Each waiting dish comes back once.
--
-- dining_checkout_scope: the choice (who, which phone, Mine/Chosen, how many dishes stay out),
--   the cart version it produced, and until when the other phones are kept from paying it.
--   A scope is "live" while the cart is still at that version; it ends by the cart moving on
--   (the round's submission, the dishes coming back, any change), so it needs no end row.
-- dining_checkout_scope_extension: the payer's "Keep them" (another 5 minutes), append-only.
-- dining_cart_waiting_line: a set-aside dish, copied exactly from its cart line (dish, quantity,
--   options, note, Catalog evidence, the phone that added it and when).
-- dining_cart_waiting_line_resolution: the dish back in the table's cart as a new line (once).
--
-- Fence (checkout_scope_held): while another guest's scope is live on a cart, nobody else at the
-- table can record a quote, checkout details or a checkout session for that cart; the API refuses
-- first with the table's ordinary "someone at your table is paying" answer, these triggers hold the
-- rule for every writer. All append-only, Store RLS. Not a sale: no dish leaves the books; every
-- dish is either in the round's cart version or waiting, never both (triggers below).
-- Grants: api SELECT, INSERT (Owner standing approval 2026-10-14 「我都批准，之后不需要问我」;
-- WP-2423 shared-table-checkout).

CREATE TABLE rms_ordering.dining_checkout_scope (
 scope_id platform_helpers.uuid_v7 NOT NULL,
 brand_id platform_helpers.uuid_v7 NOT NULL,
 store_id platform_helpers.uuid_v7 NOT NULL,
 dining_session_id platform_helpers.uuid_v7 NOT NULL,
 cart_id platform_helpers.uuid_v7 NOT NULL,
 cart_version_from integer NOT NULL CHECK (cart_version_from > 0),
 cart_version_to integer NOT NULL,
 choice text NOT NULL CHECK (choice IN ('Mine','Chosen')),
 chooser_participant_id platform_helpers.uuid_v7 NOT NULL,
 chooser_guest_session_id platform_helpers.uuid_v7 NOT NULL,
 chosen_line_count integer NOT NULL CHECK (chosen_line_count BETWEEN 1 AND 100),
 chosen_unit_count integer NOT NULL CHECK (chosen_unit_count >= chosen_line_count),
 set_aside_line_count integer NOT NULL CHECK (set_aside_line_count BETWEEN 1 AND 100),
 set_aside_unit_count integer NOT NULL CHECK (set_aside_unit_count >= set_aside_line_count),
 operation_id platform_helpers.uuid_v7 NOT NULL,
 intent_digest text NOT NULL CHECK (intent_digest ~ '^sha256:[0-9a-f]{64}$'),
 recorded_at timestamptz NOT NULL CHECK (isfinite(recorded_at) AND recorded_at=date_trunc('milliseconds',recorded_at)),
 expires_at timestamptz NOT NULL,
 audit_id platform_helpers.uuid_v7 NOT NULL,
 PRIMARY KEY (brand_id,store_id,scope_id),
 CONSTRAINT dining_checkout_scope_id_unique UNIQUE (scope_id),
 CONSTRAINT dining_checkout_scope_operation_unique UNIQUE (brand_id,store_id,operation_id),
 CONSTRAINT dining_checkout_scope_version_once UNIQUE (brand_id,store_id,cart_id,cart_version_to),
 CONSTRAINT dining_checkout_scope_next_version CHECK (cart_version_to = cart_version_from + 1),
 CONSTRAINT dining_checkout_scope_five_minutes CHECK (expires_at = recorded_at + interval '5 minutes'),
 CONSTRAINT dining_checkout_scope_cart_fk FOREIGN KEY (cart_id,brand_id,store_id,dining_session_id)
  REFERENCES rms_ordering.cart(cart_id,brand_id,store_id,dining_session_id)
);
CREATE INDEX dining_checkout_scope_session_idx
 ON rms_ordering.dining_checkout_scope (brand_id,store_id,dining_session_id,recorded_at);

CREATE TABLE rms_ordering.dining_checkout_scope_extension (
 operation_id platform_helpers.uuid_v7 NOT NULL,
 brand_id platform_helpers.uuid_v7 NOT NULL,
 store_id platform_helpers.uuid_v7 NOT NULL,
 scope_id platform_helpers.uuid_v7 NOT NULL,
 guest_session_id platform_helpers.uuid_v7 NOT NULL,
 recorded_at timestamptz NOT NULL CHECK (isfinite(recorded_at) AND recorded_at=date_trunc('milliseconds',recorded_at)),
 expires_at timestamptz NOT NULL,
 PRIMARY KEY (brand_id,store_id,operation_id),
 CONSTRAINT dining_checkout_scope_extension_five_minutes CHECK (expires_at = recorded_at + interval '5 minutes'),
 CONSTRAINT dining_checkout_scope_extension_scope_fk FOREIGN KEY (brand_id,store_id,scope_id)
  REFERENCES rms_ordering.dining_checkout_scope(brand_id,store_id,scope_id)
);
CREATE INDEX dining_checkout_scope_extension_scope_idx
 ON rms_ordering.dining_checkout_scope_extension (brand_id,store_id,scope_id,expires_at);

CREATE TABLE rms_ordering.dining_cart_waiting_line (
 waiting_line_id platform_helpers.uuid_v7 NOT NULL,
 brand_id platform_helpers.uuid_v7 NOT NULL,
 store_id platform_helpers.uuid_v7 NOT NULL,
 dining_session_id platform_helpers.uuid_v7 NOT NULL,
 cart_id platform_helpers.uuid_v7 NOT NULL,
 scope_id platform_helpers.uuid_v7 NOT NULL,
 origin_cart_line_id platform_helpers.uuid_v7 NOT NULL,
 origin_quantity integer NOT NULL CHECK (origin_quantity BETWEEN 1 AND 999),
 sellable_id platform_helpers.uuid_v7 NOT NULL,
 quantity integer NOT NULL CHECK (quantity BETWEEN 1 AND 999),
 option_selections_json jsonb NOT NULL CHECK (jsonb_typeof(option_selections_json) = 'array'),
 customer_note text CHECK (customer_note IS NULL OR (char_length(customer_note) BETWEEN 1 AND 500 AND customer_note = btrim(customer_note))),
 catalog_selection_evidence_json jsonb CHECK (catalog_selection_evidence_json IS NULL OR jsonb_typeof(catalog_selection_evidence_json) = 'object'),
 added_by_actor_id platform_helpers.uuid_v7 NOT NULL,
 added_by_participant_id platform_helpers.uuid_v7,
 added_at timestamptz NOT NULL,
 recorded_at timestamptz NOT NULL CHECK (isfinite(recorded_at) AND recorded_at=date_trunc('milliseconds',recorded_at)),
 PRIMARY KEY (brand_id,store_id,waiting_line_id),
 CONSTRAINT dining_cart_waiting_line_id_unique UNIQUE (waiting_line_id),
 CONSTRAINT dining_cart_waiting_line_origin_once UNIQUE (scope_id,origin_cart_line_id),
 CONSTRAINT dining_cart_waiting_line_part CHECK (quantity <= origin_quantity),
 CONSTRAINT dining_cart_waiting_line_scope_fk FOREIGN KEY (brand_id,store_id,scope_id)
  REFERENCES rms_ordering.dining_checkout_scope(brand_id,store_id,scope_id)
);
CREATE INDEX dining_cart_waiting_line_session_idx
 ON rms_ordering.dining_cart_waiting_line (brand_id,store_id,dining_session_id,recorded_at);

CREATE TABLE rms_ordering.dining_cart_waiting_line_resolution (
 waiting_line_id platform_helpers.uuid_v7 NOT NULL,
 brand_id platform_helpers.uuid_v7 NOT NULL,
 store_id platform_helpers.uuid_v7 NOT NULL,
 cart_id platform_helpers.uuid_v7 NOT NULL,
 cart_version integer NOT NULL CHECK (cart_version > 1),
 resolution text NOT NULL CHECK (resolution = 'Returned'),
 returned_cart_line_id platform_helpers.uuid_v7 NOT NULL,
 reason_code text NOT NULL CHECK (reason_code IN ('RoundSent','PayerCancelled','ScopeExpired','CartChanged')),
 operation_id platform_helpers.uuid_v7 NOT NULL,
 guest_session_id platform_helpers.uuid_v7 NOT NULL,
 occurred_at timestamptz NOT NULL CHECK (isfinite(occurred_at) AND occurred_at=date_trunc('milliseconds',occurred_at)),
 audit_id platform_helpers.uuid_v7 NOT NULL,
 PRIMARY KEY (brand_id,store_id,waiting_line_id),
 CONSTRAINT dining_cart_waiting_line_resolution_line_once UNIQUE (waiting_line_id),
 CONSTRAINT dining_cart_waiting_line_resolution_new_line UNIQUE (returned_cart_line_id),
 CONSTRAINT dining_cart_waiting_line_resolution_line_fk FOREIGN KEY (brand_id,store_id,waiting_line_id)
  REFERENCES rms_ordering.dining_cart_waiting_line(brand_id,store_id,waiting_line_id),
 CONSTRAINT dining_cart_waiting_line_resolution_cart_fk FOREIGN KEY (cart_id,brand_id,store_id)
  REFERENCES rms_ordering.cart(cart_id,brand_id,store_id)
);
CREATE INDEX dining_cart_waiting_line_resolution_operation_idx
 ON rms_ordering.dining_cart_waiting_line_resolution (brand_id,store_id,operation_id);

-- A scope is of a table cart, at the version it produced (the dishes left in the same transaction).
CREATE FUNCTION rms_ordering.validate_dining_checkout_scope() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
BEGIN
 IF NOT EXISTS (SELECT 1 FROM rms_ordering.cart c WHERE c.cart_id=NEW.cart_id
   AND c.brand_id=NEW.brand_id AND c.store_id=NEW.store_id AND c.order_type='DineIn'
   AND c.dining_session_id=NEW.dining_session_id AND c.aggregate_version=NEW.cart_version_to
   AND c.lifecycle_status='Active') THEN
  RAISE EXCEPTION 'a checkout scope is of a table cart at the version it produced' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END;
$$;
CREATE TRIGGER dining_checkout_scope_validate BEFORE INSERT ON rms_ordering.dining_checkout_scope
 FOR EACH ROW EXECUTE FUNCTION rms_ordering.validate_dining_checkout_scope();

-- "Keep them" only while the scope is live (the cart still at its version), by the payer's phone
-- (the choosing session or a later session of the same participant), and only later.
CREATE FUNCTION rms_ordering.validate_dining_checkout_scope_extension() RETURNS trigger
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
    AND o.participant_id=s.chooser_participant_id) THEN
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
CREATE TRIGGER dining_checkout_scope_extension_validate BEFORE INSERT ON rms_ordering.dining_checkout_scope_extension
 FOR EACH ROW EXECUTE FUNCTION rms_ordering.validate_dining_checkout_scope_extension();

-- A set-aside dish is a copy of a line of the scope's cart: of the same table, and at commit
-- either gone from the cart (all of it waits) or still there with exactly the units chosen; never
-- a line already ordered.
CREATE FUNCTION rms_ordering.validate_dining_cart_waiting_line() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
BEGIN
 IF NOT EXISTS (SELECT 1 FROM rms_ordering.dining_checkout_scope s WHERE s.brand_id=NEW.brand_id
   AND s.store_id=NEW.store_id AND s.scope_id=NEW.scope_id AND s.cart_id=NEW.cart_id
   AND s.dining_session_id=NEW.dining_session_id AND s.recorded_at=NEW.recorded_at) THEN
  RAISE EXCEPTION 'a waiting dish belongs to the scope that set it aside' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END;
$$;
CREATE TRIGGER dining_cart_waiting_line_validate BEFORE INSERT ON rms_ordering.dining_cart_waiting_line
 FOR EACH ROW EXECUTE FUNCTION rms_ordering.validate_dining_cart_waiting_line();
CREATE FUNCTION rms_ordering.check_dining_cart_waiting_line_left() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
DECLARE
 remaining integer;
BEGIN
 SELECT l.quantity INTO remaining FROM rms_ordering.cart_line l
  WHERE l.cart_line_id=NEW.origin_cart_line_id AND l.cart_id=NEW.cart_id;
 IF (remaining IS NULL AND NEW.quantity<>NEW.origin_quantity)
  OR (remaining IS NOT NULL AND remaining<>NEW.origin_quantity-NEW.quantity) THEN
  RAISE EXCEPTION 'a waiting dish must have left the cart' USING ERRCODE='23514';
 END IF;
 IF EXISTS (SELECT 1 FROM rms_ordering.order_item i WHERE i.brand_id=NEW.brand_id
   AND i.store_id=NEW.store_id AND i.source_cart_line_id=NEW.origin_cart_line_id) THEN
  RAISE EXCEPTION 'an ordered dish cannot wait for another round' USING ERRCODE='23514';
 END IF;
 RETURN NULL;
END;
$$;
CREATE CONSTRAINT TRIGGER dining_cart_waiting_line_left AFTER INSERT ON rms_ordering.dining_cart_waiting_line
 DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION rms_ordering.check_dining_cart_waiting_line_left();

-- A waiting dish comes back once, as a NEW line of a cart of the same table at the version the
-- return produced, and that line is the dish exactly as it was added (who, when, what).
CREATE FUNCTION rms_ordering.validate_dining_cart_waiting_line_resolution() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
BEGIN
 IF NOT EXISTS (SELECT 1 FROM rms_ordering.dining_cart_waiting_line w
   JOIN rms_ordering.cart c ON c.cart_id=NEW.cart_id AND c.brand_id=w.brand_id AND c.store_id=w.store_id
    AND c.dining_session_id=w.dining_session_id AND c.order_type='DineIn'
    AND c.aggregate_version=NEW.cart_version
   WHERE w.brand_id=NEW.brand_id AND w.store_id=NEW.store_id AND w.waiting_line_id=NEW.waiting_line_id
    AND w.origin_cart_line_id<>NEW.returned_cart_line_id
    AND w.recorded_at<=NEW.occurred_at) THEN
  RAISE EXCEPTION 'a waiting dish comes back to its own table cart as a new line' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END;
$$;
CREATE TRIGGER dining_cart_waiting_line_resolution_validate BEFORE INSERT ON rms_ordering.dining_cart_waiting_line_resolution
 FOR EACH ROW EXECUTE FUNCTION rms_ordering.validate_dining_cart_waiting_line_resolution();
CREATE FUNCTION rms_ordering.check_dining_cart_waiting_line_returned() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
BEGIN
 IF NOT EXISTS (SELECT 1 FROM rms_ordering.dining_cart_waiting_line w
   JOIN rms_ordering.cart_line l ON l.cart_line_id=NEW.returned_cart_line_id AND l.cart_id=NEW.cart_id
    AND l.brand_id=w.brand_id AND l.store_id=w.store_id
   WHERE w.brand_id=NEW.brand_id AND w.store_id=NEW.store_id AND w.waiting_line_id=NEW.waiting_line_id
    AND l.sellable_id=w.sellable_id AND l.quantity=w.quantity
    AND l.option_selections_json=w.option_selections_json
    AND l.customer_note IS NOT DISTINCT FROM w.customer_note
    AND l.catalog_selection_evidence_json IS NOT DISTINCT FROM w.catalog_selection_evidence_json
    AND l.added_by_actor_id=w.added_by_actor_id
    AND l.added_by_participant_id IS NOT DISTINCT FROM w.added_by_participant_id
    AND l.added_at=w.added_at) THEN
  RAISE EXCEPTION 'a returned dish must be back in the cart as it was added' USING ERRCODE='23514';
 END IF;
 RETURN NULL;
END;
$$;
CREATE CONSTRAINT TRIGGER dining_cart_waiting_line_resolution_returned AFTER INSERT ON rms_ordering.dining_cart_waiting_line_resolution
 DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION rms_ordering.check_dining_cart_waiting_line_returned();

-- checkout_scope_held: while another guest's scope is live on this cart (the cart still at the
-- version it produced), no quote, checkout details or checkout session of this cart by anyone but
-- the paying phone (its session, or a later session of the same participant).
CREATE FUNCTION rms_ordering.refuse_checkout_during_foreign_scope() RETURNS trigger
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
      AND o.guest_session_id=NEW.guest_session_id AND o.participant_id=s.chooser_participant_id)) THEN
  RAISE EXCEPTION 'CHECKOUT_SCOPE_HELD' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END;
$$;
CREATE TRIGGER b1_checkout_scope_held BEFORE INSERT ON rms_ordering.cart_quote_attachment
 FOR EACH ROW EXECUTE FUNCTION rms_ordering.refuse_checkout_during_foreign_scope();
CREATE TRIGGER b1_checkout_scope_held BEFORE INSERT ON rms_ordering.checkout_details_record
 FOR EACH ROW EXECUTE FUNCTION rms_ordering.refuse_checkout_during_foreign_scope();
CREATE TRIGGER b1_checkout_scope_held BEFORE INSERT ON rms_ordering.checkout_session_record
 FOR EACH ROW EXECUTE FUNCTION rms_ordering.refuse_checkout_during_foreign_scope();

CREATE FUNCTION rms_ordering.reject_dining_checkout_scope_mutation() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
BEGIN
 RAISE EXCEPTION 'append-only checkout scope history' USING ERRCODE='55000';
END;
$$;
CREATE TRIGGER dining_checkout_scope_no_mutation BEFORE UPDATE OR DELETE ON rms_ordering.dining_checkout_scope
 FOR EACH ROW EXECUTE FUNCTION rms_ordering.reject_dining_checkout_scope_mutation();
CREATE TRIGGER dining_checkout_scope_no_truncate BEFORE TRUNCATE ON rms_ordering.dining_checkout_scope
 FOR EACH STATEMENT EXECUTE FUNCTION rms_ordering.reject_dining_checkout_scope_mutation();
CREATE TRIGGER dining_checkout_scope_extension_no_mutation BEFORE UPDATE OR DELETE ON rms_ordering.dining_checkout_scope_extension
 FOR EACH ROW EXECUTE FUNCTION rms_ordering.reject_dining_checkout_scope_mutation();
CREATE TRIGGER dining_checkout_scope_extension_no_truncate BEFORE TRUNCATE ON rms_ordering.dining_checkout_scope_extension
 FOR EACH STATEMENT EXECUTE FUNCTION rms_ordering.reject_dining_checkout_scope_mutation();
CREATE TRIGGER dining_cart_waiting_line_no_mutation BEFORE UPDATE OR DELETE ON rms_ordering.dining_cart_waiting_line
 FOR EACH ROW EXECUTE FUNCTION rms_ordering.reject_dining_checkout_scope_mutation();
CREATE TRIGGER dining_cart_waiting_line_no_truncate BEFORE TRUNCATE ON rms_ordering.dining_cart_waiting_line
 FOR EACH STATEMENT EXECUTE FUNCTION rms_ordering.reject_dining_checkout_scope_mutation();
CREATE TRIGGER dining_cart_waiting_line_resolution_no_mutation BEFORE UPDATE OR DELETE ON rms_ordering.dining_cart_waiting_line_resolution
 FOR EACH ROW EXECUTE FUNCTION rms_ordering.reject_dining_checkout_scope_mutation();
CREATE TRIGGER dining_cart_waiting_line_resolution_no_truncate BEFORE TRUNCATE ON rms_ordering.dining_cart_waiting_line_resolution
 FOR EACH STATEMENT EXECUTE FUNCTION rms_ordering.reject_dining_checkout_scope_mutation();

ALTER TABLE rms_ordering.dining_checkout_scope ENABLE ROW LEVEL SECURITY;
ALTER TABLE rms_ordering.dining_checkout_scope FORCE ROW LEVEL SECURITY;
CREATE POLICY dining_checkout_scope_store_scope ON rms_ordering.dining_checkout_scope
 USING (brand_id=platform_helpers.current_brand_id() AND store_id=platform_helpers.current_store_id())
 WITH CHECK (brand_id=platform_helpers.current_brand_id() AND store_id=platform_helpers.current_store_id());
ALTER TABLE rms_ordering.dining_checkout_scope_extension ENABLE ROW LEVEL SECURITY;
ALTER TABLE rms_ordering.dining_checkout_scope_extension FORCE ROW LEVEL SECURITY;
CREATE POLICY dining_checkout_scope_extension_store_scope ON rms_ordering.dining_checkout_scope_extension
 USING (brand_id=platform_helpers.current_brand_id() AND store_id=platform_helpers.current_store_id())
 WITH CHECK (brand_id=platform_helpers.current_brand_id() AND store_id=platform_helpers.current_store_id());
ALTER TABLE rms_ordering.dining_cart_waiting_line ENABLE ROW LEVEL SECURITY;
ALTER TABLE rms_ordering.dining_cart_waiting_line FORCE ROW LEVEL SECURITY;
CREATE POLICY dining_cart_waiting_line_store_scope ON rms_ordering.dining_cart_waiting_line
 USING (brand_id=platform_helpers.current_brand_id() AND store_id=platform_helpers.current_store_id())
 WITH CHECK (brand_id=platform_helpers.current_brand_id() AND store_id=platform_helpers.current_store_id());
ALTER TABLE rms_ordering.dining_cart_waiting_line_resolution ENABLE ROW LEVEL SECURITY;
ALTER TABLE rms_ordering.dining_cart_waiting_line_resolution FORCE ROW LEVEL SECURITY;
CREATE POLICY dining_cart_waiting_line_resolution_store_scope ON rms_ordering.dining_cart_waiting_line_resolution
 USING (brand_id=platform_helpers.current_brand_id() AND store_id=platform_helpers.current_store_id())
 WITH CHECK (brand_id=platform_helpers.current_brand_id() AND store_id=platform_helpers.current_store_id());

REVOKE ALL ON TABLE rms_ordering.dining_checkout_scope FROM PUBLIC;
REVOKE ALL ON TABLE rms_ordering.dining_checkout_scope_extension FROM PUBLIC;
REVOKE ALL ON TABLE rms_ordering.dining_cart_waiting_line FROM PUBLIC;
REVOKE ALL ON TABLE rms_ordering.dining_cart_waiting_line_resolution FROM PUBLIC;
REVOKE ALL ON FUNCTION rms_ordering.validate_dining_checkout_scope() FROM PUBLIC;
REVOKE ALL ON FUNCTION rms_ordering.validate_dining_checkout_scope_extension() FROM PUBLIC;
REVOKE ALL ON FUNCTION rms_ordering.validate_dining_cart_waiting_line() FROM PUBLIC;
REVOKE ALL ON FUNCTION rms_ordering.check_dining_cart_waiting_line_left() FROM PUBLIC;
REVOKE ALL ON FUNCTION rms_ordering.validate_dining_cart_waiting_line_resolution() FROM PUBLIC;
REVOKE ALL ON FUNCTION rms_ordering.check_dining_cart_waiting_line_returned() FROM PUBLIC;
REVOKE ALL ON FUNCTION rms_ordering.refuse_checkout_during_foreign_scope() FROM PUBLIC;
REVOKE ALL ON FUNCTION rms_ordering.reject_dining_checkout_scope_mutation() FROM PUBLIC;
