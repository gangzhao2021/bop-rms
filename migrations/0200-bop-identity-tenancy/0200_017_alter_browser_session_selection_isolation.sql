-- bop-rms-migration: 1
-- owner: @bop/identity
-- schema: bop_identity
-- phase: expand
-- risk: medium
-- transaction: required
-- lock-timeout-ms: 5000
-- statement-timeout-ms: 60000
-- recovery: forward-fix
-- Pre-Tenant selection is scoped to the authenticated session and Actor.
-- Its selected Brand/Store are references to revalidate, never permission grants.
ALTER TABLE bop_identity.browser_session_selection ENABLE ROW LEVEL SECURITY;
ALTER TABLE bop_identity.browser_session_selection FORCE ROW LEVEL SECURITY;
CREATE POLICY browser_session_selection_current_session ON bop_identity.browser_session_selection
  USING (session_id = NULLIF(current_setting('bop.identity_session_id', true), '')::uuid AND actor_id = NULLIF(current_setting('bop.identity_actor_id', true), '')::uuid)
  WITH CHECK (session_id = NULLIF(current_setting('bop.identity_session_id', true), '')::uuid AND actor_id = NULLIF(current_setting('bop.identity_actor_id', true), '')::uuid);
