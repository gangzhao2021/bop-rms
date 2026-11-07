-- bop-rms-migration: 1
-- owner: @bop/identity
-- schema: bop_identity
-- phase: expand
-- risk: medium
-- transaction: required
-- lock-timeout-ms: 5000
-- statement-timeout-ms: 60000
-- recovery: forward-fix
-- A choice is not authorization. The caller revalidates the owning Brand,
-- Membership and Permission; this table introduces no independent Tenant identity.
CREATE TABLE bop_identity.browser_brand_session_selection (
  session_id platform_helpers.uuid_v7 PRIMARY KEY,
  actor_id platform_helpers.uuid_v7 NOT NULL,
  brand_id platform_helpers.uuid_v7 NOT NULL,
  selected_at timestamptz NOT NULL CHECK (
    isfinite(selected_at) AND selected_at=date_trunc('milliseconds',selected_at)
  ),
  CONSTRAINT browser_brand_session_selection_session_fkey FOREIGN KEY (session_id,actor_id)
    REFERENCES bop_identity.authentication_session(session_id,actor_id)
);
CREATE FUNCTION bop_identity.reject_browser_brand_selection_mutation() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
BEGIN
  RAISE EXCEPTION 'BrowserBrandSelectionImmutable' USING ERRCODE='23514';
END;
$$;
CREATE TRIGGER browser_brand_selection_immutable
  BEFORE UPDATE OR DELETE ON bop_identity.browser_brand_session_selection
  FOR EACH ROW EXECUTE FUNCTION bop_identity.reject_browser_brand_selection_mutation();
CREATE TRIGGER browser_brand_selection_no_truncate
  BEFORE TRUNCATE ON bop_identity.browser_brand_session_selection
  FOR EACH STATEMENT EXECUTE FUNCTION bop_identity.reject_browser_brand_selection_mutation();
ALTER TABLE bop_identity.browser_brand_session_selection ENABLE ROW LEVEL SECURITY;
ALTER TABLE bop_identity.browser_brand_session_selection FORCE ROW LEVEL SECURITY;
CREATE POLICY browser_brand_selection_current_session ON bop_identity.browser_brand_session_selection
  USING (session_id = NULLIF(current_setting('bop.identity_session_id', true), '')::uuid AND actor_id = NULLIF(current_setting('bop.identity_actor_id', true), '')::uuid)
  WITH CHECK (session_id = NULLIF(current_setting('bop.identity_session_id', true), '')::uuid AND actor_id = NULLIF(current_setting('bop.identity_actor_id', true), '')::uuid);
REVOKE ALL ON TABLE bop_identity.browser_brand_session_selection FROM PUBLIC;
REVOKE ALL ON FUNCTION bop_identity.reject_browser_brand_selection_mutation() FROM PUBLIC;
