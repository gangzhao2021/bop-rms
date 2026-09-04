-- bop-rms-migration: 1
-- owner: @bop/identity
-- schema: bop_identity
-- phase: expand
-- risk: high
-- transaction: required
-- lock-timeout-ms: 5000
-- statement-timeout-ms: 60000
-- recovery: forward-fix
CREATE TABLE bop_identity.guest_session_operation (
  LIKE bop_identity.guest_session INCLUDING CONSTRAINTS,
  PRIMARY KEY (operation_id),
  FOREIGN KEY (guest_session_id) REFERENCES bop_identity.guest_session (guest_session_id)
);

CREATE INDEX guest_session_operation_scope_idx
  ON bop_identity.guest_session_operation (brand_id, store_id, guest_session_id);

CREATE FUNCTION bop_identity.reject_guest_session_operation_mutation()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
BEGIN
  RAISE EXCEPTION 'Guest Session operation history is append-only' USING ERRCODE = '55000';
END;
$$;
REVOKE ALL ON FUNCTION bop_identity.reject_guest_session_operation_mutation() FROM PUBLIC;

CREATE TRIGGER guest_session_operation_no_mutation
  BEFORE UPDATE OR DELETE ON bop_identity.guest_session_operation
  FOR EACH ROW EXECUTE FUNCTION bop_identity.reject_guest_session_operation_mutation();
CREATE TRIGGER guest_session_operation_no_truncate
  BEFORE TRUNCATE ON bop_identity.guest_session_operation
  FOR EACH STATEMENT EXECUTE FUNCTION bop_identity.reject_guest_session_operation_mutation();

ALTER TABLE bop_identity.guest_session_operation ENABLE ROW LEVEL SECURITY;
ALTER TABLE bop_identity.guest_session_operation FORCE ROW LEVEL SECURITY;
CREATE POLICY guest_session_operation_scope_policy ON bop_identity.guest_session_operation
  USING (brand_id = platform_helpers.current_brand_id()
    AND store_id = platform_helpers.current_store_id())
  WITH CHECK (brand_id = platform_helpers.current_brand_id()
    AND store_id = platform_helpers.current_store_id());
REVOKE ALL ON TABLE bop_identity.guest_session_operation FROM PUBLIC;
