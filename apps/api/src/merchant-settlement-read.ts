import type { ConsumerTransaction } from "@bop/eventing";
import type { PaymentReconciliationDay } from "@rms/payment";

export interface MerchantSettlementScope {
  readonly tenantReference: string;
  readonly brandReference: string;
  readonly storeReference: string;
  readonly sessionReference: string;
}
/** One Store business day as a UTC window; "Open" means the day has not ended yet. */
export interface MerchantSettlementWindow {
  readonly businessDate: string;
  readonly startsAt: string;
  readonly endsAt: string;
  readonly timeZone: string;
  readonly status: "Closed" | "Open";
}
export interface MerchantSettlementAmount {
  readonly count: number;
  readonly amountMinor: string;
  readonly currencyCode: "CAD";
}
/** The day's reconciliation facts without the window the view already carries. */
export type MerchantSettlementReconciliation = Pick<
  PaymentReconciliationDay,
  "settlement" | "operational" | "differences" | "differenceCount"
>;
/**
 * WP-2423 Q7 (DEC-COUNTER-PAYMENT-RECORD decision 3): payments and refunds on the Store's own card
 * machine in the day, apart from online (Provider) takings, to match the machine's batch total.
 */
export interface MerchantSettlementCardMachine {
  readonly taken: MerchantSettlementAmount;
  /** The tips within the takings. */
  readonly tipMinor: string;
  /** Payments entered afterwards from paper orders taken during an outage. */
  readonly recordedAfterOutageCount: number;
  readonly refunded: MerchantSettlementAmount;
}
/**
 * DEC-DINE-IN-PAY-LATER (cash): what the Store took in cash for tables in the day (rounding to 5
 * cents included), cash given back, the net it should have from us, and the rounding. The till
 * also holds cash from the Store's own register, so this is what our side expects, not a count.
 */
export interface MerchantSettlementCash {
  readonly received: MerchantSettlementAmount;
  readonly tipMinor: string;
  readonly roundingMinor: string;
  readonly refunded: MerchantSettlementAmount;
  readonly netMinor: string;
  /** Cash payments entered afterwards from paper during an outage. */
  readonly recordedAfterOutageCount: number;
}
export interface MerchantSettlementView {
  readonly screenId: "PAY-RECONCILIATION";
  readonly storeLabel: string;
  readonly businessDate: string;
  readonly window: Omit<MerchantSettlementWindow, "businessDate">;
  /** Null when the owner source could not answer; the page says so instead of showing zero. */
  readonly captured: MerchantSettlementAmount | null;
  readonly refunded: MerchantSettlementAmount | null;
  /** WP-2423 Q19: refunds an Owner approved for themself (sole operator) in the day, for review.
   * Null when the source could not answer or is not composed. */
  readonly selfApprovedRefunds: MerchantSettlementAmount | null;
  /** WP-2423 Q19: when a closed day is shown, the current (open) business day's self-approved
   * refunds so far, so the owner sees them without picking today. Null when not read. */
  readonly currentDaySelfApprovedRefunds:
    (MerchantSettlementAmount & { readonly businessDate: string }) | null;
  readonly reconciliation: MerchantSettlementReconciliation | null;
  /** Null when the source could not answer or is not composed. */
  readonly cardMachine: MerchantSettlementCardMachine | null;
  /** DEC-DINE-IN-PAY-LATER: tables paid in cash; null when not read. */
  readonly cash: MerchantSettlementCash | null;
  /**
   * WP-2423: charges the payment provider took in the day that match no Order, and refunds of such
   * charges in the day. The settlement statement counts both on the store's side; the Captured and
   * Refunded totals above (the store's own orders) do not. Null when not read.
   */
  readonly unmatchedProviderCharges: MerchantSettlementUnmatchedCharges | null;
  readonly projectedAt: string;
}
export interface MerchantSettlementUnmatchedCharges {
  readonly captured: MerchantSettlementAmount;
  readonly refunded: MerchantSettlementAmount;
}
const businessDatePattern = /^\d{4}-\d{2}-\d{2}$/u;
/**
 * WP-2423 (catalog v17, Owner "单独加权限（推荐）"): the day-end settlement read's own permission,
 * apart from handling payment and order exceptions.
 */
export const merchantSettlementReadPermission = "payment.settlement.read" as const;
/** WP-2423: the asked business day is before the Store's settlement records begin. */
export const merchantSettlementNotCovered = "MERCHANT_SETTLEMENT_NOT_COVERED" as const;
export class MerchantSettlementNotCoveredError extends Error {
  readonly code = merchantSettlementNotCovered;
  constructor(readonly firstBusinessDate: string) {
    super(merchantSettlementNotCovered);
    this.name = "MerchantSettlementNotCoveredError";
  }
}
const sameScope = (a: MerchantSettlementScope, b: MerchantSettlementScope) =>
  a.tenantReference === b.tenantReference &&
  a.brandReference === b.brandReference &&
  a.storeReference === b.storeReference &&
  a.sessionReference === b.sessionReference;

/**
 * WP-2423 P1 (PAY-RECONCILIATION): the day-end view for one Store business day — what was captured
 * and refunded in the day, and whether the daily settlement reconciliation matched the Provider.
 * Each owner source answers in the caller's transaction; scope is re-resolved before the reply.
 */
export function createMerchantSettlementRead(options: {
  readonly transactions: { run<T>(work: (tx: ConsumerTransaction) => Promise<T>): Promise<T> };
  authorize(
    tx: ConsumerTransaction,
    input: {
      readonly sessionCookie: unknown;
      readonly permission: typeof merchantSettlementReadPermission;
    },
  ): Promise<MerchantSettlementScope | null>;
  storeLabel(tx: ConsumerTransaction, scope: MerchantSettlementScope): Promise<string>;
  window(
    tx: ConsumerTransaction,
    scope: MerchantSettlementScope,
    businessDate: string | null,
  ): Promise<MerchantSettlementWindow>;
  captured(
    tx: ConsumerTransaction,
    scope: MerchantSettlementScope,
    window: MerchantSettlementWindow,
  ): Promise<MerchantSettlementAmount | null>;
  refunded(
    tx: ConsumerTransaction,
    scope: MerchantSettlementScope,
    window: MerchantSettlementWindow,
  ): Promise<MerchantSettlementAmount | null>;
  reconciliation(
    tx: ConsumerTransaction,
    scope: MerchantSettlementScope,
    window: MerchantSettlementWindow,
  ): Promise<MerchantSettlementReconciliation | null>;
  selfApprovedRefunds?(
    tx: ConsumerTransaction,
    scope: MerchantSettlementScope,
    window: MerchantSettlementWindow,
  ): Promise<MerchantSettlementAmount | null>;
  currentDaySelfApprovedRefunds?(
    tx: ConsumerTransaction,
    scope: MerchantSettlementScope,
  ): Promise<(MerchantSettlementAmount & { readonly businessDate: string }) | null>;
  cardMachine?(
    tx: ConsumerTransaction,
    scope: MerchantSettlementScope,
    window: MerchantSettlementWindow,
  ): Promise<MerchantSettlementCardMachine | null>;
  cash?(
    tx: ConsumerTransaction,
    scope: MerchantSettlementScope,
    window: MerchantSettlementWindow,
  ): Promise<MerchantSettlementCash | null>;
  unmatchedProviderCharges?(
    tx: ConsumerTransaction,
    scope: MerchantSettlementScope,
    window: MerchantSettlementWindow,
  ): Promise<MerchantSettlementUnmatchedCharges | null>;
  /**
   * WP-2423: the first business day the Store's settlement records cover (when it started using
   * the system); null when not known. An earlier day has no records to show, which is an answer,
   * not a refusal.
   */
  firstBusinessDate?(
    tx: ConsumerTransaction,
    scope: MerchantSettlementScope,
  ): Promise<string | null>;
  now(): string;
}) {
  return async (input: {
    readonly sessionCookie: unknown;
    readonly businessDate: string | null;
  }): Promise<MerchantSettlementView> =>
    options.transactions.run(async (tx) => {
      const unavailable = (): never => {
        throw Error("MERCHANT_SETTLEMENT_UNAVAILABLE");
      };
      if (input.businessDate !== null && !businessDatePattern.test(input.businessDate))
        return unavailable();
      const permission = merchantSettlementReadPermission;
      const scope = await options.authorize(tx, { sessionCookie: input.sessionCookie, permission });
      if (!scope) return unavailable();
      const storeLabel = await options.storeLabel(tx, scope);
      if (typeof storeLabel !== "string" || !/^[^\p{Cc}\p{Cf}]{1,100}$/u.test(storeLabel))
        return unavailable();
      if (input.businessDate !== null && options.firstBusinessDate !== undefined) {
        const first = await options.firstBusinessDate(tx, scope);
        if (first !== null && !businessDatePattern.test(first)) return unavailable();
        if (first !== null && input.businessDate < first) {
          const again = await options.authorize(tx, {
            sessionCookie: input.sessionCookie,
            permission,
          });
          if (!again || !sameScope(again, scope)) return unavailable();
          throw new MerchantSettlementNotCoveredError(first);
        }
      }
      const window = await options.window(tx, scope, input.businessDate);
      if (
        !businessDatePattern.test(window.businessDate) ||
        (input.businessDate !== null && window.businessDate !== input.businessDate) ||
        window.startsAt >= window.endsAt ||
        (window.status !== "Closed" && window.status !== "Open")
      )
        return unavailable();
      // One transaction, one read at a time: the owner sources check their authorization as they
      // go and their re-entrancy guards refuse interleaved authorization on a shared connection.
      const captured = await options.captured(tx, scope, window);
      const refunded = await options.refunded(tx, scope, window);
      const reconciliation = await options.reconciliation(tx, scope, window);
      const selfApprovedRefunds =
        options.selfApprovedRefunds === undefined
          ? null
          : await options.selfApprovedRefunds(tx, scope, window);
      const currentDaySelfApprovedRefunds =
        window.status === "Closed" && options.currentDaySelfApprovedRefunds !== undefined
          ? await options.currentDaySelfApprovedRefunds(tx, scope)
          : null;
      const cardMachine =
        options.cardMachine === undefined ? null : await options.cardMachine(tx, scope, window);
      const cash = options.cash === undefined ? null : await options.cash(tx, scope, window);
      const unmatchedProviderCharges =
        options.unmatchedProviderCharges === undefined
          ? null
          : await options.unmatchedProviderCharges(tx, scope, window);
      const again = await options.authorize(tx, { sessionCookie: input.sessionCookie, permission });
      if (!again || !sameScope(again, scope)) return unavailable();
      return Object.freeze({
        screenId: "PAY-RECONCILIATION",
        storeLabel,
        businessDate: window.businessDate,
        window: Object.freeze({
          startsAt: window.startsAt,
          endsAt: window.endsAt,
          timeZone: window.timeZone,
          status: window.status,
        }),
        captured,
        refunded,
        selfApprovedRefunds,
        currentDaySelfApprovedRefunds,
        reconciliation:
          reconciliation === null
            ? null
            : Object.freeze({
                settlement: reconciliation.settlement,
                operational: reconciliation.operational,
                differences: reconciliation.differences,
                differenceCount: reconciliation.differenceCount,
              }),
        cardMachine,
        cash,
        unmatchedProviderCharges,
        projectedAt: options.now(),
      });
    });
}
