-- bop-rms-migration: 1
-- owner: @rms/payment
-- schema: rms_payment
-- phase: expand
-- risk: medium
-- transaction: required
-- lock-timeout-ms: 5000
-- statement-timeout-ms: 60000
-- recovery: forward-fix
-- WP-2423 Q5 (DEC-REFUND-ESCALATION-PILOT): an Owner/Finance member who did not ask for an ordinary
-- refund may decline it while nothing has been prepared or sent for it (no Provider effect is
-- possible). The decline is durable no-Provider-effect evidence (RF-D04): the request stops
-- occupying the Order's ordinary refund total and its captured balance. claim_count records how
-- many requests the Order had when it was declined, so earlier allocations stay reproducible.
-- A request reason "Other" carries a short staff note in a companion record (never in Audit).
-- Both records are append-only.
CREATE FUNCTION rms_payment.reject_ordinary_refund_decline_mutation() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
BEGIN
 RAISE EXCEPTION 'append-only ordinary refund decline or note' USING ERRCODE='55000';
END;
$$;
REVOKE ALL ON FUNCTION rms_payment.reject_ordinary_refund_decline_mutation() FROM PUBLIC;

CREATE TABLE rms_payment.ordinary_refund_decline (
 tenant_id platform_helpers.uuid_v7 NOT NULL,
 brand_id platform_helpers.uuid_v7 NOT NULL,
 store_id platform_helpers.uuid_v7 NOT NULL,
 order_id platform_helpers.uuid_v7 NOT NULL,
 request_id platform_helpers.uuid_v7 NOT NULL,
 decline_id platform_helpers.uuid_v7 NOT NULL,
 operation_id platform_helpers.uuid_v7 NOT NULL,
 requester_id platform_helpers.uuid_v7 NOT NULL,
 decliner_id platform_helpers.uuid_v7 NOT NULL,
 reason_code text NOT NULL CHECK (
  reason_code IN ('NOT_ELIGIBLE','NEEDS_MORE_INFORMATION','ENTERED_IN_ERROR','CUSTOMER_WITHDREW')
 ),
 claim_count bigint NOT NULL CHECK (claim_count BETWEEN 1 AND 9007199254740991),
 declined_at timestamptz NOT NULL CHECK (isfinite(declined_at) AND declined_at=date_trunc('milliseconds',declined_at)),
 decliner_mfa_at timestamptz NOT NULL CHECK (isfinite(decliner_mfa_at)),
 audit_id platform_helpers.uuid_v7 NOT NULL UNIQUE,
 PRIMARY KEY (brand_id,store_id,decline_id),
 CONSTRAINT ordinary_refund_decline_once UNIQUE (brand_id,store_id,request_id),
 CONSTRAINT ordinary_refund_decline_operation_unique UNIQUE (brand_id,store_id,operation_id),
 CONSTRAINT ordinary_refund_decline_request_fk FOREIGN KEY (brand_id,store_id,request_id)
  REFERENCES rms_payment.ordinary_refund_request (brand_id,store_id,request_id),
 CONSTRAINT ordinary_refund_decline_independent CHECK (decliner_id<>requester_id),
 CONSTRAINT ordinary_refund_decline_recent_mfa CHECK (
  decliner_mfa_at BETWEEN declined_at-interval '15 minutes' AND declined_at
 )
);

CREATE TABLE rms_payment.ordinary_refund_request_note (
 tenant_id platform_helpers.uuid_v7 NOT NULL,
 brand_id platform_helpers.uuid_v7 NOT NULL,
 store_id platform_helpers.uuid_v7 NOT NULL,
 order_id platform_helpers.uuid_v7 NOT NULL,
 request_id platform_helpers.uuid_v7 NOT NULL,
 actor_id platform_helpers.uuid_v7 NOT NULL,
 note text NOT NULL CHECK (
  note=btrim(note) AND char_length(note) BETWEEN 1 AND 200 AND note !~ '[[:cntrl:]]'
 ),
 recorded_at timestamptz NOT NULL CHECK (isfinite(recorded_at) AND recorded_at=date_trunc('milliseconds',recorded_at)),
 PRIMARY KEY (brand_id,store_id,request_id),
 CONSTRAINT ordinary_refund_request_note_request_fk FOREIGN KEY (brand_id,store_id,request_id)
  REFERENCES rms_payment.ordinary_refund_request (brand_id,store_id,request_id)
);

-- The database also holds the decline rules: the request is an Ordinary claim of that Order by
-- the named requester, nothing was prepared for it, and the note belongs to an "Other" request.
CREATE FUNCTION rms_payment.check_ordinary_refund_decline() RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE requested rms_payment.ordinary_refund_request%ROWTYPE;
BEGIN
 SELECT * INTO requested FROM rms_payment.ordinary_refund_request
  WHERE brand_id=NEW.brand_id AND store_id=NEW.store_id AND request_id=NEW.request_id;
 IF NOT FOUND OR requested.order_id<>NEW.order_id OR requested.tenant_id<>NEW.tenant_id THEN
  RAISE EXCEPTION 'ordinary refund request missing' USING ERRCODE='23514';
 END IF;
 IF TG_TABLE_NAME = 'ordinary_refund_decline' THEN
  IF requested.actor_id<>NEW.requester_id OR (requested.record_json ? 'claim')
     OR NEW.declined_at<requested.requested_at THEN
   RAISE EXCEPTION 'ordinary refund decline does not match its request' USING ERRCODE='23514';
  END IF;
  IF EXISTS (SELECT 1 FROM rms_payment.ordinary_refund_operation o
             WHERE o.brand_id=NEW.brand_id AND o.store_id=NEW.store_id AND o.request_id=NEW.request_id) THEN
   RAISE EXCEPTION 'ordinary refund already prepared' USING ERRCODE='23514';
  END IF;
 ELSIF requested.actor_id<>NEW.actor_id OR (requested.record_json->>'reasonCode') IS DISTINCT FROM 'OTHER' THEN
  RAISE EXCEPTION 'ordinary refund note does not match its request' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION rms_payment.check_ordinary_refund_decline() FROM PUBLIC;
CREATE TRIGGER ordinary_refund_decline_check BEFORE INSERT ON rms_payment.ordinary_refund_decline
 FOR EACH ROW EXECUTE FUNCTION rms_payment.check_ordinary_refund_decline();
CREATE TRIGGER ordinary_refund_request_note_check BEFORE INSERT ON rms_payment.ordinary_refund_request_note
 FOR EACH ROW EXECUTE FUNCTION rms_payment.check_ordinary_refund_decline();

CREATE TRIGGER ordinary_refund_decline_no_mutation BEFORE UPDATE OR DELETE ON rms_payment.ordinary_refund_decline
 FOR EACH ROW EXECUTE FUNCTION rms_payment.reject_ordinary_refund_decline_mutation();
CREATE TRIGGER ordinary_refund_decline_no_truncate BEFORE TRUNCATE ON rms_payment.ordinary_refund_decline
 FOR EACH STATEMENT EXECUTE FUNCTION rms_payment.reject_ordinary_refund_decline_mutation();
ALTER TABLE rms_payment.ordinary_refund_decline ENABLE ROW LEVEL SECURITY;
ALTER TABLE rms_payment.ordinary_refund_decline FORCE ROW LEVEL SECURITY;
CREATE POLICY ordinary_refund_decline_scope ON rms_payment.ordinary_refund_decline
 USING (brand_id=platform_helpers.current_brand_id() AND store_id=platform_helpers.current_store_id())
 WITH CHECK (brand_id=platform_helpers.current_brand_id() AND store_id=platform_helpers.current_store_id());
REVOKE ALL ON TABLE rms_payment.ordinary_refund_decline FROM PUBLIC;

CREATE TRIGGER ordinary_refund_request_note_no_mutation BEFORE UPDATE OR DELETE ON rms_payment.ordinary_refund_request_note
 FOR EACH ROW EXECUTE FUNCTION rms_payment.reject_ordinary_refund_decline_mutation();
CREATE TRIGGER ordinary_refund_request_note_no_truncate BEFORE TRUNCATE ON rms_payment.ordinary_refund_request_note
 FOR EACH STATEMENT EXECUTE FUNCTION rms_payment.reject_ordinary_refund_decline_mutation();
ALTER TABLE rms_payment.ordinary_refund_request_note ENABLE ROW LEVEL SECURITY;
ALTER TABLE rms_payment.ordinary_refund_request_note FORCE ROW LEVEL SECURITY;
CREATE POLICY ordinary_refund_request_note_scope ON rms_payment.ordinary_refund_request_note
 USING (brand_id=platform_helpers.current_brand_id() AND store_id=platform_helpers.current_store_id())
 WITH CHECK (brand_id=platform_helpers.current_brand_id() AND store_id=platform_helpers.current_store_id());
REVOKE ALL ON TABLE rms_payment.ordinary_refund_request_note FROM PUBLIC;
