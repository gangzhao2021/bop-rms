-- bop-rms-migration: 1
-- owner: @rms/fulfillment
-- schema: rms_fulfillment
-- phase: expand
-- risk: low
-- transaction: required
-- lock-timeout-ms: 5000
-- statement-timeout-ms: 60000
-- recovery: forward-fix
-- DEC-CHECKOUT-SESSION-OUTAGE (review): an online pickup order the kitchen's hour could not take is
-- recorded, so staff on Orders are told that online guests are being turned away (v15 Test
-- Merchant 2: about 25 minutes of refused online orders while the counter saw nothing). One row per
-- Cart and pickup time: a guest who tries again is one guest. No contact, name or amount: the
-- Cart's opaque reference only. Append-only, Store RLS.
-- Grants: api SELECT, INSERT (Owner standing approval 2026-10-14 「我都批准，之后不需要问我」;
-- DEC-CHECKOUT-SESSION-OUTAGE).
CREATE TABLE rms_fulfillment.capacity_asap_refusal (
 brand_id platform_helpers.uuid_v7 NOT NULL,
 store_id platform_helpers.uuid_v7 NOT NULL,
 slot_id platform_helpers.uuid_v7 NOT NULL,
 cart_id platform_helpers.uuid_v7 NOT NULL,
 refused_at timestamptz NOT NULL CHECK (isfinite(refused_at) AND refused_at=date_trunc('milliseconds',refused_at)),
 PRIMARY KEY (brand_id,store_id,slot_id,cart_id),
 CONSTRAINT capacity_asap_refusal_slot_fk FOREIGN KEY (brand_id,store_id,slot_id)
  REFERENCES rms_fulfillment.capacity_slot(brand_id,store_id,slot_id)
);

-- Refused within its own pickup time, which is a pickup time.
CREATE FUNCTION rms_fulfillment.validate_capacity_asap_refusal() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
BEGIN
 IF NOT EXISTS (SELECT 1 FROM rms_fulfillment.capacity_slot s WHERE s.brand_id=NEW.brand_id
   AND s.store_id=NEW.store_id AND s.slot_id=NEW.slot_id AND s.fulfillment_type='Pickup'
   AND s.starts_at<=NEW.refused_at AND s.ends_at>NEW.refused_at) THEN
  RAISE EXCEPTION 'a refusal is recorded within its own pickup time' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END;
$$;
CREATE TRIGGER capacity_asap_refusal_validate BEFORE INSERT ON rms_fulfillment.capacity_asap_refusal
 FOR EACH ROW EXECUTE FUNCTION rms_fulfillment.validate_capacity_asap_refusal();
CREATE TRIGGER capacity_asap_refusal_no_mutation BEFORE UPDATE OR DELETE ON rms_fulfillment.capacity_asap_refusal
 FOR EACH ROW EXECUTE FUNCTION rms_fulfillment.reject_fulfillment_append_only_update();
CREATE TRIGGER capacity_asap_refusal_no_truncate BEFORE TRUNCATE ON rms_fulfillment.capacity_asap_refusal
 FOR EACH STATEMENT EXECUTE FUNCTION rms_fulfillment.reject_fulfillment_append_only_update();

ALTER TABLE rms_fulfillment.capacity_asap_refusal ENABLE ROW LEVEL SECURITY;
ALTER TABLE rms_fulfillment.capacity_asap_refusal FORCE ROW LEVEL SECURITY;
CREATE POLICY capacity_asap_refusal_scope ON rms_fulfillment.capacity_asap_refusal
 USING ((brand_id=platform_helpers.current_brand_id() AND store_id=platform_helpers.current_store_id()) IS TRUE)
 WITH CHECK ((brand_id=platform_helpers.current_brand_id() AND store_id=platform_helpers.current_store_id()) IS TRUE);
REVOKE ALL ON TABLE rms_fulfillment.capacity_asap_refusal FROM PUBLIC;
REVOKE ALL ON FUNCTION rms_fulfillment.validate_capacity_asap_refusal() FROM PUBLIC;
