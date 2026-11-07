-- bop-rms-migration: 1
-- owner: @rms/kitchen
-- schema: rms_kitchen
-- phase: expand
-- risk: low
-- transaction: required
-- lock-timeout-ms: 5000
-- statement-timeout-ms: 60000
-- recovery: forward-fix
-- WP-2423 DEC-PAID-ORDER-AUTO-ACCEPT: when a kitchen board was last read at this Store. A paid order
-- goes straight to the kitchen only while a board is open: an Orders page open at the till, or on
-- an owner's phone at home, must not count (Store presence counts any staff screen). One row per
-- Store, written at most once a minute. An instant only: no person, device or request detail.
-- Grants: api SELECT/INSERT/UPDATE (Owner standing approval 2026-10-14, WP-2423).
CREATE TABLE rms_kitchen.kitchen_screen_presence (
 brand_id platform_helpers.uuid_v7 NOT NULL,
 store_id platform_helpers.uuid_v7 NOT NULL,
 last_seen_at timestamptz NOT NULL CHECK (isfinite(last_seen_at) AND last_seen_at=date_trunc('milliseconds',last_seen_at)),
 PRIMARY KEY (brand_id,store_id)
);
ALTER TABLE rms_kitchen.kitchen_screen_presence ENABLE ROW LEVEL SECURITY;
ALTER TABLE rms_kitchen.kitchen_screen_presence FORCE ROW LEVEL SECURITY;
CREATE POLICY kitchen_screen_presence_scope ON rms_kitchen.kitchen_screen_presence
 USING (brand_id=platform_helpers.current_brand_id() AND store_id=platform_helpers.current_store_id())
 WITH CHECK (brand_id=platform_helpers.current_brand_id() AND store_id=platform_helpers.current_store_id());
REVOKE ALL ON TABLE rms_kitchen.kitchen_screen_presence FROM PUBLIC;
-- The latest kitchen step at this Store, read while a Store has paid orders going straight there.
CREATE INDEX kitchen_work_lifecycle_operation_store_latest_idx
 ON rms_kitchen.kitchen_work_lifecycle_operation (brand_id,store_id,occurred_at DESC);
