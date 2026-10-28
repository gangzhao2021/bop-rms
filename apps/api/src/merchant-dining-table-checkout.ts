import { createHash } from "node:crypto";
import type { ConsumerTransaction } from "@bop/eventing";
import { canonicalizeRfc8785 } from "@bop/audit";
import { readClosedRecord } from "@bop/identity";
import {
  createPostgresDiningPaymentTimingStore,
  createPostgresDiningSessionReadStore,
  listDiningSessionTableLabels,
  parseDiningReference,
  loadDiningSessionPhones,
} from "@rms/dining";
import {
  createPostgresPayLaterItemCancellationStore,
  createPostgresOrderPayLaterConfirmationStore,
  createPostgresOrderPricedAmountSource,
  listOrderItemPrices,
  listOrderPriceReductions,
  listStoreDiningSessionOrders,
} from "@rms/ordering";
import {
  createPostgresDiningTableSettlementStore,
  DiningTableSettlementError,
  DiningTableSettlementStoreError,
  splitDiningTableBill,
  type DiningTableSettlementRecord,
  type DiningTableSplitPlanRecord,
} from "@rms/payment";
import { createMerchantStoreScope } from "./merchant-store-scope.js";
import { withMerchantTransactionAuthorization } from "./merchant-transaction-authorization.js";
import { runMerchantSnapshotRead } from "./merchant-snapshot-read.js";
import type { PersistentMerchantBffOptions } from "./persistent-merchant-bff.js";
import type { MerchantBffService } from "./merchant-bff.js";
import { staffDiningRoundPermission } from "./merchant-staff-dining-round.js";

/**
 * WP-2423 DEC-DINE-IN-PAY-LATER: a pay-later table's checkout. Staff read the table's bill (each
 * round with its items before tax, tax and total; what was paid; what is still owed) and record
 * the table's one payment — on the Store's card machine after it approved, or in cash with the
 * 5-cent rounding and the change — which Payment splits by round. The table must be at checkout
 * (the dining session's Closing phase: no more rounds). Who may: staff who operate tables and take
 * payments (the same people who enter a table's round and record its card-machine payment).
 */
export const diningTableCheckoutPermission = "dining.operate" as const;

export const diningTableCheckoutErrorCodes = [
  "TABLE_CHECKOUT_INPUT_INVALID",
  "TABLE_CHECKOUT_PERMISSION_DENIED",
  "TABLE_CHECKOUT_NOT_PAY_LATER",
  "TABLE_CHECKOUT_NOT_STARTED",
  "TABLE_CHECKOUT_NOTHING_OWED",
  "TABLE_CHECKOUT_BILL_CHANGED",
  "TABLE_CHECKOUT_TENDER_SHORT",
  "TABLE_CHECKOUT_ALREADY_PAID",
  /** S4: a guest is paying the whole table on their phone right now. */
  "TABLE_CHECKOUT_GUEST_PAYING",
  "TABLE_CHECKOUT_IDEMPOTENCY_CONFLICT",
  /** WP-2423 item 8 ④: the split can't change once a part was paid or a guest started paying. */
  "TABLE_CHECKOUT_SPLIT_LOCKED",
  "TABLE_CHECKOUT_UNAVAILABLE",
] as const;
export type DiningTableCheckoutErrorCode = (typeof diningTableCheckoutErrorCodes)[number];
export class DiningTableCheckoutError extends Error {
  constructor(readonly code: DiningTableCheckoutErrorCode) {
    super("table checkout is unavailable");
    this.name = "DiningTableCheckoutError";
  }
}
const fail = (code: DiningTableCheckoutErrorCode): never => {
  throw new DiningTableCheckoutError(code);
};
const sha256 = (value: string) => "sha256:" + createHash("sha256").update(value).digest("hex");

export type DiningTableTip =
  | { readonly kind: "None" }
  | { readonly kind: "Percent"; readonly percent: 10 | 15 | 18 | 20 }
  | { readonly kind: "Amount"; readonly amountMinor: string };

/** A tip as a share of the bill before tax, rounded half up (as at the counter). */
export function tableTipMinor(tip: DiningTableTip, subtotalMinor: bigint): bigint {
  if (tip.kind === "None") return 0n;
  if (tip.kind === "Percent") return (subtotalMinor * BigInt(tip.percent) + 50n) / 100n;
  const amount = BigInt(tip.amountMinor);
  // A typed tip larger than the bill itself is a mistake, never accepted silently.
  if (amount > subtotalMinor) return fail("TABLE_CHECKOUT_INPUT_INVALID");
  return amount;
}

export interface DiningTableBill {
  readonly diningSessionReference: string;
  readonly sessionPhase: "Active" | "Closing" | "Closed" | "Cancelled";
  readonly sessionVersion: number;
  readonly paymentTiming: "PayFirst" | "PayLater";
  readonly tableLabel: string | null;
  readonly orderReference: string | null;
  readonly rounds: readonly {
    readonly roundNumber: number;
    readonly orderBatchReference: string;
    readonly submissionReference: string;
    readonly items: readonly {
      readonly displayName: string;
      readonly subtotalMinor: string;
      readonly totalMinor: string;
      /**
       * WP-2423 item 8 ① segment 2: a manager's comp or discount on this dish (tax included),
       * already taken off `totalMinor` and the round; null when none.
       */
      readonly reduction: null | {
        readonly kind: "Comp" | "Percent" | "Amount";
        readonly percent: number | null;
        readonly amountMinor: string;
      };
    }[];
    readonly subtotalMinor: string;
    readonly taxMinor: string;
    readonly totalMinor: string;
    readonly paid: boolean;
    /**
     * WP-2423 item 8 ④: which phone at the table sent the round (1, 2, … in the order they first
     * ordered; no name), or null for a round staff entered for the table.
     */
    readonly orderedBy: number | null;
  }[];
  /** Still owed: the rounds not yet paid, before tax, tax and total. */
  readonly owed: {
    readonly subtotalMinor: string;
    readonly taxMinor: string;
    readonly totalMinor: string;
  };
  /** False while a round is still being sent: the bill would not match the Order (refresh). */
  readonly consistent: boolean;
  readonly settlement: null | {
    readonly method: "CardMachine" | "Cash" | "Online";
    readonly roundsMinor: string;
    readonly tipMinor: string;
    readonly roundingMinor: string;
    readonly totalMinor: string;
    readonly tenderedMinor: string | null;
    readonly changeMinor: string | null;
    readonly recordedAt: string;
    readonly recordedAfterOutage: boolean;
  };
  /**
   * DEC-DINE-IN-PAY-LATER (rule 14): the guests left without paying and a manager wrote the
   * table's bill off (the Order is closed on it). Never paid as well (one or the other).
   */
  readonly writeOff: null | {
    readonly amountMinor: string;
    readonly decidedAt: string;
  };
  /**
   * WP-2423 item 8 ④ DEC-DINE-IN-SPLIT-BILL: how the bill is split (null: paid whole). Each part is
   * paid once, by any method; the table closes when every part is paid (or written off). `stale`:
   * the bill changed before anything was paid (a dish taken off or comped) — split it again.
   */
  readonly split: null | {
    readonly mode: "Even" | "ByRounds";
    readonly stale: boolean;
    readonly parts: readonly {
      readonly partNumber: number;
      readonly amountMinor: string;
      readonly subtotalMinor: string;
      readonly taxMinor: string;
      /** The rounds this part takes from (by round number). */
      readonly roundNumbers: readonly number[];
      readonly payment: null | {
        readonly method: "CardMachine" | "Cash" | "Online";
        readonly tipMinor: string;
        readonly roundingMinor: string;
        readonly totalMinor: string;
        readonly tenderedMinor: string | null;
        readonly changeMinor: string | null;
        readonly recordedAt: string;
        readonly recordedAfterOutage: boolean;
      };
      /** A guest is paying this part on their phone now. */
      readonly guestPaying: boolean;
    }[];
    readonly paidParts: number;
    /** What the parts still unpaid come to. */
    readonly remainingMinor: string;
  };
  /**
   * S4: the guests' latest attempt to pay the whole table on their phone. "InProgress" (no
   * Provider outcome yet) holds the table: staff can't take another payment until it ends.
   */
  readonly onlinePayment: null | {
    readonly status: "InProgress" | "Captured" | "Failed" | "Cancelled";
    readonly totalMinor: string;
    readonly tipMinor: string;
    readonly startedAt: string;
  };
}

interface Scope {
  tenantReference: string;
  brandReference: string;
  storeReference: string;
}

/** The table's bill from the owners' records, in the caller's (authorized) transaction. */
export async function readDiningTableBill(
  tx: ConsumerTransaction,
  scope: Scope,
  input: {
    readonly diningSessionReference: string;
    readonly observedAt: string;
    authorize(): Promise<boolean>;
  },
): Promise<
  DiningTableBill & {
    readonly settlementRecord: DiningTableSettlementRecord | null;
    /** The current split plan (not "Whole"), for paying a part. */
    readonly splitPlanRecord: DiningTableSplitPlanRecord | null;
  }
> {
  const session = String(parseDiningReference(input.diningSessionReference));
  const owner = { brandReference: scope.brandReference, storeReference: scope.storeReference };
  const [found] = await createPostgresDiningSessionReadStore(
    { run: (work) => work(tx) },
    scope,
  ).loadSessions([session]);
  if (!found || found.diningSessionReference !== session) return fail("TABLE_CHECKOUT_UNAVAILABLE");
  const timing =
    (
      await createPostgresDiningPaymentTimingStore({
        scope,
        hashIntent: (value) => createHash("sha256").update(value).digest("hex"),
        equals: (a, b) => a === b,
      }).loadSessionTimings(tx, [session])
    ).get(session) ?? "PayFirst";
  const tableLabel =
    (await listDiningSessionTableLabels(tx as never, scope, [session])).get(session) ?? null;
  const orderReference =
    (await listStoreDiningSessionOrders(tx, owner, [session])).get(session) ?? null;
  const base = {
    diningSessionReference: session,
    sessionPhase: found.phase,
    sessionVersion: found.version,
    paymentTiming: timing,
    tableLabel,
    orderReference,
  };
  const zero = { subtotalMinor: "0", taxMinor: "0", totalMinor: "0" };
  if (orderReference === null)
    return Object.freeze({
      ...base,
      rounds: Object.freeze([]),
      owed: zero,
      consistent: true,
      settlement: null,
      split: null,
      writeOff: null,
      onlinePayment: null,
      settlementRecord: null,
      splitPlanRecord: null,
    });
  const allowed = async () => (await input.authorize()) === true;
  const confirmations = [
    ...(await createPostgresOrderPayLaterConfirmationStore({
      ...owner,
      quoteVersion: 2,
      sha256,
      authorize: allowed,
    }).listByOrders({ transaction: tx, orderReferences: [orderReference] })),
  ].sort((a, b) => (a.confirmedAt < b.confirmedAt ? -1 : a.confirmedAt > b.confirmedAt ? 1 : 0));
  // Dishes taken off the bill before the table paid (rule 2) are no longer owed.
  const removed = new Set(
    (
      await createPostgresPayLaterItemCancellationStore({
        ...owner,
        authorize: async (_tx, value) =>
          value.orderReference === orderReference && (await allowed()),
      }).listByOrders(tx, [orderReference])
    ).flatMap((record) => record.orderItemReferences),
  );
  const prices = (await listOrderItemPrices(tx, owner, orderReference)).filter(
    (item) => !removed.has(String(item.orderItemReference)),
  );
  // Comps and discounts a manager decided (append-only): the dish stays on the bill at its price,
  // with what came off it.
  const reductions = new Map(
    (await listOrderPriceReductions(tx, owner, [orderReference], input.observedAt)).map(
      (record) => [record.orderItemReference, record],
    ),
  );
  const payments = createPostgresDiningTableSettlementStore({
    scope,
    authorize: async (_tx, value) => value.orderReference === orderReference && (await allowed()),
  });
  const settlements = await payments.listByOrders(tx, [orderReference]);
  const [writeOff] = await payments.listWriteOffsByOrders(tx, [orderReference]);
  const onlinePayments = await payments.listOnlinePaymentsByOrders(tx, [orderReference]);
  const onlinePayment = onlinePayments.filter((entry) => entry.part === null).at(-1);
  // The whole-table payment, if the table paid at once.
  const settlement = settlements.find((entry) => entry.part === null) ?? null;
  const [latestPlan] = await payments.listSplitPlans(tx, [orderReference]);
  const plan = latestPlan !== undefined && latestPlan.mode !== "Whole" ? latestPlan : null;
  const partPayments = new Map(
    settlements
      .filter(
        (entry) =>
          entry.part !== null && entry.part.splitPlanReference === plan?.splitPlanReference,
      )
      .map((entry) => [entry.part?.partNumber as number, entry]),
  );
  // A round is paid once all of it is: by the whole-table payment, or by its slices' parts.
  const paidBatches = new Set(settlement?.lines.map((line) => line.orderBatchReference) ?? []);
  if (plan !== null) {
    const unpaidBatches = new Set(
      plan.parts
        .filter((part) => !partPayments.has(part.partNumber))
        .flatMap((part) => part.slices.map((slice) => slice.orderBatchReference)),
    );
    for (const part of plan.parts)
      for (const slice of part.slices)
        if (!unpaidBatches.has(slice.orderBatchReference))
          paidBatches.add(slice.orderBatchReference);
  }
  // Which phone sent each round: phones are numbered in the order they joined the table
  // (WP-2423 item 8 ⑤ decision 3, the same numbers staff see in the table's phone list); staff
  // rounds have none.
  const phoneOf = new Map(
    (await loadDiningSessionPhones(tx as never, scope, session)).map((phone) => [
      String(phone.participantReference),
      phone.phoneNumber,
    ]),
  );
  const orderedByOf = (batch: string): number | null => {
    const participant = prices.find(
      (item) => String(item.orderBatchReference) === batch,
    )?.addedByParticipantReference;
    if (participant === null || participant === undefined) return null;
    return phoneOf.get(String(participant)) ?? null;
  };
  let owedSubtotal = 0n,
    owedTax = 0n,
    owedTotal = 0n,
    paidAllocation = 0n;
  const rounds = confirmations.map((confirmation, index) => {
    const batch = String(confirmation.orderBatchReference);
    const items = prices.filter((item) => String(item.orderBatchReference) === batch);
    const off = (item: (typeof items)[number]) =>
      reductions.get(String(item.orderItemReference)) ?? null;
    const subtotal = items.reduce(
      (sum, item) => sum + item.subtotal.amountMinor - (off(item)?.netMinor ?? 0n),
      0n,
    );
    const tax = items.reduce(
      (sum, item) => sum + item.tax.amountMinor - (off(item)?.taxMinor ?? 0n),
      0n,
    );
    const total = items.reduce(
      (sum, item) => sum + item.total.amountMinor - (off(item)?.totalMinor ?? 0n),
      0n,
    );
    const paid = paidBatches.has(batch);
    // A round whose every dish was taken off owes nothing (and is never a payment line).
    if (total === 0n) {
      /* nothing owed */
    } else if (paid) paidAllocation += total;
    else {
      owedSubtotal += subtotal;
      owedTax += tax;
      owedTotal += total;
    }
    return Object.freeze({
      roundNumber: index + 1,
      orderBatchReference: batch,
      submissionReference: String(confirmation.submissionReference),
      items: Object.freeze(
        items.map((item) =>
          Object.freeze({
            displayName: item.displayName,
            subtotalMinor: item.subtotal.amountMinor.toString(),
            totalMinor: (item.total.amountMinor - (off(item)?.totalMinor ?? 0n)).toString(),
            reduction:
              off(item) === null
                ? null
                : Object.freeze({
                    kind: (off(item) as NonNullable<ReturnType<typeof off>>).kind,
                    percent: (off(item) as NonNullable<ReturnType<typeof off>>).percent,
                    amountMinor: (
                      off(item) as NonNullable<ReturnType<typeof off>>
                    ).totalMinor.toString(),
                  }),
          }),
        ),
      ),
      subtotalMinor: subtotal.toString(),
      taxMinor: tax.toString(),
      totalMinor: total.toString(),
      paid,
      orderedBy: orderedByOf(batch),
    });
  });
  // A split's parts: what each was paid with, and what is still owed by the parts unpaid.
  let split: DiningTableBill["split"] = null;
  if (plan !== null) {
    const roundNumberOf = new Map(
      rounds.map((round) => [round.orderBatchReference, round.roundNumber]),
    );
    const owing = rounds.filter((round) => round.totalMinor !== "0");
    // Before anything is paid the plan must still be the bill (a comp or a dish taken off changes
    // it): recomputed the same way, it must give the same parts and slices.
    let stale = false;
    if (partPayments.size === 0) {
      try {
        const splitRounds = owing.map((round) => ({
          orderBatchReference: round.orderBatchReference,
          submissionReference: round.submissionReference,
          sequence: round.roundNumber,
          roundMinor: BigInt(round.totalMinor),
          subtotalMinor: BigInt(round.subtotalMinor),
          taxMinor: BigInt(round.taxMinor),
        }));
        const again =
          plan.mode === "Even"
            ? splitDiningTableBill({ mode: "Even", rounds: splitRounds, people: plan.parts.length })
            : splitDiningTableBill({
                mode: "ByRounds",
                rounds: splitRounds,
                partOf: new Map(
                  plan.parts.flatMap((part) =>
                    part.slices.map(
                      (slice) => [slice.orderBatchReference, part.partNumber] as const,
                    ),
                  ),
                ),
              });
        const shape = (
          parts: readonly {
            amountMinor: bigint;
            slices: readonly { orderBatchReference: string; roundMinor: bigint }[];
          }[],
        ) =>
          JSON.stringify(
            parts.map((part) => [
              part.amountMinor.toString(),
              [...part.slices]
                .map((slice) => `${slice.orderBatchReference}:${slice.roundMinor}`)
                .sort(),
            ]),
          );
        stale = shape(again.parts) !== shape(plan.parts);
      } catch {
        stale = true;
      }
    }
    const open = (partNumber: number) =>
      onlinePayments.some(
        (entry) =>
          entry.outcome === null &&
          entry.part?.splitPlanReference === plan.splitPlanReference &&
          entry.part.partNumber === partNumber,
      );
    const parts = plan.parts.map((part) => {
      const paidWith = partPayments.get(part.partNumber) ?? null;
      return Object.freeze({
        partNumber: part.partNumber,
        amountMinor: part.amountMinor.toString(),
        subtotalMinor: part.subtotalMinor.toString(),
        taxMinor: part.taxMinor.toString(),
        roundNumbers: Object.freeze(
          part.slices
            .map((slice) => roundNumberOf.get(slice.orderBatchReference) ?? 0)
            .sort((a, b) => a - b),
        ),
        payment:
          paidWith === null
            ? null
            : Object.freeze({
                method: paidWith.method,
                tipMinor: paidWith.tipMinor.toString(),
                roundingMinor: paidWith.roundingMinor.toString(),
                totalMinor: paidWith.totalMinor.toString(),
                tenderedMinor: paidWith.tenderedMinor?.toString() ?? null,
                changeMinor: paidWith.changeMinor?.toString() ?? null,
                recordedAt: paidWith.recordedAt,
                recordedAfterOutage: paidWith.recordingReason === "RecordedAfterOutage",
              }),
        guestPaying: open(part.partNumber),
      });
    });
    const unpaid = plan.parts.filter((part) => !partPayments.has(part.partNumber));
    paidAllocation = plan.parts
      .filter((part) => partPayments.has(part.partNumber))
      .reduce((sum, part) => sum + part.amountMinor, 0n);
    owedTotal = unpaid.reduce((sum, part) => sum + part.amountMinor, 0n);
    owedSubtotal = unpaid.reduce((sum, part) => sum + part.subtotalMinor, 0n);
    owedTax = unpaid.reduce((sum, part) => sum + part.taxMinor, 0n);
    split = Object.freeze({
      mode: plan.mode as "Even" | "ByRounds",
      stale,
      parts: Object.freeze(parts),
      paidParts: partPayments.size,
      remainingMinor: owedTotal.toString(),
    });
  }
  // The Order's priced total (Ordering) is what the rounds must come to: a round still being sent
  // (submitted, not yet in the kitchen) or a change to the Order makes the bill inconsistent.
  const priced = await createPostgresOrderPricedAmountSource({ ...owner, authorize: allowed })(tx, {
    orderReference,
    observedAt: input.observedAt,
  });
  const consistent =
    priced.pendingAmendmentCount === 0 &&
    priced.pricedTotalMinor === paidAllocation + owedTotal &&
    (settlement === null || settlement.roundsMinor === paidAllocation) &&
    split?.stale !== true;
  return Object.freeze({
    ...base,
    rounds: Object.freeze(rounds),
    owed: Object.freeze({
      subtotalMinor: owedSubtotal.toString(),
      taxMinor: owedTax.toString(),
      totalMinor: owedTotal.toString(),
    }),
    consistent,
    settlement:
      settlement === null
        ? null
        : Object.freeze({
            method: settlement.method,
            roundsMinor: settlement.roundsMinor.toString(),
            tipMinor: settlement.tipMinor.toString(),
            roundingMinor: settlement.roundingMinor.toString(),
            totalMinor: settlement.totalMinor.toString(),
            tenderedMinor: settlement.tenderedMinor?.toString() ?? null,
            changeMinor: settlement.changeMinor?.toString() ?? null,
            recordedAt: settlement.recordedAt,
            recordedAfterOutage: settlement.recordingReason === "RecordedAfterOutage",
          }),
    split,
    writeOff:
      writeOff === undefined
        ? null
        : Object.freeze({
            amountMinor: writeOff.writtenOffMinor.toString(),
            decidedAt: writeOff.decidedAt,
          }),
    onlinePayment:
      onlinePayment === undefined
        ? null
        : Object.freeze({
            status: onlinePayment.outcome?.status ?? ("InProgress" as const),
            totalMinor: onlinePayment.totalMinor.toString(),
            tipMinor: onlinePayment.tipMinor.toString(),
            startedAt: onlinePayment.createdAt,
          }),
    settlementRecord: settlement,
    splitPlanRecord: plan,
  });
}

export const publicBill = (
  bill: Awaited<ReturnType<typeof readDiningTableBill>>,
): DiningTableBill => {
  const { settlementRecord, splitPlanRecord, ...rest } = bill;
  void settlementRecord;
  void splitPlanRecord;
  return Object.freeze(rest);
};

export const scopeOf = (current: {
  selected: { tenantReference: unknown };
  context: { brand: { brandReference: unknown } };
  store: { storeReference: unknown };
}): Scope => ({
  tenantReference: String(current.selected.tenantReference),
  brandReference: String(current.context.brand.brandReference),
  storeReference: String(current.store.storeReference),
});

function instant(value: string): string {
  const at = Date.parse(value);
  if (!Number.isFinite(at)) return fail("TABLE_CHECKOUT_UNAVAILABLE");
  return new Date(at).toISOString();
}

export function createMerchantDiningTableBillRead(options: {
  persistence: PersistentMerchantBffOptions;
  authentication: Pick<MerchantBffService, "authorize">;
}) {
  const resolve = createMerchantStoreScope(options.persistence);
  return async (input: { sessionCookie: unknown; csrf: unknown; query: unknown }) => {
    const authenticated = await options.authentication.authorize(input);
    let session: string;
    try {
      session = String(
        parseDiningReference(
          readClosedRecord(input.query, ["diningSessionReference"]).diningSessionReference,
        ),
      );
    } catch {
      return fail("TABLE_CHECKOUT_INPUT_INVALID");
    }
    return runMerchantSnapshotRead(options.persistence.transactions, (tx) =>
      withMerchantTransactionAuthorization(
        {
          transaction: tx,
          resolve: async () => {
            const current = await resolve(
              tx,
              input.sessionCookie,
              diningTableCheckoutPermission,
              authenticated.sessionReference,
            ).catch(() => fail("TABLE_CHECKOUT_PERMISSION_DENIED"));
            if ((await current.allowed()) !== true) return fail("TABLE_CHECKOUT_PERMISSION_DENIED");
            return current;
          },
          recheck: async (current) => (await current.allowed()) === true,
          denied: () => fail("TABLE_CHECKOUT_PERMISSION_DENIED"),
        },
        async (authority) =>
          publicBill(
            await readDiningTableBill(
              tx as unknown as ConsumerTransaction,
              scopeOf(authority.scope),
              {
                diningSessionReference: session,
                observedAt: instant(options.persistence.now()),
                authorize: () => authority.guard(),
              },
            ),
          ),
      ),
    );
  };
}

export function parseDiningTableSettleCommand(value: unknown) {
  try {
    const raw = readClosedRecord(value, [
      "operationReference",
      "diningSessionReference",
      "method",
      "tip",
      "tenderedMinor",
      "slipReference",
      "recordedAfterOutage",
      "takenAt",
      ...(value !== null && typeof value === "object" && Object.hasOwn(value, "partNumber")
        ? ["partNumber"]
        : []),
    ]);
    const method = raw.method === "Cash" || raw.method === "CardMachine" ? raw.method : null;
    // WP-2423 item 8 ④: the part of a split bill this payment is (absent or null: the whole table).
    const partNumber =
      raw.partNumber === undefined || raw.partNumber === null
        ? null
        : Number.isSafeInteger(raw.partNumber) &&
            (raw.partNumber as number) >= 1 &&
            (raw.partNumber as number) <= 20
          ? (raw.partNumber as number)
          : fail("TABLE_CHECKOUT_INPUT_INVALID");
    if (method === null || typeof raw.recordedAfterOutage !== "boolean")
      return fail("TABLE_CHECKOUT_INPUT_INVALID");
    const tipRaw = readClosedRecord(raw.tip, Object.keys(raw.tip as object));
    let tip: DiningTableTip;
    if (tipRaw.kind === "None" && Object.keys(tipRaw).length === 1) tip = { kind: "None" };
    else if (
      tipRaw.kind === "Percent" &&
      Object.keys(tipRaw).length === 2 &&
      [10, 15, 18, 20].includes(tipRaw.percent as number)
    )
      tip = { kind: "Percent", percent: tipRaw.percent as 10 | 15 | 18 | 20 };
    else if (
      tipRaw.kind === "Amount" &&
      Object.keys(tipRaw).length === 2 &&
      typeof tipRaw.amountMinor === "string" &&
      /^(0|[1-9][0-9]{0,8})$/u.test(tipRaw.amountMinor)
    )
      tip = { kind: "Amount", amountMinor: tipRaw.amountMinor };
    else return fail("TABLE_CHECKOUT_INPUT_INVALID");
    const tendered =
      raw.tenderedMinor === null
        ? null
        : typeof raw.tenderedMinor === "string" && /^[1-9][0-9]{0,8}$/u.test(raw.tenderedMinor)
          ? BigInt(raw.tenderedMinor)
          : fail("TABLE_CHECKOUT_INPUT_INVALID");
    if ((method === "Cash") !== (tendered !== null)) return fail("TABLE_CHECKOUT_INPUT_INVALID");
    const slip =
      raw.slipReference === null
        ? null
        : typeof raw.slipReference === "string" &&
            /^[A-Za-z0-9][A-Za-z0-9 #./-]{0,39}$/u.test(raw.slipReference) &&
            raw.slipReference.replace(/[^0-9]/gu, "").length <= 12
          ? raw.slipReference
          : fail("TABLE_CHECKOUT_INPUT_INVALID");
    if (method === "Cash" && slip !== null) return fail("TABLE_CHECKOUT_INPUT_INVALID");
    const takenAt =
      raw.takenAt === null
        ? null
        : typeof raw.takenAt === "string" && Number.isFinite(Date.parse(raw.takenAt))
          ? new Date(Date.parse(raw.takenAt)).toISOString()
          : fail("TABLE_CHECKOUT_INPUT_INVALID");
    if (raw.recordedAfterOutage !== (takenAt !== null)) return fail("TABLE_CHECKOUT_INPUT_INVALID");
    return Object.freeze({
      operationReference: String(parseDiningReference(raw.operationReference)),
      diningSessionReference: String(parseDiningReference(raw.diningSessionReference)),
      method,
      tip,
      tenderedMinor: tendered,
      slipReference: slip,
      recordedAfterOutage: raw.recordedAfterOutage,
      takenAt,
      partNumber,
    });
  } catch (error) {
    if (error instanceof DiningTableCheckoutError) throw error;
    return fail("TABLE_CHECKOUT_INPUT_INVALID");
  }
}

export function createMerchantDiningTableSettle(options: {
  persistence: PersistentMerchantBffOptions;
  authentication: Pick<MerchantBffService, "authorize">;
  environment: "Test" | "Live";
  nextReference(): string;
}) {
  const resolve = createMerchantStoreScope(options.persistence);
  return async (input: { sessionCookie: unknown; csrf: unknown; command: unknown }) => {
    const authenticated = await options.authentication.authorize(input);
    const command = parseDiningTableSettleCommand(input.command);
    const intentDigest = sha256(
      canonicalizeRfc8785({
        kind: "DiningTableSettlement/v1",
        diningSessionReference: command.diningSessionReference,
        method: command.method,
        tip: command.tip,
        tenderedMinor: command.tenderedMinor?.toString() ?? null,
        slipReference: command.slipReference,
        takenAt: command.takenAt,
        ...(command.partNumber === null ? {} : { partNumber: command.partNumber }),
      }),
    );
    try {
      return await options.persistence.transactions.run((transaction) =>
        withMerchantTransactionAuthorization(
          {
            transaction,
            resolve: async () => {
              const current = await resolve(
                transaction,
                input.sessionCookie,
                diningTableCheckoutPermission,
                authenticated.sessionReference,
              ).catch(() => fail("TABLE_CHECKOUT_PERMISSION_DENIED"));
              const decisions = await current.authorizeActions([
                diningTableCheckoutPermission,
                staffDiningRoundPermission,
              ]);
              if (
                decisions.get(diningTableCheckoutPermission)?.effect !== "Allow" ||
                decisions.get(staffDiningRoundPermission)?.effect !== "Allow"
              )
                return fail("TABLE_CHECKOUT_PERMISSION_DENIED");
              return current;
            },
            recheck: async (current) => (await current.allowed()) === true,
            denied: () => fail("TABLE_CHECKOUT_PERMISSION_DENIED"),
          },
          async (authority) => {
            const tx = transaction as unknown as ConsumerTransaction;
            const scope = scopeOf(authority.scope);
            const guard = () => authority.guard();
            const store = createPostgresDiningTableSettlementStore({
              scope,
              authorize: async () => (await guard()) === true,
            });
            const observedAt = instant(options.persistence.now());
            // A retry of the same command returns the payment it recorded.
            const prior = await store.loadByOperation(tx, command.operationReference);
            if (prior !== null) {
              if (prior.intentDigest !== intentDigest)
                return fail("TABLE_CHECKOUT_IDEMPOTENCY_CONFLICT");
              const bill = await readDiningTableBill(tx, scope, {
                diningSessionReference: command.diningSessionReference,
                observedAt,
                authorize: guard,
              });
              return Object.freeze({ status: "AlreadyRecorded" as const, bill: publicBill(bill) });
            }
            const bill = await readDiningTableBill(tx, scope, {
              diningSessionReference: command.diningSessionReference,
              observedAt,
              authorize: guard,
            });
            if (bill.paymentTiming !== "PayLater") return fail("TABLE_CHECKOUT_NOT_PAY_LATER");
            if (bill.sessionPhase !== "Closing") return fail("TABLE_CHECKOUT_NOT_STARTED");
            // Paid, or written off when the guests left: never a (second) payment.
            if (bill.settlement !== null || bill.writeOff !== null)
              return fail("TABLE_CHECKOUT_ALREADY_PAID");
            // WP-2423 item 8 ④: a split bill is paid part by part; a whole bill at once.
            const part =
              bill.split === null || command.partNumber === null
                ? null
                : (bill.split.parts.find((entry) => entry.partNumber === command.partNumber) ??
                  null);
            if (
              (bill.split === null) !== (command.partNumber === null) ||
              (bill.split !== null && part === null)
            )
              return fail("TABLE_CHECKOUT_INPUT_INVALID");
            if (part?.payment !== null && part !== null) return fail("TABLE_CHECKOUT_ALREADY_PAID");
            if (part?.guestPaying === true) return fail("TABLE_CHECKOUT_GUEST_PAYING");
            // S4: a guest is paying the whole table on their phone right now.
            if (bill.onlinePayment?.status === "InProgress")
              return fail("TABLE_CHECKOUT_GUEST_PAYING");
            if (!bill.consistent || bill.orderReference === null)
              return fail(
                bill.orderReference === null
                  ? "TABLE_CHECKOUT_NOTHING_OWED"
                  : "TABLE_CHECKOUT_BILL_CHANGED",
              );
            const owed = bill.rounds.filter((round) => !round.paid && round.totalMinor !== "0");
            if (owed.length === 0) return fail("TABLE_CHECKOUT_NOTHING_OWED");
            const planPart =
              part === null || bill.splitPlanRecord === null
                ? null
                : (bill.splitPlanRecord.parts.find(
                    (entry) => entry.partNumber === part.partNumber,
                  ) ?? fail("TABLE_CHECKOUT_BILL_CHANGED"));
            const sequenceOf = new Map(
              bill.rounds.map((round) => [round.orderBatchReference, round] as const),
            );
            // A part's tip is on its own share of the bill before tax.
            const tipMinor = tableTipMinor(
              command.tip,
              planPart === null ? BigInt(bill.owed.subtotalMinor) : planPart.subtotalMinor,
            );
            await store.record(tx, {
              ...(planPart === null || bill.splitPlanRecord === null
                ? {}
                : {
                    part: {
                      splitPlanReference: bill.splitPlanRecord.splitPlanReference,
                      partNumber: planPart.partNumber,
                    },
                  }),
              settlementReference: options.nextReference(),
              operationReference: command.operationReference,
              intentDigest,
              diningSessionReference: command.diningSessionReference,
              orderReference: bill.orderReference,
              method: command.method,
              rounds:
                planPart === null
                  ? owed.map((round) => ({
                      orderBatchReference: round.orderBatchReference,
                      submissionReference: round.submissionReference,
                      sequence: round.roundNumber,
                      roundMinor: BigInt(round.totalMinor),
                    }))
                  : planPart.slices.map((slice) => {
                      const round =
                        sequenceOf.get(slice.orderBatchReference) ??
                        fail("TABLE_CHECKOUT_BILL_CHANGED");
                      return {
                        orderBatchReference: slice.orderBatchReference,
                        submissionReference: round.submissionReference,
                        sequence: round.roundNumber,
                        roundMinor: slice.roundMinor,
                      };
                    }),
              tipMinor,
              tenderedMinor: command.tenderedMinor,
              environment: options.environment,
              slipReference: command.slipReference,
              recordingReason: command.recordedAfterOutage ? "RecordedAfterOutage" : "AtTable",
              takenAt: command.takenAt ?? observedAt,
              recordedAt: observedAt,
              actorReference: String(authority.scope.actorReference),
              auditReference: options.nextReference(),
              correlationReference: command.operationReference,
            });
            const after = await readDiningTableBill(tx, scope, {
              diningSessionReference: command.diningSessionReference,
              observedAt,
              authorize: guard,
            });
            return Object.freeze({ status: "Recorded" as const, bill: publicBill(after) });
          },
        ),
      );
    } catch (error) {
      if (error instanceof DiningTableCheckoutError) throw error;
      if (error instanceof DiningTableSettlementError)
        return fail(
          error.code === "DINING_TABLE_SETTLEMENT_TENDER_SHORT"
            ? "TABLE_CHECKOUT_TENDER_SHORT"
            : error.code === "DINING_TABLE_SETTLEMENT_NOTHING_OWED"
              ? "TABLE_CHECKOUT_NOTHING_OWED"
              : "TABLE_CHECKOUT_INPUT_INVALID",
        );
      if (error instanceof DiningTableSettlementStoreError)
        return fail(
          error.code === "DINING_TABLE_SETTLEMENT_ALREADY_PAID"
            ? "TABLE_CHECKOUT_ALREADY_PAID"
            : error.code === "DINING_TABLE_SETTLEMENT_IDEMPOTENCY_CONFLICT"
              ? "TABLE_CHECKOUT_IDEMPOTENCY_CONFLICT"
              : error.code === "DINING_TABLE_SETTLEMENT_PERMISSION_DENIED"
                ? "TABLE_CHECKOUT_PERMISSION_DENIED"
                : "TABLE_CHECKOUT_UNAVAILABLE",
        );
      return fail("TABLE_CHECKOUT_UNAVAILABLE");
    }
  };
}

/**
 * WP-2423 item 8 ④ DEC-DINE-IN-SPLIT-BILL: staff split a pay-later table's bill at checkout —
 * evenly by people (2–20), or by rounds (each round to a part) — or go back to one payment. The
 * browser sends only the choice; the parts are computed from the Order's own rounds. Allowed at
 * checkout until a part is paid or a guest is paying (then the split is locked).
 */
export function parseDiningTableSplitCommand(value: unknown) {
  try {
    const raw = readClosedRecord(value, [
      "operationReference",
      "diningSessionReference",
      "mode",
      "people",
      "rounds",
    ]);
    const mode =
      raw.mode === "Whole" || raw.mode === "Even" || raw.mode === "ByRounds" ? raw.mode : null;
    if (mode === null) return fail("TABLE_CHECKOUT_INPUT_INVALID");
    const people =
      mode === "Even" &&
      Number.isSafeInteger(raw.people) &&
      (raw.people as number) >= 2 &&
      (raw.people as number) <= 20
        ? (raw.people as number)
        : raw.people === null && mode !== "Even"
          ? null
          : fail("TABLE_CHECKOUT_INPUT_INVALID");
    let rounds: { roundNumber: number; partNumber: number }[] | null = null;
    if (mode === "ByRounds") {
      if (!Array.isArray(raw.rounds) || raw.rounds.length < 2 || raw.rounds.length > 200)
        return fail("TABLE_CHECKOUT_INPUT_INVALID");
      rounds = raw.rounds.map((entry: unknown) => {
        const item = readClosedRecord(entry, ["roundNumber", "partNumber"]);
        if (
          !Number.isSafeInteger(item.roundNumber) ||
          (item.roundNumber as number) < 1 ||
          !Number.isSafeInteger(item.partNumber) ||
          (item.partNumber as number) < 1 ||
          (item.partNumber as number) > 20
        )
          return fail("TABLE_CHECKOUT_INPUT_INVALID");
        return { roundNumber: item.roundNumber as number, partNumber: item.partNumber as number };
      });
    } else if (raw.rounds !== null) return fail("TABLE_CHECKOUT_INPUT_INVALID");
    return Object.freeze({
      operationReference: String(parseDiningReference(raw.operationReference)),
      diningSessionReference: String(parseDiningReference(raw.diningSessionReference)),
      mode,
      people,
      rounds,
    });
  } catch (error) {
    if (error instanceof DiningTableCheckoutError) throw error;
    return fail("TABLE_CHECKOUT_INPUT_INVALID");
  }
}

export function createMerchantDiningTableSplit(options: {
  persistence: PersistentMerchantBffOptions;
  authentication: Pick<MerchantBffService, "authorize">;
  nextReference(): string;
}) {
  const resolve = createMerchantStoreScope(options.persistence);
  return async (input: { sessionCookie: unknown; csrf: unknown; command: unknown }) => {
    const authenticated = await options.authentication.authorize(input);
    const command = parseDiningTableSplitCommand(input.command);
    const intentDigest = sha256(
      canonicalizeRfc8785({
        kind: "DiningTableSplit/v1",
        diningSessionReference: command.diningSessionReference,
        mode: command.mode,
        people: command.people,
        rounds: command.rounds,
      }),
    );
    try {
      return await options.persistence.transactions.run((transaction) =>
        withMerchantTransactionAuthorization(
          {
            transaction,
            resolve: async () => {
              const current = await resolve(
                transaction,
                input.sessionCookie,
                diningTableCheckoutPermission,
                authenticated.sessionReference,
              ).catch(() => fail("TABLE_CHECKOUT_PERMISSION_DENIED"));
              const decisions = await current.authorizeActions([
                diningTableCheckoutPermission,
                staffDiningRoundPermission,
              ]);
              if (
                decisions.get(diningTableCheckoutPermission)?.effect !== "Allow" ||
                decisions.get(staffDiningRoundPermission)?.effect !== "Allow"
              )
                return fail("TABLE_CHECKOUT_PERMISSION_DENIED");
              return current;
            },
            recheck: async (current) => (await current.allowed()) === true,
            denied: () => fail("TABLE_CHECKOUT_PERMISSION_DENIED"),
          },
          async (authority) => {
            const tx = transaction as unknown as ConsumerTransaction;
            const scope = scopeOf(authority.scope);
            const guard = () => authority.guard();
            const store = createPostgresDiningTableSettlementStore({
              scope,
              authorize: async () => (await guard()) === true,
            });
            const observedAt = instant(options.persistence.now());
            const read = () =>
              readDiningTableBill(tx, scope, {
                diningSessionReference: command.diningSessionReference,
                observedAt,
                authorize: guard,
              });
            const bill = await read();
            if (bill.paymentTiming !== "PayLater") return fail("TABLE_CHECKOUT_NOT_PAY_LATER");
            if (bill.sessionPhase !== "Closing") return fail("TABLE_CHECKOUT_NOT_STARTED");
            if (bill.orderReference === null) return fail("TABLE_CHECKOUT_NOTHING_OWED");
            if (
              bill.settlement !== null ||
              bill.writeOff !== null ||
              (bill.split?.paidParts ?? 0) > 0 ||
              bill.split?.parts.some((part) => part.guestPaying) === true ||
              bill.onlinePayment?.status === "InProgress"
            )
              return fail("TABLE_CHECKOUT_SPLIT_LOCKED");
            // A stale split is exactly what a new split corrects; any other mismatch is not.
            if (!bill.consistent && bill.split?.stale !== true)
              return fail("TABLE_CHECKOUT_BILL_CHANGED");
            const owing = bill.rounds.filter((round) => round.totalMinor !== "0");
            if (owing.length === 0) return fail("TABLE_CHECKOUT_NOTHING_OWED");
            const splitRounds = owing.map((round) => ({
              orderBatchReference: round.orderBatchReference,
              submissionReference: round.submissionReference,
              sequence: round.roundNumber,
              roundMinor: BigInt(round.totalMinor),
              subtotalMinor: BigInt(round.subtotalMinor),
              taxMinor: BigInt(round.taxMinor),
            }));
            const billMinor = splitRounds.reduce((sum, round) => sum + round.roundMinor, 0n);
            const split =
              command.mode === "Whole"
                ? { mode: "Whole" as const, billMinor }
                : command.mode === "Even"
                  ? splitDiningTableBill({
                      mode: "Even",
                      rounds: splitRounds,
                      people: command.people as number,
                    })
                  : splitDiningTableBill({
                      mode: "ByRounds",
                      rounds: splitRounds,
                      partOf: new Map(
                        (command.rounds ?? []).map((entry) => {
                          const round =
                            owing.find((value) => value.roundNumber === entry.roundNumber) ??
                            fail("TABLE_CHECKOUT_INPUT_INVALID");
                          return [round.orderBatchReference, entry.partNumber] as const;
                        }),
                      ),
                    });
            const result = await store.recordSplitPlan(tx, {
              splitPlanReference: options.nextReference(),
              operationReference: command.operationReference,
              intentDigest,
              diningSessionReference: command.diningSessionReference,
              orderReference: bill.orderReference,
              split,
              recordedAt: observedAt,
              actorReference: String(authority.scope.actorReference),
              auditReference: options.nextReference(),
              correlationReference: command.operationReference,
            });
            return Object.freeze({ status: result.status, bill: publicBill(await read()) });
          },
        ),
      );
    } catch (error) {
      if (error instanceof DiningTableCheckoutError) throw error;
      if (error instanceof DiningTableSettlementError) return fail("TABLE_CHECKOUT_INPUT_INVALID");
      if (error instanceof DiningTableSettlementStoreError)
        return fail(
          error.code === "DINING_TABLE_SETTLEMENT_ALREADY_PAID"
            ? "TABLE_CHECKOUT_SPLIT_LOCKED"
            : error.code === "DINING_TABLE_SETTLEMENT_IDEMPOTENCY_CONFLICT"
              ? "TABLE_CHECKOUT_IDEMPOTENCY_CONFLICT"
              : error.code === "DINING_TABLE_SETTLEMENT_PERMISSION_DENIED"
                ? "TABLE_CHECKOUT_PERMISSION_DENIED"
                : "TABLE_CHECKOUT_UNAVAILABLE",
        );
      return fail("TABLE_CHECKOUT_UNAVAILABLE");
    }
  };
}
