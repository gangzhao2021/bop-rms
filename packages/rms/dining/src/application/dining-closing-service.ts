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

import { captureSessionData } from "./dining-session-snapshot.js";

function dependencyFailure(error: unknown): never {
  if (
    error instanceof DiningClosingError &&
    (error.code === "DINING_CLOSING_VERSION_CONFLICT" ||
      error.code === "DINING_CLOSING_IDEMPOTENCY_CONFLICT")
  )
    throw new DiningClosingError(error.code);
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
    if (value.kind !== "Staff" && value.kind !== "Host") throw new Error("denied");
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
        String(context.resolvedAt) !== observedAt ||
        context.actor.actorType !== "User" ||
        audit.actor.type !== "User" ||
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
      parseDiningReference(value.guestSessionReference);
      if (
        audit.actor.type !== "System" ||
        audit.sourceChannel !== "CUSTOMER_PWA" ||
        audit.dataClassification !== "Restricted" ||
        Object.keys(audit.beforeSummary ?? {}).length !== 0 ||
        Object.keys(audit.afterSummary ?? {}).length !== 0
      )
        throw new Error("denied");
      actorReference = null;
    }
    if (
      audit.brandId !== session.brandReference ||
      audit.storeId !== session.storeReference ||
      (value.kind === "Staff" &&
        (audit.actor.type === "System" || audit.actor.reference !== actorReference)) ||
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
  parsed: ReturnType<typeof input>,
  action: DiningClosingOperationRecord["action"],
  session: DiningSession,
  expectedIntent: ReturnType<typeof parseDiningHash>,
): Promise<DiningClosingOperationRecord | null> {
  const prior = await ports.store
    .resolveOperation(parsed.operationReference)
    .catch(dependencyFailure);
  if (prior === null) return null;
  const record = bounded(() => parseDiningClosingOperationRecord(prior));
  if (!ports.hashes.equals(record.operationIntentHash, expectedIntent))
    throw new DiningClosingError("DINING_CLOSING_IDEMPOTENCY_CONFLICT");
  const historical = record.session;
  if (
    record.action !== action ||
    record.operationReference !== parsed.operationReference ||
    historical.diningSessionReference !== session.diningSessionReference ||
    historical.brandReference !== session.brandReference ||
    historical.storeReference !== session.storeReference ||
    historical.startedAt !== session.startedAt ||
    historical.startedByActorReference !== session.startedByActorReference ||
    historical.version !== parsed.expectedVersion + 1 ||
    historical.version > session.version ||
    historical.phase !==
      ({ Begin: "Closing", Cancel: "Active", Finalize: "Closed" } as const)[action] ||
    (action === "Finalize"
      ? record.closureEvidenceDigest === null
      : record.closureEvidenceDigest !== null || record.taskReferences.length !== 0) ||
    (historical.version === session.version && !sameSession(historical, session))
  )
    throw new DiningClosingError("DINING_CLOSING_DEPENDENCY_UNAVAILABLE");

  return record;
}

async function current(ports: DiningClosingPorts, reference: DiningReference) {
  const session = await ports.store.load(reference).catch(dependencyFailure);
  if (session === null) throw new DiningClosingError("DINING_CLOSING_UNAVAILABLE");
  const parsed = bounded(() => parseDiningSession(session));
  if (parsed.diningSessionReference !== reference)
    throw new DiningClosingError("DINING_CLOSING_DEPENDENCY_UNAVAILABLE");
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
  const committed = bounded(() => parseDiningClosingOperationRecord(value));
  if (
    !sameSession(committed.session, expected.session) ||
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

function bounded<T>(call: () => T): T {
  try {
    return call();
  } catch (error) {
    return dependencyFailure(error);
  }
}
function sameSession(left: DiningSession, right: DiningSession): boolean {
  return (Object.keys(left) as (keyof DiningSession)[]).every((key) => left[key] === right[key]);
}
async function dependency<T>(call: () => Promise<T>): Promise<T> {
  try {
    return captureSessionData(await call());
  } catch (error) {
    return dependencyFailure(error);
  }
}

export function createDiningClosingService(source: DiningClosingPorts) {
  const ports: DiningClosingPorts = {
    store: {
      load: (value) => dependency(() => source.store.load(value)),
      resolveOperation: (value) => dependency(() => source.store.resolveOperation(value)),
      commit: (value) => dependency(() => source.store.commit(value)),
    },
    authorization: {
      authorize: (value) => dependency(() => source.authorization.authorize(value)),
    },
    closureEvidence: {
      resolve: (value) => dependency(() => source.closureEvidence.resolve(value)),
    },
    reversibility: { evaluate: (value) => dependency(() => source.reversibility.evaluate(value)) },
    tasks: { ensure: (value) => dependency(() => source.tasks.ensure(value)) },
    hashes: {
      hashIntent: (value) => bounded(() => parseDiningHash(source.hashes.hashIntent(value))),
      equals: (left, right) =>
        bounded(() => {
          const equal = source.hashes.equals(left, right);
          if (typeof equal !== "boolean") throw new Error("invalid");
          return equal;
        }),
    },
  };
  return Object.freeze({
    async begin(value: unknown): Promise<DiningClosingResult> {
      const parsed = input(value);
      const session = await current(ports, parsed.sessionReference);
      const audit = await authorized(
        ports,
        "Begin",
        session,
        parsed.operationReference,
        parsed.requestedAt,
      );
      const operationIntentHash = intent(ports, "Begin", parsed);
      const prior = await replay(ports, parsed, "Begin", session, operationIntentHash);
      if (prior !== null) return result("AlreadyApplied", prior);
      if (session.version !== parsed.expectedVersion)
        throw new DiningClosingError("DINING_CLOSING_VERSION_CONFLICT");

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
      const session = await current(ports, parsed.sessionReference);
      const audit = await authorized(
        ports,
        "Cancel",
        session,
        parsed.operationReference,
        parsed.requestedAt,
      );
      const operationIntentHash = intent(ports, "Cancel", parsed);
      const prior = await replay(ports, parsed, "Cancel", session, operationIntentHash);
      if (prior !== null) return result("AlreadyApplied", prior);
      if (session.version !== parsed.expectedVersion)
        throw new DiningClosingError("DINING_CLOSING_VERSION_CONFLICT");

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
      const session = await current(ports, parsed.sessionReference);
      const audit = await authorized(
        ports,
        "Finalize",
        session,
        parsed.operationReference,
        parsed.requestedAt,
      );
      const operationIntentHash = intent(ports, "Finalize", parsed);
      const prior = await replay(ports, parsed, "Finalize", session, operationIntentHash);
      if (prior !== null) return result("AlreadyApplied", prior);
      if (session.version !== parsed.expectedVersion)
        throw new DiningClosingError("DINING_CLOSING_VERSION_CONFLICT");
      if (session.phase !== "Closing")
        throw new DiningClosingError("DINING_CLOSING_PHASE_CONFLICT");
      const evidenceValue = await ports.closureEvidence
        .resolve({
          diningSessionReference: session.diningSessionReference,
          storeReference: session.storeReference,
          observedAt: parsed.requestedAt,
        })
        .catch(dependencyFailure);
      if (evidenceValue === null)
        throw new DiningClosingError("DINING_CLOSING_DEPENDENCY_UNAVAILABLE");
      const evidence = bounded(() => parseDiningClosureEvidence(evidenceValue));
      if (evidence.observedAt !== parsed.requestedAt)
        throw new DiningClosingError("DINING_CLOSING_UNAVAILABLE");

      if (
        evidence.diningSessionReference !== session.diningSessionReference ||
        evidence.brandReference !== session.brandReference ||
        evidence.storeReference !== session.storeReference
      )
        throw new DiningClosingError("DINING_CLOSING_UNAVAILABLE");
      const unresolved = unresolvedDiningOrders(evidence);
      const receipts = [];
      for (const order of unresolved) {
        const taskIntentHash = parseDiningHash(
          ports.hashes.hashIntent(
            `DINING_UNPAID_BATCH_EXCEPTION:${session.storeReference}:${session.diningSessionReference}:${order.orderReference}:${evidence.evidenceVersion}`,
          ),
        );
        const receiptValue = await ports.tasks
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
          .catch(dependencyFailure);
        const receipt = bounded(() => parseDiningExceptionTaskReceipt(receiptValue));
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
