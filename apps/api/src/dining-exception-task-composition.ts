import type { ActorReference } from "@bop/identity";
import { parseBusinessAction } from "@bop/permission";
import type { ConsumerTransaction } from "@bop/eventing";
import { createPostgresTaskStore, parseTaskReference, type TaskPorts } from "@bop/task";
import {
  createDiningExceptionTaskCreator,
  createPostgresDiningExceptionTaskStore,
  resolveDiningExceptionTaskPolicy,
  type parseDiningClosureEvidence,
} from "@rms/dining";
type Evidence = ReturnType<typeof parseDiningClosureEvidence>;
type StoreOptions = Parameters<typeof createPostgresDiningExceptionTaskStore>[0];
const fail = (): never => {
  throw new Error("DINING_EXCEPTION_TASK_COMPOSITION_UNAVAILABLE");
};
/** Must run inside the enclosing closing transaction. Every failure propagates
 * so Task, assignment, audit, Dining acknowledgement and session roll back together. */
export function createDiningExceptionTaskComposition(options: {
  transaction: ConsumerTransaction;
  scope: StoreOptions["scope"];
  actorReference: string;
  correlationReference: string;
  observedAt: string;
  evidence: Evidence;
  policy: unknown;
  hashes: StoreOptions["hashes"];
  newReference(): string;
  authorizeAndFence(): Promise<boolean>;
  authorizeTask: TaskPorts["authorization"]["authorize"];
}) {
  const tx = options.transaction,
    scope = options.scope,
    evidence = options.evidence;
  const actor = parseTaskReference(options.actorReference) as unknown as ActorReference;
  if (
    evidence.brandReference !== scope.brandReference ||
    evidence.storeReference !== scope.storeReference ||
    evidence.observedAt !== options.observedAt
  )
    return fail();
  const allowedInput: StoreOptions["authorizeAndFence"] = async (t, input) =>
    t === tx &&
    input.brandReference === scope.brandReference &&
    input.storeReference === scope.storeReference &&
    input.diningSessionReference === evidence.diningSessionReference &&
    input.evidenceVersion === evidence.evidenceVersion &&
    input.evidenceDigest === evidence.evidenceDigest &&
    input.requestedAt === options.observedAt &&
    evidence.orders.some(
      (order) =>
        order.orderReference === input.orderReference &&
        order.orderClosureStatus === "Open" &&
        (order.financialClass === "Unpaid" || order.financialClass === "Indeterminate"),
    ) &&
    (await options.authorizeAndFence());
  const runner = { run: <T>(work: (transaction: ConsumerTransaction) => Promise<T>) => work(tx) };
  const creator = createDiningExceptionTaskCreator<ConsumerTransaction>({
    hashes: options.hashes,
    newReference: options.newReference,
    resolve: async (t, input) => {
      if (!(await allowedInput(t, input))) return fail();
      const policy = resolveDiningExceptionTaskPolicy(options.policy, {
        ...scope,
        requestedAt: input.requestedAt,
        observedAt: options.observedAt,
      });
      return {
        actorReference: actor,
        managerQueueReference: policy.managerQueueReference,
        escalationPolicyReference: policy.escalationPolicyReference,
        dueAt: policy.dueAt,
        correlationReference: options.correlationReference,
        sourceChannel: "MERCHANT_WEB",
      };
    },
    ports: (t) => {
      if (t !== tx) return fail();
      const authorization: TaskPorts["authorization"] = {
        authorize: async (request) => {
          if (
            String(request.actorReference) !== String(actor) ||
            request.scope.kind !== "Store" ||
            String(request.scope.brandReference) !== scope.brandReference ||
            String(request.scope.storeReference) !== scope.storeReference ||
            request.purposeCode !== "DINING_UNPAID_BATCH_EXCEPTION" ||
            request.evaluatedAt !== options.observedAt ||
            !["task.create", "task.assign"].includes(request.action) ||
            !(await options.authorizeAndFence())
          )
            return fail();
          return options.authorizeTask(request);
        },
      };
      const store = createPostgresTaskStore({
        scope: {
          kind: "Store",
          brandReference: parseTaskReference(scope.brandReference),
          storeReference: parseTaskReference(scope.storeReference),
        },
        transactions: runner,
        now: () => options.observedAt,
        authorizeAndFence: async (actual, request) => {
          if (
            actual !== tx ||
            request.operation !== "Write" ||
            !(await options.authorizeAndFence())
          )
            return false;
          const mutation = request.mutation;
          if (
            !["Create", "Assign"].includes(mutation.operation) ||
            mutation.audit.actor.type !== "User" ||
            String(mutation.audit.actor.reference) !== String(actor)
          )
            return false;
          const decision = await authorization.authorize({
            actorReference: actor,
            action: parseBusinessAction(
              mutation.operation === "Create" ? "task.create" : "task.assign",
            ),
            scope: mutation.next.scope,
            taskReference: mutation.next.taskReference,
            purposeCode: mutation.next.taskType,
            expectedVersion: mutation.expectedVersion,
            evaluatedAt: options.observedAt,
          });
          return decision.effect === "Allow";
        },
      });
      return {
        authorization,
        unitOfWork: store,
        eligibility: { resolve: async () => fail() },
        notifications: { requestEscalation: async () => fail() },
      };
    },
  });
  return createPostgresDiningExceptionTaskStore({
    scope,
    transactions: runner,
    hashes: options.hashes,
    authorizeAndFence: allowedInput,
    createAndAssign: creator,
  });
}
