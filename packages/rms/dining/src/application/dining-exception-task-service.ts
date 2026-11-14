import {
  createTask,
  assignTask,
  createTaskRecord,
  createTaskAssignmentRecord,
  parseTaskReference,
  parseTaskCode,
  parseTaskDigest,
  parseTaskVersion,
  type TaskPorts,
  type CreateTaskInput,
} from "@bop/task";
import {
  exactObject,
  parsePositiveDiningVersion,
  DiningClosingError,
} from "../contracts/dining-closing.js";
import {
  parseDiningReference,
  parseDiningHash,
  parseDiningInstant,
} from "../contracts/dining-session.js";
import type {
  EnsureDiningExceptionTaskInput,
  DiningClosingHashPort,
} from "./ports/dining-closing-ports.js";

/** Trusted transaction-bound composition. Invoke only inside the Dining intent
 * store's createAndAssign callback. Both Task commands use that same transaction;
 * its runner must roll back creation if assignment or later acknowledgement fails.
 * Resolution must supply the current authenticated staff actor and configured
 * Manager queue/SLA, never values selected by an unauthenticated caller. */
export function createDiningExceptionTaskCreator<Transaction>(options: {
  resolve(
    tx: Transaction,
    input: EnsureDiningExceptionTaskInput,
  ): Promise<{
    actorReference: CreateTaskInput["actorReference"];
    managerQueueReference: string;
    escalationPolicyReference: string;
    dueAt: string;
    correlationReference: string;
    sourceChannel: string;
  }>;
  ports(tx: Transaction): TaskPorts;
  newReference(): string;
  hashes: DiningClosingHashPort;
}) {
  return async (tx: Transaction, value: EnsureDiningExceptionTaskInput) => {
    try {
      const raw = exactObject(value, [
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
      if (raw.purpose !== "DINING_UNPAID_BATCH_EXCEPTION") throw new Error();
      const input = Object.freeze({
        purpose: "DINING_UNPAID_BATCH_EXCEPTION" as const,
        brandReference: parseDiningReference(raw.brandReference),
        storeReference: parseDiningReference(raw.storeReference),
        diningSessionReference: parseDiningReference(raw.diningSessionReference),
        orderReference: parseDiningReference(raw.orderReference),
        evidenceVersion: parsePositiveDiningVersion(raw.evidenceVersion),
        evidenceDigest: parseDiningHash(raw.evidenceDigest),
        intentHash: parseDiningHash(raw.intentHash),
        requestedAt: parseDiningInstant(raw.requestedAt),
      });
      if (
        !options.hashes.equals(
          input.intentHash,
          options.hashes.hashIntent(
            `${input.purpose}:${input.storeReference}:${input.diningSessionReference}:${input.orderReference}:${input.evidenceVersion}`,
          ),
        )
      )
        throw new Error();
      const resolved = await options.resolve(tx, input);
      const config = Object.freeze({
        actorReference: parseTaskReference(resolved.actorReference),
        managerQueueReference: parseTaskReference(resolved.managerQueueReference),
        escalationPolicyReference: parseTaskReference(resolved.escalationPolicyReference),
        dueAt: parseDiningInstant(resolved.dueAt),
        correlationReference: parseTaskReference(resolved.correlationReference),
        sourceChannel: parseTaskCode(resolved.sourceChannel),
      });
      if (config.dueAt < input.requestedAt) throw new Error();
      // Capture and validate every generated identity before any Task mutation.
      const references = Array.from({ length: 6 }, () =>
        parseTaskReference(options.newReference()),
      );
      if (new Set(references).size !== references.length) throw new Error();
      const [
        taskReference,
        assignmentReference,
        createOperation,
        createAudit,
        assignOperation,
        assignAudit,
      ] = references;
      const task = createTaskRecord({
        taskReference,
        scope: {
          kind: "Store",
          brandReference: input.brandReference,
          storeReference: input.storeReference,
        },
        source: {
          sourceType: "DINING_SESSION",
          sourceReference: input.diningSessionReference,
          snapshotDigest: `sha256:${input.evidenceDigest}`,
        },
        taskType: input.purpose,
        severityCode: "CRITICAL",
        priorityCode: "CRITICAL",
        status: "Open",
        assignmentHistory: [],
        currentAssignment: null,
        claimHistory: [],
        currentClaim: null,
        dueAt: config.dueAt,
        escalationPolicyReference: config.escalationPolicyReference,
        escalationHistory: [],
        terminalOutcome: null,
        version: 1,
        createdAt: input.requestedAt,
        updatedAt: input.requestedAt,
      });
      const assignment = createTaskAssignmentRecord({
        assignmentReference,
        target: { kind: "Queue", reference: config.managerQueueReference },
        assignedBy: config.actorReference,
        assignedAt: input.requestedAt,
        reasonCode: input.purpose,
      });
      const digest = (operation: string) =>
        parseTaskDigest(
          `sha256:${parseDiningHash(options.hashes.hashIntent(JSON.stringify({ operation, input, config, task, assignment })))}`,
        );
      const common = {
        actorReference: config.actorReference as unknown as CreateTaskInput["actorReference"],
        purposeCode: parseTaskCode(input.purpose),
        expectedVersion: parseTaskVersion(1),
        correlationId: config.correlationReference,
        occurredAt: input.requestedAt,
        sourceChannel: config.sourceChannel,
      };
      const ports = options.ports(tx);
      const current = await createTask(
        {
          ...common,
          task,
          idempotencyKey: parseTaskReference(createOperation),
          auditId: parseTaskReference(createAudit),
          requestDigest: digest("Create"),
        },
        ports,
      );
      return await assignTask(
        {
          ...common,
          current,
          assignment,
          idempotencyKey: parseTaskReference(assignOperation),
          auditId: parseTaskReference(assignAudit),
          requestDigest: digest("Assign"),
        },
        ports,
      );
    } catch {
      throw new DiningClosingError("DINING_CLOSING_TASK_REQUIRED");
    }
  };
}
