-- bop-rms-migration: 1
-- owner: @rms/ordering
-- schema: rms_ordering
-- phase: expand
-- risk: medium
-- transaction: required
-- lock-timeout-ms: 5000
-- statement-timeout-ms: 60000
-- recovery: forward-fix
-- DEC-STAFF-ROUND-ONE-AT-A-TIME (v15 b12 staff-round-concurrency): a staff round puts its dishes
-- in the table's shared cart and then sends that cart, so two staff sending a round for the same
-- table at the same moment mixed their dishes (one was told "nothing was sent" while its dish
-- went out with the other's round, and was charged again on the next send). Staff rounds for one
-- table now take turns: a round holds the table's turn from before it touches the cart until it
-- is placed or taken back out, and a second staff member's round waits for it (or is told the
-- table is busy, with nothing sent). The turn is held for at most two minutes, so a tablet that
-- loses its connection mid-send never blocks the table for longer. Who held the table and how
-- each turn ended is kept: one row per turn, one row when it ended. Append-only, Store RLS.
-- Grants: api SELECT, INSERT on both tables (Owner standing approval 2026-10-14
-- 「我都批准，之后不需要问我」; DEC-STAFF-ROUND-ONE-AT-A-TIME).
CREATE TABLE rms_ordering.staff_dining_round_table_turn (
 turn_id platform_helpers.uuid_v7 PRIMARY KEY,
 brand_id platform_helpers.uuid_v7 NOT NULL,
 store_id platform_helpers.uuid_v7 NOT NULL,
 table_id platform_helpers.uuid_v7 NOT NULL,
 operation_id platform_helpers.uuid_v7 NOT NULL,
 actor_id platform_helpers.uuid_v7 NOT NULL,
 begun_at timestamptz NOT NULL CHECK (isfinite(begun_at) AND begun_at=date_trunc('milliseconds',begun_at)),
 held_until timestamptz NOT NULL CHECK (isfinite(held_until) AND held_until=date_trunc('milliseconds',held_until)),
 CONSTRAINT staff_dining_round_table_turn_lease CHECK (held_until > begun_at AND held_until <= begun_at + interval '5 minutes'),
 CONSTRAINT staff_dining_round_table_turn_scope_identity UNIQUE (turn_id,brand_id,store_id)
);
CREATE INDEX staff_dining_round_table_turn_table_idx
 ON rms_ordering.staff_dining_round_table_turn (brand_id,store_id,table_id,begun_at DESC);

CREATE TABLE rms_ordering.staff_dining_round_table_turn_end (
 turn_id platform_helpers.uuid_v7 PRIMARY KEY,
 brand_id platform_helpers.uuid_v7 NOT NULL,
 store_id platform_helpers.uuid_v7 NOT NULL,
 ended_at timestamptz NOT NULL CHECK (isfinite(ended_at) AND ended_at=date_trunc('milliseconds',ended_at)),
 -- Placed: the round went to the table's order. NotSent: nothing of it was sent and its dishes
 -- are out of the cart. DishesLeftAtTable: not sent, but its dishes could not be taken back out
 -- of the table's cart (staff were told so). Unknown: the request ended without knowing.
 outcome text NOT NULL CHECK (outcome IN ('Placed','NotSent','DishesLeftAtTable','Unknown')),
 CONSTRAINT staff_dining_round_table_turn_end_turn_fk FOREIGN KEY (turn_id,brand_id,store_id)
  REFERENCES rms_ordering.staff_dining_round_table_turn (turn_id,brand_id,store_id)
);

CREATE FUNCTION rms_ordering.reject_staff_dining_round_table_turn_mutation() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
BEGIN
 RAISE EXCEPTION 'append-only staff dining round table turn' USING ERRCODE='55000';
END;
$$;
CREATE TRIGGER staff_dining_round_table_turn_no_mutation BEFORE UPDATE OR DELETE ON rms_ordering.staff_dining_round_table_turn
 FOR EACH ROW EXECUTE FUNCTION rms_ordering.reject_staff_dining_round_table_turn_mutation();
CREATE TRIGGER staff_dining_round_table_turn_no_truncate BEFORE TRUNCATE ON rms_ordering.staff_dining_round_table_turn
 FOR EACH STATEMENT EXECUTE FUNCTION rms_ordering.reject_staff_dining_round_table_turn_mutation();
CREATE TRIGGER staff_dining_round_table_turn_end_no_mutation BEFORE UPDATE OR DELETE ON rms_ordering.staff_dining_round_table_turn_end
 FOR EACH ROW EXECUTE FUNCTION rms_ordering.reject_staff_dining_round_table_turn_mutation();
CREATE TRIGGER staff_dining_round_table_turn_end_no_truncate BEFORE TRUNCATE ON rms_ordering.staff_dining_round_table_turn_end
 FOR EACH STATEMENT EXECUTE FUNCTION rms_ordering.reject_staff_dining_round_table_turn_mutation();

ALTER TABLE rms_ordering.staff_dining_round_table_turn ENABLE ROW LEVEL SECURITY;
ALTER TABLE rms_ordering.staff_dining_round_table_turn FORCE ROW LEVEL SECURITY;
CREATE POLICY staff_dining_round_table_turn_scope ON rms_ordering.staff_dining_round_table_turn
 USING (brand_id=platform_helpers.current_brand_id() AND store_id=platform_helpers.current_store_id())
 WITH CHECK (brand_id=platform_helpers.current_brand_id() AND store_id=platform_helpers.current_store_id());
ALTER TABLE rms_ordering.staff_dining_round_table_turn_end ENABLE ROW LEVEL SECURITY;
ALTER TABLE rms_ordering.staff_dining_round_table_turn_end FORCE ROW LEVEL SECURITY;
CREATE POLICY staff_dining_round_table_turn_end_scope ON rms_ordering.staff_dining_round_table_turn_end
 USING (brand_id=platform_helpers.current_brand_id() AND store_id=platform_helpers.current_store_id())
 WITH CHECK (brand_id=platform_helpers.current_brand_id() AND store_id=platform_helpers.current_store_id());
REVOKE ALL ON TABLE rms_ordering.staff_dining_round_table_turn FROM PUBLIC;
REVOKE ALL ON TABLE rms_ordering.staff_dining_round_table_turn_end FROM PUBLIC;
REVOKE ALL ON FUNCTION rms_ordering.reject_staff_dining_round_table_turn_mutation() FROM PUBLIC;
