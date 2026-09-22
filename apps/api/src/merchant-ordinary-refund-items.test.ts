import { beforeEach, expect, it, vi } from "vitest";
import { createMerchantOrdinaryRefundItems } from "./merchant-ordinary-refund-items.js";
const d = vi.hoisted(() => ({
  resolve: vi.fn(),
  workforce: vi.fn(),
  context: vi.fn(),
  order: vi.fn(),
  capture: vi.fn(),
}));
vi.mock("./merchant-store-scope.js", () => ({ createMerchantStoreScope: () => d.resolve }));
vi.mock("./merchant-workforce-authority-source.js", () => ({
  createMerchantWorkforcePermissionSource: () => d.workforce,
}));
vi.mock("@rms/payment", async (original) => ({
  ...(await original<object>()),
  createPostgresOrdinaryRefundRequestContextSource: () => d.context,
  createPostgresCapturedBatchPaymentSource: () => ({ load: d.capture }),
}));
vi.mock("@rms/ordering", async (original) => ({
  ...(await original<object>()),
  createPostgresReceiptOrderSource: () => d.order,
}));
const id = (n: number) => "01909974-0000-7000-8000-" + n.toString(16).padStart(12, "0");
type Options = Parameters<typeof createMerchantOrdinaryRefundItems>[0];
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
  const operation = createMerchantOrdinaryRefundItems({
    persistence: { transactions: { run } } as unknown as Options["persistence"],
    authentication: { authorize } as unknown as Options["authentication"],
    resolveConfiguration: configure,
    newReference: () => id(7),
    locale: "en-CA",
  });
  const input = {
    sessionCookie: "synthetic-cookie",
    csrf: "synthetic-csrf",
    query: { orderReference: id(8) },
  };
  return { tx, allowed, run, authorize, configure, operation, input };
}
beforeEach(() => {
  vi.clearAllMocks();
  d.workforce.mockResolvedValue({ decision: { effect: "Allow" }, activeRoleCodes: ["manager"] });
  d.context.mockResolvedValue({
    existing: null,
    history: [
      {
        requestReference: id(40),
        operationReference: id(41),
        expectedClaimVersion: 0,
        requestedAt: "2026-09-20T12:00:00.000Z",
        reasonCode: "CUSTOMER_REQUEST",
        currencyCode: "CAD",
        amountMinor: 1130n,
        payments: [{ items: [{ orderItemReference: id(12), refundUnitOrdinals: [1] }] }],
      },
    ],
  });
  d.order.mockResolvedValue({
    orderNumber: "12",
    guestSessionReference: "private",
    batches: [{ orderBatchReference: id(11) }, { orderBatchReference: id(21) }],
    items: [
      {
        snapshot: {
          orderBatchReference: id(11),
          orderItemReference: id(12),
          quantity: 3,
          catalog: { localizedNames: { "en-CA": "Latte" } },
          customerNote: "private",
        },
      },
      {
        snapshot: {
          orderBatchReference: id(21),
          orderItemReference: id(22),
          quantity: 1,
          catalog: { localizedNames: { "en-CA": "Tea" } },
        },
      },
    ],
  });
  d.capture.mockImplementation(async (_tx, q) =>
    q.orderBatchReference === id(11)
      ? { paymentEvent: "private", paymentIntentReference: id(31) }
      : null,
  );
});
it("returns paid unclaimed units and current claim version without private facts", async () => {
  const f = setup();
  expect(await f.operation(f.input)).toEqual({
    orderReference: id(8),
    orderNumber: "12",
    claimVersion: 1,
    recentRequests: [
      {
        requestReference: id(40),
        operationReference: id(41),
        claimVersion: 1,
        requestedAt: "2026-09-20T12:00:00.000Z",
        reasonCode: "CUSTOMER_REQUEST",
        currencyCode: "CAD",
        amountMinor: "1130",
      },
    ],
    items: [
      {
        orderBatchReference: id(11),
        orderItemReference: id(12),
        label: "Latte",
        quantity: 3,
        unclaimedQuantity: 2,
        paymentCaptured: true,
        paymentIntentReference: id(31),
      },
      {
        orderBatchReference: id(21),
        orderItemReference: id(22),
        label: "Tea",
        quantity: 1,
        unclaimedQuantity: 0,
        paymentCaptured: false,
        paymentIntentReference: null,
      },
    ],
  });
  expect(d.resolve).toHaveBeenCalledWith(
    f.tx,
    f.input.sessionCookie,
    "payment.refund.request",
    id(5),
  );
  expect(d.context.mock.calls[0]?.[1]).toEqual({
    orderReference: id(8),
    operationReference: id(7),
    observedAt: at,
  });
});
it.each(["actorReference", "observedAt", "storeReference"])("rejects injected %s", async (key) => {
  const f = setup();
  await expect(
    f.operation({ ...f.input, query: { ...f.input.query, [key]: id(99) } }),
  ).rejects.toThrow();
  expect(f.run).not.toHaveBeenCalled();
});
it("rejects non-Manager role before reading financial information", async () => {
  const f = setup();
  d.workforce.mockResolvedValue({ decision: { effect: "Allow" }, activeRoleCodes: ["owner"] });
  await expect(f.operation(f.input)).rejects.toThrow();
  expect(d.context).not.toHaveBeenCalled();
});
it("denies a scope change before returning data", async () => {
  const f = setup();
  f.allowed.mockResolvedValueOnce(true).mockResolvedValueOnce(true).mockResolvedValue(false);
  await expect(f.operation(f.input)).rejects.toThrow();
});
it.each([[1, 1], [4]])("rejects inconsistent unit occupancy %j", async (...ordinals: unknown[]) => {
  const f = setup();
  d.context.mockResolvedValue({
    existing: null,
    history: [
      { payments: [{ items: [{ orderItemReference: id(12), refundUnitOrdinals: ordinals }] }] },
    ],
  });
  await expect(f.operation(f.input)).rejects.toThrow();
});

it("bounds request summaries to latest20 without exposing actor or audit facts", async () => {
  const f = setup();
  d.context.mockResolvedValue({
    existing: null,
    history: Array.from({ length: 25 }, (_, i) => ({
      requestReference: id(100 + i),
      operationReference: id(200 + i),
      expectedClaimVersion: i,
      requestedAt: "2026-09-20T12:00:00.000Z",
      reasonCode: "CUSTOMER_REQUEST",
      currencyCode: "CAD",
      amountMinor: 1130n,
      payments: [],
      actorReference: "private",
      auditReference: "private",
    })),
  });
  const result = await f.operation(f.input);
  expect(result.claimVersion).toBe(25);
  expect(result.recentRequests).toHaveLength(20);
  expect(result.recentRequests[0]?.claimVersion).toBe(6);
  expect(result.recentRequests[19]?.claimVersion).toBe(25);
  expect(JSON.stringify(result)).not.toContain("private");
});
