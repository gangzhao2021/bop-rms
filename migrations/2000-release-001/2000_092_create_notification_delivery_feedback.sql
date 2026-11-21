-- bop-rms-migration: 1
-- owner: @bop/notification
-- schema: bop_notification
-- phase: expand
-- risk: low
-- transaction: required
-- lock-timeout-ms: 5000
-- statement-timeout-ms: 60000
-- recovery: forward-fix
-- DEC-PILOT-NOTIFICATIONS (2026-10-20, IDR-0027 revision 1): provider feedback for customer order
-- messages. A signed SES bounce/complaint/delivery event is stored once (Inbox) before the HTTPS
-- endpoint answers 2xx. A hard bounce or complaint suppresses that address for the channel and
-- opens a delivery issue for the operator. No table holds an address, phone number, message text
-- or provider payload: the suppression list holds only a keyed digest (HMAC-SHA-256 with a
-- versioned, purpose-separated key held outside the database). Append-only.

-- "Email my receipt" at checkout: the issued receipt is emailed once per Order (purpose ReceiptEmail).
ALTER TABLE bop_notification.customer_order_notification_attempt
 DROP CONSTRAINT customer_order_notification_attempt_purpose_check;
ALTER TABLE bop_notification.customer_order_notification_attempt
 ADD CONSTRAINT customer_order_notification_attempt_purpose_check
 CHECK (purpose IN ('OrderPlaced','PickupReady','ReceiptEmail'));

CREATE TABLE bop_notification.delivery_provider_event (
 provider_event_id uuid PRIMARY KEY,
 brand_id platform_helpers.uuid_v7 NOT NULL,
 store_id platform_helpers.uuid_v7 NOT NULL,
 notification_id platform_helpers.uuid_v7 NOT NULL,
 provider_message_reference text NOT NULL CHECK (provider_message_reference ~ '^[A-Za-z0-9._:-]{1,128}$'),
 event_type text NOT NULL CHECK (event_type IN ('Delivered','HardBounce','SoftBounce','Complaint')),
 occurred_at timestamptz NOT NULL CHECK (isfinite(occurred_at)),
 accepted_at timestamptz NOT NULL CHECK (isfinite(accepted_at) AND accepted_at=date_trunc('milliseconds',accepted_at)),
 CONSTRAINT delivery_provider_event_attempt_fk FOREIGN KEY (notification_id,brand_id,store_id)
  REFERENCES bop_notification.customer_order_notification_attempt (notification_id,brand_id,store_id),
 CONSTRAINT delivery_provider_event_scope_identity UNIQUE (provider_event_id,brand_id,store_id)
);

CREATE TABLE bop_notification.contact_suppression (
 suppression_id platform_helpers.uuid_v7 PRIMARY KEY,
 brand_id platform_helpers.uuid_v7 NOT NULL,
 store_id platform_helpers.uuid_v7 NOT NULL,
 channel text NOT NULL CHECK (channel IN ('Sms','Email')),
 destination_digest text NOT NULL CHECK (destination_digest ~ '^hmac-sha256:v[1-9][0-9]{0,5}:[0-9a-f]{64}$'),
 reason text NOT NULL CHECK (reason IN ('HardBounce','Complaint')),
 provider_event_id uuid NOT NULL,
 created_at timestamptz NOT NULL CHECK (isfinite(created_at) AND created_at=date_trunc('milliseconds',created_at)),
 CONSTRAINT contact_suppression_once UNIQUE (brand_id,store_id,channel,destination_digest),
 CONSTRAINT contact_suppression_event_fk FOREIGN KEY (provider_event_id,brand_id,store_id)
  REFERENCES bop_notification.delivery_provider_event (provider_event_id,brand_id,store_id)
);

CREATE TABLE bop_notification.delivery_issue_case (
 case_id platform_helpers.uuid_v7 PRIMARY KEY,
 brand_id platform_helpers.uuid_v7 NOT NULL,
 store_id platform_helpers.uuid_v7 NOT NULL,
 provider_event_id uuid NOT NULL,
 kind text NOT NULL CHECK (kind IN ('HardBounce','Complaint')),
 opened_at timestamptz NOT NULL CHECK (isfinite(opened_at) AND opened_at=date_trunc('milliseconds',opened_at)),
 CONSTRAINT delivery_issue_case_once UNIQUE (provider_event_id),
 CONSTRAINT delivery_issue_case_event_fk FOREIGN KEY (provider_event_id,brand_id,store_id)
  REFERENCES bop_notification.delivery_provider_event (provider_event_id,brand_id,store_id)
);

CREATE INDEX customer_order_notification_outcome_provider_reference
 ON bop_notification.customer_order_notification_outcome (brand_id,store_id,provider_message_reference)
 WHERE provider_message_reference IS NOT NULL;

CREATE TRIGGER delivery_provider_event_no_mutation
 BEFORE UPDATE OR DELETE ON bop_notification.delivery_provider_event
 FOR EACH ROW EXECUTE FUNCTION bop_notification.reject_customer_order_notification_mutation();
CREATE TRIGGER contact_suppression_no_mutation
 BEFORE UPDATE OR DELETE ON bop_notification.contact_suppression
 FOR EACH ROW EXECUTE FUNCTION bop_notification.reject_customer_order_notification_mutation();
CREATE TRIGGER delivery_issue_case_no_mutation
 BEFORE UPDATE OR DELETE ON bop_notification.delivery_issue_case
 FOR EACH ROW EXECUTE FUNCTION bop_notification.reject_customer_order_notification_mutation();

ALTER TABLE bop_notification.delivery_provider_event ENABLE ROW LEVEL SECURITY;
ALTER TABLE bop_notification.delivery_provider_event FORCE ROW LEVEL SECURITY;
CREATE POLICY delivery_provider_event_scope ON bop_notification.delivery_provider_event
 USING (brand_id = platform_helpers.current_brand_id() AND store_id = platform_helpers.current_store_id())
 WITH CHECK (brand_id = platform_helpers.current_brand_id() AND store_id = platform_helpers.current_store_id());
ALTER TABLE bop_notification.contact_suppression ENABLE ROW LEVEL SECURITY;
ALTER TABLE bop_notification.contact_suppression FORCE ROW LEVEL SECURITY;
CREATE POLICY contact_suppression_scope ON bop_notification.contact_suppression
 USING (brand_id = platform_helpers.current_brand_id() AND store_id = platform_helpers.current_store_id())
 WITH CHECK (brand_id = platform_helpers.current_brand_id() AND store_id = platform_helpers.current_store_id());
ALTER TABLE bop_notification.delivery_issue_case ENABLE ROW LEVEL SECURITY;
ALTER TABLE bop_notification.delivery_issue_case FORCE ROW LEVEL SECURITY;
CREATE POLICY delivery_issue_case_scope ON bop_notification.delivery_issue_case
 USING (brand_id = platform_helpers.current_brand_id() AND store_id = platform_helpers.current_store_id())
 WITH CHECK (brand_id = platform_helpers.current_brand_id() AND store_id = platform_helpers.current_store_id());
REVOKE ALL ON TABLE bop_notification.delivery_provider_event FROM PUBLIC;
REVOKE ALL ON TABLE bop_notification.contact_suppression FROM PUBLIC;
REVOKE ALL ON TABLE bop_notification.delivery_issue_case FROM PUBLIC;
