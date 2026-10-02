import { createHash } from "node:crypto";
import {
  appendAuditRecordInTransaction,
  canonicalizeRfc8785,
  validateAuditRecord,
  type AuditTransaction,
} from "@bop/audit";
import {
  createTaskRecord,
  createTaskScope,
  parseTaskReference,
  parseTaskDigest,
  parseTaskVersion,
  parseTaskCode,
  parseTaskInstant,
  sameTaskScope,
  type TaskScope,
  type TaskRecord,
} from "../../contracts/task.js";
import {
  parseTaskQueueFilters,
  matchesTaskQueueFilters,
  type TaskQueueFilters,
} from "../../contracts/task-queue.js";
import { evaluateTaskTransition, taskOperations } from "../../domain/task-lifecycle.js";
import type { CommitTaskMutationInput } from "../../application/ports/task-ports.js";
const fail = (): never => {
  throw new Error("TASK_STORE_UNAVAILABLE");
};
function rows(value: unknown): readonly Record<string, unknown>[] {
  if (!value || typeof value !== "object") return fail();
  const result = Object.getOwnPropertyDescriptor(value, "rows")?.value as unknown;
  if (!Array.isArray(result) || result.length > 1) return fail();
  return result as Record<string, unknown>[];
}
const encode = (record: TaskRecord) => canonicalizeRfc8785(record);
const auditCodes = {
  Create: "TASK_CREATED",
  Assign: "TASK_ASSIGNED",
  Claim: "TASK_CLAIMED",
  Complete: "TASK_COMPLETED",
  Fail: "TASK_FAILED",
  Cancel: "TASK_CANCELLED",
  Escalate: "TASK_ESCALATED",
} as const;
/** Trusted owning adapter. Caller must roll back thrown errors. Its authority
 * port retains current actor/permission/eligibility fences until commit ends. */
export function createPostgresTaskStore(options: {
  scope: TaskScope;
  transactions: { run<T>(work: (tx: AuditTransaction) => Promise<T>): Promise<T> };
  now(): string;
  authorizeAndFence(
    tx: AuditTransaction,
    request:
      | { operation: "Read"; taskReference: string }
      | { operation: "Write"; mutation: CommitTaskMutationInput },
  ): Promise<boolean>;
}) {
  const scope = createTaskScope(options.scope);
  const context = async (tx: AuditTransaction) =>
    tx.query("SELECT set_config('bop.brand_id',$1,true),set_config('bop.store_id',$2,true)", [
      scope.brandReference,
      scope.storeReference ?? "",
    ]);
  const load = async (tx: AuditTransaction, reference: string) => {
    const found = rows(
      await tx.query(
        "SELECT record_json FROM bop_task.task_version WHERE task_id=$1 AND brand_id=$2 AND store_id IS NOT DISTINCT FROM $3 ORDER BY version DESC LIMIT 1",
        [reference, scope.brandReference, scope.storeReference],
      ),
    );
    if (!found.length) return null;
    const task = createTaskRecord(found[0]?.record_json);
    if (task.taskReference !== reference || !sameTaskScope(task.scope, scope)) return fail();
    return task;
  };
  return Object.freeze({
    async load(reference: string) {
      try {
        const taskReference = parseTaskReference(reference);
        return await options.transactions.run(async (tx) => {
          await context(tx);
          const authorize = async () => {
            if (
              (await options.authorizeAndFence(tx, { operation: "Read", taskReference })) !== true
            )
              return fail();
          };
          await authorize();
          const result = await load(tx, taskReference);
          await authorize();
          return result;
        });
      } catch {
        return fail();
      }
    },
    async commit(input: CommitTaskMutationInput): Promise<void> {
      try {
        const operation = input.operation;
        if (!taskOperations.includes(operation)) return fail();
        const next = createTaskRecord(input.next),
          current = input.current === null ? null : createTaskRecord(input.current),
          expectedVersion = parseTaskVersion(input.expectedVersion),
          idempotencyKey = parseTaskReference(input.idempotencyKey),
          requestDigest = parseTaskDigest(input.requestDigest),
          audit = validateAuditRecord(input.audit, Date.parse(options.now()));
        const transition = evaluateTaskTransition(operation, current);
        if (
          !sameTaskScope(next.scope, scope) ||
          transition.outcome !== "Allowed" ||
          transition.nextStatus !== next.status ||
          (current === null
            ? next.version !== 1 || expectedVersion !== 1
            : current.taskReference !== next.taskReference ||
              current.version !== expectedVersion ||
              next.version !== current.version + 1) ||
          audit.brandId !== scope.brandReference ||
          (audit.storeId ?? null) !== scope.storeReference ||
          audit.actor.type !== "User" ||
          audit.actionCode !== auditCodes[operation] ||
          audit.targetType !== "Task" ||
          audit.targetId !== next.taskReference ||
          audit.occurredAt !== next.updatedAt ||
          audit.dataClassification !== "Confidential" ||
          audit.retentionPolicyCode !== "TASK_AUDIT"
        )
          return fail();
        const mutation = Object.freeze({
          operation,
          expectedVersion,
          idempotencyKey,
          requestDigest,
          current,
          next,
          audit,
        });
        const digest =
          "sha256:" + createHash("sha256").update(canonicalizeRfc8785(mutation)).digest("hex");
        await options.transactions.run(async (tx) => {
          await context(tx);
          const authorize = async () => {
            if ((await options.authorizeAndFence(tx, { operation: "Write", mutation })) !== true)
              return fail();
          };
          await authorize();
          await tx.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
            taskSourceLock(scope, next.source.sourceType, next.source.sourceReference),
          ]);
          await tx.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
            "TaskOperation:" +
              scope.brandReference +
              ":" +
              (scope.storeReference ?? "brand") +
              ":" +
              idempotencyKey,
          ]);
          const existing = rows(
            await tx.query(
              "SELECT mutation_digest FROM bop_task.task_version WHERE brand_id=$1 AND store_id IS NOT DISTINCT FROM $2 AND idempotency_key=$3",
              [scope.brandReference, scope.storeReference, idempotencyKey],
            ),
          );
          if (existing.length) {
            if (existing[0]?.mutation_digest !== digest) return fail();
            await authorize();
            return;
          }
          await tx.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
            "TaskVersion:" + next.taskReference,
          ]);
          const persisted = await load(tx, next.taskReference);
          if (
            (persisted === null) !== (current === null) ||
            (persisted !== null && current !== null && encode(persisted) !== encode(current))
          )
            return fail();
          const inserted = await tx.query(
            "INSERT INTO bop_task.task_version(task_id,brand_id,store_id,version,expected_version,operation_code,idempotency_key,request_digest,mutation_digest,audit_id,source_type,source_id,task_type,status,occurred_at,record_json) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16::jsonb) RETURNING task_id",
            [
              next.taskReference,
              scope.brandReference,
              scope.storeReference,
              next.version,
              expectedVersion,
              operation,
              idempotencyKey,
              requestDigest,
              digest,
              audit.auditId,
              next.source.sourceType,
              next.source.sourceReference,
              next.taskType,
              next.status,
              next.updatedAt,
              encode(next),
            ],
          );
          if (rows(inserted).length !== 1) return fail();
          await appendAuditRecordInTransaction(tx, audit);
          await authorize();
        });
      } catch {
        return fail();
      }
    },
  });
}

function taskSourceLock(scope: TaskScope, type: string, reference: string) {
  return (
    "TaskSource:" +
    scope.brandReference +
    ":" +
    (scope.storeReference ?? "brand") +
    ":" +
    type +
    ":" +
    reference
  );
}
/** Complete current tasks under their shared writer fence. Status is not financial clearance. */
export function createPostgresTaskSourceReader(options: {
  scope: TaskScope;
  authorizeAndFence(
    tx: AuditTransaction,
    query: { sourceType: string; sourceReference: string; observedAt: string },
  ): Promise<boolean>;
}) {
  const scope = createTaskScope(options.scope);
  return Object.freeze({
    async load(
      tx: AuditTransaction,
      input: { sourceType: string; sourceReference: string; observedAt: string },
    ) {
      try {
        const query = Object.freeze({
          sourceType: parseTaskCode(input.sourceType),
          sourceReference: parseTaskReference(input.sourceReference),
          observedAt: parseTaskInstant(input.observedAt),
        });
        const authorize = async () => {
          if ((await options.authorizeAndFence(tx, query)) !== true) return fail();
        };
        await authorize();
        await tx.query(
          "SELECT set_config('bop.brand_id',$1,true),set_config('bop.store_id',$2,true)",
          [scope.brandReference, scope.storeReference ?? ""],
        );
        await tx.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
          taskSourceLock(scope, query.sourceType, query.sourceReference),
        ]);
        const result = await tx.query(
          `SELECT DISTINCT ON(task_id) task_id::text,version,record_json,
     count(*) OVER(PARTITION BY task_id)::text AS version_count,
     min(version) OVER(PARTITION BY task_id) AS minimum_version
     FROM bop_task.task_version WHERE brand_id=$1 AND store_id IS NOT DISTINCT FROM $2 AND source_type=$3 AND source_id=$4 ORDER BY task_id,version DESC LIMIT 1001`,
          [scope.brandReference, scope.storeReference, query.sourceType, query.sourceReference],
        );
        if (!result || typeof result !== "object") return fail();
        const data = Object.getOwnPropertyDescriptor(result, "rows")?.value as unknown;
        if (!Array.isArray(data) || data.length > 1000) return fail();
        const seen = new Set<string>();
        const tasks = data.map((row: Record<string, unknown>) => {
          const task = createTaskRecord(row.record_json);
          if (
            !sameTaskScope(task.scope, scope) ||
            task.taskReference !== row.task_id ||
            task.version !== row.version ||
            String(task.version) !== row.version_count ||
            row.minimum_version !== 1 ||
            task.source.sourceType !== query.sourceType ||
            task.source.sourceReference !== query.sourceReference ||
            task.updatedAt > query.observedAt ||
            seen.has(task.taskReference)
          )
            return fail();
          seen.add(task.taskReference);
          return task;
        });
        await authorize();
        return Object.freeze({
          scope,
          ...query,
          tasks: Object.freeze(tasks),
          snapshotDigest:
            "sha256:" +
            createHash("sha256")
              .update(canonicalizeRfc8785({ scope, ...query, tasks }))
              .digest("hex"),
        });
      } catch {
        return fail();
      }
    },
  });
}

/** Bounded current Queue view. Pagination is not a frozen cross-page snapshot,
 * and an empty page is not evidence of financial clearance. Writes use versions. */
export function createPostgresTaskQueueReader(options: {
  scope: TaskScope;
  authorizeAndFence(
    tx: AuditTransaction,
    query: {
      queueReference: string;
      afterTaskReference: string | null;
      limit: number;
      observedAt: string;
      filters: TaskQueueFilters;
    },
  ): Promise<boolean>;
}) {
  const scope = createTaskScope(options.scope);
  return Object.freeze({
    async list(
      tx: AuditTransaction,
      input: {
        queueReference: string;
        afterTaskReference: string | null;
        limit: number;
        observedAt: string;
        filters?: unknown;
      },
    ) {
      try {
        const query = Object.freeze({
          queueReference: parseTaskReference(input.queueReference),
          afterTaskReference:
            input.afterTaskReference === null ? null : parseTaskReference(input.afterTaskReference),
          limit: input.limit,
          observedAt: parseTaskInstant(input.observedAt),
          filters: parseTaskQueueFilters(input.filters),
        });
        if (!Number.isSafeInteger(query.limit) || query.limit < 1 || query.limit > 100)
          return fail();
        const authorize = async () => {
          if ((await options.authorizeAndFence(tx, query)) !== true) return fail();
        };
        await authorize();
        await tx.query(
          "SELECT set_config('bop.brand_id',$1,true),set_config('bop.store_id',$2,true)",
          [scope.brandReference, scope.storeReference ?? ""],
        );
        const result = await tx.query(
          `WITH latest AS (
        SELECT DISTINCT ON(task_id) task_id,version,status,record_json,
          count(*) OVER(PARTITION BY task_id)::text AS version_count,
          min(version) OVER(PARTITION BY task_id) AS minimum_version
        FROM bop_task.task_version
        WHERE brand_id=$1 AND store_id IS NOT DISTINCT FROM $2 AND ($3::uuid IS NULL OR task_id>$3::uuid)
        ORDER BY task_id,version DESC
      ) SELECT task_id::text,version,record_json,version_count,minimum_version FROM latest
      WHERE status IN ('Assigned','Claimed') AND record_json#>>'{currentAssignment,target,kind}'='Queue'
        AND record_json#>>'{currentAssignment,target,reference}'=$4
        AND ($6::text IS NULL OR status=$6)
        AND ($7::text IS NULL OR record_json->>'taskType'=$7)
        AND ($8::text IS NULL OR record_json->>'severityCode'=$8)
        AND ($9::text IS NULL OR task_id::text=$9 OR record_json#>>'{source,sourceReference}'=$9)
        AND ($10::text IS NULL OR
          ($10='Unclaimed' AND record_json->'currentClaim'='null'::jsonb) OR
          ($10='ByActor' AND record_json#>>'{currentClaim,actorReference}'=$11) OR
          ($10='ByOtherActor' AND record_json#>>'{currentClaim,actorReference}'<>$11))
        AND ($12::boolean IS NULL OR ((record_json->>'dueAt')::timestamptz<$13::timestamptz)=$12)
      ORDER BY task_id LIMIT $5`,
          [
            scope.brandReference,
            scope.storeReference,
            query.afterTaskReference,
            query.queueReference,
            query.limit + 1,
            query.filters.status,
            query.filters.taskType,
            query.filters.severityCode,
            query.filters.exactReference,
            query.filters.owner?.kind ?? null,
            query.filters.owner !== null && query.filters.owner.kind !== "Unclaimed"
              ? query.filters.owner.actorReference
              : null,
            query.filters.overdue,
            query.observedAt,
          ],
        );
        if (!result || typeof result !== "object") return fail();
        const data = Object.getOwnPropertyDescriptor(result, "rows")?.value as unknown;
        if (!Array.isArray(data) || data.length > query.limit + 1) return fail();
        let previous = query.afterTaskReference;
        const tasks = data.map((row: Record<string, unknown>) => {
          const task = createTaskRecord(row.record_json);
          if (
            !sameTaskScope(task.scope, scope) ||
            task.taskReference !== row.task_id ||
            task.version !== row.version ||
            String(task.version) !== row.version_count ||
            row.minimum_version !== 1 ||
            !["Assigned", "Claimed"].includes(task.status) ||
            task.currentAssignment?.target.kind !== "Queue" ||
            task.currentAssignment.target.reference !== query.queueReference ||
            task.updatedAt > query.observedAt ||
            !matchesTaskQueueFilters(task, query.filters, query.observedAt) ||
            (previous !== null && task.taskReference <= previous)
          )
            return fail();
          previous = task.taskReference;
          return task;
        });
        const items = Object.freeze(tasks.slice(0, query.limit));
        await authorize();
        return Object.freeze({
          scope,
          queueReference: query.queueReference,
          observedAt: query.observedAt,
          items,
          nextAfterTaskReference:
            tasks.length > query.limit ? (items[items.length - 1]?.taskReference ?? fail()) : null,
        });
      } catch {
        return fail();
      }
    },
  });
}
