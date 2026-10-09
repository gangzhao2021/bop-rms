import type { ConsumerTransaction } from "@bop/eventing";
import type { PaymentReconciliationWindow } from "@rms/payment";

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
export interface MerchantSettlementView {
  readonly screenId: "PAY-RECONCILIATION";
  readonly storeLabel: string;
  readonly businessDate: string;
  readonly window: Omit<MerchantSettlementWindow, "businessDate">;
  /** Null when the owner source could not answer; the page says so instead of showing zero. */
  readonly captured: MerchantSettlementAmount | null;
  readonly refunded: MerchantSettlementAmount | null;
  readonly reconciliation: Pick<PaymentReconciliationWindow, "runs" | "differences"> | null;
  readonly projectedAt: string;
}
const businessDatePattern = /^\d{4}-\d{2}-\d{2}$/u;
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
      readonly permission: "operations.order-exception.manage";
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
  ): Promise<Pick<PaymentReconciliationWindow, "runs" | "differences"> | null>;
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
      const permission = "operations.order-exception.manage" as const;
      const scope = await options.authorize(tx, { sessionCookie: input.sessionCookie, permission });
      if (!scope) return unavailable();
      const storeLabel = await options.storeLabel(tx, scope);
      if (typeof storeLabel !== "string" || !/^[^\p{Cc}\p{Cf}]{1,100}$/u.test(storeLabel))
        return unavailable();
      const window = await options.window(tx, scope, input.businessDate);
      if (
        !businessDatePattern.test(window.businessDate) ||
        (input.businessDate !== null && window.businessDate !== input.businessDate) ||
        window.startsAt >= window.endsAt ||
        (window.status !== "Closed" && window.status !== "Open")
      )
        return unavailable();
      const [captured, refunded, reconciliation] = await Promise.all([
        options.captured(tx, scope, window),
        options.refunded(tx, scope, window),
        options.reconciliation(tx, scope, window),
      ]);
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
        reconciliation:
          reconciliation === null
            ? null
            : Object.freeze({ runs: reconciliation.runs, differences: reconciliation.differences }),
        projectedAt: options.now(),
      });
    });
}
