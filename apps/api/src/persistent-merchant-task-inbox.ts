import { createPostgresTaskQueueReader, parseTaskReference, parseTaskInstant } from "@bop/task";
import type { ConsumerTransaction } from "@bop/eventing";
import { createMerchantStoreScope } from "./merchant-store-scope.js";
import { createMerchantTaskInboxRead } from "./merchant-task-inbox-read.js";
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
  authorizeSource(
    ...args: [...Parameters<ReadOptions["authorizeSource"]>, cookie: unknown]
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
    // Request-local authority cannot be replaced by another concurrent request.
    let current: Awaited<ReturnType<typeof resolve>> | null = null;
    let selectedQueue: (typeof queues)[number] | null = null;
    const authorize: ReadOptions["authorize"] = async (tx) => {
      const at = parseTaskInstant(source.now());
      current ??= await resolve(tx, cookie, "workflow.operate");
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
      selectedQueue = queue;
      const claim = await current.authorizeAction("task.claim");
      return Object.freeze({
        tenantReference: queue.tenantReference,
        brandReference: queue.brandReference,
        storeReference: queue.storeReference,
        actorReference: current.actorReference,
        queueReference: queue.queueReference,
        storeLabel: current.store.displayName,
        canClaim: claim?.effect === "Allow",
      });
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
            return work(transaction);
          }),
      },
      authorize,
      queue: (tx, authority) => {
        const queue = selectedQueue;
        if (!queue || queue.queueReference !== authority.queueReference) return fail();
        return createPostgresTaskQueueReader({
          scope: {
            kind: "Store",
            brandReference: queue.brandReference,
            storeReference: queue.storeReference,
          },
          authorizeAndFence: async (transaction, query) => {
            if (transaction !== tx || query.queueReference !== queue.queueReference) return false;
            const fresh = await authorize(tx, cookie);
            return JSON.stringify(fresh) === JSON.stringify(authority);
          },
        });
      },
      authorizeSource: (tx, scope, task) => authorizeSource(tx, scope, task, cookie),
    })(cookie, input);
  };
}
