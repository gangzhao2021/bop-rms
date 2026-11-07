import { beforeEach, expect, it, vi } from "vitest";
const mock = vi.hoisted(() => ({ revision: vi.fn(), delivery: vi.fn() }));
vi.mock("@rms/ordering", async (original) => ({
  ...(await original<typeof import("@rms/ordering")>()),
  createPostgresOrderRevisionPosition: () => mock.revision,
}));
vi.mock("./dining-order-delivery-progress.js", () => ({
  createDiningOrderDeliveryProgress: () => ({ load: mock.delivery }),
}));
import { createDiningOrderExecutionPosition } from "./dining-order-execution-position.js";
const id = (n: number) => "0190fad0-0000-7000-8000-" + String(n).padStart(12, "0");
beforeEach(() => vi.resetAllMocks());
function setup() {
  const scope = { brandReference: id(1), storeReference: id(2) },
    tx = { query: vi.fn() },
    at = "2026-09-20T00:00:00.000Z";
  const input = {
    ...scope,
    transaction: tx,
    orderReference: id(3),
    diningSessionReference: id(4),
    guestSessionReference: id(5),
    observedAt: at,
  };
  const revision = {
    ...scope,
    orderReference: id(3),
    observedAt: at,
    version: 6,
    checkpoint: id(6),
    snapshotDigest: "sha256:" + "a".repeat(64),
    batchReferences: [id(7)],
    terminalOperation: null as string | null,
  };
  const progress = {
    ...scope,
    orderReference: id(3),
    observedAt: at,
    orderVersion: 6,
    phase: "Fulfilled",
    kitchenEvidenceComplete: true,
    items: [
      {
        orderItemReference: id(8),
        orderBatchReference: id(7),
        orderedQuantity: 2,
        deliveredQuantity: 2,
        phase: "Fulfilled",
        everStarted: true,
        everAccepted: true,
        itemServiceVersion: 1n,
      },
    ],
  };
  mock.revision.mockResolvedValue(revision);
  mock.delivery.mockResolvedValue(progress);
  const authorize = vi.fn(async () => true),
    source = createDiningOrderExecutionPosition({
      ...scope,
      diningScope: { tenantReference: id(9), ...scope },
      authorize,
      authorizeKitchen: async () => true,
      authorizeDining: async () => true,
    });
  return { revision, progress, authorize, load: () => source.load(input) };
}
it("reports actual full delivery instead of initial acceptance", async () => {
  const f = setup(),
    result = await f.load();
  expect(result?.phase).toBe("Fulfilled");
  expect(result?.revisionCheckpoint).toBe(id(6));
  expect(result?.kitchenEvidenceComplete).toBe(true);
  expect(Object.isFrozen(result?.items[0])).toBe(true);
});
it("keeps missing Kitchen evidence explicit", async () => {
  const f = setup();
  f.progress.kitchenEvidenceComplete = false;
  expect((await f.load())?.kitchenEvidenceComplete).toBe(false);
});
it("terminal operation cannot masquerade as active delivery state", async () => {
  const f = setup();
  f.revision.terminalOperation = "Termination";
  expect(await f.load()).toBe(null);
  expect(mock.delivery).not.toHaveBeenCalled();
});
it.each(["version", "scope", "time", "batch", "unavailable"])(
  "rejects mixed owner snapshots %s",
  async (kind) => {
    const f = setup();
    if (kind === "version") f.progress.orderVersion = 5;
    if (kind === "scope") f.progress.storeReference = id(40);
    if (kind === "time") f.progress.observedAt = "2026-09-21T00:00:00.000Z";
    if (kind === "batch") f.revision.batchReferences.push(id(40));
    if (kind === "unavailable") mock.delivery.mockResolvedValue(null);
    await expect(f.load()).rejects.toThrow("DINING_ORDER_EXECUTION_POSITION_UNAVAILABLE");
  },
);
it("requires current authority after composition", async () => {
  const f = setup();
  f.authorize.mockResolvedValue(false);
  await expect(f.load()).rejects.toThrow();
});
