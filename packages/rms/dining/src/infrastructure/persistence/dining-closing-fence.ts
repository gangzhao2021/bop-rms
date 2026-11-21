import { DiningClosingError } from "../../contracts/dining-closing.js";
import {
  parseDiningReference,
  parseDiningInstant,
  parseDiningSession,
} from "../../contracts/dining-session.js";
import type { DiningTableTransaction, DiningTableStoreScope } from "./dining-table-store.js";
const fail = (): never => {
  throw new DiningClosingError("DINING_CLOSING_DEPENDENCY_UNAVAILABLE");
};
/** Caller retains transaction through evidence collection and closing commit.
 * Same table/admission lock order as Dining admission consumption; no phase mutation. */
export function createPostgresDiningClosingFence(options: {
  scope: DiningTableStoreScope;
  authorize(tx: DiningTableTransaction): Promise<boolean>;
}) {
  const tenant = parseDiningReference(options.scope.tenantReference),
    brand = parseDiningReference(options.scope.brandReference),
    store = parseDiningReference(options.scope.storeReference);
  return async (
    tx: DiningTableTransaction,
    input: { diningSessionReference: string; observedAt: string },
  ) => {
    try {
      const reference = parseDiningReference(input.diningSessionReference),
        at = parseDiningInstant(input.observedAt);
      const authorize = async () => {
        if ((await options.authorize(tx)) !== true) return fail();
      };
      await authorize();
      await tx.query(
        "SELECT set_config('bop.brand_id',$1,true),set_config('bop.store_id',$2,true)",
        [brand, store],
      );
      const rows = (result: unknown) => {
        if (!result || typeof result !== "object") return fail();
        const value = Object.getOwnPropertyDescriptor(result, "rows")?.value as unknown;
        if (!Array.isArray(value) || value.length !== 1) return fail();
        return value as Record<string, unknown>[];
      };
      const read = async (lock: boolean) => {
        const row = rows(
          await tx.query(
            "SELECT session_snapshot AS session FROM rms_dining.dining_session WHERE tenant_id=$1 AND brand_id=$2 AND store_id=$3 AND session_id=$4" +
              (lock ? " FOR UPDATE" : ""),
            [tenant, brand, store, reference],
          ),
        )[0];
        const session = parseDiningSession(row?.session);
        if (
          session.diningSessionReference !== reference ||
          session.brandReference !== brand ||
          session.storeReference !== store ||
          session.startedAt > at
        )
          return fail();
        return session;
      };
      const before = await read(false);
      await tx.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
        `DiningTable:${tenant}:${brand}:${store}:${before.tableReference}`,
      ]);
      const table = rows(
        await tx.query(
          "SELECT table_id::text AS reference FROM rms_dining.dining_table WHERE tenant_id=$1 AND brand_id=$2 AND store_id=$3 AND table_id=$4 FOR UPDATE",
          [tenant, brand, store, before.tableReference],
        ),
      )[0];
      if (table?.reference !== before.tableReference) return fail();
      const current = await read(true);
      if (
        current.tableReference !== before.tableReference ||
        current.tableAssignmentVersion !== before.tableAssignmentVersion ||
        current.version !== before.version ||
        current.phase !== before.phase
      )
        return fail();
      await authorize();
      return current;
    } catch {
      return fail();
    }
  };
}
