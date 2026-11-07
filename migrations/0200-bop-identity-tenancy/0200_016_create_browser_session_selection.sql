-- bop-rms-migration: 1
-- owner: @bop/identity
-- schema: bop_identity
-- phase: expand
-- risk: medium
-- transaction: required
-- lock-timeout-ms: 5000
-- statement-timeout-ms: 60000
-- recovery: forward-fix
ALTER TABLE bop_identity.authentication_session
  ADD CONSTRAINT authentication_session_actor_identity_unique UNIQUE (session_id, actor_id);
CREATE TABLE bop_identity.browser_session_selection (
  session_id platform_helpers.uuid_v7 PRIMARY KEY,
  actor_id platform_helpers.uuid_v7 NOT NULL,
  tenant_id platform_helpers.uuid_v7 NOT NULL,
  brand_id platform_helpers.uuid_v7 NOT NULL,
  store_id platform_helpers.uuid_v7 NOT NULL,
  selected_at timestamptz NOT NULL,
  CONSTRAINT browser_session_selection_session_fkey FOREIGN KEY (session_id, actor_id)
    REFERENCES bop_identity.authentication_session (session_id, actor_id)
);
CREATE RULE browser_session_selection_no_update AS
  ON UPDATE TO bop_identity.browser_session_selection DO INSTEAD NOTHING;
CREATE RULE browser_session_selection_no_delete AS
  ON DELETE TO bop_identity.browser_session_selection DO INSTEAD NOTHING;
REVOKE ALL ON TABLE bop_identity.browser_session_selection FROM PUBLIC;
