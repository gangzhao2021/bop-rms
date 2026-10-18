import { beforeEach, expect, it, vi } from "vitest";
import { createMerchantOrdinaryRefundItems } from "./merchant-ordinary-refund-items.js";
const d = vi.hoisted(() => ({
  cards: (): unknown => ({
    loadByIntent: async () => null,
    loadByBatch: async () => null,
  }),
  resolve: vi.fn(),
  workforce: vi.fn(),
  context: vi.fn(),
  contextFence: vi.fn(),
  order: vi.fn(),
  capture: vi.fn(),
  member: vi.fn(),
  status: vi.fn(),
  cancelledRound: vi.fn(),
}));
// Rounds refunded whole by their cancellation (Ordering owner reads), none unless a test says so.
vi.mock("./merchant-round-cancellation-refund.js", () => ({
  createRoundCancellationRefundSource: () => d.cancelledRound,
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
  // WP-2423 item 4: no card-machine payment unless a test says so.
  createPostgresCardMachinePaymentStore: () => d.cards(),
  // Without declines every recorded request occupies the Order (WP-2423 Q5).
  createPostgresOrdinaryRefundRequestContextSource: (options: { fence?: unknown }) => {
    d.contextFence(options.fence);
    return async (...args: unknown[]) => {
      const value = (await d.context(...args)) as { history: unknown[] };
      return { occupying: value.history, declines: new Map(), ...value };
    };
  },
  createPostgresCapturedBatchPaymentSource: () => ({ load: d.capture }),
  createPostgresOrdinaryRefundRequestStatusSource: () => d.status,
}));
vi.mock("@bop/membership", async (original) => ({
  ...(await original<object>()),
  loadStoreMember: d.member,
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
  observations.at = null;
  observations.calls.length = 0;
  d.status.mockResolvedValue({ payments: [{ state: "Confirmed" }] });
  d.cancelledRound.mockResolvedValue(false);
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
      ? { paymentEvent: { eventId: id(32), private: true }, paymentIntentReference: id(31) }
      : null,
  );
});
it("returns paid unclaimed units and current claim version without private facts", async () => {
  const f = setup();
  expect(await f.operation(f.input)).toEqual({
    orderReference: id(8),
    canRequest: true,
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
        decline: null,
        progress: "Refunded",
        paymentMethod: "Online",
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
        refundedByCancellation: false,
        paymentIntentReference: id(31),
        paymentMethod: "Online",
      },
      {
        orderBatchReference: id(21),
        orderItemReference: id(22),
        label: "Tea",
        quantity: 1,
        unclaimedQuantity: 0,
        paymentCaptured: false,
        refundedByCancellation: false,
        paymentIntentReference: null,
        paymentMethod: null,
      },
    ],
  });
  expect(d.resolve).toHaveBeenCalledWith(f.tx, f.input.sessionCookie, "merchant.access", id(5));
  expect(d.context.mock.calls[0]?.[1]).toEqual({
    orderReference: id(8),
    operationReference: id(7),
    observedAt: at,
  });
  // v15 2026-10-17 (40P01): read-only, the Order's refund fence alone (the request status reads
  // that follow never take a request fence after it).
  expect(d.contextFence.mock.calls).toEqual([["OrderOnly"]]);
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
  d.workforce.mockResolvedValue({ decision: { effect: "Allow" }, activeRoleCodes: ["kitchen"] });
  await expect(f.operation(f.input)).rejects.toThrow();
  expect(d.context).not.toHaveBeenCalled();
});
it("denies a scope change before returning data", async () => {
  const f = setup();
  // WP-2423: allowed at the start, refused by the one full re-check before the reply.
  f.allowed.mockResolvedValueOnce(true).mockResolvedValue(false);
  await expect(f.operation(f.input)).rejects.toThrow();
  expect(f.allowed).toHaveBeenCalledTimes(2);
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

it("WP-2423 Q5: a declined request frees its units and shows who declined, when and why", async () => {
  const f = setup();
  const declined = {
    requestReference: id(40),
    operationReference: id(41),
    expectedClaimVersion: 0,
    requestedAt: "2026-09-20T12:00:00.000Z",
    reasonCode: "OTHER",
    currencyCode: "CAD",
    amountMinor: 1130n,
    payments: [{ items: [{ orderItemReference: id(12), refundUnitOrdinals: [1] }] }],
  };
  d.context.mockResolvedValue({
    existing: null,
    history: [declined],
    occupying: [],
    declines: new Map([
      [
        id(40),
        {
          declineReference: id(50),
          requestReference: id(40),
          declinerReference: id(4),
          reasonCode: "ENTERED_IN_ERROR",
          declinedAt: "2026-09-20T12:05:00.000Z",
          claimCount: 1,
        },
      ],
    ]),
  });
  d.member.mockResolvedValue({ displayName: "Sam" });
  const result = await f.operation(f.input);
  expect(result.items[0]?.unclaimedQuantity).toBe(3);
  expect(result.recentRequests[0]?.decline).toEqual({
    reasonCode: "ENTERED_IN_ERROR",
    declinedAt: "2026-09-20T12:05:00.000Z",
    declinerName: "Sam",
    declinedByYou: true,
  });
});

it("WP-2423 Q5: an Owner reads refunds (progress included) but may not record a request", async () => {
  const f = setup();
  d.workforce.mockImplementation(async (_tx, query: { permissionCode: string }) => ({
    decision: { effect: "Allow" },
    activeRoleCodes: query.permissionCode === "payment.refund.approve" ? ["owner"] : ["owner"],
  }));
  d.status.mockResolvedValueOnce({ payments: [{ state: "NeedsReconciliation" }] });
  const result = await f.operation(f.input);
  expect(result.canRequest).toBe(false);
  expect(result.recentRequests[0]?.progress).toBe("Sending");
});

it("WP-2423: a round refunded whole by its cancellation offers no unit again", async () => {
  const f = setup();
  d.cancelledRound.mockImplementation(
    async (round: { orderBatchReference: string }) => round.orderBatchReference === id(11),
  );
  const result = await f.operation(f.input);
  expect(d.cancelledRound).toHaveBeenCalledWith({
    orderBatchReference: id(11),
    paymentEventReference: id(32),
  });
  expect(result.items[0]).toMatchObject({
    orderItemReference: id(12),
    paymentCaptured: true,
    unclaimedQuantity: 0,
    refundedByCancellation: true,
  });
  // A round never charged is not "refunded by cancellation".
  expect(result.items[1]).toMatchObject({ paymentCaptured: false, refundedByCancellation: false });
});

it("v15 2026-10-18 40P01: locks the Order's Ordering rows before the Payment refund fence", async () => {
  const f = setup();
  await f.operation(f.input);
  const orderCall = d.order.mock.invocationCallOrder[0] ?? Number.POSITIVE_INFINITY;
  const fenceCall = d.context.mock.invocationCallOrder[0] ?? Number.NEGATIVE_INFINITY;
  expect(orderCall).toBeLessThan(fenceCall);
});
it("v15 2026-10-18 (dd750045): reads the refund history at the time taken once the Order's refund fence is held", async () => {
  const f = setup();
  // A request was recorded for this Order after the session resolved (at) and before the fence.
  const later = "2026-09-20T12:00:01.500Z";
  observations.at = later;
  await f.operation(f.input);
  expect(observations.calls).toEqual([id(8)]);
  // Ordering's rows are read first (canonical lock order) at the session's time ...
  expect(d.order.mock.calls[0]?.[1]).toMatchObject({ observedAt: at });
  // ... the refund history, payments and request status at the time after the fence.
  expect(d.context.mock.calls[0]?.[1]).toMatchObject({ observedAt: later });
  for (const call of d.capture.mock.calls) expect(call[1]).toMatchObject({ observedAt: later });
  for (const call of d.status.mock.calls) expect(call[1]).toMatchObject({ observedAt: later });
});
