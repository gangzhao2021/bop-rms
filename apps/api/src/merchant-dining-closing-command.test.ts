vi.mock("./dining-table-release-composition.js", () => ({
  createDiningTableReleaseComposition: () => mock.release,
}));
import { beforeEach, expect, it, vi } from "vitest";
const mock = vi.hoisted(() => ({
  scope: vi.fn(),
  fence: vi.fn(),
  receipt: vi.fn(),
  begin: vi.fn(),
  finalize: vi.fn(),
  ports: vi.fn(),
  release: vi.fn(),
}));
vi.mock("./merchant-store-scope.js", () => ({ createMerchantStoreScope: () => mock.scope }));
vi.mock("@rms/dining", async (original) => ({
  ...(await original<typeof import("@rms/dining")>()),
  createPostgresDiningClosingFence: () => mock.fence,
  createPostgresDiningClosingStore: () => ({ readReceipt: mock.receipt }),
  createDiningClosingService: (ports: unknown) => {
    mock.ports(ports);
    return { begin: mock.begin, finalize: mock.finalize };
  },
}));
import { createMerchantDiningClosingCommand } from "./merchant-dining-closing-command.js";
const id = (n: number) => "0190fad7-0000-7000-8000-" + String(n).padStart(12, "0"),
  at = "2026-09-20T00:00:00.000Z";
beforeEach(() => vi.resetAllMocks());
function setup() {
  const allowed = vi.fn(async () => true),
    authenticate = vi.fn(async () => ({ sessionReference: id(8) })),
    tx = { query: vi.fn() },
    run = vi.fn(async (work: (tx: object) => Promise<unknown>) => work(tx));
  mock.scope.mockResolvedValue({
    selected: { tenantReference: id(1) },
    context: { brand: { brandReference: id(2) }, resolvedAt: at },
    store: { storeReference: id(3) },
    actorReference: id(4),
    allowed,
    authorizeAction: vi.fn(),
  });
  mock.fence.mockResolvedValue({
    diningSessionReference: id(5),
    version: 2,
    tableAssignmentVersion: 1,
  });
  mock.receipt.mockResolvedValue(null);
  mock.begin.mockResolvedValue({ status: "Applied", session: { phase: "Closing", version: 3 } });
  mock.finalize.mockResolvedValue({ status: "Applied", session: { phase: "Closed", version: 3 } });
  const handler = createMerchantDiningClosingCommand({
    persistence: { transactions: { run } } as unknown as Parameters<
      typeof createMerchantDiningClosingCommand
    >[0]["persistence"],
    authentication: { authorize: authenticate } as unknown as Parameters<
      typeof createMerchantDiningClosingCommand
    >[0]["authentication"],
    providerAccountReference: id(9),
    environment: "Test",
    newReference: () => id(10),
    retentionPolicyCode: "ORDER_AUDIT",
    retentionPolicyVersion: 1,
  });
  const input = {
    sessionCookie: "synthetic",
    csrf: "synthetic",
    command: {
      action: "Begin",
      diningSessionReference: id(5),
      operationReference: id(6),
      expectedSessionVersion: 2,
    },
  };
  return { allowed, authenticate, run, input, handler };
}
it.each(["Begin", "Finalize"])("routes %s through domain with server time", async (action) => {
  const f = setup();
  f.input.command.action = action;
  const result = await f.handler(f.input);
  expect(result.status).toBe("Applied");
  expect(action === "Begin" ? mock.begin : mock.finalize).toHaveBeenCalledWith({
    diningSessionReference: id(5),
    operationReference: id(6),
    expectedSessionVersion: 2,
    requestedAt: at,
  });
});
it("returns matching historical retry without reapplying transition", async () => {
  const f = setup();
  mock.receipt.mockResolvedValue({
    record: {
      action: "Begin",
      session: { diningSessionReference: id(5), version: 2, phase: "Closing" },
    },
    expectedVersion: 2,
    occurredAt: at,
  });
  expect(await f.handler(f.input)).toEqual({
    status: "AlreadyApplied",
    phase: "Closing",
    sessionVersion: 2,
  });
  expect(mock.begin).not.toHaveBeenCalled();
});
it("rejects conflicting retry action", async () => {
  const f = setup();
  mock.receipt.mockResolvedValue({
    record: { action: "Finalize", session: { diningSessionReference: id(5), version: 2 } },
    expectedVersion: 2,
    occurredAt: at,
  });
  await expect(f.handler(f.input)).rejects.toThrow();
});
it("rejects absent current permission before fence", async () => {
  const f = setup();
  f.allowed.mockResolvedValue(false);
  await expect(f.handler(f.input)).rejects.toThrow();
  expect(mock.fence).not.toHaveBeenCalled();
});
it("rejects CSRF failure before transaction", async () => {
  const f = setup();
  f.authenticate.mockRejectedValue(new Error("denied"));
  await expect(f.handler(f.input)).rejects.toThrow();
  expect(f.run).not.toHaveBeenCalled();
});
it("rejects caller time and unsupported Cancel", async () => {
  const f = setup();
  await expect(
    f.handler({ ...f.input, command: { ...f.input.command, requestedAt: at } }),
  ).rejects.toThrow();
  f.input.command.action = "Cancel";
  await expect(f.handler(f.input)).rejects.toThrow();
});

it("releases table only after Finalize with the resulting session version", async () => {
  const f = setup();
  f.input.command.action = "Finalize";
  await f.handler(f.input);
  expect(mock.release).toHaveBeenCalledWith(expect.anything(), {
    diningSessionReference: id(5),
    operationReference: id(6),
    expectedSessionVersion: 3,
    observedAt: at,
  });
  expect(mock.finalize.mock.invocationCallOrder[0]).toBeLessThan(
    mock.release.mock.invocationCallOrder[0] ?? 0,
  );
});
it("fails the outer command if table release fails", async () => {
  const f = setup();
  f.input.command.action = "Finalize";
  mock.release.mockRejectedValue(new Error("release"));
  await expect(f.handler(f.input)).rejects.toThrow("release");
});
it("repairs matching old Finalize via release without repeating session transition", async () => {
  const f = setup();
  f.input.command.action = "Finalize";
  mock.fence.mockResolvedValue({ version: 3 });
  mock.receipt.mockResolvedValue({
    record: {
      action: "Finalize",
      session: { diningSessionReference: id(5), version: 3, phase: "Closed" },
    },
    expectedVersion: 2,
    occurredAt: at,
  });
  expect((await f.handler(f.input)).status).toBe("AlreadyApplied");
  expect(mock.finalize).not.toHaveBeenCalled();
  expect(mock.release).toHaveBeenCalledTimes(1);
});
