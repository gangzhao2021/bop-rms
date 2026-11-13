import type { AuditTransaction } from "@bop/audit";

import { parseOrderingReference } from "../../domain/cart.js";

/**
 * DEC-STAFF-ROUND-ONE-AT-A-TIME (v15 b12 staff-round-concurrency): staff rounds for one table take
 * turns. A staff round puts its dishes in the table's shared cart and then sends that cart, so two
 * rounds sent for the same table at the same moment would mix their dishes. A round takes the
 * table's turn before it touches the cart and keeps it until its round is placed (the turn then
 * ends with the round itself) or it ends the turn (not sent, or its dishes left at the table). A
 * turn nobody ended is over after the lease: a tablet that lost its connection never blocks the
 * table for longer.
 */
export const staffDiningRoundTurnLeaseSeconds = 120;

export type StaffDiningRoundTurnOutcome = "Placed" | "NotSent" | "DishesLeftAtTable" | "Unknown";
const outcomes: readonly StaffDiningRoundTurnOutcome[] = [
  "Placed",
  "NotSent",
  "DishesLeftAtTable",
  "Unknown",
];

export class StaffDiningRoundTurnError extends Error {
  readonly code = "STAFF_DINING_ROUND_TURN_UNAVAILABLE";
  constructor() {
    super("staff dining round table turn is unavailable");
    this.name = "StaffDiningRoundTurnError";
  }
}
const fail = (): never => {
  throw new StaffDiningRoundTurnError();
};
const instantOf = (value: unknown): string =>
  typeof value === "string" && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(value)
    ? value
    : fail();
const rowsOf = (result: unknown): readonly Record<string, unknown>[] => {
  const rows = (result as { rows?: unknown } | null)?.rows;
  return Array.isArray(rows) ? (rows as Record<string, unknown>[]) : fail();
};

/** Owner persistence; the caller holds the transaction and authorizes the staff member. */
export function createPostgresStaffDiningRoundTableTurnStore(options: {
  brandReference: string;
  storeReference: string;
  authorize(transaction: AuditTransaction): Promise<boolean>;
}) {
  const brand = parseOrderingReference(options.brandReference);
  const store = parseOrderingReference(options.storeReference);
  const context = async (tx: AuditTransaction) => {
    if ((await options.authorize(tx)) !== true) return fail();
    await tx.query("SELECT set_config('bop.brand_id',$1,true),set_config('bop.store_id',$2,true)", [
      brand,
      store,
    ]);
  };
  return Object.freeze({
    /**
     * Takes the table's turn for this staff round command, unless another round holds it: a turn
     * begun within the lease that was not ended and whose round was not placed (a placed round ends its
     * turn with a row; a turn whose end could not be written is still over once its round exists). The database's
     * clock times every turn, whichever server sends the round.
     */
    async take(
      tx: AuditTransaction,
      input: {
        readonly turnReference: string;
        readonly tableReference: string;
        readonly operationReference: string;
        readonly actorReference: string;
      },
    ): Promise<
      | { readonly status: "Taken"; readonly heldUntil: string }
      | { readonly status: "Busy"; readonly heldUntil: string }
    > {
      const turn = parseOrderingReference(input.turnReference);
      const table = parseOrderingReference(input.tableReference);
      const operation = parseOrderingReference(input.operationReference);
      const actor = parseOrderingReference(input.actorReference);
      await context(tx);
      await tx.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
        "StaffDiningRoundTableTurn:" + brand + ":" + store + ":" + table,
      ]);
      const held = rowsOf(
        await tx.query(
          `SELECT to_char(t.held_until AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS held_until
 FROM rms_ordering.staff_dining_round_table_turn t
 WHERE t.brand_id=$1 AND t.store_id=$2 AND t.table_id=$3
  AND t.begun_at > clock_timestamp() - interval '5 minutes' AND t.held_until > clock_timestamp()
  AND NOT EXISTS (SELECT 1 FROM rms_ordering.staff_dining_round_table_turn_end e
   WHERE e.brand_id=t.brand_id AND e.store_id=t.store_id AND e.turn_id=t.turn_id)
  AND NOT EXISTS (SELECT 1 FROM rms_ordering.staff_dining_round_entry r
   JOIN rms_ordering.order_batch b ON b.brand_id=r.brand_id AND b.store_id=r.store_id
    AND b.submitted_by_actor_id=r.guest_session_id
   WHERE r.brand_id=t.brand_id AND r.store_id=t.store_id AND r.operation_id=t.operation_id)
 ORDER BY t.held_until DESC LIMIT 1`,
          [brand, store, table],
        ),
      );
      if (held.length === 1)
        return Object.freeze({
          status: "Busy" as const,
          heldUntil: instantOf(held[0]?.held_until),
        });
      const taken = rowsOf(
        await tx.query(
          `WITH c AS (SELECT date_trunc('milliseconds',clock_timestamp()) AS at)
 INSERT INTO rms_ordering.staff_dining_round_table_turn
 (turn_id,brand_id,store_id,table_id,operation_id,actor_id,begun_at,held_until)
 SELECT $1,$2,$3,$4,$5,$6,c.at,c.at+make_interval(secs => $7) FROM c
 RETURNING to_char(held_until AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS held_until`,
          [turn, brand, store, table, operation, actor, staffDiningRoundTurnLeaseSeconds],
        ),
      );
      if (taken.length !== 1) return fail();
      return Object.freeze({
        status: "Taken" as const,
        heldUntil: instantOf(taken[0]?.held_until),
      });
    },
    /**
     * v15 b12 review: how the turns of one staff round command ended, for the same command sent
     * again (its answer was lost) with no round behind it. `DishesLeftAtTable`: some turn ended
     * with its dishes left in the table's cart. `Placed`: a turn ended with the round placed.
     * `Undecided`: a turn ended without knowing, or was never ended (its dishes may still be in the
     * table's cart). `NotSent`: every turn ended with nothing sent. `None`: no turn (a command
     * recorded before turns were kept).
     */
    async outcomeOf(
      tx: AuditTransaction,
      operationReference: string,
    ): Promise<"None" | "NotSent" | "Undecided" | "DishesLeftAtTable" | "Placed"> {
      const operation = parseOrderingReference(operationReference);
      await context(tx);
      const row = rowsOf(
        await tx.query(
          `SELECT count(*)::int AS turns,
 coalesce(bool_or(e.outcome='DishesLeftAtTable'),false) AS left_at_table,
 coalesce(bool_or(e.outcome='Placed'),false) AS placed,
 coalesce(bool_or(e.outcome IS NULL OR e.outcome='Unknown'),false) AS undecided
 FROM rms_ordering.staff_dining_round_table_turn t
 LEFT JOIN rms_ordering.staff_dining_round_table_turn_end e
  ON e.brand_id=t.brand_id AND e.store_id=t.store_id AND e.turn_id=t.turn_id
 WHERE t.brand_id=$1 AND t.store_id=$2 AND t.operation_id=$3`,
          [brand, store, operation],
        ),
      )[0];
      if (row === undefined || typeof row.turns !== "number") return fail();
      if (row.left_at_table === true) return "DishesLeftAtTable";
      if (row.placed === true) return "Placed";
      if (row.undecided === true) return "Undecided";
      return row.turns > 0 ? "NotSent" : "None";
    },
    /** Ends this round's turn with how it ended (once; a repeat changes nothing). */
    async end(
      tx: AuditTransaction,
      input: { readonly turnReference: string; readonly outcome: StaffDiningRoundTurnOutcome },
    ): Promise<void> {
      const turn = parseOrderingReference(input.turnReference);
      if (!outcomes.includes(input.outcome)) return fail();
      await context(tx);
      await tx.query(
        `INSERT INTO rms_ordering.staff_dining_round_table_turn_end (turn_id,brand_id,store_id,ended_at,outcome)
 VALUES ($1,$2,$3,date_trunc('milliseconds',clock_timestamp()),$4) ON CONFLICT (turn_id) DO NOTHING`,
        [turn, brand, store, input.outcome],
      );
    },
  });
}
