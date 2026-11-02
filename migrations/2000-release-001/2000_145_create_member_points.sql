-- bop-rms-migration: 1
-- owner: @rms/customer-loyalty
-- schema: rms_loyalty
-- phase: expand
-- risk: medium
-- transaction: required
-- lock-timeout-ms: 5000
-- statement-timeout-ms: 60000
-- recovery: forward-fix
-- WP-2423 取舍 18 DEC-MEMBER-POINTS: members and points, one account per phone per Brand, usable at
-- every Store of the Brand. The ledger is append-only and holds no phone number; the contact row is
-- the only phone data and is deleted when a member leaves, so the ledger and reports still reconcile.
-- Grants: pilot ACL by role (Owner standing approval 2026-10-14, WP-2423 取舍 18).
CREATE SCHEMA rms_loyalty;
REVOKE ALL ON SCHEMA rms_loyalty FROM PUBLIC;

CREATE TABLE rms_loyalty.loyalty_rule_version (
 brand_id platform_helpers.uuid_v7 NOT NULL,
 version integer NOT NULL CHECK (version BETWEEN 1 AND 1000000),
 earn_points_per_dollar integer NOT NULL CHECK (earn_points_per_dollar BETWEEN 0 AND 100),
 redeem_points_per_dollar integer NOT NULL CHECK (redeem_points_per_dollar BETWEEN 1 AND 10000),
 minimum_redemption_points integer NOT NULL CHECK (minimum_redemption_points BETWEEN 1 AND 1000000),
 redemption_increment_points integer NOT NULL CHECK (redemption_increment_points BETWEEN 1 AND 1000000),
 inactivity_expiry_days integer NOT NULL CHECK (inactivity_expiry_days BETWEEN 90 AND 3650),
 expiry_notice_days integer NOT NULL CHECK (expiry_notice_days BETWEEN 7 AND 89),
 rewards jsonb NOT NULL CHECK (jsonb_typeof(rewards)='array' AND jsonb_array_length(rewards)<=100),
 operation_id platform_helpers.uuid_v7 NOT NULL,
 actor_id platform_helpers.uuid_v7 NOT NULL,
 recorded_at timestamptz NOT NULL CHECK (isfinite(recorded_at)),
 PRIMARY KEY (brand_id,version),
 CONSTRAINT loyalty_rule_version_operation UNIQUE (brand_id,operation_id)
);

CREATE TABLE rms_loyalty.loyalty_account (
 account_id platform_helpers.uuid_v7 PRIMARY KEY,
 brand_id platform_helpers.uuid_v7 NOT NULL,
 status text NOT NULL CHECK (status IN ('Active','Closed')),
 available_points bigint NOT NULL CHECK (available_points >= 0),
 points_debt bigint NOT NULL CHECK (points_debt >= 0),
 lifetime_earned_points bigint NOT NULL CHECK (lifetime_earned_points >= 0),
 aggregate_version integer NOT NULL CHECK (aggregate_version > 0),
 created_at timestamptz NOT NULL CHECK (isfinite(created_at)),
 updated_at timestamptz NOT NULL CHECK (isfinite(updated_at)),
 last_activity_at timestamptz NOT NULL CHECK (isfinite(last_activity_at)),
 CONSTRAINT loyalty_account_brand UNIQUE (brand_id,account_id)
);
CREATE INDEX loyalty_account_recent ON rms_loyalty.loyalty_account (brand_id,status,last_activity_at);

CREATE TABLE rms_loyalty.loyalty_points_transaction (
 transaction_id platform_helpers.uuid_v7 PRIMARY KEY,
 brand_id platform_helpers.uuid_v7 NOT NULL,
 account_id platform_helpers.uuid_v7 NOT NULL,
 type text NOT NULL CHECK (type IN ('Earn','Activate','Reserve','Release','Redeem','Reverse','Adjust','Expire','Return')),
 points bigint NOT NULL CHECK (points > 0),
 source_type text NOT NULL CHECK (source_type IN ('Order','Payment','Refund','Reservation','ExpiryJob','AuthorizedCorrection')),
 source_reference platform_helpers.uuid_v7 NOT NULL,
 source_store_id platform_helpers.uuid_v7,
 order_id platform_helpers.uuid_v7,
 original_transaction_id platform_helpers.uuid_v7,
 rule_version integer NOT NULL CHECK (rule_version >= 0),
 reason_code text NOT NULL CHECK (reason_code ~ '^[A-Z][A-Z0-9_]{0,63}$'),
 idempotency_reference platform_helpers.uuid_v7 NOT NULL,
 occurred_at timestamptz NOT NULL CHECK (isfinite(occurred_at)),
 CONSTRAINT loyalty_points_transaction_idempotency UNIQUE (brand_id,idempotency_reference,type),
 FOREIGN KEY (brand_id,account_id) REFERENCES rms_loyalty.loyalty_account (brand_id,account_id)
);
-- One payment earns once, whoever claims it, even after the member who claimed it has left.
CREATE UNIQUE INDEX loyalty_points_transaction_one_earn
 ON rms_loyalty.loyalty_points_transaction (brand_id,source_reference) WHERE type='Earn';
CREATE INDEX loyalty_points_transaction_account
 ON rms_loyalty.loyalty_points_transaction (brand_id,account_id,occurred_at DESC);
CREATE INDEX loyalty_points_transaction_order
 ON rms_loyalty.loyalty_points_transaction (brand_id,order_id) WHERE order_id IS NOT NULL;

-- The only phone data. Deleted when the member leaves.
CREATE TABLE rms_loyalty.loyalty_member_contact (
 account_id platform_helpers.uuid_v7 PRIMARY KEY,
 brand_id platform_helpers.uuid_v7 NOT NULL,
 phone_lookup_hash bytea NOT NULL CHECK (octet_length(phone_lookup_hash)=32),
 phone_ciphertext bytea NOT NULL CHECK (octet_length(phone_ciphertext) BETWEEN 29 AND 120),
 phone_last4 text NOT NULL CHECK (phone_last4 ~ '^[0-9]{4}$'),
 joined_at timestamptz NOT NULL CHECK (isfinite(joined_at)),
 data_classification text NOT NULL CHECK (data_classification='PersonalData'),
 CONSTRAINT loyalty_member_contact_phone UNIQUE (brand_id,phone_lookup_hash),
 FOREIGN KEY (brand_id,account_id) REFERENCES rms_loyalty.loyalty_account (brand_id,account_id)
);

CREATE TABLE rms_loyalty.loyalty_marketing_consent (
 consent_id platform_helpers.uuid_v7 PRIMARY KEY,
 brand_id platform_helpers.uuid_v7 NOT NULL,
 account_id platform_helpers.uuid_v7 NOT NULL,
 given boolean NOT NULL,
 wording_version integer NOT NULL CHECK (wording_version > 0),
 recorded_at timestamptz NOT NULL CHECK (isfinite(recorded_at)),
 FOREIGN KEY (brand_id,account_id) REFERENCES rms_loyalty.loyalty_account (brand_id,account_id)
);

CREATE TABLE rms_loyalty.loyalty_redemption (
 redemption_id platform_helpers.uuid_v7 PRIMARY KEY,
 brand_id platform_helpers.uuid_v7 NOT NULL,
 source_store_id platform_helpers.uuid_v7 NOT NULL,
 account_id platform_helpers.uuid_v7 NOT NULL,
 order_id platform_helpers.uuid_v7 NOT NULL,
 operation_id platform_helpers.uuid_v7 NOT NULL,
 points bigint NOT NULL CHECK (points > 0),
 net_minor bigint NOT NULL CHECK (net_minor >= 0),
 total_minor bigint NOT NULL CHECK (total_minor > 0),
 reward_product_id platform_helpers.uuid_v7,
 recorded_at timestamptz NOT NULL CHECK (isfinite(recorded_at)),
 CONSTRAINT loyalty_redemption_operation UNIQUE (brand_id,operation_id),
 FOREIGN KEY (brand_id,account_id) REFERENCES rms_loyalty.loyalty_account (brand_id,account_id)
);
CREATE INDEX loyalty_redemption_order ON rms_loyalty.loyalty_redemption (brand_id,order_id);

-- Hashes only; removed once used or expired.
CREATE TABLE rms_loyalty.loyalty_phone_challenge (
 challenge_id platform_helpers.uuid_v7 PRIMARY KEY,
 brand_id platform_helpers.uuid_v7 NOT NULL,
 phone_lookup_hash bytea NOT NULL CHECK (octet_length(phone_lookup_hash)=32),
 code_hash bytea NOT NULL CHECK (octet_length(code_hash)=32),
 attempts integer NOT NULL CHECK (attempts BETWEEN 0 AND 5),
 expires_at timestamptz NOT NULL CHECK (isfinite(expires_at)),
 created_at timestamptz NOT NULL CHECK (isfinite(created_at))
);
CREATE INDEX loyalty_phone_challenge_phone
 ON rms_loyalty.loyalty_phone_challenge (brand_id,phone_lookup_hash,created_at DESC);

CREATE TABLE rms_loyalty.loyalty_member_session (
 session_id platform_helpers.uuid_v7 PRIMARY KEY,
 brand_id platform_helpers.uuid_v7 NOT NULL,
 account_id platform_helpers.uuid_v7 NOT NULL,
 selector_hash bytea NOT NULL CHECK (octet_length(selector_hash)=32),
 expires_at timestamptz NOT NULL CHECK (isfinite(expires_at)),
 created_at timestamptz NOT NULL CHECK (isfinite(created_at)),
 CONSTRAINT loyalty_member_session_selector UNIQUE (brand_id,selector_hash),
 FOREIGN KEY (brand_id,account_id) REFERENCES rms_loyalty.loyalty_account (brand_id,account_id)
);
CREATE INDEX loyalty_member_session_account ON rms_loyalty.loyalty_member_session (brand_id,account_id);

-- Proof that the member was told before their points expired: no notice, no expiry.
CREATE TABLE rms_loyalty.loyalty_expiry_notice (
 notice_id platform_helpers.uuid_v7 PRIMARY KEY,
 brand_id platform_helpers.uuid_v7 NOT NULL,
 account_id platform_helpers.uuid_v7 NOT NULL,
 activity_at timestamptz NOT NULL CHECK (isfinite(activity_at)),
 expires_at timestamptz NOT NULL CHECK (isfinite(expires_at)),
 sent_at timestamptz NOT NULL CHECK (isfinite(sent_at)),
 CONSTRAINT loyalty_expiry_notice_cycle UNIQUE (brand_id,account_id,activity_at),
 FOREIGN KEY (brand_id,account_id) REFERENCES rms_loyalty.loyalty_account (brand_id,account_id)
);

CREATE FUNCTION rms_loyalty.reject_loyalty_history_mutation() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
BEGIN
 RAISE EXCEPTION 'append-only loyalty history' USING ERRCODE='55000';
END;
$$;
REVOKE ALL ON FUNCTION rms_loyalty.reject_loyalty_history_mutation() FROM PUBLIC;
CREATE TRIGGER loyalty_rule_version_append_only BEFORE UPDATE OR DELETE ON rms_loyalty.loyalty_rule_version
 FOR EACH ROW EXECUTE FUNCTION rms_loyalty.reject_loyalty_history_mutation();
CREATE TRIGGER loyalty_points_transaction_append_only BEFORE UPDATE OR DELETE ON rms_loyalty.loyalty_points_transaction
 FOR EACH ROW EXECUTE FUNCTION rms_loyalty.reject_loyalty_history_mutation();
CREATE TRIGGER loyalty_points_transaction_no_truncate BEFORE TRUNCATE ON rms_loyalty.loyalty_points_transaction
 FOR EACH STATEMENT EXECUTE FUNCTION rms_loyalty.reject_loyalty_history_mutation();
CREATE TRIGGER loyalty_marketing_consent_append_only BEFORE UPDATE OR DELETE ON rms_loyalty.loyalty_marketing_consent
 FOR EACH ROW EXECUTE FUNCTION rms_loyalty.reject_loyalty_history_mutation();
CREATE TRIGGER loyalty_redemption_append_only BEFORE UPDATE OR DELETE ON rms_loyalty.loyalty_redemption
 FOR EACH ROW EXECUTE FUNCTION rms_loyalty.reject_loyalty_history_mutation();
CREATE TRIGGER loyalty_expiry_notice_append_only BEFORE UPDATE OR DELETE ON rms_loyalty.loyalty_expiry_notice
 FOR EACH ROW EXECUTE FUNCTION rms_loyalty.reject_loyalty_history_mutation();

ALTER TABLE rms_loyalty.loyalty_rule_version ENABLE ROW LEVEL SECURITY;
ALTER TABLE rms_loyalty.loyalty_rule_version FORCE ROW LEVEL SECURITY;
CREATE POLICY loyalty_rule_version_brand ON rms_loyalty.loyalty_rule_version
 USING (brand_id::uuid=platform_helpers.current_brand_id())
 WITH CHECK (brand_id::uuid=platform_helpers.current_brand_id());
REVOKE ALL ON TABLE rms_loyalty.loyalty_rule_version FROM PUBLIC;
ALTER TABLE rms_loyalty.loyalty_account ENABLE ROW LEVEL SECURITY;
ALTER TABLE rms_loyalty.loyalty_account FORCE ROW LEVEL SECURITY;
CREATE POLICY loyalty_account_brand ON rms_loyalty.loyalty_account
 USING (brand_id::uuid=platform_helpers.current_brand_id())
 WITH CHECK (brand_id::uuid=platform_helpers.current_brand_id());
REVOKE ALL ON TABLE rms_loyalty.loyalty_account FROM PUBLIC;
ALTER TABLE rms_loyalty.loyalty_points_transaction ENABLE ROW LEVEL SECURITY;
ALTER TABLE rms_loyalty.loyalty_points_transaction FORCE ROW LEVEL SECURITY;
CREATE POLICY loyalty_points_transaction_brand ON rms_loyalty.loyalty_points_transaction
 USING (brand_id::uuid=platform_helpers.current_brand_id())
 WITH CHECK (brand_id::uuid=platform_helpers.current_brand_id());
REVOKE ALL ON TABLE rms_loyalty.loyalty_points_transaction FROM PUBLIC;
ALTER TABLE rms_loyalty.loyalty_member_contact ENABLE ROW LEVEL SECURITY;
ALTER TABLE rms_loyalty.loyalty_member_contact FORCE ROW LEVEL SECURITY;
CREATE POLICY loyalty_member_contact_brand ON rms_loyalty.loyalty_member_contact
 USING (brand_id::uuid=platform_helpers.current_brand_id())
 WITH CHECK (brand_id::uuid=platform_helpers.current_brand_id());
REVOKE ALL ON TABLE rms_loyalty.loyalty_member_contact FROM PUBLIC;
ALTER TABLE rms_loyalty.loyalty_marketing_consent ENABLE ROW LEVEL SECURITY;
ALTER TABLE rms_loyalty.loyalty_marketing_consent FORCE ROW LEVEL SECURITY;
CREATE POLICY loyalty_marketing_consent_brand ON rms_loyalty.loyalty_marketing_consent
 USING (brand_id::uuid=platform_helpers.current_brand_id())
 WITH CHECK (brand_id::uuid=platform_helpers.current_brand_id());
REVOKE ALL ON TABLE rms_loyalty.loyalty_marketing_consent FROM PUBLIC;
ALTER TABLE rms_loyalty.loyalty_redemption ENABLE ROW LEVEL SECURITY;
ALTER TABLE rms_loyalty.loyalty_redemption FORCE ROW LEVEL SECURITY;
CREATE POLICY loyalty_redemption_brand ON rms_loyalty.loyalty_redemption
 USING (brand_id::uuid=platform_helpers.current_brand_id())
 WITH CHECK (brand_id::uuid=platform_helpers.current_brand_id());
REVOKE ALL ON TABLE rms_loyalty.loyalty_redemption FROM PUBLIC;
ALTER TABLE rms_loyalty.loyalty_phone_challenge ENABLE ROW LEVEL SECURITY;
ALTER TABLE rms_loyalty.loyalty_phone_challenge FORCE ROW LEVEL SECURITY;
CREATE POLICY loyalty_phone_challenge_brand ON rms_loyalty.loyalty_phone_challenge
 USING (brand_id::uuid=platform_helpers.current_brand_id())
 WITH CHECK (brand_id::uuid=platform_helpers.current_brand_id());
REVOKE ALL ON TABLE rms_loyalty.loyalty_phone_challenge FROM PUBLIC;
ALTER TABLE rms_loyalty.loyalty_member_session ENABLE ROW LEVEL SECURITY;
ALTER TABLE rms_loyalty.loyalty_member_session FORCE ROW LEVEL SECURITY;
CREATE POLICY loyalty_member_session_brand ON rms_loyalty.loyalty_member_session
 USING (brand_id::uuid=platform_helpers.current_brand_id())
 WITH CHECK (brand_id::uuid=platform_helpers.current_brand_id());
REVOKE ALL ON TABLE rms_loyalty.loyalty_member_session FROM PUBLIC;
ALTER TABLE rms_loyalty.loyalty_expiry_notice ENABLE ROW LEVEL SECURITY;
ALTER TABLE rms_loyalty.loyalty_expiry_notice FORCE ROW LEVEL SECURITY;
CREATE POLICY loyalty_expiry_notice_brand ON rms_loyalty.loyalty_expiry_notice
 USING (brand_id::uuid=platform_helpers.current_brand_id())
 WITH CHECK (brand_id::uuid=platform_helpers.current_brand_id());
REVOKE ALL ON TABLE rms_loyalty.loyalty_expiry_notice FROM PUBLIC;
