-- bop-rms-migration: 1
-- owner: @rms/ordering
-- schema: rms_ordering
-- phase: expand
-- risk: medium
-- transaction: required
-- lock-timeout-ms: 5000
-- statement-timeout-ms: 60000
-- recovery: forward-fix
-- WP-2423 Q7 slice 2 (DEC-STAFF-DINE-IN-ROUND): staff enter a dine-in round for a table on behalf
-- of guests who can't or won't use a phone, or enter a paper round taken during an outage. The
-- round goes through the ordinary table guest path (table entry, join, the table's shared Cart,
-- menu, sold out, price, tax, checkout and submission) under a table guest session the staff
-- command opens for this one round. This record names the staff member who entered it, the table
-- and dining session, and makes the staff command idempotent: one operation, one table guest
-- session, one round. The round itself is the Order batch that guest session submitted.
-- Append-only. Grants: api SELECT/INSERT (Owner standing approval 2026-10-14, WP-2423 Q7 staff
-- dine-in).
CREATE TABLE rms_ordering.staff_dining_round_entry (
 brand_id platform_helpers.uuid_v7 NOT NULL,
 store_id platform_helpers.uuid_v7 NOT NULL,
 operation_id platform_helpers.uuid_v7 NOT NULL,
 intent_hash text NOT NULL CHECK (intent_hash ~ '^sha256:[0-9a-f]{64}$'),
 actor_id platform_helpers.uuid_v7 NOT NULL,
 table_id platform_helpers.uuid_v7 NOT NULL,
 dining_session_id platform_helpers.uuid_v7 NOT NULL,
 guest_session_id platform_helpers.uuid_v7 NOT NULL,
 tip_selection_id platform_helpers.uuid_v7 NOT NULL,
 recorded_after_outage boolean NOT NULL,
 created_at timestamptz NOT NULL CHECK (isfinite(created_at) AND created_at=date_trunc('milliseconds',created_at)),
 audit_id platform_helpers.uuid_v7 NOT NULL UNIQUE,
 PRIMARY KEY (brand_id,store_id,operation_id),
 CONSTRAINT staff_dining_round_entry_guest_unique UNIQUE (brand_id,store_id,guest_session_id),
 CONSTRAINT staff_dining_round_entry_tip_unique UNIQUE (brand_id,store_id,tip_selection_id)
);
CREATE INDEX staff_dining_round_entry_session_idx
 ON rms_ordering.staff_dining_round_entry (brand_id,store_id,dining_session_id);

CREATE FUNCTION rms_ordering.reject_staff_dining_round_entry_mutation() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
BEGIN
 RAISE EXCEPTION 'append-only staff dining round entry' USING ERRCODE='55000';
END;
$$;
REVOKE ALL ON FUNCTION rms_ordering.reject_staff_dining_round_entry_mutation() FROM PUBLIC;
CREATE TRIGGER staff_dining_round_entry_no_mutation BEFORE UPDATE OR DELETE ON rms_ordering.staff_dining_round_entry
 FOR EACH ROW EXECUTE FUNCTION rms_ordering.reject_staff_dining_round_entry_mutation();
CREATE TRIGGER staff_dining_round_entry_no_truncate BEFORE TRUNCATE ON rms_ordering.staff_dining_round_entry
 FOR EACH STATEMENT EXECUTE FUNCTION rms_ordering.reject_staff_dining_round_entry_mutation();
ALTER TABLE rms_ordering.staff_dining_round_entry ENABLE ROW LEVEL SECURITY;
ALTER TABLE rms_ordering.staff_dining_round_entry FORCE ROW LEVEL SECURITY;
CREATE POLICY staff_dining_round_entry_scope ON rms_ordering.staff_dining_round_entry
 USING (brand_id=platform_helpers.current_brand_id() AND store_id=platform_helpers.current_store_id())
 WITH CHECK (brand_id=platform_helpers.current_brand_id() AND store_id=platform_helpers.current_store_id());
REVOKE ALL ON TABLE rms_ordering.staff_dining_round_entry FROM PUBLIC;
