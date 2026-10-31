import { createHash } from "node:crypto";
import type { ConsumerTransaction } from "@bop/eventing";
import { createPostgresDiningSessionReadStore, createPostgresDiningTableStore } from "@rms/dining";
import { listStoreCancelledDishes } from "@rms/ordering";
import { readDiningTableBill } from "./merchant-dining-table-checkout.js";

/**
 * WP-2423 item 8 ② (Figma 47-2): what the closing summary adds to today's sales report — the
 * tables still open (each with what its bill still owes, from the table's own bill) and the dishes
 * that left the sales tonight (listed, never counted as sales). Read in the reports' own
 * authorized transaction, so the evening's figures are the report's and the day-end settlement's.
 */
export interface TonightOpenTable {
  readonly tableLabel: string;
  readonly phase: "Active" | "Closing";
  readonly paymentTiming: "PayFirst" | "PayLater";
  /** What the table's bill still owes (tax included); "0" for a table that pays each round. */
  readonly owedMinor: string;
  /** Minutes since the table was opened. */
  readonly openedMinutes: number;
}
export interface TonightFacts {
  readonly openTables: readonly TonightOpenTable[];
  readonly openTablesOwedMinor: string;
  readonly cancelled: {
    readonly removedBeforePayment: { readonly dishCount: number; readonly amountMinor: string };
    readonly cancelledAfterPayment: { readonly dishCount: number; readonly amountMinor: string };
    readonly cancelledUnpaid: {
      readonly roundCount: number;
      readonly dishCount: number;
      readonly amountMinor: string;
    };
  };
}

/** At most this many tables are read (the Tables page reads 50 a page; a store has fewer). */
const TONIGHT_TABLE_PAGES = 4;

export async function readTonightFacts(
  tx: ConsumerTransaction,
  input: {
    readonly scope: {
      readonly tenantReference: string;
      readonly brandReference: string;
      readonly storeReference: string;
    };
    readonly window: { readonly startsAt: string; readonly endsAt: string };
    readonly observedAt: string;
    authorize(tx: ConsumerTransaction): Promise<boolean>;
  },
): Promise<TonightFacts> {
  const allowed = async () => (await input.authorize(tx)) === true;
  const tables = createPostgresDiningTableStore({ run: (work) => work(tx) }, input.scope, {
    hashIntent: (value) => "sha256:" + createHash("sha256").update(value).digest("hex"),
    equals: (a, b) => a === b,
  });
  const sessions = createPostgresDiningSessionReadStore({ run: (work) => work(tx) }, input.scope);
  const observed = Date.parse(input.observedAt);
  const open: TonightOpenTable[] = [];
  let after: string | null = null;
  for (let page = 0; page < TONIGHT_TABLE_PAGES; page++) {
    const listed = await tables.listTables({
      afterTableReference: after,
      limit: 100,
      authorize: async () => allowed(),
    });
    for (const table of listed.items) {
      if (table.activeDiningSessionReference === null) continue;
      const bill = await readDiningTableBill(tx, input.scope, {
        diningSessionReference: String(table.activeDiningSessionReference),
        observedAt: input.observedAt,
        authorize: allowed,
      });
      if (bill.sessionPhase !== "Active" && bill.sessionPhase !== "Closing") continue;
      const [session] = await sessions.loadSessions([table.activeDiningSessionReference]);
      const startedAt = session ? Date.parse(session.startedAt) : Number.NaN;
      if (!Number.isFinite(startedAt) || startedAt > observed)
        throw new Error("MERCHANT_STORE_REPORTS_UNAVAILABLE");
      // Paid in full (or written off) and still seated: nothing left to take at this table.
      const owed = bill.settlement !== null || bill.writeOff !== null ? "0" : bill.owed.totalMinor;
      open.push(
        Object.freeze({
          tableLabel: bill.tableLabel ?? String(table.stableLabel),
          phase: bill.sessionPhase,
          paymentTiming: bill.paymentTiming,
          owedMinor: owed,
          openedMinutes: Math.floor((observed - startedAt) / 60_000),
        }),
      );
    }
    if (listed.nextAfterTableReference === null) break;
    after = listed.nextAfterTableReference;
  }
  const cancelled = await listStoreCancelledDishes(tx, input.scope, input.window);
  if (!(await allowed())) throw new Error("MERCHANT_STORE_REPORTS_UNAVAILABLE");
  return Object.freeze({
    openTables: Object.freeze(open),
    openTablesOwedMinor: open.reduce((sum, table) => sum + BigInt(table.owedMinor), 0n).toString(),
    cancelled: Object.freeze({
      removedBeforePayment: Object.freeze({
        dishCount: cancelled.removedBeforePayment.dishCount,
        amountMinor: cancelled.removedBeforePayment.amountMinor.toString(),
      }),
      cancelledAfterPayment: Object.freeze({
        dishCount: cancelled.cancelledAfterPayment.dishCount,
        amountMinor: cancelled.cancelledAfterPayment.amountMinor.toString(),
      }),
      cancelledUnpaid: Object.freeze({
        roundCount: cancelled.cancelledUnpaid.roundCount,
        dishCount: cancelled.cancelledUnpaid.dishCount,
        amountMinor: cancelled.cancelledUnpaid.amountMinor.toString(),
      }),
    }),
  });
}
