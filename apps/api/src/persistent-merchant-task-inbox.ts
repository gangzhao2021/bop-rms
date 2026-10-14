import { createPostgresTaskQueueReader, parseTaskReference, parseTaskInstant } from "@bop/task";
import type { ConsumerTransaction } from "@bop/eventing";
import { createMerchantStoreScope } from "./merchant-store-scope.js";
import {
  createMerchantTaskInboxRead,
  type MerchantTaskInboxAuthority,
} from "./merchant-task-inbox-read.js";
import {
  withMerchantTransactionAuthorization,
  type MerchantTransactionAuthority,
} from "./merchant-transaction-authorization.js";
import type { PersistentMerchantBffOptions } from "./persistent-merchant-bff.js";

type ReadOptions = Parameters<typeof createMerchantTaskInboxRead>[0];
export interface PersistentMerchantTaskInboxQueueConfiguration {
  tenantReference: string;
  brandReference: string;
  storeReference: string;
  queueReference: string;
  effectiveFrom: string;
  effectiveUntil: string;
}
const fail = (): never => {
  throw new Error("MERCHANT_TASK_INBOX_UNAVAILABLE");
};
/** Server-owned queue configuration only. The source callback must use public owner
 * contracts and retain current source permission fences in the supplied transaction.
 * task.claim here is an affordance, never Queue eligibility or write authorization. */
export function createPersistentMerchantTaskInbox(options: {
  persistence: PersistentMerchantBffOptions;
  queues: readonly PersistentMerchantTaskInboxQueueConfiguration[];
  /**
   * A Task's source check; `run` is this read's authorized transaction: a permission the source
   * resolves in full is resolved once per transaction and re-checked before the reply.
   */
  authorizeSource(
    ...args: [
      ...Parameters<ReadOptions["authorizeSource"]>,
      cookie: unknown,
      run: MerchantTransactionAuthority<unknown>,
    ]
  ): Promise<boolean>;
}) {
  const queues = options.queues.map((q) =>
    Object.freeze({
      tenantReference: parseTaskReference(q.tenantReference),
      brandReference: parseTaskReference(q.brandReference),
      storeReference: parseTaskReference(q.storeReference),
      queueReference: parseTaskReference(q.queueReference),
      effectiveFrom: parseTaskInstant(q.effectiveFrom),
      effectiveUntil: parseTaskInstant(q.effectiveUntil),
    }),
  );
  const queueByScope = new Map(
    queues.map((queue) => [
      `${queue.tenantReference}:${queue.brandReference}:${queue.storeReference}`,
      queue,
    ]),
  );
  if (
    queues.length === 0 ||
    queueByScope.size !== queues.length ||
    queues.some((queue) => queue.effectiveFrom >= queue.effectiveUntil) ||
    typeof options.authorizeSource !== "function"
  )
    return fail();
  const source = options.persistence,
    resolve = createMerchantStoreScope(source),
    authorizeSource = options.authorizeSource;
  return async (
    cookie: unknown,
    input: Parameters<ReturnType<typeof createMerchantTaskInboxRead>>[1],
  ) => {
    type Authority = MerchantTransactionAuthority<{
      readonly authority: MerchantTaskInboxAuthority;
      readonly queue: (typeof queues)[number];
      recheck(): Promise<boolean>;
    }>;
    // Request-local authority cannot be replaced by another concurrent request.
    const runs = new Map<ConsumerTransaction, Authority>();
    /** The caller's Session, Store, workflow.operate and task.claim, resolved in full. */
    const resolveInbox = async (tx: ConsumerTransaction) => {
      const at = parseTaskInstant(source.now());
      const current = await resolve(tx, cookie, "workflow.operate");
      const queue = queueByScope.get(
        `${current.selected.tenantReference}:${current.context.brand.brandReference}:${current.store.storeReference}`,
      );
      if (
        !queue ||
        at < queue.effectiveFrom ||
        at >= queue.effectiveUntil ||
        (await current.allowed()) !== true
      )
        return fail();
      const claim = await current.authorizeAction("task.claim");
      const authority: MerchantTaskInboxAuthority = Object.freeze({
        tenantReference: queue.tenantReference,
        brandReference: queue.brandReference,
        storeReference: queue.storeReference,
        actorReference: current.actorReference,
        queueReference: queue.queueReference,
        storeLabel: current.store.displayName,
        canClaim: claim?.effect === "Allow",
      });
      const recheck = async () => {
        const later = parseTaskInstant(source.now());
        if (
          later < queue.effectiveFrom ||
          later >= queue.effectiveUntil ||
          (await current.allowed()) !== true
        )
          return false;
        const again = await current.authorizeAction("task.claim");
        return (again?.effect === "Allow") === authority.canClaim;
      };
      return Object.freeze({ authority, queue, recheck });
    };
    // The caller's scope is resolved in full at the start of the transaction and once more before
    // the reply; the Task queue and source reads in between only confirm they run in this
    // authorized transaction (re-resolving it for each Task cost ~100 queries per Task).
    const authorize: ReadOptions["authorize"] = async (tx) => {
      const run = runs.get(tx);
      if (!run || !(await run.guard(tx))) return fail();
      return run.scope.authority;
    };
    return createMerchantTaskInboxRead({
      now: source.now,
      transactions: {
        run: (work) =>
          source.transactions.run(async (tx) => {
            const transaction: ConsumerTransaction = {
              async query<Row = Record<string, unknown>>(sql: string, values: readonly unknown[]) {
                const result = await tx.query(sql, values);
                if (!result || typeof result !== "object") return fail();
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
                  return fail();
                return {
                  rows: rows.value as readonly Row[],
                  rowCount: count.value as number | null,
                };
              },
            };
            return withMerchantTransactionAuthorization(
              {
                transaction,
                resolve: () => resolveInbox(transaction),
                recheck: (resolved) => resolved.recheck(),
                denied: fail,
              },
              async (run) => {
                runs.set(transaction, run);
                try {
                  return await work(transaction);
                } finally {
                  runs.delete(transaction);
                }
              },
            );
          }),
      },
      authorize,
      queue: (tx, authority) => {
        const run = runs.get(tx);
        const queue = run?.scope.queue;
        if (!run || !queue || queue.queueReference !== authority.queueReference) return fail();
        return createPostgresTaskQueueReader({
          scope: {
            kind: "Store",
            brandReference: queue.brandReference,
            storeReference: queue.storeReference,
          },
          authorizeAndFence: async (transaction, query) =>
            transaction === tx &&
            query.queueReference === queue.queueReference &&
            (await run.guard(transaction)),
        });
      },
      authorizeSource: (tx, scope, task) => {
        const run = runs.get(tx);
        if (!run) return fail();
        return authorizeSource(tx, scope, task, cookie, run);
      },
    })(cookie, input);
  };
}
