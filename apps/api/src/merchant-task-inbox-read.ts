import {
  createTaskRecord,
  parseTaskReference,
  parseTaskInstant,
  type TaskRecord,
  type createPostgresTaskQueueReader,
} from "@bop/task";
import type { ConsumerTransaction } from "@bop/eventing";
export interface MerchantTaskInboxAuthority {
  readonly tenantReference: string;
  readonly brandReference: string;
  readonly storeReference: string;
  readonly actorReference: string;
  readonly queueReference: string;
  readonly storeLabel: string;
  readonly canClaim: boolean;
}
const fail = (): never => {
  throw new Error("MERCHANT_TASK_INBOX_UNAVAILABLE");
};
function authority(value: MerchantTaskInboxAuthority | null) {
  if (
    value === null ||
    typeof value.canClaim !== "boolean" ||
    typeof value.storeLabel !== "string" ||
    !/^[^\p{Cc}\p{Cf}]{1,100}$/u.test(value.storeLabel)
  )
    return fail();
  return Object.freeze({
    tenantReference: parseTaskReference(value.tenantReference),
    brandReference: parseTaskReference(value.brandReference),
    storeReference: parseTaskReference(value.storeReference),
    actorReference: parseTaskReference(value.actorReference),
    queueReference: parseTaskReference(value.queueReference),
    storeLabel: value.storeLabel,
    canClaim: value.canClaim,
  });
}
/** Canonical TASK-INBOX presentation of current Task owner facts, not an invented
 * organization projection. Source authorization must retain its owner fence in
 * this transaction. A filtered/empty page says nothing about source finality. */
export function createMerchantTaskInboxRead(options: {
  now(): string;
  transactions: { run<T>(work: (tx: ConsumerTransaction) => Promise<T>): Promise<T> };
  authorize(tx: ConsumerTransaction, cookie: unknown): Promise<MerchantTaskInboxAuthority | null>;
  queue(
    tx: ConsumerTransaction,
    scope: MerchantTaskInboxAuthority,
  ): ReturnType<typeof createPostgresTaskQueueReader>;
  authorizeSource(
    tx: ConsumerTransaction,
    scope: MerchantTaskInboxAuthority,
    task: TaskRecord,
  ): Promise<boolean>;
}) {
  return async (cookie: unknown, input: { afterTaskReference: string | null }) => {
    try {
      const afterTaskReference =
        input.afterTaskReference === null ? null : parseTaskReference(input.afterTaskReference);
      return await options.transactions.run(async (tx) => {
        const scope = authority(await options.authorize(tx, cookie));
        const observedAt = parseTaskInstant(options.now());
        const page = await options.queue(tx, scope).list(tx, {
          queueReference: scope.queueReference,
          afterTaskReference,
          limit: 50,
          observedAt,
        });
        if (
          page.scope.kind !== "Store" ||
          page.scope.brandReference !== scope.brandReference ||
          page.scope.storeReference !== scope.storeReference ||
          page.queueReference !== scope.queueReference ||
          page.observedAt !== observedAt ||
          page.items.length > 50
        )
          return fail();
        const nextAfterTaskReference =
          page.nextAfterTaskReference === null
            ? null
            : parseTaskReference(page.nextAfterTaskReference);
        const items = [];
        let previous = afterTaskReference;
        for (const value of page.items) {
          const task = createTaskRecord(value);
          if (
            task.scope.kind !== "Store" ||
            task.scope.brandReference !== scope.brandReference ||
            task.scope.storeReference !== scope.storeReference ||
            !["Assigned", "Claimed"].includes(task.status) ||
            task.currentAssignment?.target.kind !== "Queue" ||
            task.currentAssignment.target.reference !== scope.queueReference ||
            task.updatedAt > observedAt ||
            (previous !== null && task.taskReference <= previous)
          )
            return fail();
          previous = task.taskReference;
          if ((await options.authorizeSource(tx, scope, task)) !== true) continue;
          items.push(
            Object.freeze({
              taskReference: task.taskReference,
              version: task.version,
              taskType: task.taskType,
              severity: task.severityCode,
              priority: task.priorityCode,
              status: task.status,
              ownerStatus:
                task.currentClaim === null
                  ? "Unclaimed"
                  : String(task.currentClaim.actorReference) === scope.actorReference
                    ? "ClaimedByYou"
                    : "ClaimedByStaff",
              dueAt: task.dueAt,
              sourceType: task.source.sourceType,
              sourceReference: task.source.sourceReference,
              canClaim: scope.canClaim && task.status === "Assigned",
            }),
          );
        }
        if (
          nextAfterTaskReference !== null &&
          (page.items.length === 0 || nextAfterTaskReference !== previous)
        )
          return fail();
        const finalScope = authority(await options.authorize(tx, cookie));
        if (JSON.stringify(scope) !== JSON.stringify(finalScope)) return fail();
        return Object.freeze({
          screenId: "TASK-INBOX" as const,
          storeLabel: scope.storeLabel,
          observedAt,
          items: Object.freeze(items),
          nextAfterTaskReference,
        });
      });
    } catch {
      return fail();
    }
  };
}
