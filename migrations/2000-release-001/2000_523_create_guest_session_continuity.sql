-- bop-rms-migration: 1
-- owner: @bop/identity
-- schema: bop_identity
-- phase: expand
-- risk: medium
-- transaction: required
-- lock-timeout-ms: 5000
-- statement-timeout-ms: 60000
-- recovery: forward-fix
-- WP-2423 shared-table-checkout (b), lost cookie (DEC-DINING-CHECKOUT-SCOPE): a guest whose phone
-- lost its Guest cookie (the browser cleared it, the session cookie expired) but kept the page's
-- storage scans the table code again and is the same phone at the table, not a new one: "Only what
-- I added" still finds the dishes it added. No login, no contact: a seated Guest Session is given a
-- continuity token (256 bits, shown once, only its SHA-256 kept here); the scan presents it and,
-- while that session is still live and seated at the same Store, table and code version, Identity
-- rotates it into a successor session bound to the same dining session and participant (the old
-- one revoked 'Rotated'). Each token is used at most once; the successor gets a new token.
-- guest_session_continuity: a token issued for a live, seated session.
-- guest_session_continuity_use: the token used once, the session it rotated and the successor.
-- Append-only, Store RLS. The token is a bearer value: never in a URL or log; it only works with a
-- physical scan of the same table's current code and only while the old session is live.
-- Grants: api SELECT, INSERT (Owner standing approval 2026-10-14 「我都批准，之后不需要问我」;
-- WP-2423 shared-table-checkout).

CREATE TABLE bop_identity.guest_session_continuity (
 continuity_id platform_helpers.uuid_v7 NOT NULL,
 brand_id platform_helpers.uuid_v7 NOT NULL,
 store_id platform_helpers.uuid_v7 NOT NULL,
 guest_session_id platform_helpers.uuid_v7 NOT NULL,
 continuity_hash bytea NOT NULL CHECK (octet_length(continuity_hash) = 32),
 operation_id platform_helpers.uuid_v7 NOT NULL,
 issued_at timestamptz NOT NULL CHECK (isfinite(issued_at) AND issued_at=date_trunc('milliseconds',issued_at)),
 PRIMARY KEY (brand_id,store_id,continuity_id),
 CONSTRAINT guest_session_continuity_id_unique UNIQUE (continuity_id),
 CONSTRAINT guest_session_continuity_hash_unique UNIQUE (continuity_hash),
 CONSTRAINT guest_session_continuity_operation_unique UNIQUE (brand_id,store_id,operation_id),
 CONSTRAINT guest_session_continuity_session_fk FOREIGN KEY (brand_id,store_id,guest_session_id)
  REFERENCES bop_identity.guest_session (brand_id,store_id,guest_session_id)
);
CREATE INDEX guest_session_continuity_session_idx
 ON bop_identity.guest_session_continuity (brand_id,store_id,guest_session_id);

CREATE TABLE bop_identity.guest_session_continuity_use (
 continuity_id platform_helpers.uuid_v7 NOT NULL,
 brand_id platform_helpers.uuid_v7 NOT NULL,
 store_id platform_helpers.uuid_v7 NOT NULL,
 from_guest_session_id platform_helpers.uuid_v7 NOT NULL,
 to_guest_session_id platform_helpers.uuid_v7 NOT NULL,
 operation_id platform_helpers.uuid_v7 NOT NULL,
 occurred_at timestamptz NOT NULL CHECK (isfinite(occurred_at) AND occurred_at=date_trunc('milliseconds',occurred_at)),
 PRIMARY KEY (brand_id,store_id,continuity_id),
 CONSTRAINT guest_session_continuity_use_once UNIQUE (continuity_id),
 CONSTRAINT guest_session_continuity_use_from_once UNIQUE (from_guest_session_id),
 CONSTRAINT guest_session_continuity_use_to_once UNIQUE (to_guest_session_id),
 CONSTRAINT guest_session_continuity_use_operation_unique UNIQUE (brand_id,store_id,operation_id),
 CONSTRAINT guest_session_continuity_use_token_fk FOREIGN KEY (brand_id,store_id,continuity_id)
  REFERENCES bop_identity.guest_session_continuity (brand_id,store_id,continuity_id),
 CONSTRAINT guest_session_continuity_use_to_fk FOREIGN KEY (brand_id,store_id,to_guest_session_id)
  REFERENCES bop_identity.guest_session (brand_id,store_id,guest_session_id)
);

-- A token is issued only for a live session seated at a table (DiningBound), at an instant it is live.
CREATE FUNCTION bop_identity.validate_guest_session_continuity() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
BEGIN
 IF NOT EXISTS (SELECT 1 FROM bop_identity.guest_session s WHERE s.brand_id=NEW.brand_id
   AND s.store_id=NEW.store_id AND s.guest_session_id=NEW.guest_session_id AND s.status='Active'
   AND s.channel='DineIn' AND s.dining_state='DiningBound'
   AND NEW.issued_at>=s.created_at AND NEW.issued_at<s.absolute_expires_at) THEN
  RAISE EXCEPTION 'a continuity token is for a live seated guest session' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END;
$$;
CREATE TRIGGER guest_session_continuity_validate BEFORE INSERT ON bop_identity.guest_session_continuity
 FOR EACH ROW EXECUTE FUNCTION bop_identity.validate_guest_session_continuity();

-- A use rotates the token's own session (now revoked 'Rotated') into a successor seated for the
-- same dining session and participant, at the same Store, table and code version.
CREATE FUNCTION bop_identity.validate_guest_session_continuity_use() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
BEGIN
 IF NOT EXISTS (SELECT 1 FROM bop_identity.guest_session_continuity c
   JOIN bop_identity.guest_session f ON f.brand_id=c.brand_id AND f.store_id=c.store_id
    AND f.guest_session_id=c.guest_session_id
   JOIN bop_identity.guest_session t ON t.brand_id=c.brand_id AND t.store_id=c.store_id
    AND t.guest_session_id=NEW.to_guest_session_id
   WHERE c.brand_id=NEW.brand_id AND c.store_id=NEW.store_id AND c.continuity_id=NEW.continuity_id
    AND c.guest_session_id=NEW.from_guest_session_id
    AND f.status='Revoked' AND f.revocation_reason='Rotated' AND f.revoked_at=NEW.occurred_at
    AND t.status='Active' AND t.dining_state='DiningBound' AND t.rotated_from_guest_session_id=f.guest_session_id
    AND t.dining_session_id=f.dining_session_id AND t.dining_participant_id=f.dining_participant_id
    AND t.public_store_id=f.public_store_id AND t.public_table_id=f.public_table_id
    AND t.qr_id=f.qr_id AND t.qr_revocation_version=f.qr_revocation_version
    AND t.created_at=NEW.occurred_at AND NEW.occurred_at<f.absolute_expires_at) THEN
  RAISE EXCEPTION 'a continuity token rotates its own live session into the same seat' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END;
$$;
CREATE TRIGGER guest_session_continuity_use_validate BEFORE INSERT ON bop_identity.guest_session_continuity_use
 FOR EACH ROW EXECUTE FUNCTION bop_identity.validate_guest_session_continuity_use();

CREATE FUNCTION bop_identity.reject_guest_session_continuity_mutation() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
BEGIN
 RAISE EXCEPTION 'append-only guest session continuity' USING ERRCODE='55000';
END;
$$;
CREATE TRIGGER guest_session_continuity_no_mutation BEFORE UPDATE OR DELETE ON bop_identity.guest_session_continuity
 FOR EACH ROW EXECUTE FUNCTION bop_identity.reject_guest_session_continuity_mutation();
CREATE TRIGGER guest_session_continuity_no_truncate BEFORE TRUNCATE ON bop_identity.guest_session_continuity
 FOR EACH STATEMENT EXECUTE FUNCTION bop_identity.reject_guest_session_continuity_mutation();
CREATE TRIGGER guest_session_continuity_use_no_mutation BEFORE UPDATE OR DELETE ON bop_identity.guest_session_continuity_use
 FOR EACH ROW EXECUTE FUNCTION bop_identity.reject_guest_session_continuity_mutation();
CREATE TRIGGER guest_session_continuity_use_no_truncate BEFORE TRUNCATE ON bop_identity.guest_session_continuity_use
 FOR EACH STATEMENT EXECUTE FUNCTION bop_identity.reject_guest_session_continuity_mutation();

ALTER TABLE bop_identity.guest_session_continuity ENABLE ROW LEVEL SECURITY;
ALTER TABLE bop_identity.guest_session_continuity FORCE ROW LEVEL SECURITY;
CREATE POLICY guest_session_continuity_scope ON bop_identity.guest_session_continuity
 USING (brand_id=platform_helpers.current_brand_id() AND store_id=platform_helpers.current_store_id())
 WITH CHECK (brand_id=platform_helpers.current_brand_id() AND store_id=platform_helpers.current_store_id());
ALTER TABLE bop_identity.guest_session_continuity_use ENABLE ROW LEVEL SECURITY;
ALTER TABLE bop_identity.guest_session_continuity_use FORCE ROW LEVEL SECURITY;
CREATE POLICY guest_session_continuity_use_scope ON bop_identity.guest_session_continuity_use
 USING (brand_id=platform_helpers.current_brand_id() AND store_id=platform_helpers.current_store_id())
 WITH CHECK (brand_id=platform_helpers.current_brand_id() AND store_id=platform_helpers.current_store_id());
REVOKE ALL ON TABLE bop_identity.guest_session_continuity FROM PUBLIC;
REVOKE ALL ON TABLE bop_identity.guest_session_continuity_use FROM PUBLIC;
REVOKE ALL ON FUNCTION bop_identity.validate_guest_session_continuity() FROM PUBLIC;
REVOKE ALL ON FUNCTION bop_identity.validate_guest_session_continuity_use() FROM PUBLIC;
REVOKE ALL ON FUNCTION bop_identity.reject_guest_session_continuity_mutation() FROM PUBLIC;
