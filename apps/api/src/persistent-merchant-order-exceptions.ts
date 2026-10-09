import { createPostgresReconciliationFollowUpQuery } from "@rms/payment";
import { listStoreOrderNumbers } from "@rms/ordering";
import type { ConsumerTransaction } from "@bop/eventing";
import {
  createPostgresOrderExceptionSourceStore,
  type OrderExceptionSource,
} from "@bop/projection";
import { createMerchantStoreScope } from "./merchant-store-scope.js";
import {
  createMerchantOrderExceptionRead,
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
}) {
  const persistence = options.persistence,
    resolve = createMerchantStoreScope(persistence);
  return async (cookie: unknown) => {
    type Original = Parameters<Parameters<typeof persistence.transactions.run>[0]>[0];
    const originals = new Map<ConsumerTransaction, Original>();
    const unavailable = (): never => {
      throw new Error("MERCHANT_ORDER_EXCEPTION_UNAVAILABLE");
    };
    const current = async (tx: ConsumerTransaction) => {
      const original = originals.get(tx);
      if (!original) return unavailable();
      const value = await resolve(original, cookie, "operations.order-exception.manage");
      if (!(await value.allowed())) return unavailable();
      return value;
    };
    const authorize = async (tx: ConsumerTransaction) => {
      const value = await current(tx);
      return Object.freeze({
        tenantReference: value.selected.tenantReference,
        brandReference: String(value.context.brand.brandReference),
        storeReference: String(value.store.storeReference),
        sessionReference: String(value.sessionReference),
      });
    };
    const matches = (a: MerchantExceptionScope, b: MerchantExceptionScope) =>
      a.tenantReference === b.tenantReference &&
      a.brandReference === b.brandReference &&
      a.storeReference === b.storeReference &&
      a.sessionReference === b.sessionReference;
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
          originals.set(tx, original);
          try {
            return await work(tx);
          } finally {
            originals.delete(tx);
          }
        }),
    };
    return createMerchantOrderExceptionRead({
      transactions,
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
      metadata: async (tx, scope, sources) => {
        if (!matches(await authorize(tx), scope)) return unavailable();
        const value = await current(tx);
        return options.metadata(tx, { scope, storeLabel: value.store.displayName, sources });
      },
    })(cookie);
  };
}
