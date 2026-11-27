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
// Batch 45 (v15 b44 live 2026-11-22 01:33:25 UTC): what the caller is told as a refusal, never as
// an outage (503 and an ops alert): a table visit this Store has no record of, and a session that
// another device or the guests changed while this request waited for the table's lock.
const notFound = (): never => {
  throw new DiningClosingError("DINING_CLOSING_SESSION_NOT_FOUND");
};
const changed = (): never => {
  throw new DiningClosingError("DINING_CLOSING_VERSION_CONFLICT");
};
const refusal = (error: unknown) =>
  error instanceof DiningClosingError &&
  (error.code === "DINING_CLOSING_SESSION_NOT_FOUND" ||
    error.code === "DINING_CLOSING_VERSION_CONFLICT");
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
        const result: unknown = await tx.query(
          "SELECT session_snapshot AS session FROM rms_dining.dining_session WHERE tenant_id=$1 AND brand_id=$2 AND store_id=$3 AND session_id=$4" +
            (lock ? " FOR UPDATE" : ""),
          [tenant, brand, store, reference],
        );
        // Sessions are never deleted: no row is no such visit at this Store (RLS scopes the read).
        const found = (result as { rows?: unknown } | null)?.rows;
        if (Array.isArray(found) && found.length === 0) return notFound();
        const row = rows(result)[0];
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
        return changed();
      await authorize();
      return current;
    } catch (error) {
      if (refusal(error)) throw error;
      return fail();
    }
  };
}
