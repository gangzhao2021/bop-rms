-- bop-rms-migration: 1
-- owner: @bop/notification
-- schema: bop_notification
-- phase: expand
-- risk: low
-- transaction: required
-- lock-timeout-ms: 5000
-- statement-timeout-ms: 60000
-- recovery: forward-fix
-- WP-2423 Q10: evidence of messages sent to a customer about their own order ("we have your order",
-- "your order is ready"), only to the contact the customer gave for that order. One attempt per
-- Order and purpose, appended before the provider is called, then its outcome. Neither table holds
-- the destination, the customer's name or the message text: the contact stays in Ordering's
-- checkout details (and is removed there after its retention period); the attempt only points to
-- that record. Append-only.
CREATE SCHEMA bop_notification;
REVOKE ALL ON SCHEMA bop_notification FROM PUBLIC;

CREATE TABLE bop_notification.customer_order_notification_attempt (
 notification_id platform_helpers.uuid_v7 PRIMARY KEY,
 brand_id platform_helpers.uuid_v7 NOT NULL,
 store_id platform_helpers.uuid_v7 NOT NULL,
 order_id platform_helpers.uuid_v7 NOT NULL,
 purpose text NOT NULL CHECK (purpose IN ('OrderPlaced','PickupReady')),
 channel text NOT NULL CHECK (channel IN ('Sms','Email')),
 contact_details_id platform_helpers.uuid_v7 NOT NULL,
 contact_details_version integer NOT NULL CHECK (contact_details_version > 0),
 created_at timestamptz NOT NULL CHECK (isfinite(created_at) AND created_at=date_trunc('milliseconds',created_at)),
 CONSTRAINT customer_order_notification_once UNIQUE (brand_id,store_id,order_id,purpose),
 CONSTRAINT customer_order_notification_scope_identity UNIQUE (notification_id,brand_id,store_id)
);

CREATE TABLE bop_notification.customer_order_notification_outcome (
 notification_id platform_helpers.uuid_v7 PRIMARY KEY,
 brand_id platform_helpers.uuid_v7 NOT NULL,
 store_id platform_helpers.uuid_v7 NOT NULL,
 outcome text NOT NULL CHECK (outcome IN ('Accepted','Rejected','Unknown')),
 provider_message_reference text CHECK (provider_message_reference ~ '^[A-Za-z0-9._:-]{1,128}$'),
 recorded_at timestamptz NOT NULL CHECK (isfinite(recorded_at) AND recorded_at=date_trunc('milliseconds',recorded_at)),
 CONSTRAINT customer_order_notification_outcome_attempt_fk FOREIGN KEY (notification_id,brand_id,store_id)
  REFERENCES bop_notification.customer_order_notification_attempt (notification_id,brand_id,store_id),
 CONSTRAINT customer_order_notification_outcome_reference CHECK (
  (outcome = 'Accepted') = (provider_message_reference IS NOT NULL)
 )
);

CREATE FUNCTION bop_notification.reject_customer_order_notification_mutation() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
BEGIN
 RAISE EXCEPTION 'append-only customer order notification evidence' USING ERRCODE='55000';
END;
$$;
REVOKE ALL ON FUNCTION bop_notification.reject_customer_order_notification_mutation() FROM PUBLIC;
CREATE TRIGGER customer_order_notification_attempt_no_mutation
 BEFORE UPDATE OR DELETE ON bop_notification.customer_order_notification_attempt
 FOR EACH ROW EXECUTE FUNCTION bop_notification.reject_customer_order_notification_mutation();
CREATE TRIGGER customer_order_notification_outcome_no_mutation
 BEFORE UPDATE OR DELETE ON bop_notification.customer_order_notification_outcome
 FOR EACH ROW EXECUTE FUNCTION bop_notification.reject_customer_order_notification_mutation();

ALTER TABLE bop_notification.customer_order_notification_attempt ENABLE ROW LEVEL SECURITY;
ALTER TABLE bop_notification.customer_order_notification_attempt FORCE ROW LEVEL SECURITY;
CREATE POLICY customer_order_notification_attempt_scope ON bop_notification.customer_order_notification_attempt
 USING (brand_id = platform_helpers.current_brand_id() AND store_id = platform_helpers.current_store_id())
 WITH CHECK (brand_id = platform_helpers.current_brand_id() AND store_id = platform_helpers.current_store_id());
ALTER TABLE bop_notification.customer_order_notification_outcome ENABLE ROW LEVEL SECURITY;
ALTER TABLE bop_notification.customer_order_notification_outcome FORCE ROW LEVEL SECURITY;
CREATE POLICY customer_order_notification_outcome_scope ON bop_notification.customer_order_notification_outcome
 USING (brand_id = platform_helpers.current_brand_id() AND store_id = platform_helpers.current_store_id())
 WITH CHECK (brand_id = platform_helpers.current_brand_id() AND store_id = platform_helpers.current_store_id());
REVOKE ALL ON TABLE bop_notification.customer_order_notification_attempt FROM PUBLIC;
REVOKE ALL ON TABLE bop_notification.customer_order_notification_outcome FROM PUBLIC;
