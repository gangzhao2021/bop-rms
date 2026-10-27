import { createHash } from "node:crypto";
import type { ConsumerTransaction } from "@bop/eventing";
import { canonicalizeRfc8785 } from "@bop/audit";
import { readClosedRecord } from "@bop/identity";
import {
  createPostgresDiningPaymentTimingStore,
  createPostgresDiningSessionReadStore,
  listDiningSessionTableLabels,
  parseDiningReference,
} from "@rms/dining";
import {
  createPostgresOrderPayLaterConfirmationStore,
  createPostgresOrderPricedAmountSource,
  listOrderItemPrices,
  listStoreDiningSessionOrders,
} from "@rms/ordering";
import {
  createPostgresDiningTableSettlementStore,
  DiningTableSettlementError,
  DiningTableSettlementStoreError,
  type DiningTableSettlementRecord,
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
  "TABLE_CHECKOUT_IDEMPOTENCY_CONFLICT",
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
    }[];
    readonly subtotalMinor: string;
    readonly taxMinor: string;
    readonly totalMinor: string;
    readonly paid: boolean;
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
    readonly method: "CardMachine" | "Cash";
    readonly roundsMinor: string;
    readonly tipMinor: string;
    readonly roundingMinor: string;
    readonly totalMinor: string;
    readonly tenderedMinor: string | null;
    readonly changeMinor: string | null;
    readonly recordedAt: string;
    readonly recordedAfterOutage: boolean;
  };
}

type Scope = { tenantReference: string; brandReference: string; storeReference: string };

/** The table's bill from the owners' records, in the caller's (authorized) transaction. */
export async function readDiningTableBill(
  tx: ConsumerTransaction,
  scope: Scope,
  input: {
    readonly diningSessionReference: string;
    readonly observedAt: string;
    authorize(): Promise<boolean>;
  },
): Promise<DiningTableBill & { readonly settlementRecord: DiningTableSettlementRecord | null }> {
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
      settlementRecord: null,
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
  const prices = await listOrderItemPrices(tx, owner, orderReference);
  const settlements = await createPostgresDiningTableSettlementStore({
    scope,
    authorize: async (_tx, value) => value.orderReference === orderReference && (await allowed()),
  }).listByOrders(tx, [orderReference]);
  const settlement = settlements[0] ?? null;
  const paidBatches = new Set(settlement?.lines.map((line) => line.orderBatchReference) ?? []);
  let owedSubtotal = 0n,
    owedTax = 0n,
    owedTotal = 0n,
    paidAllocation = 0n;
  const rounds = confirmations.map((confirmation, index) => {
    const batch = String(confirmation.orderBatchReference);
    const items = prices.filter((item) => String(item.orderBatchReference) === batch);
    const subtotal = items.reduce((sum, item) => sum + item.subtotal.amountMinor, 0n);
    const tax = items.reduce((sum, item) => sum + item.tax.amountMinor, 0n);
    const total = items.reduce((sum, item) => sum + item.total.amountMinor, 0n);
    const paid = paidBatches.has(batch);
    if (paid) paidAllocation += total;
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
            totalMinor: item.total.amountMinor.toString(),
          }),
        ),
      ),
      subtotalMinor: subtotal.toString(),
      taxMinor: tax.toString(),
      totalMinor: total.toString(),
      paid,
    });
  });
  // The Order's priced total (Ordering) is what the rounds must come to: a round still being sent
  // (submitted, not yet in the kitchen) or a change to the Order makes the bill inconsistent.
  const priced = await createPostgresOrderPricedAmountSource({ ...owner, authorize: allowed })(tx, {
    orderReference,
    observedAt: input.observedAt,
  });
  const consistent =
    priced.pendingAmendmentCount === 0 &&
    priced.pricedTotalMinor === paidAllocation + owedTotal &&
    (settlement === null || settlement.roundsMinor === paidAllocation);
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
    settlementRecord: settlement,
  });
}

const publicBill = (bill: Awaited<ReturnType<typeof readDiningTableBill>>): DiningTableBill => {
  const { settlementRecord, ...rest } = bill;
  void settlementRecord;
  return Object.freeze(rest);
};

const scopeOf = (current: {
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
    ]);
    const method = raw.method === "Cash" || raw.method === "CardMachine" ? raw.method : null;
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
            if (bill.settlement !== null) return fail("TABLE_CHECKOUT_ALREADY_PAID");
            if (!bill.consistent || bill.orderReference === null)
              return fail(
                bill.orderReference === null
                  ? "TABLE_CHECKOUT_NOTHING_OWED"
                  : "TABLE_CHECKOUT_BILL_CHANGED",
              );
            const owed = bill.rounds.filter((round) => !round.paid);
            if (owed.length === 0) return fail("TABLE_CHECKOUT_NOTHING_OWED");
            const tipMinor = tableTipMinor(command.tip, BigInt(bill.owed.subtotalMinor));
            await store.record(tx, {
              settlementReference: options.nextReference(),
              operationReference: command.operationReference,
              intentDigest,
              diningSessionReference: command.diningSessionReference,
              orderReference: bill.orderReference,
              method: command.method,
              rounds: owed.map((round) => ({
                orderBatchReference: round.orderBatchReference,
                submissionReference: round.submissionReference,
                sequence: round.roundNumber,
                roundMinor: BigInt(round.totalMinor),
              })),
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
