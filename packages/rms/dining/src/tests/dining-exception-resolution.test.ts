import { createHash } from "node:crypto";
import { expect, it, vi } from "vitest";
import {
  createDiningExceptionResolution,
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

function setup(currentTask: unknown = task) {
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
    observedAt: at,
  };
  const fact = {
    ...scope,
    orderReference: id(5),
    orderVersion: 3,
    observedAt: at,
    financialClass: "Settled",
    ownerFinalityReference: id(20),
    ownerDecidedAt: at,
  };
  const association = vi.fn(async () => link as unknown),
    financial = vi.fn(async () => fact as unknown),
    authorize = vi.fn(async () => true),
    source = createDiningExceptionResolution({ scope, association, financial, authorize });
  return {
    link,
    fact,
    association,
    financial,
    authorize,
    run: (orderReference: string = id(5)) =>
      source.resolve(
        {},
        { task: currentTask, orderReference, expectedOrderVersion: 3, observedAt: at },
      ),
  };
}
it("clears own source from current finality without requiring Order alreadyClosed", async () => {
  const f = setup();
  expect((await f.run()).outcome).toBe("Cleared");
});
it("another Order remains independent; no financial lookup or paid claim", async () => {
  const f = setup();
  expect((await f.run(id(99))).outcome).toBe("NotApplicable");
  expect(f.financial).not.toHaveBeenCalled();
});
it.each(["Unpaid", "Indeterminate"])("keeps %s blocking", async (financialClass) => {
  const f = setup();
  f.financial.mockResolvedValue({
    ...f.fact,
    financialClass,
    ownerFinalityReference: null,
    ownerDecidedAt: null,
  });
  expect((await f.run()).outcome).toBe("Blocking");
});
it.each(["association", "financial"] as const)("missing %s is Unknown", async (key) => {
  const f = setup();
  f[key].mockResolvedValue(null);
  expect((await f.run()).outcome).toBe("Unknown");
});
it.each([
  { storeReference: id(99) },
  { taskVersion: 99 },
  { orderReference: "invalid" },
  { observedAt: "2026-09-21T00:00:00.000Z" },
])("rejects mixed source association %#", async (change) => {
  const f = setup();
  f.association.mockResolvedValue({ ...f.link, ...change });
  await expect(f.run()).rejects.toThrow();
});
it.each([
  { orderReference: id(99) },
  { ownerFinalityReference: null },
  { ownerDecidedAt: "2026-09-21T00:00:00.000Z" },
  { observedAt: "2026-09-21T00:00:00.000Z" },
  { orderVersion: 0 },
  { orderVersion: 2 },
])("rejects invalid financial evidence %#", async (change) => {
  const f = setup();
  f.financial.mockResolvedValue({ ...f.fact, ...change });
  await expect(f.run()).rejects.toThrow();
});
it("rechecks authority even on nonapplicable source", async () => {
  const f = setup();
  f.authorize.mockResolvedValueOnce(true).mockResolvedValue(false);
  await expect(f.run(id(99))).rejects.toThrow();
});

it("a cancelled Task does not clear an unpaid source", async () => {
  const f = setup({
    ...task,
    status: "Cancelled",
    version: 3,
    terminalOutcome: {
      outcomeReference: id(30),
      kind: "Cancelled",
      resultCode: "INTERNAL_TEST",
      completionReference: null,
      decidedBy: id(9),
      occurredAt: at,
    },
  });
  f.link.taskVersion = 3;
  f.financial.mockResolvedValue({
    ...f.fact,
    financialClass: "Unpaid",
    ownerFinalityReference: null,
    ownerDecidedAt: null,
  });
  expect((await f.run()).outcome).toBe("Blocking");
});
