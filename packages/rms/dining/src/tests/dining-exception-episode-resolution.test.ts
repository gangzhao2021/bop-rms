import { createHash } from "node:crypto";
import { expect, it, vi } from "vitest";
import {
  createDiningExceptionEpisodeResolution,
  parseDiningHash,
  parseDiningInstant,
  parseDiningReference,
} from "../index.js";
import type { EnsureDiningExceptionTaskInput } from "../application/ports/dining-closing-ports.js";
const id = (n: number) =>
  parseDiningReference("0190fac7-0000-7000-8000-" + String(n).padStart(12, "0"));
const at = parseDiningInstant("2026-09-20T00:00:00.000Z");
const hashes = {
  hashIntent: (value: string) => parseDiningHash(createHash("sha256").update(value).digest("hex")),
  equals: (a: string, b: string) => a === b,
};
const scope = { tenantReference: id(1), brandReference: id(2), storeReference: id(3) };
function request(order = id(5)): EnsureDiningExceptionTaskInput {
  return {
    purpose: "DINING_UNPAID_BATCH_EXCEPTION",
    brandReference: id(2),
    storeReference: id(3),
    diningSessionReference: id(4),
    orderReference: order,
    evidenceVersion: 1,
    evidenceDigest: parseDiningHash("a".repeat(64)),
    intentHash: hashes.hashIntent(`DINING_UNPAID_BATCH_EXCEPTION:${id(3)}:${id(4)}:${order}:1`),
    requestedAt: at,
  };
}
const assignment = {
  assignmentReference: id(7),
  target: { kind: "Queue", reference: id(8) },
  assignedBy: id(9),
  assignedAt: at,
  reasonCode: "MANAGER_REVIEW",
};
const task = {
  taskReference: id(6),
  scope: { kind: "Store", brandReference: id(2), storeReference: id(3) },
  source: {
    sourceType: "DINING_SESSION",
    sourceReference: id(4),
    snapshotDigest: "sha256:" + "a".repeat(64),
  },
  taskType: "DINING_UNPAID_BATCH_EXCEPTION",
  severityCode: "CRITICAL",
  priorityCode: "CRITICAL",
  status: "Assigned",
  assignmentHistory: [assignment],
  currentAssignment: assignment,
  claimHistory: [],
  currentClaim: null,
  dueAt: at,
  escalationPolicyReference: id(10),
  escalationHistory: [],
  terminalOutcome: null,
  version: 2,
  createdAt: at,
  updatedAt: at,
};

function setup() {
  const observedAt = parseDiningInstant("2026-09-20T00:03:00.000Z");
  const link = {
    ...scope,
    diningSessionReference: id(4),
    orderReference: id(5),
    evidenceVersion: 1,
    evidenceDigest: request().evidenceDigest,
    intentHash: request().intentHash,
    taskReference: task.taskReference,
    taskVersion: task.version,
    requestedAt: at,
    observedAt,
  };
  const fact = {
    ...scope,
    orderReference: id(5),
    orderVersion: 3,
    closureReference: id(30),
    closureVersion: 1,
    closedAt: "2026-09-20T00:02:00.000Z",
    ownerFinalityReference: id(31),
    ownerDecidedAt: "2026-09-20T00:01:00.000Z",
    observedAt,
  };
  const association = vi.fn(async () => link as unknown),
    closure = vi.fn(async () => fact as unknown),
    authorize = vi.fn(async () => true),
    tx = {};
  const input = { task, orderReference: id(5), expectedOrderVersion: 4, observedAt };
  const service = createDiningExceptionEpisodeResolution({
    scope,
    association,
    closure,
    authorize,
  });
  return {
    fact,
    link,
    closure,
    association,
    authorize,
    input,
    run: () => service.resolve(tx, input),
  };
}
it("resolves an earlier episode from committed owner closure without claiming current-version financial clearance", async () => {
  const f = setup();
  expect(await f.run()).toMatchObject({
    outcome: "ResolvedEpisode",
    orderVersion: 4,
    historicalOrderVersion: 3,
    closureReference: id(30),
    ownerFinalityReference: id(31),
    resolvedAt: f.fact.closedAt,
  });
  expect(f.association).toHaveBeenCalledTimes(1);
  expect(f.closure).toHaveBeenCalledWith(
    {},
    { orderReference: id(5), requestedAt: at, observedAt: f.input.observedAt },
  );
});
it("keeps a new or equal-clock episode unresolved by earlier settlement", async () => {
  for (const requestedAt of ["2026-09-20T00:01:00.000Z", "2026-09-20T00:02:30.000Z"]) {
    const f = setup();
    f.link.requestedAt = parseDiningInstant(requestedAt);
    expect(await f.run()).toMatchObject({
      outcome: "UnresolvedEpisode",
      ownerFinalityReference: null,
      closureReference: null,
    });
  }
});
it("does not infer a historical result from absent owner facts or unrelated Order", async () => {
  const f = setup();
  f.closure.mockResolvedValueOnce(null);
  expect((await f.run()).outcome).toBe("UnresolvedEpisode");
  f.association.mockResolvedValueOnce(null);
  f.closure.mockClear();
  expect((await f.run()).outcome).toBe("UnresolvedEpisode");
  expect(f.closure).not.toHaveBeenCalled();
  f.input.orderReference = id(99);
  expect((await f.run()).outcome).toBe("NotApplicable");
  expect(f.closure).not.toHaveBeenCalled();
});
it("refuses malformed, crossscope, future and version-inconsistent closure facts", async () => {
  for (const change of [
    { storeReference: id(99) },
    { orderReference: id(99) },
    { orderVersion: 5 },
    { ownerDecidedAt: "2026-09-20T00:02:30.000Z" },
    { closedAt: "2026-09-21T00:00:00.000Z" },
    { ownerFinalityReference: null },
    { extra: true },
  ]) {
    const f = setup();
    f.closure.mockResolvedValue({ ...f.fact, ...change });
    await expect(f.run()).rejects.toMatchObject({ code: "DINING_CLOSING_DEPENDENCY_UNAVAILABLE" });
  }
});
it("rechecks authority after owner evidence and never returns a revoked resolution", async () => {
  const f = setup();
  f.closure.mockImplementation(async () => {
    f.authorize.mockResolvedValue(false);
    return f.fact;
  });
  await expect(f.run()).rejects.toMatchObject({ code: "DINING_CLOSING_DEPENDENCY_UNAVAILABLE" });
});
