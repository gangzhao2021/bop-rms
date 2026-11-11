import {
  createPostgresPaymentReconciliationExceptionDetailReader,
  createPostgresReconciliationFollowUpQuery,
  type PaymentReconciliationExceptionDetail,
} from "@rms/payment";
import { createMerchantBusinessDayWindows } from "./merchant-business-day-window.js";
import { listOrderTerminationCauses, listStoreOrderNumbers } from "@rms/ordering";
import type { ConsumerTransaction } from "@bop/eventing";
import {
  createPostgresOrderExceptionSourceStore,
  type OrderExceptionSource,
} from "@bop/projection";
import { createMerchantStoreScope } from "./merchant-store-scope.js";
import {
  withMerchantTransactionAuthorization,
  type MerchantTransactionAuthority,
} from "./merchant-transaction-authorization.js";
import {
  createMerchantOrderExceptionRead,
  type MerchantExceptionOrderCause,
  type MerchantExceptionReconciliationDetail,
  type MerchantExceptionScope,
} from "./merchant-order-exception-read.js";
import type { PersistentMerchantBffOptions } from "./persistent-merchant-bff.js";
type Metadata = Awaited<
  ReturnType<Parameters<typeof createMerchantOrderExceptionRead>[0]["metadata"]>
>;
export function createPersistentMerchantOrderExceptions(options: {
  persistence: PersistentMerchantBffOptions;
  metadata(
    tx: ConsumerTransaction,
    input: {
      scope: MerchantExceptionScope;
      storeLabel: string;
      sources: readonly OrderExceptionSource[];
    },
  ): Promise<Metadata>;
  /**
   * WP-2423: how the Store's scheduler names its settlement runs, so a business day's totals
   * difference names its day. `dayEndOf` reads the day end a scheduled run's reference carries
   * (null for any other run); the day is accepted only when that day's scheduled run or one of
   * its re-checks is exactly the run that found the difference.
   */
  settlementDays?: {
    dayEndOf(runReference: string): string | null;
    runReferences(
      scope: MerchantExceptionScope,
      window: { readonly businessDate: string; readonly startsAt: string; readonly endsAt: string },
    ): Promise<{ readonly original: string; readonly rechecks: readonly string[] }>;
  };
  /**
   * WP-2423 D3: an unexpected failure reading what a payment reconciliation difference is about
   * (the card then says its details could not be loaded), or (v15 M44, `read` "OrderCause") why a
   * case's Order ended (the case then keeps its kind as the title). Callers log code and frames
   * only, under a code for which read failed.
   */
  onUnexpected?(error: unknown, read?: "OrderCause"): void;
}) {
  const persistence = options.persistence,
    resolve = createMerchantStoreScope(persistence);
  return async (cookie: unknown, request: { readonly resolvedBefore?: string | null } = {}) => {
    const unavailable = (): never => {
      throw new Error("MERCHANT_ORDER_EXCEPTION_UNAVAILABLE");
    };
    const denied = (): never => {
      throw new Error("MERCHANT_ORDER_EXCEPTION_DENIED");
    };
    type Resolved = Awaited<ReturnType<typeof resolve>>;
    /** Each running transaction's authorized run (resolved in full at its start). */
    const runs = new Map<ConsumerTransaction, MerchantTransactionAuthority<Resolved>>();
    // The caller's Session, Store and permission are resolved in full at the start of the
    // transaction and once more before the reply; the owner reads in between only confirm they
    // run in that transaction for that scope (re-resolving it for each cost ~30 queries a read).
    const current = async (tx: ConsumerTransaction) => {
      const run = runs.get(tx);
      if (!run || !(await run.guard(tx))) return unavailable();
      return run.scope;
    };
    const scopeOf = (value: Resolved): MerchantExceptionScope =>
      Object.freeze({
        tenantReference: value.selected.tenantReference,
        brandReference: String(value.context.brand.brandReference),
        storeReference: String(value.store.storeReference),
        sessionReference: String(value.sessionReference),
      });
    const authorize = async (tx: ConsumerTransaction) => scopeOf(await current(tx));
    const matches = (a: MerchantExceptionScope, b: MerchantExceptionScope) =>
      a.tenantReference === b.tenantReference &&
      a.brandReference === b.brandReference &&
      a.storeReference === b.storeReference &&
      a.sessionReference === b.sessionReference;
    /** The owner's transaction, with each reply's rows checked before an owner read sees them. */
    const checked = (original: {
      query(sql: string, values: readonly unknown[]): Promise<unknown>;
    }) => {
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
      return tx;
    };
    /** This request's scope once its cases' transaction rechecked it in full before the reply. */
    let verified: MerchantExceptionScope | null = null;
    /** The verified Store's time zone (its business days name a totals difference's day). */
    let verifiedTimeZone: string | null = null;
    /** v15 batch 7 review: the short read-only transactions of this request's order-cause read. */
    const causeRuns = new WeakSet<ConsumerTransaction>();
    const causeTransactions = {
      run: <T>(work: (tx: ConsumerTransaction) => Promise<T>) =>
        persistence.transactions.run(async (original) => {
          if (verified === null) return unavailable();
          const tx = checked(original);
          causeRuns.add(tx);
          return work(tx);
        }),
    };
    const transactions = {
      run: <T>(work: (tx: ConsumerTransaction) => Promise<T>) =>
        persistence.transactions.run(async (original) => {
          const tx = checked(original);
          return withMerchantTransactionAuthorization(
            {
              transaction: tx,
              resolve: async () => {
                const value = await resolve(original, cookie, "operations.order-exception.manage");
                if (!(await value.allowed())) return denied();
                return value;
              },
              recheck: async (value) => {
                const again = await resolve(original, cookie, "operations.order-exception.manage");
                const ok =
                  matches(scopeOf(again), scopeOf(value)) && (await again.allowed()) === true;
                verified = ok ? scopeOf(value) : null;
                verifiedTimeZone = ok ? again.store.timeZone : null;
                return ok;
              },
              denied,
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
    return createMerchantOrderExceptionRead({
      transactions,
      causeTransactions,
      authorize,
      orderNumbers: async (tx, scope, orderReferences) => {
        if (!matches(await authorize(tx), scope)) return unavailable();
        const numbers = new Map<string, string>();
        for (let start = 0; start < orderReferences.length; start += 100)
          for (const [order, number] of await listStoreOrderNumbers(
            tx,
            scope,
            orderReferences.slice(start, start + 100),
          ))
            numbers.set(order, number);
        return numbers;
      },
      orderCauses: async (tx, scope, orderReferences) => {
        // In its own transaction after the cases (see causeTransactions), for the scope this
        // request's cases' transaction just rechecked in full; it only titles those cases.
        if (
          causeRuns.has(tx)
            ? verified === null || !matches(verified, scope)
            : !matches(await authorize(tx), scope)
        )
          return unavailable();
        const causes = new Map<string, MerchantExceptionOrderCause>();
        try {
          for (let start = 0; start < orderReferences.length; start += 100)
            for (const [order, cause] of await listOrderTerminationCauses(
              tx,
              scope,
              orderReferences.slice(start, start + 100),
            ))
              causes.set(order, cause);
        } catch (error) {
          // v15 M44: read in its own transaction (merchant-order-exception-read), so the cases
          // stay on the page with their kind as the title; the failure is reported, not hidden.
          options.onUnexpected?.(error, "OrderCause");
          throw error;
        }
        return causes;
      },
      sources: (scope) =>
        createPostgresOrderExceptionSourceStore({
          scope,
          authorize: async (tx, access) =>
            access === "Read" && matches(await authorize(tx as ConsumerTransaction), scope),
          validateSource: async () => false,
        }),
      reconciliationAssigned: async (tx, scope, source) => {
        const result = await createPostgresReconciliationFollowUpQuery({
          scope,
          authorize: async (t, query, purpose) =>
            t === tx &&
            purpose === "ReadPaymentReconciliationFollowUp" &&
            query.tenantReference === scope.tenantReference &&
            query.brandReference === scope.brandReference &&
            query.storeReference === scope.storeReference &&
            query.exceptionReference === source.sourceReference &&
            matches(await authorize(t), scope),
        })(tx, source.sourceReference);
        return result.assigned;
      },
      reconciliationDetailsFailed: (error) => options.onUnexpected?.(error),
      reconciliationDetails: async (detailTransactions, scope, sources) => {
        // WP-2423 (outage-reads-and-retry): in its own short read-only transactions after the
        // cases (see causeTransactions), for the scope the cases' transaction just rechecked in
        // full. A failed statement aborts its PostgreSQL transaction (25P02), so each retry below
        // gets a transaction of its own; in the cases' one it could never succeed.
        const timeZone = verifiedTimeZone;
        if (verified === null || !matches(verified, scope) || timeZone === null)
          return unavailable();
        const own = async (t: ConsumerTransaction) =>
          causeRuns.has(t) && verified !== null && matches(verified, scope);
        const result = new Map<string, MerchantExceptionReconciliationDetail>();
        const reader = createPostgresPaymentReconciliationExceptionDetailReader({
          scope,
          authorize: own,
        });
        const references = sources.map((source) => source.sourceReference);
        const ownRefusal = (error: unknown) =>
          error instanceof Error &&
          (error.message === "MERCHANT_ORDER_EXCEPTION_UNAVAILABLE" ||
            error.message === "MERCHANT_ORDER_EXCEPTION_DENIED");
        const read = (some: readonly string[]) => detailTransactions.run((tx) => reader(tx, some));
        let details: ReadonlyMap<string, PaymentReconciliationExceptionDetail>;
        try {
          details = await read(references);
        } catch (error) {
          if (ownRefusal(error)) throw error;
          options.onUnexpected?.(error);
          // WP-2423 D3: one unreadable difference must not hide every other card's detail, nor
          // show as the wrong kind of card: read each on its own and mark the unreadable ones.
          const each = new Map<string, PaymentReconciliationExceptionDetail>();
          for (const reference of references) {
            try {
              for (const [key, value] of await read([reference])) each.set(key, value);
            } catch (itemError) {
              if (ownRefusal(itemError)) throw itemError;
              options.onUnexpected?.(itemError);
              result.set(reference, Object.freeze({ type: "Unavailable" as const }));
            }
          }
          details = each;
        }
        const businessDateOf = async (runReference: string): Promise<string | null> => {
          const settlementDays = options.settlementDays;
          const endsAt = settlementDays?.dayEndOf(runReference) ?? null;
          if (!settlementDays || endsAt === null) return null;
          try {
            // Its own transaction too: a day that can't be read leaves the others readable.
            return await detailTransactions.run(async (tx) => {
              const days = createMerchantBusinessDayWindows({
                persistence,
                scope,
                timeZone,
                authorize: async (t) => t === tx && (await own(t)),
              });
              const lastInstant = new Date(Date.parse(endsAt) - 1).toISOString();
              const { businessDate } = await days.today(tx, lastInstant);
              const window = await days.window(tx, businessDate);
              if (window.status !== "Closed" || window.endsAt !== endsAt) return null;
              const runs = await settlementDays.runReferences(scope, window);
              return runs.original === runReference || runs.rechecks.includes(runReference)
                ? businessDate
                : null;
            });
          } catch (error) {
            if (ownRefusal(error)) throw error;
            return null;
          }
        };
        for (const [reference, detail] of details) {
          if (detail.kind === "Payment") {
            // WP-2423 (2026-10-17): a later check of the same payment can resolve it.
            result.set(
              reference,
              Object.freeze({
                type: "Payment" as const,
                resolvedAt: detail.resolution?.resolvedAt ?? null,
              }),
            );
            continue;
          }
          if (detail.kind !== "BusinessDayTotals") {
            result.set(reference, Object.freeze({ type: detail.kind }));
            continue;
          }
          const check = detail.openingCheck;
          if (check === null) continue; // Marked below: never shown as another kind of card.
          result.set(
            reference,
            Object.freeze({
              type: "BusinessDayTotals" as const,
              businessDate: await businessDateOf(check.runReference),
              captured: Object.freeze({
                storeMinor: check.internalCapturedMinor,
                providerMinor: check.providerCapturedMinor,
              }),
              refunded: Object.freeze({
                storeMinor: check.internalRefundedMinor,
                providerMinor: check.providerRefundedMinor,
              }),
              checkedAt: check.checkedAt,
              resolvedAt: detail.resolution?.resolvedAt ?? null,
            }),
          );
        }
        for (const reference of references)
          if (!result.has(reference)) {
            options.onUnexpected?.(new Error("PAYMENT_RECONCILIATION_DETAIL_MISSING"));
            result.set(reference, Object.freeze({ type: "Unavailable" as const }));
          }
        return result;
      },
      refundCheckDueAt: async (tx, scope, sources) => {
        if (!matches(await authorize(tx), scope)) return unavailable();
        const days = createMerchantBusinessDayWindows({
          persistence,
          scope,
          timeZone: (await current(tx)).store.timeZone,
          authorize: async (t) => t === tx && matches(await authorize(t), scope),
        });
        const ownRefusal = (error: unknown) =>
          error instanceof Error &&
          (error.message === "MERCHANT_ORDER_EXCEPTION_UNAVAILABLE" ||
            error.message === "MERCHANT_ORDER_EXCEPTION_DENIED");
        const due = new Map<string, string>();
        let today: Awaited<ReturnType<typeof days.dayOf>>;
        try {
          today = await days.dayOf(tx, persistence.now());
        } catch (error) {
          // The business day cannot be read: these cases keep the 15-minute due time.
          if (ownRefusal(error)) throw error;
          options.onUnexpected?.(error);
          return due;
        }
        for (const source of sources) {
          if (Date.parse(source.createdAt) >= Date.parse(today.startsAt)) {
            due.set(source.sourceReference, today.endsAt);
            continue;
          }
          // Opened on an earlier business day: due at that day's end. If that day can no longer be
          // read, today's start is the latest it could have ended (it is overdue either way).
          let endsAt = today.startsAt;
          try {
            endsAt = (await days.dayOf(tx, source.createdAt)).endsAt;
          } catch (error) {
            if (ownRefusal(error)) throw error;
            options.onUnexpected?.(error);
          }
          if (Date.parse(endsAt) > Date.parse(source.createdAt))
            due.set(source.sourceReference, endsAt);
        }
        return due;
      },
      metadata: async (tx, scope, sources) => {
        if (!matches(await authorize(tx), scope)) return unavailable();
        const value = await current(tx);
        return options.metadata(tx, { scope, storeLabel: value.store.displayName, sources });
      },
    })(cookie, request);
  };
}
