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
const observations = vi.hoisted(() => ({
  at: null as string | null,
  calls: [] as string[],
}));
vi.mock("@rms/payment", async (original) => ({
  ...(await original<object>()),
  // v15 2026-10-18: the time read once the Order's refund fence is held (recorded per call).
  observeOrdinaryRefundOrderAfterFence: async (
    _tx: unknown,
    _scope: unknown,
    orderReference: string,
    notBefore: string,
  ) => {
    observations.calls.push(orderReference);
    return observations.at ?? notBefore;
  },
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
    kdsOperatorProfileAllows: () => true,
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
  observations.at = null;
  observations.calls.length = 0;
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
it("v15 2026-10-18 (dd750045): reads the request status at the time taken once the Order's refund fence is held", async () => {
  const f = setup();
  const later = "2026-09-20T12:00:02.000Z";
  observations.at = later;
  await f.operation(f.input);
  expect(observations.calls).toEqual([id(8)]);
  expect(d.status).toHaveBeenCalledWith(expect.anything(), {
    orderReference: id(8),
    operationReference: id(9),
    observedAt: later,
  });
});
it("denies current non-Manager requester before querying status", async () => {
  const f = setup();
  d.workforce.mockResolvedValue({ decision: { effect: "Allow" }, activeRoleCodes: ["kitchen"] });
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
