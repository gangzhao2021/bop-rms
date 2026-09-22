import { beforeEach, expect, it, vi } from "vitest";
import { createMerchantDiningItemService } from "./merchant-dining-item-service.js";

const doubles = vi.hoisted(() => ({
  resolve: vi.fn(),
  compose: vi.fn(),
  commit: vi.fn(),
}));
vi.mock("./merchant-store-scope.js", () => ({
  createMerchantStoreScope: () => doubles.resolve,
}));
vi.mock("./merchant-dining-item-service-composition.js", () => ({
  createMerchantDiningItemServiceComposition: doubles.compose,
}));
const id = (n: number) => "01909985-0000-7000-8000-" + n.toString(16).padStart(12, "0");
const at = "2026-09-13T12:00:01.000Z";
const record = () => ({
  serviceReference: id(1),
  operationReference: id(2),
  tenantReference: id(3),
  brandReference: id(4),
  storeReference: id(5),
  diningSessionReference: id(6),
  tableReference: id(7),
  orderReference: id(8),
  orderBatchReference: id(9),
  orderItemReference: id(10),
  actorReference: id(11),
  sourceCheckpoint: id(12),
  auditReference: id(13),
  sessionVersion: 2,
  tableAssignmentVersion: 3,
  expectedOrderVersion: 5,
  expectedItemServiceVersion: 0,
  itemServiceVersion: 1,
  quantity: 1,
  purposeCode: "ServeDiningOrderItem",
  permissionCode: "dining.item.serve",
  servedAt: at,
  recordedAt: at,
  sourceDigest: "a".repeat(64),
});
type Options = Parameters<typeof createMerchantDiningItemService>[0];
function setup() {
  const tx = {};
  const allowed = vi.fn(async () => true);
  const authenticate = vi.fn(async () => ({ sessionReference: id(20) }));
  doubles.resolve.mockResolvedValue({
    selected: { tenantReference: id(3) },
    context: { brand: { brandReference: id(4) } },
    store: { storeReference: id(5) },
    actorReference: id(11),
    allowed,
  });
  const run = vi.fn(async (work: (transaction: object) => Promise<unknown>) => work(tx));
  const source = vi.fn(async () => true);
  const operation = createMerchantDiningItemService({
    // Adapter-only doubles; actual scope sources are separately persisted implementations.
    persistence: { transactions: { run }, now: () => at } as unknown as Options["persistence"],
    authentication: { authorize: authenticate } as unknown as Options["authentication"],
    validateSource: source,
    audit: {
      reasonCode: "SYNTHETIC_SERVICE",
      retentionPolicyCode: "FINANCIAL_COMPLIANCE",
      retentionPolicyVersion: 1,
    },
  });
  const input = {
    sessionCookie: "synthetic-cookie",
    csrf: "synthetic-csrf",
    command: { record: record(), guestSessionReference: id(21) },
  };
  return { operation, input, allowed, authenticate, run, tx, source };
}
beforeEach(() => {
  vi.clearAllMocks();
  doubles.commit.mockResolvedValue({ status: "Created" });
  doubles.compose.mockImplementation(() => ({ commit: doubles.commit }));
});
it("binds expected authenticated session, selected scope and server Audit", async () => {
  const f = setup();
  await f.operation(f.input);
  expect(doubles.resolve).toHaveBeenCalledWith(
    f.tx,
    f.input.sessionCookie,
    "dining.item.serve",
    id(20),
  );
  expect(doubles.commit).toHaveBeenCalledWith({
    transaction: expect.objectContaining({ query: expect.any(Function) }),
    record: record(),
    guestSessionReference: id(21),
  });
  const options = doubles.compose.mock.calls[0]?.[0];
  expect(options.validateSource).toBe(f.source);
  expect(await options.audit(record())).toMatchObject({
    actor: { type: "User", reference: id(11) },
    actionCode: "DINING_ITEM_SERVED",
    sourceChannel: "MERCHANT_WEB",
    dataClassification: "Restricted",
    afterSummary: { quantity: 1, version: 1 },
  });
  f.allowed.mockResolvedValue(false);
  expect(await options.authorize(f.tx, record())).toBe(false);
});
it("rejects CSRF/session failure before opening a transaction", async () => {
  const f = setup();
  f.authenticate.mockRejectedValue(new Error("denied"));
  await expect(f.operation(f.input)).rejects.toThrow();
  expect(f.run).not.toHaveBeenCalled();
  expect(doubles.compose).not.toHaveBeenCalled();
});
it.each(["actorReference", "tenantReference", "brandReference", "storeReference"] as const)(
  "rejects forged %s before composition",
  async (key) => {
    const f = setup();
    f.input.command.record[key] = id(99);
    await expect(f.operation(f.input)).rejects.toThrow("PERMISSION_DENIED");
    expect(doubles.compose).not.toHaveBeenCalled();
  },
);
it("rejects a denied action before composition", async () => {
  const f = setup();
  f.allowed.mockResolvedValue(false);
  await expect(f.operation(f.input)).rejects.toThrow("PERMISSION_DENIED");
  expect(doubles.compose).not.toHaveBeenCalled();
});
