import { ReconciliationFollowUpError } from "@rms/payment";
import type { ConsumerTransaction } from "@bop/eventing";
import { createMerchantStoreScope } from "./merchant-store-scope.js";
import { withMerchantTransactionAuthorization } from "./merchant-transaction-authorization.js";
import type { PersistentMerchantBffOptions } from "./persistent-merchant-bff.js";
const denied = (): never => {
  throw new ReconciliationFollowUpError("RECONCILIATION_FOLLOW_UP_PERMISSION_DENIED");
};
/** Current-session and selected Store fence for Payment exception personnel actions. */
export async function createMerchantReconciliationFollowUpTransactions(options: {
  persistence: PersistentMerchantBffOptions;
  sessionCookie: unknown;
  sessionReference: string;
  exceptionReference: string;
  verifyAssignee(
    tx: ConsumerTransaction,
    input: {
      tenantReference: string;
      brandReference: string;
      storeReference: string;
      actorReference: string;
      assigneeReference: string;
    },
  ): Promise<boolean>;
}) {
  const resolveScope = createMerchantStoreScope(options.persistence);
  const bound = await options.persistence.transactions.run(async (tx) => {
    const current = await resolveScope(
      tx,
      options.sessionCookie,
      "operations.order-exception.manage",
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
    command: {
      tenantReference: string;
      brandReference: string;
      storeReference: string;
      exceptionReference: string;
      actorReference: string;
      action: "Acknowledge" | "Assign";
      assigneeReference: string | null;
    },
    purpose: string,
  ) => {
    if (
      purpose !== "OperatePaymentReconciliation" ||
      command.tenantReference !== bound.scope.tenantReference ||
      command.brandReference !== bound.scope.brandReference ||
      command.storeReference !== bound.scope.storeReference ||
      command.exceptionReference !== options.exceptionReference ||
      command.actorReference !== bound.actorReference
    )
      return false;
    const authority = await resolveAuthority(tx);
    if (command.action === "Assign") {
      if (
        command.assigneeReference === null ||
        (await options.verifyAssignee(tx, {
          ...bound.scope,
          actorReference: bound.actorReference,
          assigneeReference: command.assigneeReference,
        })) !== true
      )
        return false;
    } else if (command.action !== "Acknowledge" || command.assigneeReference !== null) return false;
    return authority.authorize();
  };

  const transactions: { run<T>(work: (tx: ConsumerTransaction) => Promise<T>): Promise<T> } = {
    run: (work) =>
      options.persistence.transactions.run((original) => {
        const tx: ConsumerTransaction = {
          async query<Row = Record<string, unknown>>(sql: string, values: readonly unknown[]) {
            const result = await original.query(sql, values);
            if (!result || typeof result !== "object")
              throw new Error("RECONCILIATION_FOLLOW_UP_UNAVAILABLE");
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
              throw new Error("RECONCILIATION_FOLLOW_UP_UNAVAILABLE");
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
                "operations.order-exception.manage",
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
