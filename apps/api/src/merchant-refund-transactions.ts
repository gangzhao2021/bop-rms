import type { ConsumerTransaction } from "@bop/eventing";
import { createMerchantStoreScope } from "./merchant-store-scope.js";
import { withMerchantTransactionAuthorization } from "./merchant-transaction-authorization.js";
import type { PersistentMerchantBffOptions } from "./persistent-merchant-bff.js";
const denied = (): never => {
  throw new Error("ORDINARY_REFUND_SEND_DENIED");
};
/** Shared current-session fence for merchant refund send and reconciliation. */
export async function createMerchantRefundTransactions(options: {
  persistence: PersistentMerchantBffOptions;
  sessionCookie: unknown;
  sessionReference: string;
  orderReference: string;
  requestReference?: string;
  permission?: "payment.refund.execute" | "operations.order-exception.manage";
}) {
  const resolveScope = createMerchantStoreScope(options.persistence);
  const bound = await options.persistence.transactions.run(async (tx) => {
    const current = await resolveScope(
      tx,
      options.sessionCookie,
      options.permission ?? "payment.refund.execute",
      options.sessionReference,
    );
    if (!(await current.allowed())) return denied();
    return {
      scope: {
        tenantReference: current.selected.tenantReference,
        brandReference: String(current.context.brand.brandReference),
        storeReference: String(current.store.storeReference),
      },
      actorReference: String(current.actorReference),
    };
  });
  type Current = Awaited<ReturnType<typeof resolveScope>>;
  /**
   * WP-2423: each run resolves the caller in full once at its start (against the bound scope) and
   * once more before its commit, inside the run's transaction, so a withdrawn permission or ended
   * Session never commits. Owner callbacks during the run (taken while rows are locked) read this
   * run's no-query guard instead of re-resolving the caller.
   */
  const active = new Map<
    ConsumerTransaction,
    { readonly context: Current["context"]; guard(): Promise<boolean> }
  >();
  const resolveAuthority = async (tx: ConsumerTransaction) => {
    const run = active.get(tx);
    if (!run) return denied();
    return { context: run.context, authorize: () => run.guard() };
  };
  const authorize = async (
    tx: ConsumerTransaction,
    query: {
      tenantReference: string;
      brandReference: string;
      storeReference: string;
      orderReference: string;
      requestReference?: string;
    },
  ) => {
    if (
      query.tenantReference !== bound.scope.tenantReference ||
      query.brandReference !== bound.scope.brandReference ||
      query.storeReference !== bound.scope.storeReference ||
      query.orderReference !== options.orderReference ||
      (options.requestReference !== undefined &&
        query.requestReference !== undefined &&
        query.requestReference !== options.requestReference)
    )
      return false;
    return (await resolveAuthority(tx)).authorize();
  };

  const transactions: { run<T>(work: (tx: ConsumerTransaction) => Promise<T>): Promise<T> } = {
    run: (work) =>
      options.persistence.transactions.run((original) => {
        const tx: ConsumerTransaction = {
          async query<Row = Record<string, unknown>>(sql: string, values: readonly unknown[]) {
            const result = await original.query(sql, values);
            if (!result || typeof result !== "object") return denied();
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
              return denied();
            return {
              rows: rows.value as readonly Row[],
              rowCount: count.value as number | null,
            };
          },
        };
        return withMerchantTransactionAuthorization(
          {
            transaction: tx,
            resolve: async () => {
              const current = await resolveScope(
                original,
                options.sessionCookie,
                options.permission ?? "payment.refund.execute",
                options.sessionReference,
              );
              if (
                current.selected.tenantReference !== bound.scope.tenantReference ||
                String(current.context.brand.brandReference) !== bound.scope.brandReference ||
                String(current.store.storeReference) !== bound.scope.storeReference ||
                String(current.actorReference) !== bound.actorReference ||
                (await current.allowed()) !== true
              )
                return denied();
              return current;
            },
            recheck: async (current) => (await current.allowed()) === true,
            denied,
          },
          async (authority) => {
            active.set(tx, {
              context: authority.scope.context,
              guard: () => authority.guard(tx),
            });
            try {
              return await work(tx);
            } finally {
              active.delete(tx);
            }
          },
        );
      }),
  };
  return { ...bound, resolveAuthority, authorize, transactions };
}
