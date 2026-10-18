import { createHash } from "node:crypto";
import { beforeEach, expect, it, vi } from "vitest";
import type { ConsumerTransaction } from "@bop/eventing";
import type { TaskAuthorizationRequest } from "@bop/task";
import { parsePolicyReference, parsePolicyVersion } from "@bop/permission";
import { parseDiningClosureEvidence, parseDiningHash } from "@rms/dining";
const mock = vi.hoisted(() => ({ taskOptions: vi.fn(), intentOptions: vi.fn(), commits: vi.fn() }));
vi.mock("@bop/task", async (original) => ({
  ...(await original<typeof import("@bop/task")>()),
  createPostgresTaskStore: (options: unknown) => {
    mock.taskOptions(options);
    return {
      commit: async (mutation: unknown) => {
        await mock.commits(mutation);
      },
    };
  },
}));
vi.mock("@rms/dining", async (original) => ({
  ...(await original<typeof import("@rms/dining")>()),
  createPostgresDiningExceptionTaskStore: (options: unknown) => {
    mock.intentOptions(options);
    return options;
  },
}));
import { createDiningExceptionTaskComposition } from "./dining-exception-task-composition.js";
const id = (n: number) => "0190fad7-0000-7000-8000-" + String(n).padStart(12, "0");
const at = "2026-09-22T00:00:00.000Z";
beforeEach(() => vi.resetAllMocks());
function setup() {
  const scope = { tenantReference: id(1), brandReference: id(2), storeReference: id(3) };
  const tx: ConsumerTransaction = { query: vi.fn() };
  const evidence = parseDiningClosureEvidence({
    diningSessionReference: id(4),
    brandReference: id(2),
    storeReference: id(3),
    evidenceVersion: 2,
    observedAt: at,
    evidenceDigest: "a".repeat(64),
    orders: [
      {
        orderReference: id(5),
        orderClosureStatus: "Open",
        batches: [{ batchReference: id(6), executionState: "Fulfilled" }],
        financialClass: "Indeterminate",
        ownerFinalityReference: null,
        ownerDecidedAt: null,
      },
    ],
  });
  const hashes = {
    hashIntent: (value: string) =>
      parseDiningHash(createHash("sha256").update(value).digest("hex")),
    equals: (a: string, b: string) => a === b,
  };
  const authorize = vi.fn(async (request: TaskAuthorizationRequest) =>
    Object.freeze({
      effect: "Allow" as const,
      reason: "EXPLICIT_ALLOW" as const,
      source: "ExplicitAllow" as const,
      action: request.action,
      scopeKind: "Store" as const,
      policySnapshotReference: parsePolicyReference(id(20)),
      policyVersion: parsePolicyVersion(1),
      audit: {
        effect: "Allow" as const,
        reason: "EXPLICIT_ALLOW" as const,
        source: "ExplicitAllow" as const,
      },
    }),
  );
  const fence = vi.fn(async () => true);
  let sequence = 100;
  const policy = {
    policyReference: id(7),
    version: 1,
    ...scope,
    managerQueueReference: id(8),
    escalationPolicyReference: id(9),
    dueAfterMilliseconds: 900000,
    effectiveFrom: "2026-09-21T00:00:00.000Z",
    effectiveUntil: "2026-09-23T00:00:00.000Z",
  };
  // Policy is scoped to Brand/Store, not a tenant credential.
  const routing = {
    policyReference: policy.policyReference,
    version: policy.version,
    brandReference: scope.brandReference,
    storeReference: scope.storeReference,
    managerQueueReference: policy.managerQueueReference,
    escalationPolicyReference: policy.escalationPolicyReference,
    dueAfterMilliseconds: policy.dueAfterMilliseconds,
    effectiveFrom: policy.effectiveFrom,
    effectiveUntil: policy.effectiveUntil,
  };
  createDiningExceptionTaskComposition({
    transaction: tx,
    scope,
    actorReference: id(10),
    correlationReference: id(11),
    observedAt: at,
    evidence,
    policy: routing,
    hashes,
    newReference: () => id(sequence++),
    authorizeAndFence: fence,
    authorizeTask: authorize,
  });
  const options = mock.intentOptions.mock.calls[0]?.[0] as Parameters<
    typeof import("@rms/dining").createPostgresDiningExceptionTaskStore
  >[0];
  const order = evidence.orders[0];
  if (!order) throw new Error("fixture order missing");
  const input = {
    purpose: "DINING_UNPAID_BATCH_EXCEPTION" as const,
    brandReference: evidence.brandReference,
    storeReference: evidence.storeReference,
    diningSessionReference: evidence.diningSessionReference,
    orderReference: order.orderReference,
    evidenceVersion: 2,
    evidenceDigest: evidence.evidenceDigest,
    intentHash: hashes.hashIntent(`DINING_UNPAID_BATCH_EXCEPTION:${id(3)}:${id(4)}:${id(5)}:2`),
    requestedAt: evidence.observedAt,
  };
  return { tx, input, options, authorize, fence, routing };
}
it("creates and assigns on original transaction through Task public commands", async () => {
  const f = setup();
  expect(await f.options.authorizeAndFence(f.tx, f.input)).toBe(true);
  const task = await f.options.createAndAssign(f.tx, f.input);
  expect(task).toMatchObject({
    status: "Assigned",
    currentAssignment: { target: { kind: "Queue", reference: id(8) } },
  });
  expect(f.authorize.mock.calls.map(([request]) => request.action)).toEqual([
    "task.create",
    "task.assign",
  ]);
  const options = mock.taskOptions.mock.calls[0]?.[0] as Parameters<
    typeof import("@bop/task").createPostgresTaskStore
  >[0];
  await options.transactions.run(async (tx) => {
    expect(tx).toBe(f.tx);
  });
  expect(mock.commits.mock.calls.map(([mutation]) => mutation.audit.actionCode)).toEqual([
    "TASK_CREATED",
    "TASK_ASSIGNED",
  ]);
});
it("rejects foreign transaction, evidence and actor authorization revocation", async () => {
  const f = setup();
  expect(await f.options.authorizeAndFence({ query: vi.fn() }, f.input)).toBe(false);
  expect(await f.options.authorizeAndFence(f.tx, { ...f.input, evidenceVersion: 3 })).toBe(false);
  f.fence.mockResolvedValue(false);
  await expect(f.options.createAndAssign(f.tx, f.input)).rejects.toThrow();
  expect(mock.commits).not.toHaveBeenCalled();
});
it("propagates Task store failure to enclosing transaction", async () => {
  const f = setup();
  mock.commits.mockRejectedValueOnce(new Error("storage failed"));
  await expect(f.options.createAndAssign(f.tx, f.input)).rejects.toThrow();
  expect(mock.commits).toHaveBeenCalledTimes(1);
});
it("rejects expired routing before task writes", async () => {
  const f = setup();
  f.routing.effectiveUntil = at;
  await expect(f.options.createAndAssign(f.tx, f.input)).rejects.toThrow();
  expect(mock.commits).not.toHaveBeenCalled();
});

it("denied assignment propagates after create and requires enclosing rollback", async () => {
  const f = setup(),
    original = f.authorize.getMockImplementation();
  if (!original) throw new Error("missing fixture authorization");
  f.authorize.mockImplementation(async (request) => {
    if (request.action === "task.assign") throw new Error("denied");
    return original(request);
  });
  await expect(f.options.createAndAssign(f.tx, f.input)).rejects.toThrow();
  expect(mock.commits).toHaveBeenCalledTimes(1);
});
