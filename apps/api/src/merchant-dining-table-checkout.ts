import { loadDiningGuestPhones } from "./dining-guest-phones.js";
import { createHash } from "node:crypto";
import { staffNameLocales } from "./staff-content-locale.js";
import type { ConsumerTransaction } from "@bop/eventing";
import { canonicalizeRfc8785 } from "@bop/audit";
import { readClosedRecord } from "@bop/identity";
import {
  createPostgresDiningPaymentTimingStore,
  createPostgresDiningSessionReadStore,
  listDiningSessionTableLabels,
  readDiningCheckoutLastStartOrCancel,
  parseDiningReference,
  listDiningSessionsMergedIn,
  listDiningSessionMergesInto,
  loadDiningCheckoutScopeSetting,
} from "@rms/dining";
import {
  createPostgresPayLaterItemCancellationStore,
  createPostgresOrderPayLaterConfirmationStore,
  createPostgresOrderPricedAmountSource,
  listOrderItemPrices,
  listOrderPriceReductions,
  listOrderBillOrders,
  listOrderDiningSessions,
  listOrderMergedInto,
  listStoreDiningSessionOrders,
  createPostgresStaffDiningRoundEntryStore,
  computeBillTaxRounding,
  loadBillTaxRounding,
  recordBillTaxRounding,
  parseOrderingReference,
} from "@rms/ordering";
import {
  createPostgresDiningTableSettlementStore,
  DiningTableSettlementError,
  DiningTableSettlementStoreError,
  chooseDiningTableGuestPart,
  diningTableSplitPaidInFull,
  diningTableSplitUnits,
  diningTableStandingGuestParts,
  onlinePaymentHoldsBill,
  splitDiningTableBill,
  type DiningTableSplitUnit,
  type DiningTableSplitDish,
  type DiningTableSettlementRecord,
  type DiningTableSplitPlanRecord,
} from "@rms/payment";
import { readStoreFirstConfigurationGoverningFrom } from "@rms/store";
import { createMerchantStoreScope } from "./merchant-store-scope.js";
import { withMerchantTransactionAuthorization } from "./merchant-transaction-authorization.js";
import { runMerchantSnapshotRead } from "./merchant-snapshot-read.js";
import type { PersistentMerchantBffOptions } from "./persistent-merchant-bff.js";
import type { MerchantBffService } from "./merchant-bff.js";
import { staffDiningRoundPermission } from "./merchant-staff-dining-round.js";
import {
  isTipPercent,
  readStoreTipChoices,
  tipRefusal,
  type StoreTipChoices,
} from "./merchant-store-features.js";
import { keepingCause, onlyRefusal } from "./merchant-failure.js";
import { fenceTableBill, listRoundsWaitingForStaff } from "./dining-waiting-rounds.js";

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
  /** WP-2423 item 8 ⑦ (Owner decision 11): the Store turned tips off; record it with no tip. */
  "TABLE_CHECKOUT_TIPS_OFF",
  /** The tip percentage is not one the Store offers now: read the bill again. */
  "TABLE_CHECKOUT_TIP_CHOICES_CHANGED",
  /**
   * WP-2423 M160: a paid-at time entered after an outage that is before the Store started using
   * the system (its first configuration governed). Nothing was recorded; the slip time is checked.
   */
  "TABLE_CHECKOUT_TAKEN_BEFORE_RECORDS",
  /**
   * WP-2423 (v15 fabf0261, Hotpot PC 9): a paid-at time entered after an outage that is well
   * before (more than `paidAtBeforeOrderedToleranceMs`) the last round it pays was ordered in the
   * system. A table pays after it orders; nothing was recorded, the slip time is checked.
   */
  "TABLE_CHECKOUT_TAKEN_BEFORE_ORDERED",
  /**
   * WP-2423 item 8 ⑤ D4: a guest round of this bill still waits for staff OK. Send it to the
   * kitchen or cancel it first (a served round is sent, never cancelled); nothing was recorded.
   */
  "TABLE_CHECKOUT_ROUNDS_WAITING",
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

/**
 * WP-2423 (v15 fabf0261): how far a paper paid-at may be before the last round it pays was ordered
 * in the system. A card machine's clock drifts and a handwritten time is approximate ("about
 * 22:00"), so a small gap is an honest slip time and only warned about on screen; a larger one is a
 * typing mistake (PC 9 was 27 hours early) and refused. Test-environment default (WP-2423 item 15),
 * to be confirmed with real stores' slips.
 */
export const paidAtBeforeOrderedToleranceMs = 30 * 60_000;

export type DiningTableTip =
  | { readonly kind: "None" }
  /** One of the Store's tip percentages (checked against them when it is taken). */
  | { readonly kind: "Percent"; readonly percent: number }
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
  /** Owner 2026-11-03: what went back from this table's payments (absent while nothing has). */
  readonly refundedMinor?: string;
  readonly diningSessionReference: string;
  readonly sessionPhase: "Active" | "Closing" | "Closed" | "Cancelled";
  readonly sessionVersion: number;
  readonly paymentTiming: "PayFirst" | "PayLater";
  readonly tableLabel: string | null;
  readonly orderReference: string | null;
  readonly rounds: readonly {
    readonly roundNumber: number;
    /**
     * WP-2423 item 8 ⑨: the Order the round belongs to — the table's own, or a table merged into
     * it (DEC-DINING-TABLE-MERGE).
     */
    readonly orderReference: string;
    readonly orderBatchReference: string;
    readonly submissionReference: string;
    readonly items: readonly {
      /** WP-2423 按菜分单: this line on the bill, and how many of it. */
      readonly orderItemReference: string;
      readonly quantity: number;
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
        /**
         * v15 batch 7 review: the same reduction before tax, so the printed bill's dish less its
         * comp adds up to the Subtotal (which is after comps and before tax).
         */
        readonly netMinor: string;
        /** WP-2423 取舍 18: a guest's points, not a manager's decision. */
        readonly points?: true;
      };
    }[];
    readonly subtotalMinor: string;
    /** Includes the round's share of the bill's tax rounding (`taxRoundingMinor`). */
    readonly taxMinor: string;
    readonly totalMinor: string;
    /** WP-2423 DEC-TAX-WHOLE-RECEIPT: the round's share of the bill's tax rounding. */
    readonly taxRoundingMinor: string;
    readonly paid: boolean;
    /**
     * WP-2423 item 8 ④: which phone at the table sent the round (1, 2, … in the order they first
     * ordered; no name), or null for a round staff entered for the table.
     */
    readonly orderedBy: number | null;
    /** WP-2423 item 8 ⑨: the table the round came from when it was merged in (null: this one). */
    readonly fromTableLabel: string | null;
    /**
     * WP-2423 (v15 fabf0261): when the round was sent in the system as it happened, or null for a
     * round staff took on paper during an outage and entered afterwards (its record is later than
     * when it was ordered). A payment of the round is not taken well before this time.
     */
    readonly liveOrderedAt: string | null;
  }[];
  /**
   * WP-2423 DEC-TAX-WHOLE-RECEIPT: the bill's tax rounding (whole-bill tax minus what the rounds
   * were charged), already in the rounds' tax; shown on its own line as "Tax rounding".
   */
  readonly taxRoundingMinor: string;
  /**
   * WP-2423 item 8 ⑤ decisions 5–7: guest rounds waiting for staff OK. Not in the kitchen and not
   * on this bill (not in `rounds` or `owed`) until staff send them; no payment is taken while any
   * waits (staff send them to the kitchen or cancel them first). `totalMinor`: what the round
   * would add, tax included, before the bill's tax rounding.
   */
  readonly waitingRounds: readonly {
    readonly orderReference: string;
    readonly orderBatchReference: string;
    readonly heldAt: string;
    /** Why it waits (staff see it in words; never a code on screen). */
    readonly reason: "FirstOrder" | "PhoneRapid" | "TableRapid";
    readonly itemCount: number;
    readonly totalMinor: string;
    /** The phone that sent it (as `rounds[].orderedBy`), or null when unknown. */
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
  /** WP-2423 item 8 ⑦: the tips offered now (the Store's percentages, or tips off). */
  readonly tips: StoreTipChoices;
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
    /** ByGuests (WP-2423 同桌结账): guests pay by dish as they go; parts are appended. */
    readonly mode: "Even" | "ByRounds" | "ByItems" | "ByGuests";
    readonly stale: boolean;
    /** Every part paid (ByGuests: and the parts cover the whole bill). */
    readonly paidInFull: boolean;
    /** ByItems: which part each unit of each dish went to (null: all the parts share it). */
    readonly dishChoices: readonly {
      readonly orderItemReference: string;
      readonly unit: number;
      readonly partNumber: number | null;
    }[];
    readonly parts: readonly {
      readonly partNumber: number;
      readonly amountMinor: string;
      readonly subtotalMinor: string;
      readonly taxMinor: string;
      /** The rounds this part takes from (by round number). */
      readonly roundNumbers: readonly number[];
      /** ByItems: the dishes this part pays for, those all the parts share marked as shared. */
      readonly dishes: readonly {
        readonly displayName: string;
        readonly quantity: number;
        readonly shared: boolean;
      }[];
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
      /** ByGuests: how the part was chosen ("Rest": the rest of the table, by a guest or staff). */
      readonly choice?: "Mine" | "Chosen" | "Rest";
      /** ByGuests: staff took this part at the counter (otherwise a guest chose it on a phone). */
      readonly byStaff?: boolean;
    }[];
    readonly paidParts: number;
    /** What the parts still unpaid come to. */
    readonly remainingMinor: string;
    /**
     * ByGuests: what the dishes nobody pays for yet come to — what staff take at the counter as
     * "the rest" (null when every dish is in a part).
     */
    readonly restMinor?: string | null;
    /** ByGuests: "the rest" before tax (a percentage tip at the counter is on it). */
    readonly restSubtotalMinor?: string | null;
    /**
     * ByGuests: dishes are left to pay but what they come to could not be worked out on this read
     * (restMinor is then null too, but not because every dish is chosen): staff read it again.
     */
    readonly restUnavailable?: boolean;
  };
  /**
   * WP-2423 同桌结账 (DEC-OWNER-DEFAULTS-2026-11-06): the dishes still to pay, by dish, for guests
   * paying by dish at a pay-later table — null when staff split the bill another way. Each dish:
   * the units nobody pays for yet and what each comes to (comped units are left out).
   */
  readonly guestChoices: null | {
    /** The Store's setting: what a guest paying on their phone starts with. */
    readonly defaultScope: "WholeTable" | "OwnDishes";
    readonly dishes: readonly {
      readonly orderItemReference: string;
      readonly displayName: string;
      readonly roundNumber: number;
      /** The phone that added it (as `rounds[].orderedBy`); null for a dish staff entered. */
      readonly orderedBy: number | null;
      readonly unitMinor: readonly string[];
      /** Each of those units before tax (for a tip on the dishes chosen). */
      readonly unitSubtotalMinor: readonly string[];
    }[];
    /**
     * What is left of each owing round once the parts paid or being paid are taken off: a choice
     * that takes the last dishes of a round pays exactly this (its tax rounding included).
     */
    readonly rounds: readonly {
      readonly roundNumber: number;
      readonly restMinor: string;
      readonly restSubtotalMinor: string;
    }[];
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

/** WP-2423 item 8 ⑨: the Order of each round on the bill (a merged table's rounds keep theirs). */
export const roundOrdersOf = (
  rounds: readonly { readonly orderBatchReference: string; readonly orderReference: string }[],
): ReadonlyMap<string, string> =>
  new Map(rounds.map((round) => [round.orderBatchReference, round.orderReference]));

/** The table's bill from the owners' records, in the caller's (authorized) transaction. */
export async function readDiningTableBill(
  tx: ConsumerTransaction,
  scope: Scope,
  input: {
    readonly diningSessionReference: string;
    readonly observedAt: string;
    authorize(): Promise<boolean>;
    /**
     * WP-2423 DEC-TAX-WHOLE-RECEIPT: a command about to take or plan a payment records the bill's
     * tax rounding first (a new version when the bill changed; never once anything is paid).
     */
    readonly recordTaxRounding?: { readonly nextReference: () => string } | undefined;
    /**
     * A command about to take a payment holds the bill's fence before reading it (implied by
     * `recordTaxRounding`), so a staff "Send to kitchen" can't change the bill meanwhile.
     */
    readonly lockForPayment?: boolean;
    /** The guest's languages for dish names, most preferred first (absent: as stored). */
    readonly displayLocales?: readonly string[] | undefined;
  },
): Promise<
  DiningTableBill & {
    readonly settlementRecord: DiningTableSettlementRecord | null;
    /** The current split plan (not "Whole"), for paying a part. */
    readonly splitPlanRecord: DiningTableSplitPlanRecord | null;
    /** WP-2423 按菜分单: the dishes of the rounds still owing, as they stand now. */
    readonly splitDishes: readonly DiningTableSplitDish[];
    /** WP-2423 同桌结账: the participant who added each dish (null: staff entered it). */
    readonly dishAdders: ReadonlyMap<string, string | null>;
    /** WP-2423 同桌结账: the owing rounds as the split computes them. */
    readonly splitRounds: readonly {
      readonly orderBatchReference: string;
      readonly submissionReference: string;
      readonly sequence: number;
      readonly roundMinor: bigint;
      readonly subtotalMinor: bigint;
      readonly taxMinor: bigint;
    }[];
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
    tips: await readStoreTipChoices(tx, scope),
  };
  const zero = { subtotalMinor: "0", taxMinor: "0", totalMinor: "0" };
  if (orderReference === null)
    return Object.freeze({
      ...base,
      rounds: Object.freeze([]),
      waitingRounds: Object.freeze([]),
      taxRoundingMinor: "0",
      owed: zero,
      consistent: true,
      settlement: null,
      split: null,
      writeOff: null,
      onlinePayment: null,
      guestChoices: null,
      settlementRecord: null,
      splitPlanRecord: null,
      splitDishes: Object.freeze([]),
      dishAdders: new Map(),
      splitRounds: Object.freeze([]),
    });
  const allowed = async () => (await input.authorize()) === true;
  // WP-2423 item 8 ⑨ (DEC-DINING-TABLE-MERGE): the bill is the table's Order and the Orders of
  // tables merged into it; each round stays on its own Order, with who ordered it.
  const billOrders = await listOrderBillOrders(tx, owner, orderReference);
  if (input.recordTaxRounding !== undefined || input.lockForPayment === true)
    await fenceTableBill(tx, owner, billOrders);
  const confirmations = [
    ...(await createPostgresOrderPayLaterConfirmationStore({
      ...owner,
      quoteVersion: 2,
      sha256,
      authorize: allowed,
    }).listByOrders({ transaction: tx, orderReferences: billOrders })),
  ].sort((a, b) => (a.confirmedAt < b.confirmedAt ? -1 : a.confirmedAt > b.confirmedAt ? 1 : 0));
  // Dishes taken off the bill before the table paid (rule 2) are no longer owed.
  const removed = new Set(
    (
      await createPostgresPayLaterItemCancellationStore({
        ...owner,
        authorize: async (_tx, value) =>
          billOrders.includes(String(value.orderReference)) && (await allowed()),
      }).listByOrders(tx, billOrders)
    ).flatMap((record) => record.orderItemReferences),
  );
  // One query at a time on the transaction (the pilot's runner refuses overlapping queries).
  const billPrices = [];
  for (const order of billOrders)
    billPrices.push(...(await listOrderItemPrices(tx, owner, order, input.displayLocales ?? "")));
  const prices = billPrices.filter((item) => !removed.has(String(item.orderItemReference)));
  // Comps and discounts a manager decided (append-only): the dish stays on the bill at its price,
  // with what came off it.
  const reductions = new Map(
    (await listOrderPriceReductions(tx, owner, billOrders, input.observedAt)).map((record) => [
      record.orderItemReference,
      record,
    ]),
  );
  const payments = createPostgresDiningTableSettlementStore({
    scope,
    authorize: async (_tx, value) => value.orderReference === orderReference && (await allowed()),
  });
  const settlements = await payments.listByOrders(tx, [orderReference]);
  const [writeOff] = await payments.listWriteOffsByOrders(tx, [orderReference]);
  const refundedMinor =
    settlements.length === 0 ? 0n : await tableRefundedMinor(tx, payments, orderReference);
  const onlinePayments = await payments.listOnlinePaymentsByOrders(tx, [orderReference]);
  const onlinePayment = onlinePayments.filter((entry) => entry.part === null).at(-1);
  // The whole-table payment, if the table paid at once.
  const settlement = settlements.find((entry) => entry.part === null) ?? null;
  const [latestPlan] = await payments.listSplitPlans(tx, [orderReference]);
  // v15 batch 9: a split belongs to the checkout it was planned in. One planned before this
  // table's checkout last started or was cancelled, with nothing paid or started on a phone for
  // it, is not the bill's: the checkout starts from the whole bill (also where cancelling recorded
  // no "pay whole" plan, as for a bill comped to $0), never old parts and "split it again".
  const planStands = async (candidate: NonNullable<typeof latestPlan>) => {
    const reference = candidate.splitPlanReference;
    if (settlements.some((entry) => entry.part?.splitPlanReference === reference)) return true;
    if (onlinePayments.some((entry) => entry.part?.splitPlanReference === reference)) return true;
    const boundary = await readDiningCheckoutLastStartOrCancel(tx as never, scope, session);
    return boundary === null || Date.parse(candidate.recordedAt) >= Date.parse(boundary);
  };
  const plan =
    latestPlan !== undefined && latestPlan.mode !== "Whole" && (await planStands(latestPlan))
      ? latestPlan
      : null;
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
  // WP-2423 同桌结账: guests paying by dish pay rounds a slice at a time; what each round's paid
  // parts (still standing) came to, before tax and tax.
  const byGuests = plan?.mode === "ByGuests";
  const standingParts = plan !== null && byGuests ? diningTableStandingGuestParts(plan) : [];
  const paidSlicesOf = new Map<string, { amount: bigint; subtotal: bigint; tax: bigint }>();
  for (const part of standingParts) {
    if (!partPayments.has(part.partNumber)) continue;
    for (const slice of part.slices) {
      const entry = paidSlicesOf.get(slice.orderBatchReference) ?? {
        amount: 0n,
        subtotal: 0n,
        tax: 0n,
      };
      entry.amount += slice.roundMinor;
      entry.subtotal += slice.subtotalMinor;
      entry.tax += slice.taxMinor;
      paidSlicesOf.set(slice.orderBatchReference, entry);
    }
  }
  if (plan !== null && !byGuests) {
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
  // WP-2423 DEC-TAX-WHOLE-RECEIPT: the bill is one receipt. Its tax per tax type is rounded once
  // over every dish; the difference from what each round was charged is the bill's "Tax rounding",
  // a share of it on each round. Recorded by the system rule before a payment is taken, and the
  // recorded version is kept once anything is paid (bills paid before the rule have none).
  let recordedRounding = await loadBillTaxRounding(tx, owner, orderReference);
  // A Failed or Cancelled online attempt took no money: it never fixes the rounding.
  const anyPayment =
    settlements.length > 0 || onlinePayments.some(onlinePaymentHoldsBill) || writeOff !== undefined;
  let taxRoundingLines: readonly { orderBatchReference: string; amountMinor: bigint }[] =
    recordedRounding?.lines ?? [];
  if (!anyPayment) {
    const computed = computeBillTaxRounding(
      confirmations.map((confirmation) => ({
        orderReference: String(confirmation.orderReference),
        orderBatchReference: String(confirmation.orderBatchReference),
        items: prices
          .filter(
            (item) => String(item.orderBatchReference) === String(confirmation.orderBatchReference),
          )
          .map((item) => {
            const reduction = reductions.get(String(item.orderItemReference)) ?? null;
            return {
              orderItemReference: String(item.orderItemReference),
              netMinor: item.subtotal.amountMinor - item.discountMinor,
              taxComponents: item.taxComponents,
              reduction:
                reduction === null
                  ? null
                  : { netMinor: reduction.netMinor, taxMinor: reduction.taxMinor },
            };
          }),
      })),
      // Rule version 2: a merged bill's rounding is on the rounds of the Order holding it.
      { carrierOrderReference: orderReference },
    );
    if (input.recordTaxRounding !== undefined)
      recordedRounding = await recordBillTaxRounding(tx, owner, {
        billOrderReference: orderReference,
        computed,
        adjustmentReference: input.recordTaxRounding.nextReference(),
        recordedAt: input.observedAt,
      });
    taxRoundingLines = computed.lines;
  }
  const taxRoundingOf = (batch: string) =>
    taxRoundingLines
      .filter((line) => line.orderBatchReference === batch)
      .reduce((sum, line) => sum + line.amountMinor, 0n);
  const taxRoundingMinor = taxRoundingLines.reduce((sum, line) => sum + line.amountMinor, 0n);
  // Which phone sent each round: phones are numbered in the order they joined the table
  // (WP-2423 item 8 ⑤ decision 3, the same numbers staff see in the table's phone list); staff
  // rounds have none.
  // A merged table's phones follow this table's (WP-2423 item 8 ⑨), so "each pays their own"
  // still tells the two tables' rounds apart.
  const phoneOf = new Map<string, number>();
  for (const party of [
    session,
    ...(billOrders.length > 1 ? await listDiningSessionsMergedIn(tx as never, scope, session) : []),
  ]) {
    const offset = phoneOf.size;
    for (const phone of await loadDiningGuestPhones(tx as never, scope, party))
      phoneOf.set(String(phone.participantReference), offset + phone.phoneNumber);
  }
  // Rounds staff entered for the table (DEC-STAFF-DINE-IN-ROUND) were sent by no phone.
  const staffRounds = await createPostgresStaffDiningRoundEntryStore({
    ...owner,
    authorize: allowed,
  }).listByOrders(tx, billOrders);
  // WP-2423 item 8 ⑨: the table each merged Order came from.
  const fromTableOf = new Map<string, string>();
  if (billOrders.length > 1) {
    const merges =
      (await listDiningSessionMergesInto(tx as never, scope, [session])).get(session) ?? [];
    const orders = await listStoreDiningSessionOrders(
      tx,
      owner,
      merges.map((merge) => merge.diningSessionReference),
    );
    for (const merge of merges) {
      const order = orders.get(merge.diningSessionReference);
      if (order !== undefined) fromTableOf.set(String(order), merge.fromTableLabel);
    }
  }
  const orderedByOf = (batch: string): number | null => {
    if (staffRounds.has(batch)) return null;
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
    // The round's share of the bill's tax rounding is part of its tax (and what it is paid).
    const taxRounding = taxRoundingOf(batch);
    const tax =
      items.reduce((sum, item) => sum + item.tax.amountMinor - (off(item)?.taxMinor ?? 0n), 0n) +
      taxRounding;
    const total =
      items.reduce(
        (sum, item) => sum + item.total.amountMinor - (off(item)?.totalMinor ?? 0n),
        0n,
      ) + taxRounding;
    const paidSlices = paidSlicesOf.get(batch);
    const paid = byGuests
      ? total > 0n && paidSlices !== undefined && paidSlices.amount >= total
      : paidBatches.has(batch);
    // A round whose every dish was taken off owes nothing (and is never a payment line).
    if (total === 0n) {
      /* nothing owed */
    } else if (byGuests) {
      // Guests paying by dish: what the round's paid parts did not pay is still owed.
      paidAllocation += paidSlices?.amount ?? 0n;
      owedSubtotal += subtotal - (paidSlices?.subtotal ?? 0n);
      owedTax += tax - (paidSlices?.tax ?? 0n);
      owedTotal += total - (paidSlices?.amount ?? 0n);
    } else if (paid) paidAllocation += total;
    else {
      owedSubtotal += subtotal;
      owedTax += tax;
      owedTotal += total;
    }
    return Object.freeze({
      roundNumber: index + 1,
      orderReference: String(confirmation.orderReference),
      orderBatchReference: batch,
      submissionReference: String(confirmation.submissionReference),
      items: Object.freeze(
        items.map((item) =>
          Object.freeze({
            orderItemReference: String(item.orderItemReference),
            quantity: item.quantity,
            displayName: item.displayName,
            subtotalMinor: item.subtotal.amountMinor.toString(),
            totalMinor: (item.total.amountMinor - (off(item)?.totalMinor ?? 0n)).toString(),
            reduction:
              off(item) === null
                ? null
                : Object.freeze({
                    kind: (off(item) as NonNullable<ReturnType<typeof off>>).kind,
                    percent: (off(item) as NonNullable<ReturnType<typeof off>>).percent,
                    ...((off(item) as NonNullable<ReturnType<typeof off>>).reasonCode ===
                    "POINTS_REDEMPTION"
                      ? { points: true as const }
                      : {}),
                    amountMinor: (
                      off(item) as NonNullable<ReturnType<typeof off>>
                    ).totalMinor.toString(),
                    netMinor: (
                      off(item) as NonNullable<ReturnType<typeof off>>
                    ).netMinor.toString(),
                  }),
          }),
        ),
      ),
      subtotalMinor: subtotal.toString(),
      taxMinor: tax.toString(),
      totalMinor: total.toString(),
      taxRoundingMinor: taxRounding.toString(),
      paid,
      orderedBy: orderedByOf(batch),
      fromTableLabel: fromTableOf.get(String(confirmation.orderReference)) ?? null,
      // A round taken on paper during an outage was confirmed when it was entered afterwards.
      liveOrderedAt:
        staffRounds.get(batch)?.entry.recordedAfterOutage === true
          ? null
          : new Date(Date.parse(String(confirmation.confirmedAt))).toISOString(),
    });
  });
  // WP-2423 item 8 ⑤: guest rounds waiting for staff OK, shown apart (never on the bill yet). The
  // same dishes the bill counts: a dish taken off is left out (as the panel's "not on the bill").
  const waitingRounds = Object.freeze(
    (await listRoundsWaitingForStaff(tx, owner, billOrders, allowed)).map((hold) => {
      const batch = String(hold.orderBatchReference);
      const items = prices.filter((item) => String(item.orderBatchReference) === batch);
      return Object.freeze({
        orderReference: String(hold.orderReference),
        orderBatchReference: batch,
        heldAt: String(hold.heldAt),
        reason: hold.reason,
        itemCount: items.reduce((sum, item) => sum + item.quantity, 0),
        totalMinor: items
          .reduce(
            (sum, item) =>
              sum +
              item.total.amountMinor -
              (reductions.get(String(item.orderItemReference))?.totalMinor ?? 0n),
            0n,
          )
          .toString(),
        orderedBy: orderedByOf(batch),
      });
    }),
  );
  const waitingMinor = waitingRounds.reduce((sum, round) => sum + BigInt(round.totalMinor), 0n);
  // WP-2423 按菜分单: the dishes of the rounds still owing, as they stand now.
  const owingBatches = new Set(
    rounds.filter((round) => round.totalMinor !== "0").map((round) => round.orderBatchReference),
  );
  const splitDishes = Object.freeze(
    prices
      .filter((item) => owingBatches.has(String(item.orderBatchReference)))
      .map((item) => {
        const off = reductions.get(String(item.orderItemReference)) ?? null;
        return Object.freeze({
          orderBatchReference: String(item.orderBatchReference),
          orderItemReference: String(item.orderItemReference),
          quantity: item.quantity,
          subtotalMinor: item.subtotal.amountMinor - (off?.netMinor ?? 0n),
          taxMinor: item.tax.amountMinor - (off?.taxMinor ?? 0n),
          totalMinor: item.total.amountMinor - (off?.totalMinor ?? 0n),
        });
      }),
  );
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
    if (partPayments.size === 0 && plan.mode !== "ByGuests") {
      try {
        const splitRounds = owing.map((round) => ({
          orderBatchReference: round.orderBatchReference,
          submissionReference: round.submissionReference,
          sequence: round.roundNumber,
          roundMinor: BigInt(round.totalMinor),
          subtotalMinor: BigInt(round.subtotalMinor),
          taxMinor: BigInt(round.taxMinor),
        }));
        const again = splitAgain(plan, splitRounds, splitDishes);
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
    const nameOf = new Map(
      prices.map((item) => [String(item.orderItemReference), item.displayName] as const),
    );
    const guestPartOf = new Map(plan.guestParts.map((part) => [part.partNumber, part]));
    const dishesOf = (partNumber: number) => {
      const counted = new Map<string, { displayName: string; quantity: number; shared: boolean }>();
      // ByGuests: the units the part pays for (never shared).
      const choices =
        plan.mode === "ByGuests"
          ? (guestPartOf.get(partNumber)?.units ?? []).map((unit) => ({
              ...unit,
              partNumber: partNumber as number | null,
            }))
          : plan.dishChoices;
      for (const choice of choices) {
        if (choice.partNumber !== null && choice.partNumber !== partNumber) continue;
        const key = `${choice.orderItemReference}:${choice.partNumber === null}`;
        const entry = counted.get(key);
        if (entry !== undefined) entry.quantity += 1;
        else
          counted.set(key, {
            // A dish taken off since keeps the choice but is no longer on the bill (split is stale).
            displayName: nameOf.get(choice.orderItemReference) ?? "",
            quantity: 1,
            shared: choice.partNumber === null,
          });
      }
      return Object.freeze(
        [...counted.values()]
          .filter((entry) => entry.displayName !== "")
          .map((entry) => Object.freeze(entry)),
      );
    };
    const shownParts = plan.mode === "ByGuests" ? standingParts : plan.parts;
    const parts = shownParts.map((part) => {
      const paidWith = partPayments.get(part.partNumber) ?? null;
      const chosen = guestPartOf.get(part.partNumber);
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
        dishes: dishesOf(part.partNumber),
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
        ...(chosen === undefined
          ? {}
          : { choice: chosen.choice, byStaff: chosen.actorType === "Staff" }),
      });
    });
    // Guests paying by dish owe what the rounds' paid parts did not pay (computed per round above).
    // v15 b12: a stale split (the bill changed before any part was paid) no longer says what is
    // owed: the bill as it now stands does (nothing at all after every dish was comped), never the
    // old parts' amounts on the guest's phone or the Tables list.
    if (plan.mode !== "ByGuests" && !stale) {
      const unpaid = plan.parts.filter((part) => !partPayments.has(part.partNumber));
      paidAllocation = plan.parts
        .filter((part) => partPayments.has(part.partNumber))
        .reduce((sum, part) => sum + part.amountMinor, 0n);
      owedTotal = unpaid.reduce((sum, part) => sum + part.amountMinor, 0n);
      owedSubtotal = unpaid.reduce((sum, part) => sum + part.subtotalMinor, 0n);
      owedTax = unpaid.reduce((sum, part) => sum + part.taxMinor, 0n);
    }
    split = Object.freeze({
      mode: plan.mode as "Even" | "ByRounds" | "ByItems" | "ByGuests",
      stale,
      paidInFull: diningTableSplitPaidInFull(plan, settlements),
      dishChoices: plan.dishChoices,
      parts: Object.freeze(parts),
      paidParts: parts.filter((part) => part.payment !== null).length,
      remainingMinor: owedTotal.toString(),
    });
  }
  // WP-2423 同桌结账: who added each dish, the owing rounds as the split computes them, and the
  // units guests may still choose to pay (a plan staff made another way leaves them none).
  const dishAdders = new Map(
    prices.map(
      (item) =>
        [
          String(item.orderItemReference),
          staffRounds.has(String(item.orderBatchReference)) ||
          item.addedByParticipantReference === null
            ? null
            : String(item.addedByParticipantReference),
        ] as const,
    ),
  );
  const splitRounds = Object.freeze(
    rounds
      .filter((round) => round.totalMinor !== "0")
      .map((round) =>
        Object.freeze({
          orderBatchReference: round.orderBatchReference,
          submissionReference: round.submissionReference,
          sequence: round.roundNumber,
          roundMinor: BigInt(round.totalMinor),
          subtotalMinor: BigInt(round.subtotalMinor),
          taxMinor: BigInt(round.taxMinor),
        }),
      ),
  );
  let guestChoices: DiningTableBill["guestChoices"] = null;
  if (
    timing === "PayLater" &&
    (plan === null || plan.mode === "ByGuests") &&
    settlement === null &&
    writeOff === undefined
  ) {
    const taken = new Set(
      (plan?.guestParts ?? [])
        .filter((part) => part.withdrawn === null)
        .flatMap((part) => part.units.map((unit) => `${unit.orderItemReference}:${unit.unit}`)),
    );
    const roundOf = new Map(rounds.map((round) => [round.orderBatchReference, round]));
    let units: ReturnType<typeof diningTableSplitUnits> = [];
    try {
      units = diningTableSplitUnits(splitDishes);
    } catch {
      units = [];
    }
    const nameOf = new Map(
      prices.map((item) => [String(item.orderItemReference), item.displayName] as const),
    );
    const setting = await loadDiningCheckoutScopeSetting(tx as never, scope);
    guestChoices = Object.freeze({
      defaultScope: setting.defaultScope,
      dishes: Object.freeze(
        splitDishes.flatMap((dish) => {
          const free = units.filter(
            (unit) =>
              unit.orderItemReference === dish.orderItemReference &&
              unit.amountMinor > 0n &&
              !taken.has(`${unit.orderItemReference}:${unit.unit}`),
          );
          if (free.length === 0) return [];
          const adder = dishAdders.get(dish.orderItemReference) ?? null;
          return [
            Object.freeze({
              orderItemReference: dish.orderItemReference,
              displayName: nameOf.get(dish.orderItemReference) ?? "",
              roundNumber: roundOf.get(dish.orderBatchReference)?.roundNumber ?? 0,
              orderedBy: adder === null ? null : (phoneOf.get(adder) ?? null),
              unitMinor: Object.freeze(free.map((unit) => unit.amountMinor.toString())),
              unitSubtotalMinor: Object.freeze(free.map((unit) => unit.subtotalMinor.toString())),
            }),
          ];
        }),
      ),
      rounds: Object.freeze(
        rounds
          .filter((round) => round.totalMinor !== "0")
          .map((round) => {
            const standingSlices = standingParts.flatMap((part) =>
              part.slices.filter(
                (slice) => slice.orderBatchReference === round.orderBatchReference,
              ),
            );
            return Object.freeze({
              roundNumber: round.roundNumber,
              restMinor: (
                BigInt(round.totalMinor) -
                standingSlices.reduce((sum, slice) => sum + slice.roundMinor, 0n)
              ).toString(),
              restSubtotalMinor: (
                BigInt(round.subtotalMinor) -
                standingSlices.reduce((sum, slice) => sum + slice.subtotalMinor, 0n)
              ).toString(),
            });
          }),
      ),
    });
  }
  // The Order's priced total (Ordering) is what the rounds must come to: a round still being sent
  // (submitted, not yet in the kitchen) or a change to the Order makes the bill inconsistent.
  // WP-2423 item 8 ⑨: a merged bill comes to every Order on it.
  // v15 b11: before anything is paid the bill carries the rounding it computes now, so Ordering's
  // total is read without the recorded version: one recorded before a comp or a dish taken off
  // (every dish comped after a split with a −$0.01 rounding came to −$0.01) no longer fits the
  // bill and must never make the table unreadable, uncancellable or unclosable.
  const pricedOrders = [];
  for (const order of billOrders)
    pricedOrders.push(
      await createPostgresOrderPricedAmountSource({
        ...owner,
        authorize: allowed,
        ...(anyPayment ? {} : { taxRounding: "Excluded" as const }),
      })(tx, {
        orderReference: order,
        observedAt: input.observedAt,
      }),
    );
  const priced = {
    pendingAmendmentCount: pricedOrders.reduce(
      (sum, entry) => sum + entry.pendingAmendmentCount,
      0,
    ),
    pricedTotalMinor: pricedOrders.reduce((sum, entry) => sum + entry.pricedTotalMinor, 0n),
  };
  // Ordering's priced total holds the recorded tax rounding; a bill shown before it is recorded
  // carries the one it would record instead. Rounds waiting for staff are on the Order, not yet
  // on the bill.
  const consistent =
    priced.pendingAmendmentCount === 0 &&
    priced.pricedTotalMinor -
      (anyPayment ? (recordedRounding?.totalMinor ?? 0n) : 0n) +
      taxRoundingMinor ===
      paidAllocation + owedTotal + waitingMinor &&
    (settlement === null || settlement.roundsMinor === paidAllocation) &&
    split?.stale !== true;
  const result = {
    ...base,
    ...(refundedMinor > 0n ? { refundedMinor: refundedMinor.toString() } : {}),
    rounds: Object.freeze(rounds),
    waitingRounds,
    taxRoundingMinor: taxRoundingMinor.toString(),
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
    guestChoices,
    settlementRecord: settlement,
    splitPlanRecord: plan,
    splitDishes,
    dishAdders,
    splitRounds,
  };
  // WP-2423 同桌结账: what "the rest" comes to for staff at the counter.
  if (split !== null && split.mode === "ByGuests") {
    const free = diningTableFreeUnits(result, null);
    let restMinor: string | null = null,
      restSubtotalMinor: string | null = null,
      restUnavailable = false;
    if (free.length > 0)
      try {
        const rest = diningTableGuestPart(result, free).part;
        restMinor = rest.amountMinor.toString();
        restSubtotalMinor = rest.subtotalMinor.toString();
      } catch {
        // Not "every dish is chosen": the rest exists but can't be priced on this read.
        restUnavailable = true;
      }
    return Object.freeze({
      ...result,
      split: Object.freeze({ ...split, restMinor, restSubtotalMinor, restUnavailable }),
    });
  }
  return Object.freeze(result);
}

/**
 * WP-2423 同桌结账: the part these units would be on this bill now — the next part of the table's
 * ByGuests plan (a new plan when it has none). Throws DiningTableSettlementError when a unit is
 * taken, worth nothing or not on the bill.
 */
export function diningTableGuestPart(
  bill: Awaited<ReturnType<typeof readDiningTableBill>>,
  chosen: readonly DiningTableSplitUnit[],
) {
  const plan = bill.splitPlanRecord;
  const standing = plan === null ? [] : diningTableStandingGuestParts(plan);
  const guestOf = new Map((plan?.guestParts ?? []).map((part) => [part.partNumber, part]));
  return chooseDiningTableGuestPart({
    rounds: bill.splitRounds,
    dishes: bill.splitDishes,
    others: standing.map((part) => ({
      units: guestOf.get(part.partNumber)?.units ?? [],
      slices: part.slices,
    })),
    chosen,
    partNumber: (plan?.parts.length ?? 0) + 1,
  });
}

/** WP-2423 同桌结账: the units still to pay — of the dishes this participant added, or all of them. */
export function diningTableFreeUnits(
  bill: Awaited<ReturnType<typeof readDiningTableBill>>,
  participantReference: string | null,
): DiningTableSplitUnit[] {
  return (bill.guestChoices?.dishes ?? []).flatMap((dish) =>
    participantReference !== null &&
    bill.dishAdders.get(dish.orderItemReference) !== participantReference
      ? []
      : freeUnitNumbers(bill, dish.orderItemReference).map((unit) => ({
          orderItemReference: dish.orderItemReference,
          unit,
        })),
  );
}
function freeUnitNumbers(
  bill: Awaited<ReturnType<typeof readDiningTableBill>>,
  orderItemReference: string,
): number[] {
  const plan = bill.splitPlanRecord;
  const taken = new Set(
    (plan?.guestParts ?? [])
      .filter((part) => part.withdrawn === null)
      .flatMap((part) => part.units)
      .filter((unit) => unit.orderItemReference === orderItemReference)
      .map((unit) => unit.unit),
  );
  return diningTableSplitUnits(bill.splitDishes)
    .filter(
      (unit) =>
        unit.orderItemReference === orderItemReference &&
        unit.amountMinor > 0n &&
        !taken.has(unit.unit),
    )
    .map((unit) => unit.unit);
}

/**
 * Cash given back, refunds on the card machine and refunds to a guest's card; one on its way
 * counts, a refused one moved nothing.
 */
export async function tableRefundedMinor(
  tx: ConsumerTransaction,
  store: ReturnType<typeof createPostgresDiningTableSettlementStore>,
  orderReference: string,
): Promise<bigint> {
  const orders = [orderReference];
  const cash = await store.listCashRefundsByOrders(tx as never, orders);
  const card = await store.listCardRefundsByOrders(tx as never, orders);
  const online = await store.listOnlineRefundsByOrders(tx as never, orders);
  return [
    ...cash,
    ...card,
    ...online.filter((refund) => refund.outcome?.status !== "Failed"),
  ].reduce((sum, refund) => sum + refund.amountMinor, 0n);
}

/**
 * WP-2423 DEC-TAX-WHOLE-RECEIPT (docs/spec/design/tax-whole-receipt.md): this Order's share of its
 * bill's tax rounding, for the Order's own detail, so the table panel and Orders read the figure
 * the checkout takes. 0 for an Order with no pay-at-end rounds (pickup, counter, a table paying
 * each round first): each of its rounds is its own receipt. Once the bill has any payment (or was
 * written off) the recorded version is the answer, without reading the table (it may be closed
 * long since); before that, the bill as checkout reads it now. A read never records. Fails closed
 * (TABLE_CHECKOUT_UNAVAILABLE) only when neither can be read.
 */
export async function readOrderTaxRoundingShare(
  tx: ConsumerTransaction,
  scope: Scope,
  input: {
    readonly orderReference: string;
    readonly observedAt: string;
    authorize(): Promise<boolean>;
  },
): Promise<bigint> {
  const owner = { brandReference: scope.brandReference, storeReference: scope.storeReference };
  const allowed = async () => (await input.authorize()) === true;
  const order = input.orderReference;
  // v15 batch 9 (DEC-TAX-WHOLE-RECEIPT rule version 2): the share is this Order's rounds' lines of
  // the bill's rounding, as checkout, the split parts and the recorded version hold them. A merged
  // bill puts its rounding on the rounds of the Order holding it, so the merged table's Order keeps
  // what it ordered and the host's carries the bill's rounding (a bill recorded under version 1
  // keeps the lines it was paid with). One source for every place that shows it.
  const rounds = await createPostgresOrderPayLaterConfirmationStore({
    ...owner,
    quoteVersion: 2,
    sha256,
    authorize: allowed,
  }).listByOrders({ transaction: tx, orderReferences: [order] });
  if (rounds.length === 0 && (await listOrderBillOrders(tx, owner, order)).length <= 1) return 0n;
  const payments = createPostgresDiningTableSettlementStore({
    scope,
    authorize: async (_tx, value) => value.orderReference === order && (await allowed()),
  });
  // The same test as readDiningTableBill: anything paid, being paid online, or written off.
  const anyPayment =
    (await payments.listByOrders(tx, [order])).length > 0 ||
    (await payments.listOnlinePaymentsByOrders(tx, [order])).some(onlinePaymentHoldsBill) ||
    (await payments.listWriteOffsByOrders(tx, [order])).length > 0;
  // An Order merged into another table's bill: that bill is the one recorded and read.
  const holder = (await listOrderMergedInto(tx, owner, [order])).get(order) ?? order;
  if (anyPayment || holder !== order) {
    const holderPaid =
      holder === order
        ? anyPayment
        : await (async () => {
            const there = createPostgresDiningTableSettlementStore({
              scope,
              authorize: async (_tx, value) => value.orderReference === holder && (await allowed()),
            });
            return (
              (await there.listByOrders(tx, [holder])).length > 0 ||
              (await there.listOnlinePaymentsByOrders(tx, [holder])).some(onlinePaymentHoldsBill) ||
              (await there.listWriteOffsByOrders(tx, [holder])).length > 0
            );
          })();
    if (holderPaid)
      return ((await loadBillTaxRounding(tx, owner, holder))?.lines ?? [])
        .filter((line) => line.orderReference === order)
        .reduce((sum, line) => sum + line.amountMinor, 0n);
  }
  const session = (await listOrderDiningSessions(tx, owner, [holder])).get(holder);
  if (session === undefined) return fail("TABLE_CHECKOUT_UNAVAILABLE");
  const bill = await readDiningTableBill(tx, scope, {
    diningSessionReference: session,
    observedAt: input.observedAt,
    authorize: allowed,
  });
  return bill.rounds
    .filter((round) => round.orderReference === order)
    .reduce((sum, round) => sum + BigInt(round.taxRoundingMinor), 0n);
}

/**
 * v15 b11 (DEC-TAX-WHOLE-RECEIPT rule 3): a command that changes a bill nothing has been paid on (a
 * comp or discount, a dish or round taken off) or closes it records the bill's tax rounding again in
 * its own transaction, so the recorded version Ordering's priced total, the write-off and closing
 * read is the bill as it now stands (a new version only when it changed). Every dish comped after a
 * split had left a −$0.01 version recorded at the split on a $0.00 bill: the table could then be
 * neither read nor closed. `whenNeverRecorded` also records a bill that has none yet (before a
 * write-off fixes it). Nothing once the bill has a payment: its recorded version is what was paid.
 * Holds the bill's fence (the Order holding the bill first), as the payment commands do.
 */
export async function refreshBillTaxRounding(
  tx: ConsumerTransaction,
  scope: Scope,
  input: {
    readonly orderReference: string;
    readonly observedAt: string;
    authorize(): Promise<boolean>;
    nextReference(): string;
    readonly whenNeverRecorded?: boolean;
  },
): Promise<void> {
  const owner = { brandReference: scope.brandReference, storeReference: scope.storeReference };
  const order = String(parseOrderingReference(input.orderReference));
  const holder = (await listOrderMergedInto(tx, owner, [order])).get(order) ?? order;
  if (input.whenNeverRecorded !== true && (await loadBillTaxRounding(tx, owner, holder)) === null)
    return;
  // The same test as readDiningTableBill (which would not record either): anything paid, being
  // paid online, or written off. Said here first so a paid table's close never reads its bill.
  const payments = createPostgresDiningTableSettlementStore({
    scope,
    authorize: async (_tx, value) =>
      value.orderReference === holder && (await input.authorize()) === true,
  });
  if (
    (await payments.listByOrders(tx, [holder])).length > 0 ||
    (await payments.listOnlinePaymentsByOrders(tx, [holder])).some(onlinePaymentHoldsBill) ||
    (await payments.listWriteOffsByOrders(tx, [holder])).length > 0
  )
    return;
  const session = (await listOrderDiningSessions(tx, owner, [holder])).get(holder);
  if (session === undefined) return;
  await readDiningTableBill(tx, scope, {
    diningSessionReference: session,
    observedAt: input.observedAt,
    authorize: input.authorize,
    recordTaxRounding: { nextReference: input.nextReference },
  });
}

/**
 * v15 b12 (DEC-DINE-IN-SPLIT-BILL rule 7): a comp, a discount or a dish taken off before any part
 * was paid changes a split bill, so in the same transaction the split is worked out again the same
 * way over the bill as it now stands and recorded as the Order's next plan version (attributed to
 * the staff member who changed the bill, audit reason BILL_CHANGED; the old plan stays on record).
 * Guests and the Tables list then never see an outdated share. Nothing is recorded when nothing is
 * owed any more (there is nothing to split: the bill reads "nothing to pay"), when that split no
 * longer exists (a part would be left with nothing: staff split it again, and until then the bill
 * owes its whole amount and no part can be paid), when rounds wait for staff OK, or once anything
 * was paid, is being paid on a phone or was written off. Call after refreshBillTaxRounding.
 */
export async function splitAgainAfterBillChange(
  tx: ConsumerTransaction,
  scope: Scope,
  input: {
    readonly orderReference: string;
    readonly observedAt: string;
    authorize(): Promise<boolean>;
    nextReference(): string;
    readonly actorReference: string;
    readonly correlationReference: string;
  },
): Promise<"SplitAgain" | "Unchanged"> {
  const owner = { brandReference: scope.brandReference, storeReference: scope.storeReference };
  const order = String(parseOrderingReference(input.orderReference));
  const holder = (await listOrderMergedInto(tx, owner, [order])).get(order) ?? order;
  const payments = createPostgresDiningTableSettlementStore({
    scope,
    authorize: async (_tx, value) =>
      value.orderReference === holder && (await input.authorize()) === true,
  });
  const [plan] = await payments.listSplitPlans(tx, [holder]);
  if (plan === undefined || plan.mode === "Whole" || plan.mode === "ByGuests") return "Unchanged";
  if (
    (await payments.listByOrders(tx, [holder])).length > 0 ||
    (await payments.listOnlinePaymentsByOrders(tx, [holder])).some(onlinePaymentHoldsBill) ||
    (await payments.listWriteOffsByOrders(tx, [holder])).length > 0
  )
    return "Unchanged";
  const session = (await listOrderDiningSessions(tx, owner, [holder])).get(holder);
  if (session === undefined) return "Unchanged";
  const bill = await readDiningTableBill(tx, scope, {
    diningSessionReference: session,
    observedAt: input.observedAt,
    authorize: input.authorize,
  });
  if (
    bill.split?.stale !== true ||
    bill.orderReference === null ||
    bill.waitingRounds.length > 0 ||
    bill.splitRounds.length === 0
  )
    return "Unchanged";
  let split: ReturnType<typeof splitAgain>;
  try {
    split = splitAgain(plan, bill.splitRounds, bill.splitDishes);
  } catch (error) {
    if (error instanceof DiningTableSettlementError) return "Unchanged";
    throw error;
  }
  await payments.recordSplitPlan(tx, {
    splitPlanReference: input.nextReference(),
    operationReference: input.nextReference(),
    intentDigest:
      "sha256:" +
      createHash("sha256")
        .update(
          JSON.stringify(["BILL_CHANGED", input.correlationReference, plan.splitPlanReference]),
        )
        .digest("hex"),
    diningSessionReference: session,
    orderReference: bill.orderReference,
    split,
    roundOrders: roundOrdersOf(bill.rounds),
    recordedAt: input.observedAt,
    actorReference: input.actorReference,
    auditReference: input.nextReference(),
    correlationReference: input.correlationReference,
    reasonCode: "BILL_CHANGED",
  });
  return "SplitAgain";
}

/**
 * v15 b12 (DEC-DINE-IN-SPLIT-BILL rule 7): the table's split worked out again, the same way, over
 * the bill as it now stands — the same number of parts for "split evenly", the same rounds for
 * "each pays own rounds", the same dish choices for "by dish". Throws when that split no longer
 * exists (a part left with nothing to pay).
 */
function splitAgain(
  plan: DiningTableSplitPlanRecord,
  rounds: Parameters<typeof splitDiningTableBill>[0]["rounds"],
  dishes: readonly DiningTableSplitDish[],
) {
  return plan.mode === "Even"
    ? splitDiningTableBill({ mode: "Even", rounds, people: plan.parts.length })
    : plan.mode === "ByItems"
      ? splitDiningTableBill({
          mode: "ByItems",
          rounds,
          people: plan.parts.length,
          dishes,
          choices: plan.dishChoices,
        })
      : splitDiningTableBill({
          mode: "ByRounds",
          rounds,
          partOf: new Map(
            plan.parts.flatMap((part) =>
              part.slices.map((slice) => [slice.orderBatchReference, part.partNumber] as const),
            ),
          ),
        });
}

export const publicBill = (
  bill: Awaited<ReturnType<typeof readDiningTableBill>>,
): DiningTableBill => {
  const { settlementRecord, splitPlanRecord, splitDishes, dishAdders, splitRounds, ...rest } = bill;
  void settlementRecord;
  void splitPlanRecord;
  void splitDishes;
  void dishAdders;
  void splitRounds;
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
  /** The language dish names are shown in (the Orders page's default when not configured). */
  locale?: string;
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
            ).catch(onlyRefusal(() => fail("TABLE_CHECKOUT_PERMISSION_DENIED")));
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
                displayLocales: staffNameLocales(options.locale ?? "en-CA"),
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
      ...(value !== null && typeof value === "object" && Object.hasOwn(value, "owedMinor")
        ? ["owedMinor"]
        : []),
    ]);
    // WP-2423 item 8 ⑤: what the bill (or the part) came to when staff took the payment
    // (absent from an older page: not checked).
    const owedMinor =
      raw.owedMinor === undefined || raw.owedMinor === null
        ? null
        : typeof raw.owedMinor === "string" && /^(0|[1-9][0-9]{0,11})$/u.test(raw.owedMinor)
          ? raw.owedMinor
          : fail("TABLE_CHECKOUT_INPUT_INVALID");
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
      isTipPercent(tipRaw.percent)
    )
      tip = { kind: "Percent", percent: tipRaw.percent };
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
      owedMinor,
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
  /** The language dish names are shown in, as for the bill read. */
  locale?: string;
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
        ...(command.owedMinor === null ? {} : { owedMinor: command.owedMinor }),
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
              ).catch(onlyRefusal(() => fail("TABLE_CHECKOUT_PERMISSION_DENIED")));
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
                displayLocales: staffNameLocales(options.locale ?? "en-CA"),
              });
              return Object.freeze({ status: "AlreadyRecorded" as const, bill: publicBill(bill) });
            }
            // WP-2423 M160: the Store's reports and settlement begin when it started using the
            // system; a table paid at an earlier time (entered after an outage) would be in no
            // day. An outage is always after that, so such a time is a mistake: refuse it.
            if (command.takenAt !== null) {
              const opening = await readStoreFirstConfigurationGoverningFrom(tx, scope);
              // A Store with no published configuration has no business day yet; its readers
              // refuse until one exists, so there is nothing to compare with here.
              if (opening !== null && command.takenAt < opening)
                return fail("TABLE_CHECKOUT_TAKEN_BEFORE_RECORDS");
            }
            const bill = await readDiningTableBill(tx, scope, {
              diningSessionReference: command.diningSessionReference,
              observedAt,
              authorize: guard,
              // Before a payment is taken, the bill's tax rounding is recorded (system rule).
              recordTaxRounding: { nextReference: () => options.nextReference() },
            });
            if (bill.paymentTiming !== "PayLater") return fail("TABLE_CHECKOUT_NOT_PAY_LATER");
            if (bill.sessionPhase !== "Closing") return fail("TABLE_CHECKOUT_NOT_STARTED");
            // Paid, or written off when the guests left: never a (second) payment.
            if (bill.settlement !== null || bill.writeOff !== null)
              return fail("TABLE_CHECKOUT_ALREADY_PAID");
            // WP-2423 item 8 ⑤ D4: never a payment while a round of the bill waits for staff
            // (at the table or entered after an outage): it would be owed on a paid bill.
            if (bill.waitingRounds.length > 0) return fail("TABLE_CHECKOUT_ROUNDS_WAITING");
            // WP-2423 item 8 ④: a split bill is paid part by part; a whole bill at once.
            const part =
              bill.split === null || command.partNumber === null
                ? null
                : (bill.split.parts.find((entry) => entry.partNumber === command.partNumber) ??
                  null);
            // WP-2423 同桌结账: guests pay by dish; staff take "the rest" (no part named) at the
            // counter as the plan's next part.
            const takesRest = bill.split?.mode === "ByGuests" && command.partNumber === null;
            if (
              (!takesRest && (bill.split === null) !== (command.partNumber === null)) ||
              (bill.split !== null && !takesRest && part === null)
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
            let rest: ReturnType<typeof diningTableGuestPart> | null = null;
            if (takesRest) {
              const free = diningTableFreeUnits(bill, null);
              if (free.length === 0) return fail("TABLE_CHECKOUT_NOTHING_OWED");
              try {
                rest = diningTableGuestPart(bill, free);
              } catch {
                return fail("TABLE_CHECKOUT_BILL_CHANGED");
              }
            }
            // What staff were shown and charged on the card machine must still be the bill.
            if (
              command.owedMinor !== null &&
              command.owedMinor !==
                (rest !== null
                  ? rest.part.amountMinor.toString()
                  : part === null
                    ? bill.owed.totalMinor
                    : part.amountMinor)
            )
              return fail("TABLE_CHECKOUT_BILL_CHANGED");
            const planPart =
              rest !== null
                ? rest.part
                : part === null || bill.splitPlanRecord === null
                  ? null
                  : (bill.splitPlanRecord.parts.find(
                      (entry) => entry.partNumber === part.partNumber,
                    ) ?? fail("TABLE_CHECKOUT_BILL_CHANGED"));
            const sequenceOf = new Map(
              bill.rounds.map((round) => [round.orderBatchReference, round] as const),
            );
            // A table pays after it orders: a paper paid-at well before the last round this
            // payment covers was sent in the system (rounds taken on paper during the outage
            // aside) is a mistyped time. Refused before anything is recorded; the bill's tax
            // rounding written above is in this transaction and rolls back with the refusal.
            if (command.takenAt !== null) {
              const covered =
                planPart === null
                  ? owed
                  : planPart.slices.map((slice) => sequenceOf.get(slice.orderBatchReference));
              const lastLive = covered.reduce<number | null>((latest, round) => {
                const at = round?.liveOrderedAt ?? null;
                return at === null ? latest : Math.max(latest ?? 0, Date.parse(at));
              }, null);
              if (
                lastLive !== null &&
                Date.parse(command.takenAt) < lastLive - paidAtBeforeOrderedToleranceMs
              )
                return fail("TABLE_CHECKOUT_TAKEN_BEFORE_ORDERED");
            }
            // Only a tip the Store offers (for a payment taken during an outage: offered then).
            const refused = tipRefusal(
              await readStoreTipChoices(tx, scope, command.takenAt),
              command.tip,
            );
            if (refused === "TipsOff") return fail("TABLE_CHECKOUT_TIPS_OFF");
            if (refused === "TipChoicesChanged") return fail("TABLE_CHECKOUT_TIP_CHOICES_CHANGED");
            // A part's tip is on its own share of the bill before tax.
            const tipMinor = tableTipMinor(
              command.tip,
              planPart === null ? BigInt(bill.owed.subtotalMinor) : planPart.subtotalMinor,
            );
            if (rest !== null && bill.splitPlanRecord !== null)
              await store.appendGuestSplitPart(tx, {
                createPlan: null,
                splitPlanReference: bill.splitPlanRecord.splitPlanReference,
                operationReference: command.operationReference,
                intentDigest,
                diningSessionReference: command.diningSessionReference,
                orderReference: bill.orderReference,
                part: rest.part,
                units: rest.units,
                completesBill: rest.completesBill,
                choice: "Rest",
                actor: { type: "Staff", reference: String(authority.scope.actorReference) },
                roundOrders: roundOrdersOf(bill.rounds),
                recordedAt: observedAt,
                auditReference: options.nextReference(),
                correlationReference: command.operationReference,
              });
            await store.record(tx, {
              // WP-2423 item 8 ⑨: a merged table's rounds stay on their own Order.
              roundOrders: roundOrdersOf(bill.rounds),
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
              displayLocales: staffNameLocales(options.locale ?? "en-CA"),
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
      return keepingCause(() => fail("TABLE_CHECKOUT_UNAVAILABLE"))(error);
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
      ...(Object.hasOwn(value as object, "dishes") ? ["dishes"] : []),
    ]);
    const mode =
      raw.mode === "Whole" ||
      raw.mode === "Even" ||
      raw.mode === "ByRounds" ||
      raw.mode === "ByItems"
        ? raw.mode
        : null;
    if (mode === null) return fail("TABLE_CHECKOUT_INPUT_INVALID");
    const people =
      (mode === "Even" || mode === "ByItems") &&
      Number.isSafeInteger(raw.people) &&
      (raw.people as number) >= 2 &&
      (raw.people as number) <= 20
        ? (raw.people as number)
        : raw.people === null && mode !== "Even" && mode !== "ByItems"
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
    let dishes: { orderItemReference: string; unit: number; partNumber: number | null }[] | null =
      null;
    if (mode === "ByItems") {
      if (!Array.isArray(raw.dishes) || raw.dishes.length < 1 || raw.dishes.length > 1000)
        return fail("TABLE_CHECKOUT_INPUT_INVALID");
      dishes = raw.dishes.map((entry: unknown) => {
        const item = readClosedRecord(entry, ["orderItemReference", "unit", "partNumber"]);
        if (
          !Number.isSafeInteger(item.unit) ||
          (item.unit as number) < 1 ||
          (item.partNumber !== null &&
            (!Number.isSafeInteger(item.partNumber) ||
              (item.partNumber as number) < 1 ||
              (item.partNumber as number) > (people as number)))
        )
          return fail("TABLE_CHECKOUT_INPUT_INVALID");
        return {
          orderItemReference: String(parseDiningReference(item.orderItemReference)),
          unit: item.unit as number,
          partNumber: item.partNumber as number | null,
        };
      });
    } else if ((raw.dishes ?? null) !== null) return fail("TABLE_CHECKOUT_INPUT_INVALID");
    return Object.freeze({
      operationReference: String(parseDiningReference(raw.operationReference)),
      diningSessionReference: String(parseDiningReference(raw.diningSessionReference)),
      mode,
      people,
      rounds,
      dishes,
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
  /** The language dish names are shown in, as for the bill read. */
  locale?: string;
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
        ...(command.dishes === null ? {} : { dishes: command.dishes }),
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
              ).catch(onlyRefusal(() => fail("TABLE_CHECKOUT_PERMISSION_DENIED")));
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
            const read = (record = false) =>
              readDiningTableBill(tx, scope, {
                diningSessionReference: command.diningSessionReference,
                observedAt,
                authorize: guard,
                displayLocales: staffNameLocales(options.locale ?? "en-CA"),
                // A split plans what each part pays: the bill's tax rounding is recorded first.
                ...(record
                  ? { recordTaxRounding: { nextReference: () => options.nextReference() } }
                  : {}),
              });
            const bill = await read(true);
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
            // WP-2423 item 8 ⑤ D4: a split plans what is paid; decide the waiting rounds first.
            if (bill.waitingRounds.length > 0) return fail("TABLE_CHECKOUT_ROUNDS_WAITING");
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
                  : command.mode === "ByItems"
                    ? splitDiningTableBill({
                        mode: "ByItems",
                        rounds: splitRounds,
                        people: command.people as number,
                        dishes: bill.splitDishes,
                        choices: command.dishes ?? [],
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
              roundOrders: roundOrdersOf(bill.rounds),
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
      return keepingCause(() => fail("TABLE_CHECKOUT_UNAVAILABLE"))(error);
    }
  };
}
