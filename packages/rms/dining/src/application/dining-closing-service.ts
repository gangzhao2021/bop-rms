import { validateAuditRecord, type AppendAuditRecordInput } from "@bop/audit";
import { revalidateTenantContext } from "@bop/permission";

import {
  DiningClosingError,
  exactObject,
  parseDiningClosingOperationRecord,
  parseDiningClosureEvidence,
  parseDiningExceptionTaskReceipt,
  parsePositiveDiningVersion,
  type DiningClosingOperationRecord,
} from "../contracts/dining-closing.js";
import {
  parseDiningHash,
  parseDiningInstant,
  parseDiningReference,
  parseDiningSession,
  type DiningInstant,
  type DiningReference,
  type DiningSession,
} from "../contracts/dining-session.js";
import {
  beginDiningClosing,
  cancelDiningClosing,
  finalizeDiningClosing,
  unresolvedDiningOrders,
} from "../domain/dining-closing.js";
import type {
  DiningClosingAuthorityEvidence,
  DiningClosingPorts,
} from "./ports/dining-closing-ports.js";

function dependencyFailure(error: unknown): never {
  if (
    error instanceof DiningClosingError &&
    (error.code === "DINING_CLOSING_VERSION_CONFLICT" ||
      error.code === "DINING_CLOSING_IDEMPOTENCY_CONFLICT")
  )
    throw error;
  throw new DiningClosingError("DINING_CLOSING_DEPENDENCY_UNAVAILABLE");
}

function authority(
  value: DiningClosingAuthorityEvidence | null,
  session: DiningSession,
  operation: "Begin" | "Cancel" | "Finalize",
  observedAt: DiningInstant,
): AppendAuditRecordInput {
  if (value === null) throw new DiningClosingError("DINING_CLOSING_PERMISSION_DENIED");
  const expectedAction = `DINING_SESSION_CLOSING_${operation.toUpperCase()}`;
  try {
    exactObject(
      value,
      value.kind === "Staff"
        ? ["kind", "tenantContext", "permission", "audit"]
        : [
            "kind",
            "guestSessionReference",
            "participantReference",
            "diningSessionReference",
            "storeReference",
            "status",
            "observedAt",
            "audit",
          ],
    );
    const audit = validateAuditRecord(value.audit, Date.parse(observedAt));
    let actorReference: string | null;
    if (value.kind === "Staff") {
      const context = revalidateTenantContext(value.tenantContext);
      if (
        value.permission.effect !== "Allow" ||
        value.permission.scopeKind !== "Store" ||
        value.permission.action !== "dining.session.close" ||
        context.scopeKind !== "Store" ||
        String(context.brand.brandReference) !== session.brandReference ||
        String(context.store?.storeReference) !== session.storeReference
      )
        throw new Error("denied");
      actorReference = context.actor.actorReference;
    } else {
      if (
        value.status !== "CurrentHost" ||
        value.diningSessionReference !== session.diningSessionReference ||
        value.storeReference !== session.storeReference ||
        value.participantReference !== session.hostParticipantReference ||
        value.observedAt !== observedAt
      )
        throw new Error("denied");
      actorReference = value.guestSessionReference;
    }
    if (
      actorReference === null ||
      audit.brandId !== session.brandReference ||
      audit.storeId !== session.storeReference ||
      audit.actor.type === "System" ||
      audit.actor.reference !== actorReference ||
      audit.actionCode !== expectedAction ||
      audit.targetType !== "DiningSession" ||
      audit.targetId !== session.diningSessionReference ||
      audit.occurredAt !== observedAt
    )
      throw new Error("denied");
    return audit;
  } catch {
    throw new DiningClosingError("DINING_CLOSING_PERMISSION_DENIED");
  }
}

function input(value: unknown): {
  sessionReference: DiningReference;
  expectedVersion: number;
  operationReference: DiningReference;
  requestedAt: DiningInstant;
} {
  const raw = exactObject(value, [
    "diningSessionReference",
    "expectedSessionVersion",
    "operationReference",
    "requestedAt",
  ]);
  return Object.freeze({
    sessionReference: parseDiningReference(raw.diningSessionReference),
    expectedVersion: parsePositiveDiningVersion(raw.expectedSessionVersion),
    operationReference: parseDiningReference(raw.operationReference),
    requestedAt: parseDiningInstant(raw.requestedAt),
  });
}

function intent(
  ports: DiningClosingPorts,
  action: "Begin" | "Cancel" | "Finalize",
  parsed: ReturnType<typeof input>,
) {
  return parseDiningHash(
    ports.hashes.hashIntent(
      `${action}:${parsed.sessionReference}:${parsed.expectedVersion}:${parsed.requestedAt}`,
    ),
  );
}

async function replay(
  ports: DiningClosingPorts,
  operationReference: DiningReference,
  expectedIntent: ReturnType<typeof parseDiningHash>,
): Promise<DiningClosingOperationRecord | null> {
  const prior = await ports.store.resolveOperation(operationReference).catch(dependencyFailure);
  if (prior === null) return null;
  const record = parseDiningClosingOperationRecord(prior);
  if (!ports.hashes.equals(record.operationIntentHash, expectedIntent))
    throw new DiningClosingError("DINING_CLOSING_IDEMPOTENCY_CONFLICT");
  return record;
}

async function current(
  ports: DiningClosingPorts,
  reference: DiningReference,
  expectedVersion: number,
) {
  const session = await ports.store.load(reference).catch(dependencyFailure);
  if (session === null) throw new DiningClosingError("DINING_CLOSING_UNAVAILABLE");
  const parsed = parseDiningSession(session);
  if (parsed.version !== expectedVersion)
    throw new DiningClosingError("DINING_CLOSING_VERSION_CONFLICT");
  return parsed;
}

async function authorized(
  ports: DiningClosingPorts,
  operation: "Begin" | "Cancel" | "Finalize",
  session: DiningSession,
  operationReference: DiningReference,
  observedAt: DiningInstant,
) {
  const evidence = await ports.authorization
    .authorize({ operation, session, operationReference, observedAt })
    .catch(dependencyFailure);
  return authority(evidence, session, operation, observedAt);
}

export type DiningClosingResult = Readonly<{
  status: "Applied" | "AlreadyApplied";
  session: DiningSession;
  taskReferences: readonly DiningReference[];
}>;

function result(
  status: DiningClosingResult["status"],
  record: DiningClosingOperationRecord,
): DiningClosingResult {
  return Object.freeze({
    status,
    session: record.session,
    taskReferences: record.taskReferences,
  });
}

function verifiedCommit(
  value: unknown,
  expected: DiningClosingOperationRecord,
  ports: DiningClosingPorts,
): DiningClosingOperationRecord {
  const committed = parseDiningClosingOperationRecord(value);
  if (
    committed.action !== expected.action ||
    committed.operationReference !== expected.operationReference ||
    !ports.hashes.equals(committed.operationIntentHash, expected.operationIntentHash) ||
    committed.session.diningSessionReference !== expected.session.diningSessionReference ||
    committed.session.brandReference !== expected.session.brandReference ||
    committed.session.storeReference !== expected.session.storeReference ||
    committed.session.phase !== expected.session.phase ||
    committed.session.version !== expected.session.version ||
    committed.closureEvidenceDigest !== expected.closureEvidenceDigest ||
    committed.taskReferences.length !== expected.taskReferences.length ||
    committed.taskReferences.some(
      (reference, index) => reference !== expected.taskReferences[index],
    )
  )
    throw new DiningClosingError("DINING_CLOSING_DEPENDENCY_UNAVAILABLE");
  return committed;
}

export function createDiningClosingService(ports: DiningClosingPorts) {
  return Object.freeze({
    async begin(value: unknown): Promise<DiningClosingResult> {
      const parsed = input(value);
      const operationIntentHash = intent(ports, "Begin", parsed);
      const prior = await replay(ports, parsed.operationReference, operationIntentHash);
      if (prior !== null) return result("AlreadyApplied", prior);
      const session = await current(ports, parsed.sessionReference, parsed.expectedVersion);
      const audit = await authorized(
        ports,
        "Begin",
        session,
        parsed.operationReference,
        parsed.requestedAt,
      );
      const record = parseDiningClosingOperationRecord({
        action: "Begin",
        session: beginDiningClosing(session),
        operationReference: parsed.operationReference,
        operationIntentHash,
        closureEvidenceDigest: null,
        taskReferences: [],
      });
      const committed = await ports.store
        .commit({ record, expectedSessionVersion: parsed.expectedVersion, audit })
        .catch(dependencyFailure);
      return result("Applied", verifiedCommit(committed, record, ports));
    },

    async cancel(value: unknown): Promise<DiningClosingResult> {
      const parsed = input(value);
      const operationIntentHash = intent(ports, "Cancel", parsed);
      const prior = await replay(ports, parsed.operationReference, operationIntentHash);
      if (prior !== null) return result("AlreadyApplied", prior);
      const session = await current(ports, parsed.sessionReference, parsed.expectedVersion);
      const audit = await authorized(
        ports,
        "Cancel",
        session,
        parsed.operationReference,
        parsed.requestedAt,
      );
      const reversibility = await ports.reversibility
        .evaluate({
          diningSessionReference: session.diningSessionReference,
          storeReference: session.storeReference,
          observedAt: parsed.requestedAt,
        })
        .catch(dependencyFailure);
      const record = parseDiningClosingOperationRecord({
        action: "Cancel",
        session: cancelDiningClosing(session, reversibility),
        operationReference: parsed.operationReference,
        operationIntentHash,
        closureEvidenceDigest: null,
        taskReferences: [],
      });
      const committed = await ports.store
        .commit({ record, expectedSessionVersion: parsed.expectedVersion, audit })
        .catch(dependencyFailure);
      return result("Applied", verifiedCommit(committed, record, ports));
    },

    async finalize(value: unknown): Promise<DiningClosingResult> {
      const parsed = input(value);
      const operationIntentHash = intent(ports, "Finalize", parsed);
      const prior = await replay(ports, parsed.operationReference, operationIntentHash);
      if (prior !== null) return result("AlreadyApplied", prior);
      const session = await current(ports, parsed.sessionReference, parsed.expectedVersion);
      const evidenceValue = await ports.closureEvidence
        .resolve({
          diningSessionReference: session.diningSessionReference,
          storeReference: session.storeReference,
          observedAt: parsed.requestedAt,
        })
        .catch(dependencyFailure);
      if (evidenceValue === null)
        throw new DiningClosingError("DINING_CLOSING_DEPENDENCY_UNAVAILABLE");
      const evidence = parseDiningClosureEvidence(evidenceValue);
      if (evidence.observedAt !== parsed.requestedAt)
        throw new DiningClosingError("DINING_CLOSING_UNAVAILABLE");
      const audit = await authorized(
        ports,
        "Finalize",
        session,
        parsed.operationReference,
        parsed.requestedAt,
      );
      const unresolved = unresolvedDiningOrders(evidence);
      const receipts = [];
      for (const order of unresolved) {
        const taskIntentHash = parseDiningHash(
          ports.hashes.hashIntent(
            `DINING_UNPAID_BATCH_EXCEPTION:${session.storeReference}:${session.diningSessionReference}:${order.orderReference}:${evidence.evidenceVersion}`,
          ),
        );
        const receipt = parseDiningExceptionTaskReceipt(
          await ports.tasks
            .ensure({
              purpose: "DINING_UNPAID_BATCH_EXCEPTION",
              brandReference: session.brandReference,
              storeReference: session.storeReference,
              diningSessionReference: session.diningSessionReference,
              orderReference: order.orderReference,
              evidenceVersion: evidence.evidenceVersion,
              evidenceDigest: evidence.evidenceDigest,
              intentHash: taskIntentHash,
              requestedAt: parsed.requestedAt,
            })
            .catch(dependencyFailure),
        );
        const task = receipt.task;
        if (
          receipt.orderReference !== order.orderReference ||
          receipt.evidenceVersion !== evidence.evidenceVersion ||
          !ports.hashes.equals(receipt.intentHash, taskIntentHash) ||
          task.scope.kind !== "Store" ||
          String(task.scope.brandReference) !== session.brandReference ||
          String(task.scope.storeReference) !== session.storeReference ||
          String(task.source.sourceType) !== "DINING_SESSION" ||
          String(task.source.sourceReference) !== session.diningSessionReference ||
          String(task.source.snapshotDigest) !== `sha256:${evidence.evidenceDigest}` ||
          String(task.taskType) !== "DINING_UNPAID_BATCH_EXCEPTION" ||
          String(task.severityCode) !== "CRITICAL" ||
          String(task.priorityCode) !== "CRITICAL" ||
          (task.status !== "Assigned" && task.status !== "Claimed") ||
          task.currentAssignment?.target.kind !== "Queue"
        )
          throw new DiningClosingError("DINING_CLOSING_TASK_REQUIRED");
        receipts.push(receipt);
      }
      const next = finalizeDiningClosing(session, evidence, receipts.length);
      const record = parseDiningClosingOperationRecord({
        action: "Finalize",
        session: next,
        operationReference: parsed.operationReference,
        operationIntentHash,
        closureEvidenceDigest: evidence.evidenceDigest,
        taskReferences: receipts.map((receipt) => String(receipt.task.taskReference)),
      });
      const committed = await ports.store
        .commit({ record, expectedSessionVersion: parsed.expectedVersion, audit })
        .catch(dependencyFailure);
      return result("Applied", verifiedCommit(committed, record, ports));
    },
  });
}
