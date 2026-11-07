-- bop-rms-migration: 1
-- owner: @bop/identity
-- schema: bop_identity
-- phase: expand
-- risk: high
-- transaction: required
-- lock-timeout-ms: 5000
-- statement-timeout-ms: 60000
-- recovery: forward-fix
-- DEC-PILOT-NOTIFICATIONS R1 (IDR-0031 §87.4.1, DEC-CUSTOMER-ORDER-CONTINUITY R1): one-time order
-- recovery link. A 256-bit token is minted just before a customer order message is sent; only its
-- keyed hash (purpose-separated pepper, versioned) is stored with the Order, the Order's original
-- Guest Session and a 30-minute expiry. At most two unexpired, unconsumed siblings per Order.
-- Consuming one appends a Consumed fact for it and a Revoked fact for every sibling, then re-keys
-- that same Guest Session (new session/CSRF selectors) so the Order stays readable on the new
-- device. Re-keying is accepted by the database only together with that Consumed fact.
-- Append-only; no token, credential or contact value is stored.

CREATE TABLE bop_identity.order_recovery_authorization (
 authorization_id platform_helpers.uuid_v7 PRIMARY KEY,
 brand_id platform_helpers.uuid_v7 NOT NULL,
 store_id platform_helpers.uuid_v7 NOT NULL,
 order_id platform_helpers.uuid_v7 NOT NULL,
 guest_session_id platform_helpers.uuid_v7 NOT NULL,
 purpose text NOT NULL CHECK (purpose = 'OrderResume'),
 token_hash bytea NOT NULL UNIQUE CHECK (octet_length(token_hash) = 32),
 pepper_version integer NOT NULL CHECK (pepper_version > 0),
 notification_attempt_id platform_helpers.uuid_v7 NOT NULL UNIQUE,
 issued_at timestamptz NOT NULL CHECK (isfinite(issued_at) AND issued_at=date_trunc('milliseconds',issued_at)),
 expires_at timestamptz NOT NULL CHECK (isfinite(expires_at) AND expires_at=date_trunc('milliseconds',expires_at)),
 CONSTRAINT order_recovery_authorization_lifetime CHECK (
  expires_at > issued_at AND expires_at <= issued_at + interval '30 minutes'
 ),
 CONSTRAINT order_recovery_authorization_scope_identity UNIQUE (authorization_id,brand_id,store_id),
 CONSTRAINT order_recovery_authorization_session_fk FOREIGN KEY (guest_session_id)
  REFERENCES bop_identity.guest_session (guest_session_id)
);
CREATE INDEX order_recovery_authorization_order
 ON bop_identity.order_recovery_authorization (brand_id,store_id,order_id,expires_at);

CREATE TABLE bop_identity.order_recovery_consumption (
 authorization_id platform_helpers.uuid_v7 PRIMARY KEY,
 brand_id platform_helpers.uuid_v7 NOT NULL,
 store_id platform_helpers.uuid_v7 NOT NULL,
 outcome text NOT NULL CHECK (outcome IN ('Consumed','Revoked')),
 guest_session_id platform_helpers.uuid_v7 NOT NULL,
 -- The Guest Session operation that re-keyed the session (Consumed only).
 rekey_operation_id platform_helpers.uuid_v7 UNIQUE,
 recorded_at timestamptz NOT NULL CHECK (isfinite(recorded_at) AND recorded_at=date_trunc('milliseconds',recorded_at)),
 CONSTRAINT order_recovery_consumption_authorization_fk FOREIGN KEY (authorization_id,brand_id,store_id)
  REFERENCES bop_identity.order_recovery_authorization (authorization_id,brand_id,store_id),
 CONSTRAINT order_recovery_consumption_rekey CHECK ((outcome = 'Consumed') = (rekey_operation_id IS NOT NULL))
);

CREATE FUNCTION bop_identity.reject_order_recovery_mutation() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
BEGIN
 RAISE EXCEPTION 'append-only order recovery evidence' USING ERRCODE='55000';
END;
$$;
REVOKE ALL ON FUNCTION bop_identity.reject_order_recovery_mutation() FROM PUBLIC;
CREATE TRIGGER order_recovery_authorization_no_mutation
 BEFORE UPDATE OR DELETE ON bop_identity.order_recovery_authorization
 FOR EACH ROW EXECUTE FUNCTION bop_identity.reject_order_recovery_mutation();
CREATE TRIGGER order_recovery_consumption_no_mutation
 BEFORE UPDATE OR DELETE ON bop_identity.order_recovery_consumption
 FOR EACH ROW EXECUTE FUNCTION bop_identity.reject_order_recovery_mutation();

-- A consumption must name the authorization's own Guest Session.
CREATE FUNCTION bop_identity.check_order_recovery_consumption() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
BEGIN
 IF NOT EXISTS (
  SELECT 1 FROM bop_identity.order_recovery_authorization a
  WHERE a.authorization_id = NEW.authorization_id AND a.brand_id = NEW.brand_id
   AND a.store_id = NEW.store_id AND a.guest_session_id = NEW.guest_session_id
   AND (NEW.outcome = 'Revoked' OR (a.expires_at > NEW.recorded_at AND a.issued_at <= NEW.recorded_at))
 ) THEN
  RAISE EXCEPTION 'order recovery consumption does not match its authorization' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION bop_identity.check_order_recovery_consumption() FROM PUBLIC;
CREATE TRIGGER order_recovery_consumption_check BEFORE INSERT ON bop_identity.order_recovery_consumption
 FOR EACH ROW EXECUTE FUNCTION bop_identity.check_order_recovery_consumption();

-- Guest Session selectors change only by a recovery re-key: same session, still Active, every other
-- column unchanged except the operation, last-seen/idle pair and version, and a Consumed fact for
-- this session naming this new operation recorded at this instant.
CREATE FUNCTION bop_identity.guard_guest_session_rekey() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
BEGIN
 IF NEW.session_selector_hash IS NOT DISTINCT FROM OLD.session_selector_hash
  AND NEW.csrf_selector_hash IS NOT DISTINCT FROM OLD.csrf_selector_hash THEN
  RETURN NEW;
 END IF;
 IF OLD.status <> 'Active' OR NEW.status <> 'Active'
  OR NEW.session_selector_hash = OLD.session_selector_hash
  OR NEW.csrf_selector_hash = OLD.csrf_selector_hash
  OR NEW.operation_id = OLD.operation_id
  OR NEW.version <> OLD.version + 1
  OR NEW.last_seen_at < OLD.last_seen_at
  OR (NEW.guest_session_id, NEW.brand_id, NEW.store_id, NEW.public_store_id, NEW.public_table_id,
      NEW.channel, NEW.locale, NEW.qr_id, NEW.qr_revocation_version, NEW.dining_state,
      NEW.created_at, NEW.absolute_expires_at, NEW.order_closed_at, NEW.closure_expires_at,
      NEW.rotated_from_guest_session_id, NEW.revocation_reason, NEW.revoked_at,
      NEW.dining_session_id, NEW.dining_participant_id)
   IS DISTINCT FROM
     (OLD.guest_session_id, OLD.brand_id, OLD.store_id, OLD.public_store_id, OLD.public_table_id,
      OLD.channel, OLD.locale, OLD.qr_id, OLD.qr_revocation_version, OLD.dining_state,
      OLD.created_at, OLD.absolute_expires_at, OLD.order_closed_at, OLD.closure_expires_at,
      OLD.rotated_from_guest_session_id, OLD.revocation_reason, OLD.revoked_at,
      OLD.dining_session_id, OLD.dining_participant_id)
  OR NOT EXISTS (
   SELECT 1 FROM bop_identity.order_recovery_consumption c
   WHERE c.guest_session_id = NEW.guest_session_id AND c.brand_id = NEW.brand_id
    AND c.store_id = NEW.store_id AND c.outcome = 'Consumed'
    AND c.rekey_operation_id = NEW.operation_id AND c.recorded_at = NEW.last_seen_at
  ) THEN
  RAISE EXCEPTION 'guest session credentials change only through order recovery' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION bop_identity.guard_guest_session_rekey() FROM PUBLIC;
CREATE TRIGGER guest_session_rekey_guard BEFORE UPDATE ON bop_identity.guest_session
 FOR EACH ROW EXECUTE FUNCTION bop_identity.guard_guest_session_rekey();

ALTER TABLE bop_identity.order_recovery_authorization ENABLE ROW LEVEL SECURITY;
ALTER TABLE bop_identity.order_recovery_authorization FORCE ROW LEVEL SECURITY;
CREATE POLICY order_recovery_authorization_scope ON bop_identity.order_recovery_authorization
 USING (brand_id = platform_helpers.current_brand_id() AND store_id = platform_helpers.current_store_id())
 WITH CHECK (brand_id = platform_helpers.current_brand_id() AND store_id = platform_helpers.current_store_id());
ALTER TABLE bop_identity.order_recovery_consumption ENABLE ROW LEVEL SECURITY;
ALTER TABLE bop_identity.order_recovery_consumption FORCE ROW LEVEL SECURITY;
CREATE POLICY order_recovery_consumption_scope ON bop_identity.order_recovery_consumption
 USING (brand_id = platform_helpers.current_brand_id() AND store_id = platform_helpers.current_store_id())
 WITH CHECK (brand_id = platform_helpers.current_brand_id() AND store_id = platform_helpers.current_store_id());
REVOKE ALL ON TABLE bop_identity.order_recovery_authorization FROM PUBLIC;
REVOKE ALL ON TABLE bop_identity.order_recovery_consumption FROM PUBLIC;
