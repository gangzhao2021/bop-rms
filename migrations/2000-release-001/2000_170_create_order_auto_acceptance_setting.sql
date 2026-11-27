-- bop-rms-migration: 1
-- owner: @rms/ordering
-- schema: rms_ordering
-- phase: expand
-- risk: medium
-- transaction: required
-- lock-timeout-ms: 5000
-- statement-timeout-ms: 60000
-- recovery: forward-fix
-- WP-2423 DEC-PAID-ORDER-AUTO-ACCEPT: a Store may send paid pickup orders and paid table rounds
-- straight to the kitchen. Off until the owner turns it on: no row reads as off, so no existing
-- Store changes. Each change is the next version with who and when. The decision table holds why a
-- paid batch was not sent (only when the reason changes), which version sent one, and who said a
-- pickup sent that way is being made by hand, so it is not refunded automatically. Append-only,
-- Store RLS. The database refuses an automatic acceptance while the switch is off, and takes the
-- setting's lock so one cannot commit after a switch-off it did not see.
-- Grants: api SELECT/INSERT on both tables (Owner standing approval 2026-10-14, WP-2423).
CREATE TABLE rms_ordering.order_auto_acceptance_setting (
 tenant_id platform_helpers.uuid_v7 NOT NULL,
 brand_id platform_helpers.uuid_v7 NOT NULL,
 store_id platform_helpers.uuid_v7 NOT NULL,
 version integer NOT NULL CHECK (version BETWEEN 1 AND 1000000),
 operation_id platform_helpers.uuid_v7 NOT NULL,
 pickup boolean NOT NULL,
 dine_in boolean NOT NULL,
 actor_id platform_helpers.uuid_v7 NOT NULL,
 occurred_at timestamptz NOT NULL CHECK (isfinite(occurred_at) AND occurred_at=date_trunc('milliseconds',occurred_at)),
 PRIMARY KEY (brand_id,store_id,version),
 CONSTRAINT order_auto_acceptance_setting_operation UNIQUE (brand_id,store_id,operation_id)
);

CREATE FUNCTION rms_ordering.validate_order_auto_acceptance_setting() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
DECLARE latest integer;
BEGIN
 PERFORM pg_advisory_xact_lock(hashtextextended('OrderAutoAcceptanceSetting:'||NEW.brand_id||':'||NEW.store_id,0));
 SELECT max(version) INTO latest FROM rms_ordering.order_auto_acceptance_setting
  WHERE brand_id=NEW.brand_id AND store_id=NEW.store_id;
 IF NEW.version<>coalesce(latest,0)+1 THEN
  RAISE EXCEPTION 'auto acceptance setting version out of order' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END;
$$;
CREATE TRIGGER order_auto_acceptance_setting_order BEFORE INSERT ON rms_ordering.order_auto_acceptance_setting
 FOR EACH ROW EXECUTE FUNCTION rms_ordering.validate_order_auto_acceptance_setting();

CREATE FUNCTION rms_ordering.reject_order_auto_acceptance_mutation() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
BEGIN
 RAISE EXCEPTION 'append-only automatic acceptance history' USING ERRCODE='55000';
END;
$$;
CREATE TRIGGER order_auto_acceptance_setting_no_mutation BEFORE UPDATE OR DELETE ON rms_ordering.order_auto_acceptance_setting
 FOR EACH ROW EXECUTE FUNCTION rms_ordering.reject_order_auto_acceptance_mutation();
CREATE TRIGGER order_auto_acceptance_setting_no_truncate BEFORE TRUNCATE ON rms_ordering.order_auto_acceptance_setting
 FOR EACH STATEMENT EXECUTE FUNCTION rms_ordering.reject_order_auto_acceptance_mutation();

ALTER TABLE rms_ordering.order_auto_acceptance_setting ENABLE ROW LEVEL SECURITY;
ALTER TABLE rms_ordering.order_auto_acceptance_setting FORCE ROW LEVEL SECURITY;
CREATE POLICY order_auto_acceptance_setting_scope ON rms_ordering.order_auto_acceptance_setting
 USING (brand_id=platform_helpers.current_brand_id() AND store_id=platform_helpers.current_store_id())
 WITH CHECK (brand_id=platform_helpers.current_brand_id() AND store_id=platform_helpers.current_store_id());
REVOKE ALL ON TABLE rms_ordering.order_auto_acceptance_setting FROM PUBLIC;

CREATE TABLE rms_ordering.order_auto_acceptance_decision (
 decision_id platform_helpers.uuid_v7 PRIMARY KEY,
 brand_id platform_helpers.uuid_v7 NOT NULL,
 store_id platform_helpers.uuid_v7 NOT NULL,
 order_id platform_helpers.uuid_v7 NOT NULL,
 order_batch_id platform_helpers.uuid_v7 NOT NULL,
 outcome text NOT NULL CHECK (outcome IN ('Accepted','Skipped','Kept')),
 reason_code text CHECK (reason_code IN ('PaidBeforeSwitch','PaidTooLongAgo','KitchenScreenOff','StoreNotOpen','HasAlcohol','LargeOrder','StockChanged','NotEligible')),
 item_count integer CHECK (item_count BETWEEN 1 AND 100000),
 setting_version integer NOT NULL,
 acceptance_id platform_helpers.uuid_v7 REFERENCES rms_ordering.order_acceptance_record(acceptance_id),
 actor_id platform_helpers.uuid_v7,
 decided_at timestamptz NOT NULL CHECK (isfinite(decided_at) AND decided_at=date_trunc('milliseconds',decided_at)),
 FOREIGN KEY (order_batch_id,order_id,brand_id,store_id) REFERENCES rms_ordering.order_batch(order_batch_id,order_id,brand_id,store_id),
 FOREIGN KEY (brand_id,store_id,setting_version) REFERENCES rms_ordering.order_auto_acceptance_setting(brand_id,store_id,version),
 CHECK ((outcome='Accepted' AND acceptance_id IS NOT NULL AND reason_code IS NULL AND actor_id IS NULL)
  OR (outcome='Skipped' AND acceptance_id IS NULL AND reason_code IS NOT NULL AND actor_id IS NULL)
  OR (outcome='Kept' AND acceptance_id IS NOT NULL AND reason_code IS NULL AND actor_id IS NOT NULL))
);
CREATE UNIQUE INDEX order_auto_acceptance_decision_accepted ON rms_ordering.order_auto_acceptance_decision (brand_id,store_id,order_batch_id) WHERE outcome='Accepted';
CREATE UNIQUE INDEX order_auto_acceptance_decision_kept ON rms_ordering.order_auto_acceptance_decision (brand_id,store_id,order_batch_id) WHERE outcome='Kept';
CREATE INDEX order_auto_acceptance_decision_batch ON rms_ordering.order_auto_acceptance_decision (brand_id,store_id,order_batch_id,decided_at DESC,decision_id DESC);
CREATE INDEX order_auto_acceptance_decision_accepted_at ON rms_ordering.order_auto_acceptance_decision (brand_id,store_id,decided_at DESC) WHERE outcome='Accepted';
CREATE TRIGGER order_auto_acceptance_decision_no_mutation BEFORE UPDATE OR DELETE ON rms_ordering.order_auto_acceptance_decision
 FOR EACH ROW EXECUTE FUNCTION rms_ordering.reject_order_auto_acceptance_mutation();
CREATE TRIGGER order_auto_acceptance_decision_no_truncate BEFORE TRUNCATE ON rms_ordering.order_auto_acceptance_decision
 FOR EACH STATEMENT EXECUTE FUNCTION rms_ordering.reject_order_auto_acceptance_mutation();
ALTER TABLE rms_ordering.order_auto_acceptance_decision ENABLE ROW LEVEL SECURITY;
ALTER TABLE rms_ordering.order_auto_acceptance_decision FORCE ROW LEVEL SECURITY;
CREATE POLICY order_auto_acceptance_decision_scope ON rms_ordering.order_auto_acceptance_decision
 USING (brand_id=platform_helpers.current_brand_id() AND store_id=platform_helpers.current_store_id())
 WITH CHECK (brand_id=platform_helpers.current_brand_id() AND store_id=platform_helpers.current_store_id());
REVOKE ALL ON TABLE rms_ordering.order_auto_acceptance_decision FROM PUBLIC;

-- Only a batch the System accepted is said to be made by hand (a pickup's automatic refund stops; a
-- table round leaves the kitchen warnings), and the row names that acceptance.
CREATE FUNCTION rms_ordering.validate_order_auto_accepted_kept() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
BEGIN
 IF NOT EXISTS (SELECT 1 FROM rms_ordering.order_acceptance_record a
   JOIN rms_ordering.order_header h ON h.brand_id=a.brand_id AND h.store_id=a.store_id AND h.order_id=a.order_id
  WHERE a.acceptance_id=NEW.acceptance_id AND a.brand_id=NEW.brand_id AND a.store_id=NEW.store_id
   AND a.order_id=NEW.order_id AND a.order_batch_id=NEW.order_batch_id
   AND a.reason_code='STORE_AUTO_ACCEPT_PAID') THEN
  RAISE EXCEPTION 'only an automatically accepted batch is kept' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END;
$$;
CREATE TRIGGER order_auto_acceptance_decision_kept_guard BEFORE INSERT ON rms_ordering.order_auto_acceptance_decision
 FOR EACH ROW WHEN (NEW.outcome='Kept')
 EXECUTE FUNCTION rms_ordering.validate_order_auto_accepted_kept();

-- An automatic acceptance is the System's, and only while the Store's current switch for this order
-- type is on. Shared lock: acceptances do not wait for each other, only for a switch change.
CREATE FUNCTION rms_ordering.validate_order_auto_acceptance() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
DECLARE kind text;
DECLARE latest rms_ordering.order_auto_acceptance_setting%ROWTYPE;
BEGIN
 IF NEW.actor_type<>'System' OR NEW.actor_id IS NOT NULL THEN
  RAISE EXCEPTION 'automatic acceptance is recorded as the System' USING ERRCODE='23514';
 END IF;
 PERFORM pg_advisory_xact_lock_shared(hashtextextended('OrderAutoAcceptanceSetting:'||NEW.brand_id||':'||NEW.store_id,0));
 SELECT order_type INTO kind FROM rms_ordering.order_header
  WHERE brand_id=NEW.brand_id AND store_id=NEW.store_id AND order_id=NEW.order_id;
 SELECT * INTO latest FROM rms_ordering.order_auto_acceptance_setting
  WHERE brand_id=NEW.brand_id AND store_id=NEW.store_id ORDER BY version DESC LIMIT 1;
 IF latest.version IS NULL OR NOT coalesce(CASE kind WHEN 'Pickup' THEN latest.pickup WHEN 'DineIn' THEN latest.dine_in END,false) THEN
  RAISE EXCEPTION 'automatic acceptance is turned off' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END;
$$;
CREATE TRIGGER order_acceptance_auto_guard BEFORE INSERT ON rms_ordering.order_acceptance_record
 FOR EACH ROW WHEN (NEW.reason_code='STORE_AUTO_ACCEPT_PAID')
 EXECUTE FUNCTION rms_ordering.validate_order_auto_acceptance();
REVOKE ALL ON FUNCTION rms_ordering.validate_order_auto_acceptance_setting() FROM PUBLIC;
REVOKE ALL ON FUNCTION rms_ordering.reject_order_auto_acceptance_mutation() FROM PUBLIC;
REVOKE ALL ON FUNCTION rms_ordering.validate_order_auto_acceptance() FROM PUBLIC;
REVOKE ALL ON FUNCTION rms_ordering.validate_order_auto_accepted_kept() FROM PUBLIC;
