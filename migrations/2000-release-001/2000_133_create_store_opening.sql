-- bop-rms-migration: 1
-- owner: @bop/tenant
-- schema: bop_tenant
-- phase: expand
-- risk: medium
-- transaction: required
-- lock-timeout-ms: 5000
-- statement-timeout-ms: 60000
-- recovery: forward-fix
-- WP-2423 DEC-BRAND-MULTI-STORE-ONE-INSTALLATION segment 3a (coordinator 2026-10-30, Owner standing
-- authority): a Brand's Owner opens another Store from the product. The opening is recorded once
-- per Store (append-only), naming who opened it, from which Store, their Store assignment there,
-- the request's exact intent and the audit record. The Store record itself is created with it.
-- Grants: api SELECT/INSERT here and INSERT on bop_tenant.store (Owner standing approval
-- 2026-10-14, WP-2423).
CREATE TABLE bop_tenant.store_opening (
 opening_id platform_helpers.uuid_v7 PRIMARY KEY,
 brand_id platform_helpers.uuid_v7 NOT NULL,
 store_id platform_helpers.uuid_v7 NOT NULL,
 opened_from_store_id platform_helpers.uuid_v7 NOT NULL,
 actor_id platform_helpers.uuid_v7 NOT NULL,
 membership_id platform_helpers.uuid_v7 NOT NULL,
 store_assignment_id platform_helpers.uuid_v7 NOT NULL,
 code text NOT NULL CHECK (code ~ '^[A-Z][A-Z0-9_-]{0,62}$'),
 display_name text NOT NULL CHECK (char_length(display_name) BETWEEN 1 AND 160),
 time_zone text NOT NULL CHECK (char_length(time_zone) BETWEEN 3 AND 64),
 locale text NOT NULL CHECK (char_length(locale) BETWEEN 2 AND 35),
 intent_digest text NOT NULL CHECK (intent_digest ~ '^sha256:[0-9a-f]{64}$'),
 audit_id platform_helpers.uuid_v7 NOT NULL,
 opened_at timestamptz NOT NULL CHECK (isfinite(opened_at) AND opened_at=date_trunc('milliseconds',opened_at)),
 CONSTRAINT store_opening_once UNIQUE (brand_id,store_id),
 CONSTRAINT store_opening_elsewhere CHECK (opened_from_store_id <> store_id),
 -- The new Store's identity is the opening request's, so a retried request finds its own result.
 CONSTRAINT store_opening_identity CHECK (opening_id = store_id),
 FOREIGN KEY (store_id,brand_id) REFERENCES bop_tenant.store(store_id,brand_id),
 FOREIGN KEY (opened_from_store_id,brand_id) REFERENCES bop_tenant.store(store_id,brand_id)
 -- membership_id and store_assignment_id are Membership's records, written by its own command in
 -- the same transaction (no foreign key across owners).
);

CREATE FUNCTION bop_tenant.reject_store_opening_mutation() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
BEGIN
 RAISE EXCEPTION 'append-only store opening' USING ERRCODE='55000';
END;
$$;
REVOKE ALL ON FUNCTION bop_tenant.reject_store_opening_mutation() FROM PUBLIC;
CREATE TRIGGER store_opening_no_mutation BEFORE UPDATE OR DELETE ON bop_tenant.store_opening
 FOR EACH ROW EXECUTE FUNCTION bop_tenant.reject_store_opening_mutation();
CREATE TRIGGER store_opening_no_truncate BEFORE TRUNCATE ON bop_tenant.store_opening
 FOR EACH STATEMENT EXECUTE FUNCTION bop_tenant.reject_store_opening_mutation();

ALTER TABLE bop_tenant.store_opening ENABLE ROW LEVEL SECURITY;
ALTER TABLE bop_tenant.store_opening FORCE ROW LEVEL SECURITY;
CREATE POLICY store_opening_scope ON bop_tenant.store_opening
 USING (brand_id=platform_helpers.current_brand_id() AND store_id=platform_helpers.current_store_id())
 WITH CHECK (brand_id=platform_helpers.current_brand_id() AND store_id=platform_helpers.current_store_id());
REVOKE ALL ON TABLE bop_tenant.store_opening FROM PUBLIC;
