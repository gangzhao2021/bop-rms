import { createHash } from "node:crypto";
import { expect, it, vi } from "vitest";
import { parsePolicyReference, parsePolicyVersion, type PermissionDecision } from "@bop/permission";
import type { TaskPorts, CommitTaskMutationInput, CreateTaskInput } from "@bop/task";
import {
  createDiningExceptionTaskCreator,
  parseDiningReference,
  parseDiningHash,
  parseDiningInstant,
} from "../index.js";
const id = (n: number) =>
  parseDiningReference("0190fac8-0000-7000-8000-" + String(n).padStart(12, "0"));
const at = parseDiningInstant("2026-09-20T00:00:00.000Z");
const hashes = {
  hashIntent: (value: string) => parseDiningHash(createHash("sha256").update(value).digest("hex")),
  equals: (a: string, b: string) => a === b,
};
const input = {
  purpose: "DINING_UNPAID_BATCH_EXCEPTION" as const,
  brandReference: id(1),
  storeReference: id(2),
  diningSessionReference: id(3),
  orderReference: id(4),
  evidenceVersion: 1,
  evidenceDigest: parseDiningHash("a".repeat(64)),
  intentHash: hashes.hashIntent(`DINING_UNPAID_BATCH_EXCEPTION:${id(2)}:${id(3)}:${id(4)}:1`),
  requestedAt: at,
};
function fixture(denyAssign = false) {
  const commits: CommitTaskMutationInput[] = [],
    actions: string[] = [],
    tx = Object.freeze({ synthetic: true });
  let counter = 100;
  const config = {
    actorReference: id(5) as unknown as CreateTaskInput["actorReference"],
    managerQueueReference: id(6) as string,
    escalationPolicyReference: id(7),
    dueAt: at as string,
    correlationReference: id(8),
    sourceChannel: "MERCHANT_WEB",
  };
  const ports: TaskPorts = {
    authorization: {
      authorize: async (request) => {
        actions.push(request.action);
        const deny = denyAssign && request.action === "task.assign";
        return Object.freeze({
          effect: deny ? "Deny" : "Allow",
          reason: deny ? "DEFAULT_DENY" : "EXPLICIT_ALLOW",
          source: deny ? "DefaultDeny" : "ExplicitAllow",
          action: request.action,
          scopeKind: "Store",
          policySnapshotReference: parsePolicyReference(id(9)),
          policyVersion: parsePolicyVersion(1),
          audit: Object.freeze({
            effect: deny ? "Deny" : "Allow",
            reason: deny ? "DEFAULT_DENY" : "EXPLICIT_ALLOW",
            source: deny ? "DefaultDeny" : "ExplicitAllow",
          }),
        }) as PermissionDecision;
      },
    },
    eligibility: {
      resolve: async () => {
        throw new Error("unexpected");
      },
    },
    unitOfWork: {
      commit: async (mutation) => {
        commits.push(mutation);
      },
    },
    notifications: {
      requestEscalation: async () => {
        throw new Error("unexpected");
      },
    },
  };
  const resolve = vi.fn(async () => config),
    getPorts = vi.fn((actual: typeof tx) => {
      expect(actual).toBe(tx);
      return ports;
    }),
    newReference = vi.fn(() => id(counter++));
  const creator = createDiningExceptionTaskCreator({
    resolve,
    ports: getPorts,
    newReference,
    hashes,
  });
  return { creator, tx, config, commits, actions, resolve, newReference };
}
it("uses public Task permissions, audit and independent operations for critical Manager assignment", async () => {
  const f = fixture(),
    task = await f.creator(f.tx, input);
  expect(f.actions).toEqual(["task.create", "task.assign"]);
  expect(task.status).toBe("Assigned");
  expect(task.currentAssignment?.target).toEqual({ kind: "Queue", reference: id(6) });
  expect(task.priorityCode).toBe("CRITICAL");
  expect(task.source.sourceReference).toBe(id(3));
  expect(f.commits.map((c) => c.audit.actionCode)).toEqual(["TASK_CREATED", "TASK_ASSIGNED"]);
  expect(f.commits[0]?.idempotencyKey).not.toBe(f.commits[1]?.idempotencyKey);
  expect(f.commits[0]?.requestDigest).not.toBe(f.commits[1]?.requestDigest);
  expect(f.resolve).toHaveBeenCalledWith(f.tx, input);
});
it("propagates assignment denial so the outer transaction can roll back creation", async () => {
  const f = fixture(true);
  await expect(f.creator(f.tx, input)).rejects.toMatchObject({
    code: "DINING_CLOSING_TASK_REQUIRED",
  });
  expect(f.commits).toHaveLength(1);
  expect(f.actions).toEqual(["task.create", "task.assign"]);
});
it.each(["queue", "due"])(
  "rejects missing or expired server configuration %s before writing",
  async (field) => {
    const f = fixture();
    if (field === "queue") f.config.managerQueueReference = "";
    else f.config.dueAt = "2026-09-19T23:59:59.000Z";
    await expect(f.creator(f.tx, input)).rejects.toMatchObject({
      code: "DINING_CLOSING_TASK_REQUIRED",
    });
    expect(f.commits).toHaveLength(0);
  },
);
it("captures request before asynchronous resolution", async () => {
  const f = fixture(),
    mutable = { ...input };
  f.resolve.mockImplementation(async () => {
    mutable.evidenceDigest = parseDiningHash("b".repeat(64));
    return f.config;
  });
  const task = await f.creator(f.tx, mutable);
  expect(task.source.snapshotDigest).toBe("sha256:" + "a".repeat(64));
});
it("rejects forged intent and duplicate generated identities before writing", async () => {
  const f = fixture();
  await expect(f.creator(f.tx, { ...input, orderReference: id(99) })).rejects.toMatchObject({
    code: "DINING_CLOSING_TASK_REQUIRED",
  });
  expect(f.resolve).not.toHaveBeenCalled();
  f.newReference.mockReturnValue(id(100));
  await expect(f.creator(f.tx, input)).rejects.toMatchObject({
    code: "DINING_CLOSING_TASK_REQUIRED",
  });
  expect(f.commits).toHaveLength(0);
});
