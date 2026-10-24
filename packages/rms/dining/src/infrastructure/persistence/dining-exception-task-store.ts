import { createTaskRecord } from "@bop/task";
import {
  DiningClosingError,
  exactObject,
  parsePositiveDiningVersion,
} from "../../contracts/dining-closing.js";
import {
  parseDiningReference,
  parseDiningHash,
  parseDiningInstant,
} from "../../contracts/dining-session.js";
import type {
  DiningClosingHashPort,
  DiningExceptionTaskPort,
  EnsureDiningExceptionTaskInput,
} from "../../application/ports/dining-closing-ports.js";
import type {
  DiningTableStoreScope,
  DiningTableTransaction,
  DiningTableTransactionRunner,
} from "./dining-table-store.js";

const purpose = "DINING_UNPAID_BATCH_EXCEPTION" as const;
const unavailable = (): never => {
  throw new DiningClosingError("DINING_CLOSING_DEPENDENCY_UNAVAILABLE");
};
const conflict = (): never => {
  throw new DiningClosingError("DINING_CLOSING_IDEMPOTENCY_CONFLICT");
};
function rows(result: unknown): readonly Record<string, unknown>[] {
  if (!result || typeof result !== "object") return unavailable();
  const value = Object.getOwnPropertyDescriptor(result, "rows")?.value as unknown;
  if (!Array.isArray(value) || value.length > 1) return unavailable();
  return value as Record<string, unknown>[];
}
/** Historical acknowledgement only. Task creation, assignment and Audit must use
 * public Task commands on this SAME transaction; the runner rolls back every failure.
 * Authority retains the session/evidence and current actor/permission fences, including replay.
 * No Task-private SQL or inference that an acknowledged exception is financially resolved. */
export function createPostgresDiningExceptionTaskStore(options: {
  scope: DiningTableStoreScope;
  transactions: DiningTableTransactionRunner;
  hashes: DiningClosingHashPort;
  authorizeAndFence(
    tx: DiningTableTransaction,
    input: EnsureDiningExceptionTaskInput,
  ): Promise<boolean>;
  createAndAssign(
    tx: DiningTableTransaction,
    input: EnsureDiningExceptionTaskInput,
  ): Promise<unknown>;
}): DiningExceptionTaskPort {
  const scope = Object.freeze({
    tenantReference: parseDiningReference(options.scope.tenantReference),
    brandReference: parseDiningReference(options.scope.brandReference),
    storeReference: parseDiningReference(options.scope.storeReference),
  });
  return Object.freeze({
    async ensure(value: EnsureDiningExceptionTaskInput) {
      try {
        const captured = exactObject(value, [
          "purpose",
          "brandReference",
          "storeReference",
          "diningSessionReference",
          "orderReference",
          "evidenceVersion",
          "evidenceDigest",
          "intentHash",
          "requestedAt",
        ]);
        if (captured.purpose !== purpose) return unavailable();
        const input = Object.freeze({
          purpose,
          brandReference: parseDiningReference(captured.brandReference),
          storeReference: parseDiningReference(captured.storeReference),
          diningSessionReference: parseDiningReference(captured.diningSessionReference),
          orderReference: parseDiningReference(captured.orderReference),
          evidenceVersion: parsePositiveDiningVersion(captured.evidenceVersion),
          evidenceDigest: parseDiningHash(captured.evidenceDigest),
          intentHash: parseDiningHash(captured.intentHash),
          requestedAt: parseDiningInstant(captured.requestedAt),
        });
        if (
          input.brandReference !== scope.brandReference ||
          input.storeReference !== scope.storeReference
        )
          return unavailable();
        const identity = `${purpose}:${input.storeReference}:${input.diningSessionReference}:${input.orderReference}:${input.evidenceVersion}`;
        if (
          !options.hashes.equals(
            input.intentHash,
            parseDiningHash(options.hashes.hashIntent(identity)),
          )
        )
          return conflict();
        return await options.transactions.run(async (tx) => {
          const authorize = async () => {
            if ((await options.authorizeAndFence(tx, input)) !== true) return unavailable();
          };
          await authorize();
          await tx.query(
            "SELECT set_config('bop.brand_id',$1,true),set_config('bop.store_id',$2,true)",
            [scope.brandReference, scope.storeReference],
          );
          await tx.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
            `DiningException:${scope.brandReference}:${identity}`,
          ]);
          const keys = [
            scope.tenantReference,
            scope.brandReference,
            scope.storeReference,
            input.diningSessionReference,
            input.orderReference,
            input.evidenceVersion,
          ];
          const existing = rows(
            await tx.query(
              "SELECT intent_hash,evidence_digest,task_id::text,requested_at,task_json FROM rms_dining.dining_exception_task WHERE tenant_id=$1 AND brand_id=$2 AND store_id=$3 AND session_id=$4 AND order_id=$5 AND evidence_version=$6",
              keys,
            ),
          );
          const previous = existing[0];
          if (
            previous &&
            (previous.intent_hash !== input.intentHash ||
              previous.evidence_digest !== input.evidenceDigest)
          )
            return conflict();
          const task = createTaskRecord(
            previous ? previous.task_json : await options.createAndAssign(tx, input),
          );
          const acknowledgedAt = previous
            ? parseDiningInstant(previous.requested_at)
            : input.requestedAt;
          if (
            acknowledgedAt > input.requestedAt ||
            String(task.updatedAt) > acknowledgedAt ||
            task.scope.kind !== "Store" ||
            String(task.scope.brandReference) !== scope.brandReference ||
            String(task.scope.storeReference) !== scope.storeReference ||
            task.source.sourceType !== "DINING_SESSION" ||
            String(task.source.sourceReference) !== input.diningSessionReference ||
            task.source.snapshotDigest !== `sha256:${input.evidenceDigest}` ||
            task.taskType !== purpose ||
            task.priorityCode !== "CRITICAL" ||
            task.severityCode !== "CRITICAL" ||
            !["Assigned", "Claimed"].includes(task.status) ||
            task.currentAssignment?.target.kind !== "Queue" ||
            (previous && previous.task_id !== task.taskReference)
          )
            return unavailable();
          if (!previous) {
            const inserted = rows(
              await tx.query(
                "INSERT INTO rms_dining.dining_exception_task(tenant_id,brand_id,store_id,session_id,order_id,evidence_version,intent_hash,evidence_digest,task_id,requested_at,task_json) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb) RETURNING task_id",
                [
                  ...keys,
                  input.intentHash,
                  input.evidenceDigest,
                  task.taskReference,
                  input.requestedAt,
                  JSON.stringify(task),
                ],
              ),
            );
            if (inserted.length !== 1) return unavailable();
          }
          await authorize();
          return Object.freeze({
            orderReference: input.orderReference,
            evidenceVersion: input.evidenceVersion,
            intentHash: input.intentHash,
            task,
          });
        });
      } catch (error) {
        if (
          error instanceof DiningClosingError &&
          error.code === "DINING_CLOSING_IDEMPOTENCY_CONFLICT"
        )
          throw error;
        return unavailable();
      }
    },
  });
}

/** Resolves the owning Order for a current Task; acknowledgement is not resolution.
 * Caller fences the current Task/source and retains the enclosing transaction.
 * Immutable owner rows need no reverse Task→Dining write lock. */
export function createPostgresDiningExceptionTaskSource(options: {
  scope: DiningTableStoreScope;
  hashes: DiningClosingHashPort;
  authorizeAndFence(
    tx: DiningTableTransaction,
    task: ReturnType<typeof createTaskRecord>,
    observedAt: string,
  ): Promise<boolean>;
}) {
  const scope = {
    tenantReference: parseDiningReference(options.scope.tenantReference),
    brandReference: parseDiningReference(options.scope.brandReference),
    storeReference: parseDiningReference(options.scope.storeReference),
  };
  return Object.freeze({
    async load(tx: DiningTableTransaction, input: { task: unknown; observedAt: string }) {
      try {
        const task = createTaskRecord(input.task),
          observedAt = parseDiningInstant(input.observedAt);
        if (
          task.scope.kind !== "Store" ||
          String(task.scope.brandReference) !== scope.brandReference ||
          String(task.scope.storeReference) !== scope.storeReference ||
          task.source.sourceType !== "DINING_SESSION" ||
          task.taskType !== purpose ||
          task.severityCode !== "CRITICAL" ||
          task.priorityCode !== "CRITICAL" ||
          String(task.updatedAt) > observedAt
        )
          return unavailable();
        const authorize = async () => {
          if ((await options.authorizeAndFence(tx, task, observedAt)) !== true)
            return unavailable();
        };
        await authorize();
        await tx.query(
          "SELECT set_config('bop.brand_id',$1,true),set_config('bop.store_id',$2,true)",
          [scope.brandReference, scope.storeReference],
        );
        const found = rows(
          await tx.query(
            "SELECT tenant_id::text,brand_id::text,store_id::text,session_id::text,order_id::text,evidence_version::text,intent_hash,evidence_digest,task_id::text,requested_at,task_json FROM rms_dining.dining_exception_task WHERE brand_id=$1 AND store_id=$2 AND task_id=$3",
            [scope.brandReference, scope.storeReference, task.taskReference],
          ),
        );
        if (found.length === 0) {
          await authorize();
          return null;
        }
        const row = found[0];
        if (!row) return unavailable();
        const original = createTaskRecord(row.task_json),
          requestedAt = parseDiningInstant(row.requested_at),
          orderReference = parseDiningReference(row.order_id),
          sessionReference = parseDiningReference(row.session_id);
        if (
          typeof row.evidence_version !== "string" ||
          !/^[1-9][0-9]{0,15}$/u.test(row.evidence_version)
        )
          return unavailable();
        const evidenceVersion = parsePositiveDiningVersion(Number(row.evidence_version)),
          evidenceDigest = parseDiningHash(row.evidence_digest),
          intentHash = parseDiningHash(row.intent_hash);
        const expected = options.hashes.hashIntent(
          `${purpose}:${scope.storeReference}:${sessionReference}:${orderReference}:${evidenceVersion}`,
        );
        if (
          row.tenant_id !== scope.tenantReference ||
          row.brand_id !== scope.brandReference ||
          row.store_id !== scope.storeReference ||
          row.task_id !== task.taskReference ||
          sessionReference !== String(task.source.sourceReference) ||
          task.source.snapshotDigest !== `sha256:${evidenceDigest}` ||
          !options.hashes.equals(intentHash, expected) ||
          requestedAt > observedAt ||
          String(original.updatedAt) > requestedAt ||
          original.version > task.version ||
          original.createdAt !== task.createdAt
        )
          return unavailable();
        if (
          original.taskReference !== task.taskReference ||
          original.scope.kind !== task.scope.kind ||
          original.scope.brandReference !== task.scope.brandReference ||
          original.scope.storeReference !== task.scope.storeReference ||
          original.source.sourceType !== task.source.sourceType ||
          original.source.sourceReference !== task.source.sourceReference ||
          original.source.snapshotDigest !== task.source.snapshotDigest ||
          original.taskType !== task.taskType ||
          original.severityCode !== task.severityCode ||
          original.priorityCode !== task.priorityCode ||
          !["Assigned", "Claimed"].includes(original.status) ||
          original.currentAssignment?.target.kind !== "Queue"
        )
          return unavailable();
        await authorize();
        return Object.freeze({
          ...scope,
          diningSessionReference: sessionReference,
          orderReference,
          evidenceVersion,
          evidenceDigest,
          intentHash,
          taskReference: task.taskReference,
          taskVersion: task.version,
          requestedAt,
          observedAt,
        });
      } catch {
        return unavailable();
      }
    },
  });
}

/** Discover immutable exception associations; a task reference is not financial resolution. */
export function createPostgresDiningExceptionTaskCandidates(options: {
  scope: DiningTableStoreScope;
  authorize(
    tx: DiningTableTransaction,
    input: DiningTableStoreScope & { readonly purpose: "ProjectOrderException" },
  ): Promise<boolean>;
}) {
  const scope = Object.freeze({
    tenantReference: parseDiningReference(options.scope.tenantReference),
    brandReference: parseDiningReference(options.scope.brandReference),
    storeReference: parseDiningReference(options.scope.storeReference),
  });
  return async (
    tx: DiningTableTransaction,
    input: { readonly afterTaskReference: string | null; readonly limit: number },
  ) => {
    try {
      if (!Number.isSafeInteger(input.limit) || input.limit < 1 || input.limit > 100)
        return unavailable();
      const after =
        input.afterTaskReference === null ? null : parseDiningReference(input.afterTaskReference);
      const authorize = async () => {
        if ((await options.authorize(tx, { ...scope, purpose: "ProjectOrderException" })) !== true)
          return unavailable();
      };
      await authorize();
      await tx.query(
        "SELECT set_config('bop.tenant_id',$1,true),set_config('bop.brand_id',$2,true),set_config('bop.store_id',$3,true)",
        [scope.tenantReference, scope.brandReference, scope.storeReference],
      );
      const result = await tx.query(
        "SELECT DISTINCT task_id::text AS task_reference FROM rms_dining.dining_exception_task WHERE tenant_id=$1 AND brand_id=$2 AND store_id=$3 AND ($4::uuid IS NULL OR task_id>$4::uuid) ORDER BY task_reference LIMIT $5",
        [scope.tenantReference, scope.brandReference, scope.storeReference, after, input.limit + 1],
      );
      if (!result || typeof result !== "object") return unavailable();
      const descriptor = Object.getOwnPropertyDescriptor(result, "rows");
      if (
        !descriptor ||
        !("value" in descriptor) ||
        !Array.isArray(descriptor.value) ||
        descriptor.value.length > input.limit + 1
      )
        return unavailable();
      let previous = after;
      const references = descriptor.value.map((row: Record<string, unknown>) => {
        const reference = parseDiningReference(row.task_reference);
        if (previous !== null && reference <= previous) return unavailable();
        previous = reference;
        return reference;
      });
      const items = Object.freeze(references.slice(0, input.limit));
      await authorize();
      return Object.freeze({
        items,
        nextAfterTaskReference: references.length > input.limit ? (items.at(-1) ?? null) : null,
      });
    } catch {
      return unavailable();
    }
  };
}
