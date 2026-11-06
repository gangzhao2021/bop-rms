import { createHash } from "node:crypto";
import type { ConsumerTransaction } from "@bop/eventing";
import { memberDisplayNames, type MemberDirectoryTransaction } from "@bop/membership";
import { createPostgresDiningSessionReadStore, createPostgresDiningTableStore } from "@rms/dining";
import {
  listStoreCancelledDishes,
  listStoreOrderAutoAcceptanceEvents,
  listStoreUnpaidGuestDiningRounds,
  readStaffOrderCancellations,
} from "@rms/ordering";
import {
  createPostgresCardMachinePaymentStore,
  listStoreOrderBatchPaymentOutcomes,
  listStoreOrderBatchesPaidOnline,
} from "@rms/payment";
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
  /** M40: where the table's money stands (never "paid" for a table that paid nothing). */
  readonly standing: TonightTableStanding;
}
/**
 * M40: Owes — its bill still owes money; RoundUnpaid — a pay-first round nobody has paid yet;
 * Paid — money was really taken and kept (a table settlement, a paid split part, or a pay-first
 * round paid and not cancelled for a refund); NothingOrdered — seated, no Order; NothingToCollect
 * — rounds were ordered but all came off unpaid; WrittenOff — the guests left without paying.
 */
export type TonightTableStanding =
  "Owes" | "RoundUnpaid" | "Paid" | "NothingOrdered" | "NothingToCollect" | "WrittenOff";

export function tonightTableStanding(input: {
  readonly writtenOff: boolean;
  readonly owedMinor: bigint;
  readonly unpaidRounds: number;
  /** A table settlement or a paid split part. */
  readonly tableMoneyTaken: boolean;
  /** Pay-first rounds paid (online or on the card machine) and not cancelled for a refund. */
  readonly keptPaidRounds: number;
  readonly ordered: boolean;
}): TonightTableStanding {
  if (input.writtenOff) return "WrittenOff";
  if (input.unpaidRounds > 0) return "RoundUnpaid";
  if (input.owedMinor > 0n) return "Owes";
  if (input.tableMoneyTaken || input.keptPaidRounds > 0) return "Paid";
  return input.ordered ? "NothingToCollect" : "NothingOrdered";
}
/**
 * DEC-PAID-ORDER-AUTO-ACCEPT: what a closing manager should see named, because no manager was asked:
 * a "Can't make it" refund, an automatic refund, a pickup someone said they made by hand.
 */
export interface TonightPaidOrderEvent {
  readonly kind: "CantMake" | "AutomaticRefund" | "KeptByHand" | "RoundMadeByHand";
  readonly orderNumber: string;
  /** RoundMadeByHand only: which table round (the key is left out otherwise). */
  readonly roundSequence?: number;
  /** Null for the System, or a person no longer on the staff list. */
  readonly staffName: string | null;
  readonly reasonCode: string | null;
  readonly at: string;
}
export interface TonightFacts {
  /** Only when there is something to say (a Store without it sees nothing new). */
  readonly paidOrderEvents?: readonly TonightPaidOrderEvent[];
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
  const open: (Omit<TonightOpenTable, "standing"> & {
    readonly diningSessionReference: string;
    readonly orderReference: string | null;
    readonly writtenOff: boolean;
    readonly tableMoneyTaken: boolean;
  })[] = [];
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
          diningSessionReference: bill.diningSessionReference,
          orderReference: bill.orderReference,
          writtenOff: bill.writeOff !== null,
          tableMoneyTaken:
            bill.settlement !== null ||
            (bill.split?.parts.some((part) => part.payment !== null) ?? false),
        }),
      );
    }
    if (listed.nextAfterTableReference === null) break;
    after = listed.nextAfterTableReference;
  }
  const standings = await payFirstRounds(tx, input.scope, open, allowed);
  const cancelled = await listStoreCancelledDishes(tx, input.scope, input.window);
  const events = await listStoreOrderAutoAcceptanceEvents(tx, input.scope, input.window);
  const names =
    events.length === 0
      ? new Map<string, string>()
      : await memberDisplayNames(
          tx as unknown as MemberDirectoryTransaction,
          input.scope,
          events.flatMap((event) => (event.actorReference === null ? [] : [event.actorReference])),
        );
  if (!(await allowed())) throw new Error("MERCHANT_STORE_REPORTS_DENIED");
  return Object.freeze({
    ...(events.length === 0
      ? {}
      : {
          paidOrderEvents: Object.freeze(
            events.map((event) =>
              Object.freeze({
                kind: event.kind,
                orderNumber: event.orderNumber,
                orderBusinessDate: event.orderBusinessDate,
                ...(event.roundSequence === null ? {} : { roundSequence: event.roundSequence }),
                staffName:
                  event.actorReference === null ? null : (names.get(event.actorReference) ?? null),
                reasonCode: event.reasonCode,
                at: event.at,
              }),
            ),
          ),
        }),
    openTables: Object.freeze(
      open.map((table) =>
        Object.freeze({
          tableLabel: table.tableLabel,
          phase: table.phase,
          paymentTiming: table.paymentTiming,
          owedMinor: table.owedMinor,
          openedMinutes: table.openedMinutes,
          standing: tonightTableStanding({
            writtenOff: table.writtenOff,
            owedMinor: BigInt(table.owedMinor),
            unpaidRounds: standings.unpaid.get(table.diningSessionReference) ?? 0,
            tableMoneyTaken: table.tableMoneyTaken,
            keptPaidRounds:
              table.orderReference === null ? 0 : (standings.kept.get(table.orderReference) ?? 0),
            ordered: table.orderReference !== null,
          }),
        }),
      ),
    ),
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

/**
 * M40: for the pay-first tables, the rounds nobody has paid yet (by session) and the rounds paid
 * online or on the card machine that were not cancelled for a refund (by Order). A round whose
 * dishes were cancelled with "Can't make it · refund" was refunded in full, so it is not money kept.
 * Read in the summary's own transaction; one read each for every open table.
 */
async function payFirstRounds(
  tx: ConsumerTransaction,
  scope: {
    readonly tenantReference: string;
    readonly brandReference: string;
    readonly storeReference: string;
  },
  tables: readonly {
    readonly paymentTiming: "PayFirst" | "PayLater";
    readonly diningSessionReference: string;
    readonly orderReference: string | null;
  }[],
  allowed: () => Promise<boolean>,
): Promise<{ unpaid: ReadonlyMap<string, number>; kept: ReadonlyMap<string, number> }> {
  const payFirst = tables.filter((table) => table.paymentTiming === "PayFirst");
  const unpaid = new Map<string, number>();
  const kept = new Map<string, number>();
  if (payFirst.length === 0) return { unpaid, kept };
  const owner = { brandReference: scope.brandReference, storeReference: scope.storeReference };
  for (let start = 0; start < payFirst.length; start += 100) {
    const chunk = payFirst.slice(start, start + 100);
    const sessions = chunk.map((table) => table.diningSessionReference);
    const orders = chunk.flatMap((table) =>
      table.orderReference === null ? [] : [table.orderReference],
    );
    const waiting = await listStoreUnpaidGuestDiningRounds(
      tx as unknown as Parameters<typeof listStoreUnpaidGuestDiningRounds>[0],
      owner,
      sessions,
    );
    // A payment that just arrived is paid, not waiting (Ordering records it seconds later).
    const justPaid = await listStoreOrderBatchesPaidOnline(
      tx as unknown as Parameters<typeof listStoreOrderBatchesPaidOnline>[0],
      owner,
      waiting.map((round) => round.orderBatchReference),
    );
    for (const round of waiting)
      if (!justPaid.has(round.orderBatchReference))
        unpaid.set(
          round.diningSessionReference,
          (unpaid.get(round.diningSessionReference) ?? 0) + 1,
        );
    if (orders.length === 0) continue;
    const paidBatches = new Map<string, string>();
    for (const outcome of await listStoreOrderBatchPaymentOutcomes(
      tx as unknown as Parameters<typeof listStoreOrderBatchPaymentOutcomes>[0],
      owner,
      orders,
    ))
      if (outcome.status === "Succeeded")
        paidBatches.set(outcome.orderBatchReference, outcome.orderReference);
    const machine = await createPostgresCardMachinePaymentStore({
      scope: owner,
      authorize: async () => allowed(),
    }).listByOrders(tx as never, orders);
    for (const [order, entries] of machine)
      for (const entry of entries)
        paidBatches.set(String(entry.payment.orderBatchReference), order);
    const refunded = new Set(
      (
        await readStaffOrderCancellations(
          tx as unknown as Parameters<typeof readStaffOrderCancellations>[0],
          owner,
          orders,
        )
      ).map((record) => String(record.orderBatchReference)),
    );
    for (const [batch, order] of paidBatches)
      if (!refunded.has(batch)) kept.set(order, (kept.get(order) ?? 0) + 1);
  }
  return { unpaid, kept };
}
