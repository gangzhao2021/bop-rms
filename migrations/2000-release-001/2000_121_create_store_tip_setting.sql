-- bop-rms-migration: 1
-- owner: @rms/payment
-- schema: rms_payment
-- phase: expand
-- risk: low
-- transaction: required
-- lock-timeout-ms: 5000
-- statement-timeout-ms: 60000
-- recovery: forward-fix
-- WP-2423 item 8 ⑦ DEC-STORE-FEATURES (Owner 2026-10-28 decision 11): the Store's tip choices.
-- Tips stay 10 % / 15 % / 18 % / other amount, never preselected, on the subtotal before tax; the
-- owner may set the three percentages or turn tips off. A Store never set offers 10/15/18. Each
-- change is the next version, with who changed it and when. Append-only, Store RLS.
-- While tips are off, no tip above zero is chosen at the Store, by a guest or by staff (below).
-- Grants: api SELECT/INSERT (Owner standing approval 2026-10-14, WP-2423).
CREATE TABLE rms_payment.store_tip_setting (
 tenant_id platform_helpers.uuid_v7 NOT NULL,
 brand_id platform_helpers.uuid_v7 NOT NULL,
 store_id platform_helpers.uuid_v7 NOT NULL,
 version integer NOT NULL CHECK (version BETWEEN 1 AND 1000000),
 operation_id platform_helpers.uuid_v7 NOT NULL,
 tips_enabled boolean NOT NULL,
 tier_percents integer[] NOT NULL CHECK (
  cardinality(tier_percents) = 3
  AND tier_percents[1] BETWEEN 1 AND 50 AND tier_percents[2] BETWEEN 1 AND 50 AND tier_percents[3] BETWEEN 1 AND 50
  AND tier_percents[1] < tier_percents[2] AND tier_percents[2] < tier_percents[3]
 ),
 actor_id platform_helpers.uuid_v7 NOT NULL,
 occurred_at timestamptz NOT NULL CHECK (isfinite(occurred_at) AND occurred_at=date_trunc('milliseconds',occurred_at)),
 PRIMARY KEY (brand_id,store_id,version),
 CONSTRAINT store_tip_setting_operation UNIQUE (brand_id,store_id,operation_id)
);

-- Versions follow one another: 1, then each change the next.
CREATE FUNCTION rms_payment.validate_store_tip_setting() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
DECLARE latest integer;
BEGIN
 PERFORM pg_advisory_xact_lock(hashtextextended('StoreTipSetting:'||NEW.brand_id||':'||NEW.store_id,0));
 SELECT max(version) INTO latest FROM rms_payment.store_tip_setting
  WHERE brand_id=NEW.brand_id AND store_id=NEW.store_id;
 IF NEW.version<>coalesce(latest,0)+1 THEN
  RAISE EXCEPTION 'store tip setting version out of order' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END;
$$;
CREATE TRIGGER store_tip_setting_order BEFORE INSERT ON rms_payment.store_tip_setting
 FOR EACH ROW EXECUTE FUNCTION rms_payment.validate_store_tip_setting();

CREATE FUNCTION rms_payment.reject_store_tip_setting_mutation() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
BEGIN
 RAISE EXCEPTION 'append-only store tip setting' USING ERRCODE='55000';
END;
$$;
CREATE TRIGGER store_tip_setting_no_mutation BEFORE UPDATE OR DELETE ON rms_payment.store_tip_setting
 FOR EACH ROW EXECUTE FUNCTION rms_payment.reject_store_tip_setting_mutation();
CREATE TRIGGER store_tip_setting_no_truncate BEFORE TRUNCATE ON rms_payment.store_tip_setting
 FOR EACH STATEMENT EXECUTE FUNCTION rms_payment.reject_store_tip_setting_mutation();

ALTER TABLE rms_payment.store_tip_setting ENABLE ROW LEVEL SECURITY;
ALTER TABLE rms_payment.store_tip_setting FORCE ROW LEVEL SECURITY;
CREATE POLICY store_tip_setting_scope ON rms_payment.store_tip_setting
 USING (brand_id=platform_helpers.current_brand_id() AND store_id=platform_helpers.current_store_id())
 WITH CHECK (brand_id=platform_helpers.current_brand_id() AND store_id=platform_helpers.current_store_id());
REVOKE ALL ON TABLE rms_payment.store_tip_setting FROM PUBLIC;
REVOKE ALL ON FUNCTION rms_payment.validate_store_tip_setting() FROM PUBLIC;
REVOKE ALL ON FUNCTION rms_payment.reject_store_tip_setting_mutation() FROM PUBLIC;

-- A tip above zero is chosen only where the Store has tips on (never set: on). Checked where a
-- tip is chosen: a guest's or staff member's tip selection (pickup, counter orders and staff
-- rounds record one), a guest's online table payment as it starts, and a table settled by staff.
-- A settlement is checked against the setting in force when the money was taken, so a payment
-- taken during an outage before tips were turned off is still recorded as it happened. A card
-- machine payment carries the tip already selected for its order and is not checked again: a
-- payment that really happened is never refused. Reads the setting of the row's own Store
-- whatever the writer's context (definer), serialized with a change of the setting.
CREATE FUNCTION rms_payment.check_store_tip_allowed() RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE enabled boolean; at timestamptz := 'infinity';
BEGIN
 IF NEW.tip_minor IS NULL OR NEW.tip_minor <= 0 THEN
  RETURN NEW;
 END IF;
 IF TG_TABLE_NAME = 'dining_table_settlement' THEN
  at := (to_jsonb(NEW)->>'taken_at')::timestamptz;
 END IF;
 PERFORM pg_advisory_xact_lock_shared(hashtextextended('StoreTipSetting:'||NEW.brand_id||':'||NEW.store_id,0));
 SELECT s.tips_enabled INTO enabled FROM rms_payment.store_tip_setting s
  WHERE s.brand_id=NEW.brand_id AND s.store_id=NEW.store_id AND s.occurred_at<=at
  ORDER BY s.version DESC LIMIT 1;
 IF enabled IS NOT NULL AND NOT enabled THEN
  RAISE EXCEPTION 'tips are turned off at this store' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION rms_payment.check_store_tip_allowed() FROM PUBLIC;
CREATE TRIGGER payment_tip_selection_store_tips BEFORE INSERT ON rms_payment.payment_tip_selection
 FOR EACH ROW EXECUTE FUNCTION rms_payment.check_store_tip_allowed();
CREATE TRIGGER dining_table_settlement_store_tips BEFORE INSERT ON rms_payment.dining_table_settlement
 FOR EACH ROW EXECUTE FUNCTION rms_payment.check_store_tip_allowed();
CREATE TRIGGER dining_table_online_payment_store_tips BEFORE INSERT ON rms_payment.dining_table_online_payment
 FOR EACH ROW EXECUTE FUNCTION rms_payment.check_store_tip_allowed();
