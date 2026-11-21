-- bop-rms-migration: 1
-- owner: @rms/payment
-- schema: rms_payment
-- phase: expand
-- risk: low
-- transaction: required
-- lock-timeout-ms: 5000
-- statement-timeout-ms: 60000
-- recovery: forward-fix
-- WP-2423 M14 (DEC-OWNER-DEFAULTS-2026-11-06 item 2): the refund role the requester held when the
-- request was recorded (Manager, Owner as sole operator, or Staff: a cashier who never sends it).
-- The Approvals queue lists a cashier's request for a manager at once from this fact, not from the
-- requester's role today. Written once in the request's transaction; append-only.
CREATE TABLE rms_payment.ordinary_refund_requester_role (
 brand_id platform_helpers.uuid_v7 NOT NULL,
 store_id platform_helpers.uuid_v7 NOT NULL,
 order_id platform_helpers.uuid_v7 NOT NULL,
 request_id platform_helpers.uuid_v7 NOT NULL,
 actor_id platform_helpers.uuid_v7 NOT NULL,
 requester_role text NOT NULL CHECK (requester_role IN ('Manager','Owner','Staff')),
 recorded_at timestamptz NOT NULL CHECK (isfinite(recorded_at) AND recorded_at=date_trunc('milliseconds',recorded_at)),
 PRIMARY KEY (brand_id,store_id,request_id),
 FOREIGN KEY (brand_id,store_id,request_id)
  REFERENCES rms_payment.ordinary_refund_request(brand_id,store_id,request_id)
);

-- The requester and Order are the request's own, recorded at the request instant.
CREATE FUNCTION rms_payment.check_ordinary_refund_requester_role() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
BEGIN
 IF NOT EXISTS (SELECT 1 FROM rms_payment.ordinary_refund_request r WHERE r.brand_id=NEW.brand_id
  AND r.store_id=NEW.store_id AND r.request_id=NEW.request_id AND r.order_id=NEW.order_id
  AND r.actor_id=NEW.actor_id AND r.requested_at=NEW.recorded_at)
 THEN RAISE EXCEPTION 'requester role does not match the request' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION rms_payment.check_ordinary_refund_requester_role() FROM PUBLIC;
CREATE TRIGGER ordinary_refund_requester_role_check BEFORE INSERT ON rms_payment.ordinary_refund_requester_role
 FOR EACH ROW EXECUTE FUNCTION rms_payment.check_ordinary_refund_requester_role();

CREATE FUNCTION rms_payment.reject_ordinary_refund_requester_role_mutation() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
BEGIN RAISE EXCEPTION 'append-only refund requester role' USING ERRCODE='55000'; END;
$$;
REVOKE ALL ON FUNCTION rms_payment.reject_ordinary_refund_requester_role_mutation() FROM PUBLIC;
CREATE TRIGGER ordinary_refund_requester_role_no_mutation BEFORE UPDATE OR DELETE ON rms_payment.ordinary_refund_requester_role
 FOR EACH ROW EXECUTE FUNCTION rms_payment.reject_ordinary_refund_requester_role_mutation();
CREATE TRIGGER ordinary_refund_requester_role_no_truncate BEFORE TRUNCATE ON rms_payment.ordinary_refund_requester_role
 FOR EACH STATEMENT EXECUTE FUNCTION rms_payment.reject_ordinary_refund_requester_role_mutation();
ALTER TABLE rms_payment.ordinary_refund_requester_role ENABLE ROW LEVEL SECURITY;
ALTER TABLE rms_payment.ordinary_refund_requester_role FORCE ROW LEVEL SECURITY;
CREATE POLICY ordinary_refund_requester_role_scope ON rms_payment.ordinary_refund_requester_role
 USING (brand_id=platform_helpers.current_brand_id() AND store_id=platform_helpers.current_store_id())
 WITH CHECK (brand_id=platform_helpers.current_brand_id() AND store_id=platform_helpers.current_store_id());
REVOKE ALL ON TABLE rms_payment.ordinary_refund_requester_role FROM PUBLIC;
