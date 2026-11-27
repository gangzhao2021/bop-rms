import { beforeEach, expect, it, vi } from "vitest";
import { createMerchantKitchenStep } from "./merchant-kitchen-step.js";

const doubles = vi.hoisted(() => ({ scope: vi.fn(), chunk: vi.fn() }));
vi.mock("./merchant-store-scope.js", () => ({ createMerchantStoreScope: () => doubles.scope }));
vi.mock("@rms/kitchen", async (original) => ({
  ...(await original<object>()),
  runKitchenWorkStepChunk: doubles.chunk,
}));
const id = (n: number) => "01909985-0000-7000-8000-" + n.toString(16).padStart(12, "0");
const line = (n: number, ticket = 900) => ({
  idempotencyKey: id(n),
  ticketReference: id(ticket),
  workItemReference: id(n + 1000),
  orderItemReference: id(n + 2000),
  optionReferences: null,
});
const tap = (lines: readonly unknown[]) => ({
  sessionCookie: "synthetic-cookie",
  csrf: "synthetic-csrf",
  body: { step: "Finish", storeReference: id(4), correlationReference: id(8), lines },
});
type Options = Parameters<typeof createMerchantKitchenStep>[0];
function setup() {
  const allowed = vi.fn(async () => true);
  const authorize = vi.fn(async () => ({
    sessionReference: id(9),
    policy: { code: "NamedKdsOperator" },
  }));
  const run = vi.fn(async (work: (tx: object) => Promise<unknown>) =>
    work({ query: vi.fn(async () => ({ rows: [], rowCount: 0 })) }),
  );
  doubles.scope.mockResolvedValue({
    actorReference: id(2),
    context: { brand: { brandReference: id(3) } },
    store: { storeReference: id(4) },
    allowed,
  });
  doubles.chunk.mockImplementation(async (_ports, input) => ({
    occurredAt: "2026-09-19T12:00:00.000Z",
    lines: input.lines.map((entry: { workItemReference: string }) => ({
      workItemReference: entry.workItemReference,
      outcome: "Finished",
    })),
  }));
  const validateTicketSource = vi.fn(async () => true);
  const operation = createMerchantKitchenStep({
    persistence: {
      transactions: { run },
      now: () => "2026-09-19T12:00:00.000Z",
    } as unknown as Options["persistence"],
    authentication: { authorize } as unknown as Options["authentication"],
    lifecycle: {} as Options["lifecycle"],
    validateTicketSource,
  });
  return { operation, allowed, authorize, run, validateTicketSource };
}
beforeEach(() => vi.resetAllMocks());

it.each(["WorkforceStandard", "Privileged", undefined])(
  "refuses a %s session before opening a transaction: the same rule as /kitchen/work",
  async (policyCode) => {
    const s = setup();
    s.authorize.mockResolvedValue({
      sessionReference: id(9),
      policy: policyCode ? { code: policyCode } : undefined,
    } as never);
    await expect(s.operation(tap([line(1)]))).rejects.toMatchObject({
      code: "KITCHEN_WORK_PERMISSION_DENIED",
    });
    expect(s.run).not.toHaveBeenCalled();
  },
);
it("refuses a body with more than it should say before opening a transaction", async () => {
  const s = setup();
  await expect(
    s.operation(tap([{ ...line(1), expectedWorkItemVersion: "1" }])),
  ).rejects.toMatchObject({ code: "KITCHEN_WORK_INPUT_INVALID" });
  expect(s.run).not.toHaveBeenCalled();
});
it("refuses a tablet whose selected Store changed in another tab", async () => {
  const s = setup();
  doubles.scope.mockResolvedValue({
    actorReference: id(2),
    context: { brand: { brandReference: id(3) } },
    store: { storeReference: id(5) },
    allowed: s.allowed,
  });
  await expect(s.operation(tap([line(1)]))).rejects.toMatchObject({
    code: "KITCHEN_WORK_PERMISSION_DENIED",
  });
  expect(doubles.chunk).not.toHaveBeenCalled();
});
it("refuses when the kitchen permission is gone, at the start and again before the commit", async () => {
  const s = setup();
  s.allowed.mockResolvedValueOnce(false);
  await expect(s.operation(tap([line(1)]))).rejects.toMatchObject({
    code: "KITCHEN_WORK_PERMISSION_DENIED",
  });
  expect(doubles.chunk).not.toHaveBeenCalled();
  s.allowed.mockResolvedValueOnce(true).mockResolvedValueOnce(false);
  await expect(s.operation(tap([line(1)]))).rejects.toMatchObject({
    code: "KITCHEN_WORK_PERMISSION_DENIED",
  });
});
it("runs a big tap in chunks, each its own authorized transaction, and replies line by line", async () => {
  const s = setup();
  const lines = Array.from({ length: 20 }, (_, n) => line(n + 1));
  const reply = await s.operation(tap(lines));
  expect(s.run).toHaveBeenCalledTimes(3);
  expect(s.allowed).toHaveBeenCalledTimes(6);
  expect(doubles.chunk.mock.calls.map(([, input]) => input.lines.length)).toEqual([8, 8, 4]);
  expect(reply.lines.map((entry) => entry.workItemReference)).toEqual(
    lines.map((entry) => entry.workItemReference),
  );
  expect(reply).toMatchObject({
    projectionName: "kitchen_work_queue_v1",
    projectionPending: true,
    occurredAt: "2026-09-19T12:00:00.000Z",
  });
});
it("a failed chunk leaves the rest not attempted; with nothing committed the tap fails as a whole", async () => {
  const s = setup();
  const lines = Array.from({ length: 20 }, (_, n) => line(n + 1));
  doubles.chunk
    .mockImplementationOnce(async (_ports, input) => ({
      occurredAt: "2026-09-19T12:00:00.000Z",
      lines: input.lines.map((entry: { workItemReference: string }) => ({
        workItemReference: entry.workItemReference,
        outcome: "Finished",
      })),
    }))
    .mockRejectedValueOnce(new Error("synthetic chunk failure"));
  const reply = await s.operation(tap(lines));
  expect(reply.lines.filter((entry) => entry.outcome === "Finished")).toHaveLength(8);
  expect(reply.lines.filter((entry) => entry.outcome === "NotAttempted")).toHaveLength(12);
  expect(doubles.chunk).toHaveBeenCalledTimes(2);
  doubles.chunk.mockReset();
  doubles.chunk.mockRejectedValueOnce(new Error("synthetic chunk failure"));
  await expect(s.operation(tap(lines))).rejects.toThrow("synthetic chunk failure");
});
it("reruns a chunk that only met a database conflict", async () => {
  const s = setup();
  doubles.chunk
    .mockRejectedValueOnce(
      Object.assign(new Error("synthetic"), { code: "TENANT_DATABASE_TRANSACTION_CONFLICT" }),
    )
    .mockImplementationOnce(async (_ports, input) => ({
      occurredAt: "2026-09-19T12:00:00.000Z",
      lines: input.lines.map((entry: { workItemReference: string }) => ({
        workItemReference: entry.workItemReference,
        outcome: "Finished",
      })),
    }));
  const reply = await s.operation(tap([line(1)]));
  expect(reply.lines[0]?.outcome).toBe("Finished");
  expect(doubles.chunk).toHaveBeenCalledTimes(2);
});
