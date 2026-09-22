import type { ConsumerTransaction } from "@bop/eventing";
import { createMerchantStoreScope } from "./merchant-store-scope.js";
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
  const active = new Map<ConsumerTransaction, Parameters<typeof resolveScope>[0]>();
  const resolveAuthority = async (tx: ConsumerTransaction) => {
    const original = active.get(tx);
    if (!original) return denied();
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
      !(await current.allowed())
    )
      return denied();
    return {
      context: current.context,
      authorize: async () => active.has(tx) && (await current.allowed()),
    };
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
      options.persistence.transactions.run(async (original) => {
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
        active.set(tx, original);
        try {
          await resolveAuthority(tx);
          const result = await work(tx);
          await resolveAuthority(tx);
          return result;
        } finally {
          active.delete(tx);
        }
      }),
  };
  return { ...bound, resolveAuthority, authorize, transactions };
}
