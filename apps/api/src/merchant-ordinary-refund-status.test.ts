import { beforeEach, expect, it, vi } from "vitest";
import { createMerchantOrdinaryRefundStatus } from "./merchant-ordinary-refund-status.js";
const d = vi.hoisted(() => ({
  resolve: vi.fn(),
  workforce: vi.fn(),
  context: vi.fn(),
  order: vi.fn(),
  capture: vi.fn(),
  status: vi.fn(),
}));
vi.mock("./merchant-store-scope.js", () => ({ createMerchantStoreScope: () => d.resolve }));
vi.mock("./merchant-workforce-authority-source.js", () => ({
  createMerchantWorkforcePermissionSource: () => d.workforce,
}));
vi.mock("@rms/payment", async (original) => ({
  ...(await original<object>()),
  createPostgresOrdinaryRefundRequestStatusSource: () => d.status,
  createPostgresCapturedBatchPaymentSource: () => ({ load: d.capture }),
}));
vi.mock("@rms/ordering", async (original) => ({
  ...(await original<object>()),
  createPostgresReceiptOrderSource: () => d.order,
}));
const id = (n: number) => "01909974-0000-7000-8000-" + n.toString(16).padStart(12, "0");
type Options = Parameters<typeof createMerchantOrdinaryRefundStatus>[0];
const at = "2026-09-20T12:00:00.000Z";
function setup() {
  const tx = {},
    allowed = vi.fn(async () => true);
  const current = {
    selected: { tenantReference: id(1) },
    context: { brand: { brandReference: id(2) }, resolvedAt: at },
    store: { storeReference: id(3) },
    actorReference: id(4),
    allowed,
  };
  d.resolve.mockResolvedValue(current);
  const run = vi.fn(async (work: (tx: object) => Promise<unknown>) => work(tx));
  const authorize = vi.fn(async () => ({ sessionReference: id(5) }));
  const configure = vi.fn(async () => ({
    providerAccountReference: id(6),
    environment: "Test" as const,
    roleMapping: { Manager: ["manager"], Owner: ["owner"], Finance: [] },
  }));
  const operation = createMerchantOrdinaryRefundStatus({
    persistence: { transactions: { run } } as unknown as Options["persistence"],
    authentication: { authorize } as unknown as Options["authentication"],
    resolveConfiguration: configure,
  });
  const input = {
    sessionCookie: "synthetic-cookie",
    csrf: "synthetic-csrf",
    query: { orderReference: id(8), operationReference: id(9) },
  };
  return { tx, allowed, run, authorize, configure, operation, input };
}

beforeEach(() => {
  vi.resetAllMocks();
  d.workforce.mockResolvedValue({ decision: { effect: "Allow" }, activeRoleCodes: ["manager"] });
  d.status.mockResolvedValue({ requestReference: id(10), observedAt: at });
});
it("queries exact request status under current Manager permission", async () => {
  const f = setup();
  expect(await f.operation(f.input)).toEqual({ requestReference: id(10), observedAt: at });
  expect(d.status).toHaveBeenCalledWith(expect.anything(), {
    orderReference: id(8),
    operationReference: id(9),
    observedAt: at,
  });
});
it("denies current non-Manager requester before querying status", async () => {
  const f = setup();
  d.workforce.mockResolvedValue({ decision: { effect: "Allow" }, activeRoleCodes: ["owner"] });
  await expect(f.operation(f.input)).rejects.toThrow();
  expect(d.status).not.toHaveBeenCalled();
});
it("denies browser authority fields", async () => {
  const f = setup();
  await expect(
    f.operation({ ...f.input, query: { ...f.input.query, actorReference: id(99) } }),
  ).rejects.toThrow();
  expect(d.status).not.toHaveBeenCalled();
});
