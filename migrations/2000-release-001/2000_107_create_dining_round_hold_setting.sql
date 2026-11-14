-- bop-rms-migration: 1
-- owner: @rms/dining
-- schema: rms_dining
-- phase: expand
-- risk: low
-- transaction: required
-- lock-timeout-ms: 5000
-- statement-timeout-ms: 60000
-- recovery: forward-fix
-- WP-2423 item 8 ⑤ DEC-DINING-QR-JOIN decision 5 (Owner 2026-10-28): the Store's setting "a new
-- phone's first round waits for staff" (tables that pay at the end; off until a manager turns it
-- on). Each change is the next version, with who changed it and when. Append-only, Store RLS.
-- Grants: api SELECT/INSERT (Owner standing approval 2026-10-14, WP-2423).
CREATE TABLE rms_dining.dining_round_hold_setting (
 tenant_id platform_helpers.uuid_v7 NOT NULL,
 brand_id platform_helpers.uuid_v7 NOT NULL,
 store_id platform_helpers.uuid_v7 NOT NULL,
 version integer NOT NULL CHECK (version BETWEEN 1 AND 1000000),
 operation_id platform_helpers.uuid_v7 NOT NULL,
 first_round_needs_staff boolean NOT NULL,
 actor_id platform_helpers.uuid_v7 NOT NULL,
 occurred_at timestamptz NOT NULL CHECK (isfinite(occurred_at) AND occurred_at=date_trunc('milliseconds',occurred_at)),
 PRIMARY KEY (brand_id,store_id,version),
 CONSTRAINT dining_round_hold_setting_operation UNIQUE (brand_id,store_id,operation_id)
);

-- Versions follow one another: 1, then each change the next.
CREATE FUNCTION rms_dining.validate_dining_round_hold_setting() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
DECLARE latest integer;
BEGIN
 PERFORM pg_advisory_xact_lock(hashtextextended('DiningRoundHoldSetting:'||NEW.brand_id||':'||NEW.store_id,0));
 SELECT max(version) INTO latest FROM rms_dining.dining_round_hold_setting
  WHERE brand_id=NEW.brand_id AND store_id=NEW.store_id;
 IF NEW.version<>coalesce(latest,0)+1 THEN
  RAISE EXCEPTION 'round hold setting version out of order' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END;
$$;
CREATE TRIGGER dining_round_hold_setting_order BEFORE INSERT ON rms_dining.dining_round_hold_setting
 FOR EACH ROW EXECUTE FUNCTION rms_dining.validate_dining_round_hold_setting();

CREATE FUNCTION rms_dining.reject_dining_round_hold_setting_mutation() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
BEGIN
 RAISE EXCEPTION 'append-only round hold setting' USING ERRCODE='55000';
END;
$$;
CREATE TRIGGER dining_round_hold_setting_no_mutation BEFORE UPDATE OR DELETE ON rms_dining.dining_round_hold_setting
 FOR EACH ROW EXECUTE FUNCTION rms_dining.reject_dining_round_hold_setting_mutation();
CREATE TRIGGER dining_round_hold_setting_no_truncate BEFORE TRUNCATE ON rms_dining.dining_round_hold_setting
 FOR EACH STATEMENT EXECUTE FUNCTION rms_dining.reject_dining_round_hold_setting_mutation();

ALTER TABLE rms_dining.dining_round_hold_setting ENABLE ROW LEVEL SECURITY;
ALTER TABLE rms_dining.dining_round_hold_setting FORCE ROW LEVEL SECURITY;
CREATE POLICY dining_round_hold_setting_scope ON rms_dining.dining_round_hold_setting
 USING (brand_id=platform_helpers.current_brand_id() AND store_id=platform_helpers.current_store_id())
 WITH CHECK (brand_id=platform_helpers.current_brand_id() AND store_id=platform_helpers.current_store_id());
REVOKE ALL ON TABLE rms_dining.dining_round_hold_setting FROM PUBLIC;
REVOKE ALL ON FUNCTION rms_dining.validate_dining_round_hold_setting() FROM PUBLIC;
REVOKE ALL ON FUNCTION rms_dining.reject_dining_round_hold_setting_mutation() FROM PUBLIC;
