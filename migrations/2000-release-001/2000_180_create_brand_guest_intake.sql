-- bop-rms-migration: 1
-- owner: @bop/tenant
-- schema: bop_tenant
-- phase: expand
-- risk: medium
-- transaction: required
-- lock-timeout-ms: 5000
-- statement-timeout-ms: 60000
-- recovery: forward-fix
-- WP-2423 item 13 ② (Owner 2026-11-05 "就按这个做"): the platform pauses a merchant. While paused, no
-- new guest starts a visit at any of the Brand's Stores (table or pickup scan, a counter order, a
-- newly seated party); guests already in a visit and staff carry on, so open orders are finished,
-- paid and refunded as usual. Nothing is hidden: orders, payments and receipts stay recorded.
-- Each pause or resume is an append-only record (who, when, why); the current state is the
-- highest version. A Brand never paused has no row and takes new guests.
-- Grants: api SELECT/INSERT (Owner standing approval 2026-10-14, WP-2423 item 13 ②).
CREATE FUNCTION bop_tenant.reject_brand_guest_intake_mutation() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
BEGIN
 RAISE EXCEPTION 'append-only brand guest intake record' USING ERRCODE='55000';
END;
$$;
REVOKE ALL ON FUNCTION bop_tenant.reject_brand_guest_intake_mutation() FROM PUBLIC;

CREATE TABLE bop_tenant.brand_guest_intake (
 tenant_id platform_helpers.uuid_v7 NOT NULL,
 brand_id platform_helpers.uuid_v7 NOT NULL REFERENCES bop_tenant.brand (brand_id),
 version bigint NOT NULL CHECK (version BETWEEN 1 AND 9007199254740991),
 state text NOT NULL CHECK (state IN ('Paused','Open')),
 reason text NOT NULL CHECK (char_length(btrim(reason)) BETWEEN 1 AND 300),
 actor_id platform_helpers.uuid_v7 NOT NULL,
 recorded_at timestamptz NOT NULL CHECK (isfinite(recorded_at) AND recorded_at=date_trunc('milliseconds',recorded_at)),
 operation_id platform_helpers.uuid_v7 NOT NULL,
 PRIMARY KEY (brand_id,version),
 CONSTRAINT brand_guest_intake_operation_unique UNIQUE (brand_id,operation_id)
);

-- Versions are contiguous per Brand and every record changes the state (the first one pauses).
CREATE FUNCTION bop_tenant.check_brand_guest_intake_sequence() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
DECLARE
 previous_version bigint;
 previous_state text;
 previous_at timestamptz;
BEGIN
 PERFORM pg_advisory_xact_lock(hashtextextended('BrandGuestIntake:'||NEW.brand_id,0));
 SELECT i.version,i.state,i.recorded_at INTO previous_version,previous_state,previous_at
 FROM bop_tenant.brand_guest_intake i
 WHERE i.brand_id=NEW.brand_id ORDER BY i.version DESC LIMIT 1;
 IF NEW.version<>COALESCE(previous_version,0)+1
  OR NEW.state=COALESCE(previous_state,'Open')
  OR NEW.recorded_at<COALESCE(previous_at,NEW.recorded_at) THEN
  RAISE EXCEPTION 'brand guest intake out of sequence' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION bop_tenant.check_brand_guest_intake_sequence() FROM PUBLIC;

CREATE TRIGGER brand_guest_intake_sequence BEFORE INSERT ON bop_tenant.brand_guest_intake
 FOR EACH ROW EXECUTE FUNCTION bop_tenant.check_brand_guest_intake_sequence();
CREATE TRIGGER brand_guest_intake_no_mutation BEFORE UPDATE OR DELETE ON bop_tenant.brand_guest_intake
 FOR EACH ROW EXECUTE FUNCTION bop_tenant.reject_brand_guest_intake_mutation();
CREATE TRIGGER brand_guest_intake_no_truncate BEFORE TRUNCATE ON bop_tenant.brand_guest_intake
 FOR EACH STATEMENT EXECUTE FUNCTION bop_tenant.reject_brand_guest_intake_mutation();
ALTER TABLE bop_tenant.brand_guest_intake ENABLE ROW LEVEL SECURITY;
ALTER TABLE bop_tenant.brand_guest_intake FORCE ROW LEVEL SECURITY;
CREATE POLICY brand_guest_intake_scope ON bop_tenant.brand_guest_intake
 USING (brand_id=platform_helpers.current_brand_id())
 WITH CHECK (brand_id=platform_helpers.current_brand_id());
REVOKE ALL ON TABLE bop_tenant.brand_guest_intake FROM PUBLIC;
