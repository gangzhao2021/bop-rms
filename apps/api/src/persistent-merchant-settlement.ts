import type { ConsumerTransaction } from "@bop/eventing";
import {
  createPostgresCardMachinePaymentStore,
  createPostgresConfirmedCompensationRefundSource,
  createPostgresOrdinaryRefundWindowSource,
  createPostgresPaymentCaptureWindowSource,
  createPostgresPaymentReconciliationDaySource,
  createPostgresSoleOperatorRefundSummaryReader,
  createPostgresUnmatchedCaptureRefundStore,
} from "@rms/payment";
import { createMerchantBusinessDayWindows } from "./merchant-business-day-window.js";
import { createMerchantStoreScope } from "./merchant-store-scope.js";
import {
  withMerchantTransactionAuthorization,
  type MerchantTransactionAuthority,
} from "./merchant-transaction-authorization.js";
import {
  createMerchantSettlementRead,
  type MerchantSettlementScope,
  type MerchantSettlementWindow,
} from "./merchant-settlement-read.js";
import type { PersistentMerchantBffOptions } from "./persistent-merchant-bff.js";

const unavailable = (): never => {
  throw new Error("MERCHANT_SETTLEMENT_UNAVAILABLE");
};
/** A retryable database conflict outlasted the read's own retries; the caller should retry later. */
export const merchantSettlementBusy = "MERCHANT_SETTLEMENT_BUSY" as const;
const conflicted = (error: unknown) =>
  (error as { code?: unknown } | null)?.code === "TENANT_DATABASE_TRANSACTION_CONFLICT";
const matches = (a: MerchantSettlementScope, b: MerchantSettlementScope) =>
  a.tenantReference === b.tenantReference &&
  a.brandReference === b.brandReference &&
  a.storeReference === b.storeReference &&
  a.sessionReference === b.sessionReference;

/**
 * WP-2423 P1: the day-end settlement read over the owner sources. The session's selected Store
 * is resolved in the same transaction as every read, under the exception-handling permission the
 * pilot gives Store Managers; Provider facts stay in Payment and only day totals leave.
 */
export function createPersistentMerchantSettlement(options: {
  persistence: PersistentMerchantBffOptions;
  /** The Provider account and environment whose captures and refunds this Store settles. */
  resolveConfiguration(
    tx: ConsumerTransaction,
    scope: MerchantSettlementScope,
  ): Promise<{ readonly providerAccountReference: string; readonly environment: "Test" | "Live" }>;
  /** The settlement run the Store's scheduler derives for a closed day; null when none applies. */
  settlementRunReference(
    scope: MerchantSettlementScope,
    window: MerchantSettlementWindow,
  ): Promise<string | null>;
  /**
   * WP-2423: the references the Store's scheduler derives for that closed day's re-checks, in
   * order; without it a day shows no re-check.
   */
  settlementRecheckRunReferences?(
    scope: MerchantSettlementScope,
    window: MerchantSettlementWindow,
  ): Promise<readonly string[]>;
  /** WP-2423: the first business day the Store's settlement records cover; null when unknown. */
  firstBusinessDate?(scope: MerchantSettlementScope): Promise<string | null>;
  /**
   * Waits before each rerun of a read that lost a lock wait (lock timeout, deadlock or
   * serialization failure). The read writes nothing, so rerunning it is safe.
   */
  retryDelaysMs?: readonly number[];
}) {
  const persistence = options.persistence,
    resolve = createMerchantStoreScope(persistence);
  return async (input: {
    readonly sessionCookie: unknown;
    readonly businessDate: string | null;
  }) => {
    const settlementScope = (value: Awaited<ReturnType<typeof resolve>>): MerchantSettlementScope =>
      Object.freeze({
        tenantReference: value.selected.tenantReference,
        brandReference: String(value.context.brand.brandReference),
        storeReference: String(value.store.storeReference),
        sessionReference: String(value.sessionReference),
      });
    interface Resolved {
      readonly settlement: MerchantSettlementScope;
      readonly store: { readonly displayName: string; readonly timeZone: string };
    }
    /** Each running transaction's authorized run (resolved in full at its start). */
    const runs = new Map<ConsumerTransaction, MerchantTransactionAuthority<Resolved>>();
    const storeOf = (tx: ConsumerTransaction) => (runs.get(tx) ?? unavailable()).scope.store;
    // The caller's Session, Store and permission are resolved in full at the start of the
    // transaction and once more before the reply (withMerchantTransactionAuthorization). In
    // between, the owner reads only confirm they run in that same transaction for that same scope:
    // re-resolving the scope inside every owner read (a Session, membership and permission-policy
    // read of ~30 queries each) cost ~750 queries for an open day and ~1,700 for a closed one.
    const guard = (scope: MerchantSettlementScope) => async (tx: ConsumerTransaction) => {
      const run = runs.get(tx);
      return run !== undefined && (await run.guard(tx)) && matches(run.scope.settlement, scope);
    };
    const authorize = async (tx: ConsumerTransaction): Promise<MerchantSettlementScope> => {
      const run = runs.get(tx);
      if (!run || !(await run.guard(tx))) return unavailable();
      return run.scope.settlement;
    };
    const transactions = {
      run: <T>(work: (tx: ConsumerTransaction) => Promise<T>) =>
        persistence.transactions.run(async (original) => {
          const tx: ConsumerTransaction = {
            async query<Row = Record<string, unknown>>(sql: string, values: readonly unknown[]) {
              const result = await original.query(sql, values);
              if (!result || typeof result !== "object") return unavailable();
              const rows = Object.getOwnPropertyDescriptor(result, "rows"),
                count = Object.getOwnPropertyDescriptor(result, "rowCount");
              if (
                !rows ||
                !("value" in rows) ||
                !Array.isArray(rows.value) ||
                !count ||
                !("value" in count) ||
                (count.value !== null && (!Number.isSafeInteger(count.value) || count.value < 0))
              )
                return unavailable();
              return { rows: rows.value as readonly Row[], rowCount: count.value as number | null };
            },
          };
          return withMerchantTransactionAuthorization(
            {
              transaction: tx,
              resolve: async (): Promise<Resolved> => {
                const value = await resolve(
                  original,
                  input.sessionCookie,
                  "operations.order-exception.manage",
                );
                if (!(await value.allowed())) return unavailable();
                return Object.freeze({
                  settlement: settlementScope(value),
                  store: Object.freeze({
                    displayName: value.store.displayName,
                    timeZone: value.store.timeZone,
                  }),
                });
              },
              recheck: async ({ settlement }) => {
                const again = await resolve(
                  original,
                  input.sessionCookie,
                  "operations.order-exception.manage",
                );
                return (
                  matches(settlementScope(again), settlement) && (await again.allowed()) === true
                );
              },
              denied: unavailable,
            },
            async (run) => {
              runs.set(tx, run);
              try {
                return await work(tx);
              } finally {
                runs.delete(tx);
              }
            },
          );
        }),
    };
    // WP-2423 Q14: the business-day window definition shared with the sales reports.
    const days = (tx: ConsumerTransaction, scope: MerchantSettlementScope) =>
      createMerchantBusinessDayWindows({
        persistence,
        scope,
        timeZone: storeOf(tx).timeZone,
        authorize: async (t) => guard(scope)(t),
      });
    /** Owner reads answer null when their source cannot; our own scope refusal still propagates. */
    const optional = async <T>(work: () => Promise<T>): Promise<T | null> => {
      try {
        return await work();
      } catch (error) {
        if (error instanceof Error && error.message === "MERCHANT_SETTLEMENT_UNAVAILABLE")
          throw error;
        return null;
      }
    };
    const read = createMerchantSettlementRead({
      transactions,
      authorize: async (tx) => authorize(tx),
      storeLabel: async (tx) => storeOf(tx).displayName,
      now: () => persistence.now(),
      ...(options.firstBusinessDate
        ? {
            firstBusinessDate: async (tx: ConsumerTransaction, scope: MerchantSettlementScope) => {
              await authorize(tx);
              return (await options.firstBusinessDate?.(scope)) ?? null;
            },
          }
        : {}),
      window: async (tx, scope, businessDate): Promise<MerchantSettlementWindow> =>
        days(tx, scope).window(tx, businessDate),
      captured: (tx, scope, window) =>
        optional(async () => {
          const configuration = await options.resolveConfiguration(tx, scope);
          const result = await createPostgresPaymentCaptureWindowSource({
            scope: {
              brandReference: scope.brandReference,
              storeReference: scope.storeReference,
              providerAccountReference: configuration.providerAccountReference,
              environment: configuration.environment,
            },
            authorize: async (t) => guard(scope)(t),
          })(tx, {
            startsAt: window.startsAt,
            endsAt: window.endsAt,
            observedAt: persistence.now(),
          });
          return {
            count: result.captureCount,
            amountMinor: result.capturedAmountMinor.toString(),
            currencyCode: "CAD" as const,
          };
        }),
      // Refunded in the day = ordinary refunds the Provider created in the window plus
      // compensation refunds it confirmed in it: the same two sources the settlement statement
      // compares, so the day's figure and the statement check agree.
      refunded: (tx, scope, window) =>
        optional(async () => {
          const configuration = await options.resolveConfiguration(tx, scope);
          const observedAt = persistence.now();
          const providerScope = {
            brandReference: scope.brandReference,
            storeReference: scope.storeReference,
            providerAccountReference: configuration.providerAccountReference,
            environment: configuration.environment,
          };
          const ordinary = await createPostgresOrdinaryRefundWindowSource({
            scope: { tenantReference: scope.tenantReference, ...providerScope },
            authorize: async (t) => guard(scope)(t),
          })(tx, { startsAt: window.startsAt, endsAt: window.endsAt, observedAt });
          const compensation = createPostgresConfirmedCompensationRefundSource({
            scope: providerScope,
            authorize: async (t) => guard(scope)(t),
          });
          let count = ordinary.refundCount,
            amountMinor = ordinary.refundedAmountMinor,
            afterRefundReference: string | null = null,
            pages = 0;
          do {
            if (++pages > 100) return unavailable();
            const page = await compensation(tx, { observedAt, afterRefundReference, limit: 100 });
            for (const record of page.records) {
              const fact = record.receipt.fact;
              if (
                fact.providerConfirmedAt >= window.startsAt &&
                fact.providerConfirmedAt < window.endsAt
              ) {
                count += 1;
                amountMinor += fact.amount.amountMinor;
              }
            }
            afterRefundReference = page.nextAfterRefundReference;
          } while (afterRefundReference !== null);
          return { count, amountMinor: amountMinor.toString(), currencyCode: "CAD" as const };
        }),
      // WP-2423 Q19: the current business day so far, shown beside a closed day.
      currentDaySelfApprovedRefunds: (tx, scope) =>
        optional(async () => {
          const now = persistence.now();
          const today = await days(tx, scope).today(tx, now);
          const startsAt = today.startsAt;
          if (startsAt >= now) return null;
          const summary = await createPostgresSoleOperatorRefundSummaryReader({
            scope: {
              tenantReference: scope.tenantReference,
              brandReference: scope.brandReference,
              storeReference: scope.storeReference,
            },
            authorize: async (t) => guard(scope)(t),
          })(tx, { startsAt, endsAt: now });
          return {
            businessDate: today.businessDate,
            count: summary.count,
            amountMinor: summary.amountMinor.toString(),
            currencyCode: summary.currencyCode,
          };
        }),
      // WP-2423 Q19: the Owner's self-approved refunds in the day (sole operator), for review.
      selfApprovedRefunds: (tx, scope, window) =>
        optional(async () => {
          const summary = await createPostgresSoleOperatorRefundSummaryReader({
            scope: {
              tenantReference: scope.tenantReference,
              brandReference: scope.brandReference,
              storeReference: scope.storeReference,
            },
            authorize: async (t) => guard(scope)(t),
          })(tx, { startsAt: window.startsAt, endsAt: window.endsAt });
          return {
            count: summary.count,
            amountMinor: summary.amountMinor.toString(),
            currencyCode: summary.currencyCode,
          };
        }),
      // WP-2423 Q7: the Store's own card machine, apart from online takings, by when the money moved.
      cardMachine: (tx, scope, window) =>
        optional(async () => {
          const summary = await createPostgresCardMachinePaymentStore({
            scope: {
              tenantReference: scope.tenantReference,
              brandReference: scope.brandReference,
              storeReference: scope.storeReference,
            },
            authorize: async (t) => t === tx && (await guard(scope)(tx)),
          }).summarize(tx, { from: window.startsAt, to: window.endsAt });
          return {
            taken: {
              count: summary.paymentCount,
              amountMinor: summary.takenMinor.toString(),
              currencyCode: "CAD" as const,
            },
            tipMinor: summary.tipMinor.toString(),
            recordedAfterOutageCount: summary.backEnteredCount,
            refunded: {
              count: summary.refundCount,
              amountMinor: summary.refundedMinor.toString(),
              currencyCode: "CAD" as const,
            },
          };
        }),
      // WP-2423: Provider charges matching no Order, and their refunds, in the day — the lines the
      // settlement statement counts on the store's side beyond the store's own orders.
      unmatchedProviderCharges: (tx, scope, window) =>
        optional(async () => {
          const configuration = await options.resolveConfiguration(tx, scope);
          const store = createPostgresUnmatchedCaptureRefundStore({
            brandReference: scope.brandReference,
            storeReference: scope.storeReference,
            authorize: async (t, access) => access === "Read" && (await guard(scope)(t)),
          });
          const inDay = (at: string) => at >= window.startsAt && at < window.endsAt;
          let captured = 0n,
            capturedCount = 0,
            refunded = 0n,
            refundedCount = 0,
            afterExceptionReference: string | null = null,
            pages = 0;
          do {
            if (++pages > 100) return unavailable();
            const page = await store.list(tx, { afterExceptionReference, limit: 100 });
            for (const state of page.states) {
              if (
                state.environment !== configuration.environment ||
                state.providerAccountReference !== configuration.providerAccountReference
              )
                continue;
              if (inDay(state.capturedAt)) {
                capturedCount += 1;
                captured += BigInt(state.amountMinor);
              }
              if (state.outcome !== null && inDay(state.outcome.providerObservedAt)) {
                refundedCount += 1;
                refunded += BigInt(state.amountMinor);
              }
            }
            afterExceptionReference = page.nextAfterExceptionReference;
          } while (afterExceptionReference !== null);
          return {
            captured: {
              count: capturedCount,
              amountMinor: captured.toString(),
              currencyCode: "CAD" as const,
            },
            refunded: {
              count: refundedCount,
              amountMinor: refunded.toString(),
              currencyCode: "CAD" as const,
            },
          };
        }),
      reconciliation: (tx, scope, window) =>
        optional(async () => {
          const settlementRunReference =
            window.status === "Closed" ? await options.settlementRunReference(scope, window) : null;
          const recheckRunReferences =
            settlementRunReference !== null && options.settlementRecheckRunReferences
              ? await options.settlementRecheckRunReferences(scope, window)
              : [];
          const day = await createPostgresPaymentReconciliationDaySource({
            scope: { brandReference: scope.brandReference, storeReference: scope.storeReference },
            authorize: async (t) => guard(scope)(t),
          })(tx, {
            startsAt: window.startsAt,
            endsAt: window.endsAt,
            settlementRunReference,
            recheckRunReferences,
          });
          return {
            settlement: day.settlement,
            operational: day.operational,
            differences: day.differences,
            differenceCount: day.differenceCount,
          };
        }),
    });
    // A Store's records are shared with live ordering and payment work; a read that waited too
    // long for one of them is rerun a few times before staff are told to try again shortly.
    const delays = options.retryDelaysMs ?? [250, 1000, 2500];
    for (let attempt = 0; ; attempt++) {
      try {
        return await read(input);
      } catch (error) {
        if (!conflicted(error)) throw error;
        const delay = delays[attempt];
        if (delay === undefined) {
          const busy = new Error(merchantSettlementBusy);
          Object.assign(busy, { code: merchantSettlementBusy });
          throw busy;
        }
        await new Promise((resolve) => setTimeout(resolve, delay));
      }
    }
  };
}
