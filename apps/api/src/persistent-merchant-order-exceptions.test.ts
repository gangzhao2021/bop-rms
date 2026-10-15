import { beforeEach, expect, it, vi } from "vitest";
const d = vi.hoisted(() => ({
  scope: vi.fn(),
  store: vi.fn(),
  list: vi.fn(),
  followUp: vi.fn(),
  detail: vi.fn(),
}));
vi.mock("./merchant-store-scope.js", () => ({ createMerchantStoreScope: () => d.scope }));
vi.mock("@bop/projection", async (original) => ({
  ...(await original<typeof import("@bop/projection")>()),
  createPostgresOrderExceptionSourceStore: d.store,
}));
vi.mock("@rms/payment", () => ({
  createPostgresReconciliationFollowUpQuery:
    (options: { authorize: (...args: unknown[]) => Promise<boolean>; scope: object }) =>
    async (tx: unknown, exceptionReference: string) => {
      const query = { ...options.scope, exceptionReference };
      if (!(await options.authorize(tx, query, "ReadPaymentReconciliationFollowUp")))
        throw Error("denied");
      const value = await d.followUp(tx, exceptionReference);
      if (!(await options.authorize(tx, query, "ReadPaymentReconciliationFollowUp")))
        throw Error("denied");
      return value;
    },
  createPostgresPaymentReconciliationExceptionDetailReader:
    (options: { authorize: (tx: unknown) => Promise<boolean> }) =>
    async (tx: unknown, references: readonly string[]) => {
      if (!(await options.authorize(tx))) throw Error("PAYMENT_COMPENSATION_PERMISSION_DENIED");
      return d.detail(references);
    },
}));
import { createPersistentMerchantOrderExceptions } from "./persistent-merchant-order-exceptions.js";
type Options = Parameters<typeof createPersistentMerchantOrderExceptions>[0];
const id = (n: number) => "0190fa86-0000-7000-8000-" + String(n).padStart(12, "0");
function fixture(onUnexpected?: Options["onUnexpected"]) {
  const state = { allowed: true, store: id(3), session: id(4) };
  d.scope.mockImplementation(async () => ({
    selected: { tenantReference: id(1) },
    context: { brand: { brandReference: id(2) } },
    store: { storeReference: state.store, displayName: "Synthetic Store" },
    sessionReference: state.session,
    allowed: async () => state.allowed,
  }));
  const original = { query: vi.fn(async () => ({ rows: [], rowCount: 0 })) },
    metadata = vi.fn<Options["metadata"]>(async () => ({
      storeLabel: "Synthetic Store",
      businessDate: "2026-09-21",
      checkpointReference: id(5),
      projectedAt: "2026-09-21T00:00:00.000Z",
      freshnessStatus: "Stale" as const,
    }));
  const read = createPersistentMerchantOrderExceptions({
    persistence: {
      transactions: { run: async (work: (tx: object) => Promise<unknown>) => work(original) },
    } as unknown as Options["persistence"],
    metadata,
    ...(onUnexpected ? { onUnexpected } : {}),
  });
  return { state, original, metadata, read };
}
beforeEach(() => {
  vi.resetAllMocks();
  d.list.mockResolvedValue({ items: [], nextAfterSourceReference: null });
  d.detail.mockResolvedValue(new Map());
  d.store.mockImplementation((options) => ({
    list: async (tx: unknown, input: unknown) => {
      if (!(await options.authorize(tx, "Read"))) throw new Error("denied");
      return d.list(tx, input);
    },
  }));
});
it("reads persisted projection through current scoped permission without manufacturing Fresh", async () => {
  const f = fixture();
  expect(await f.read("synthetic-cookie")).toMatchObject({
    screenId: "OPS-ORDER-EXCEPTION",
    freshnessStatus: "Stale",
    items: [],
    businessDate: "2026-09-21",
  });
  expect(
    d.scope.mock.calls.every(
      (c) => c[0] === f.original && c[2] === "operations.order-exception.manage",
    ),
  ).toBe(true);
  expect(Object.isFrozen(f.metadata.mock.calls[0]?.[1].sources)).toBe(true);
  expect(f.metadata.mock.calls[0]?.[1]).toEqual({
    sources: [],
    scope: {
      tenantReference: id(1),
      brandReference: id(2),
      storeReference: id(3),
      sessionReference: id(4),
    },
    storeLabel: "Synthetic Store",
  });
});
it("denies unavailable authority and scope changed during source read", async () => {
  const f = fixture();
  f.state.allowed = false;
  await expect(f.read("synthetic-cookie")).rejects.toThrow();
  expect(d.list).not.toHaveBeenCalled();
  f.state.allowed = true;
  d.list.mockImplementationOnce(async () => {
    f.state.store = id(99);
    return { items: [], nextAfterSourceReference: null };
  });
  // WP-2423: the owner reads only confirm the authorized transaction; the full re-check before
  // the reply refuses the changed Store.
  await expect(f.read("synthetic-cookie")).rejects.toThrow();
  expect(d.scope).toHaveBeenCalledTimes(3);
});
it("denies session changes before response and authorization after transaction lifetime", async () => {
  const f = fixture();
  f.metadata.mockImplementationOnce(async () => {
    f.state.session = id(99);
    return {
      storeLabel: "Synthetic Store",
      businessDate: "2026-09-21",
      checkpointReference: id(5),
      projectedAt: "2026-09-21T00:00:00.000Z",
      freshnessStatus: "Stale",
    };
  });
  await expect(f.read("synthetic-cookie")).rejects.toThrow();
  const options = d.store.mock.calls[0]?.[0],
    tx = d.list.mock.calls[0]?.[0];
  await expect(options.authorize(tx, "Read")).rejects.toThrow();
  expect(await options.authorize(tx, "Write")).toBe(false);
});

it("uses scoped Payment assignment without changing financial status and fails closed on revocation", async () => {
  const f = fixture();
  const source = {
    sourceReference: id(7),
    tenantReference: id(1),
    brandReference: id(2),
    storeReference: id(3),
    orderReference: null,
    paymentReference: null,
    diningReference: null,
    kind: "PaymentReconciliationDifference",
    severity: "High",
    sourceOwner: "Payment",
    sourceStatus: "Open",
    providerState: "Unknown",
    compensationStatus: "NotRequested",
    sourceVersion: 1n,
    sourceDigest: `sha256:${"a".repeat(64)}`,
    createdAt: "2026-09-21T00:00:00.000Z",
    updatedAt: "2026-09-21T00:00:00.000Z",
    resolutionEvidenceReference: null,
  };
  d.list.mockResolvedValue({ items: [source], nextAfterSourceReference: null });
  d.followUp.mockResolvedValue({ assigned: true });
  expect((await f.read("synthetic-cookie")).items[0]).toMatchObject({
    ownerStatus: "Assigned",
    status: "Open",
    sourceFinal: false,
  });
  d.followUp.mockResolvedValue({ assigned: false });
  expect((await f.read("synthetic-cookie")).items[0]?.ownerStatus).toBe("Unassigned");
  d.followUp.mockResolvedValue({ assigned: "true" });
  await expect(f.read("synthetic-cookie")).rejects.toThrow();
  d.followUp.mockRejectedValueOnce(Error("private-canary"));
  await expect(f.read("synthetic-cookie")).rejects.toThrow("MERCHANT_ORDER_EXCEPTION_UNAVAILABLE");
  d.followUp.mockImplementationOnce(async () => {
    f.state.store = id(99);
    return { assigned: true };
  });
  await expect(f.read("synthetic-cookie")).rejects.toThrow();
});

it("D3: reads each difference's detail on its own after a failure and never guesses the kind", async () => {
  const onUnexpected = vi.fn();
  const f = fixture(onUnexpected);
  const source = (n: number) => ({
    sourceReference: id(n),
    tenantReference: id(1),
    brandReference: id(2),
    storeReference: id(3),
    orderReference: null,
    paymentReference: null,
    diningReference: null,
    kind: "PaymentReconciliationDifference",
    severity: "High",
    sourceOwner: "Payment",
    sourceStatus: "Open",
    providerState: "Unknown",
    compensationStatus: "NotRequested",
    sourceVersion: 1n,
    sourceDigest: `sha256:${"a".repeat(64)}`,
    createdAt: "2026-09-21T00:00:00.000Z",
    updatedAt: "2026-09-21T00:00:00.000Z",
    resolutionEvidenceReference: null,
  });
  d.list.mockResolvedValue({ items: [source(7), source(8)], nextAfterSourceReference: null });
  d.followUp.mockResolvedValue({ assigned: false });
  const failure = Object.assign(Error("PAYMENT_COMPENSATION_SOURCE_UNAVAILABLE"), {
    code: "PAYMENT_COMPENSATION_SOURCE_UNAVAILABLE",
  });
  d.detail.mockImplementation(async (references: readonly string[]) => {
    if (references.includes(id(8))) throw failure;
    return new Map([[id(7), { exceptionReference: id(7), kind: "UnmatchedCharge" }]]);
  });
  const view = await f.read("synthetic-cookie");
  const byRef = (n: number) => view.items.find((item) => item.exceptionReference === id(n));
  expect(byRef(7)).toMatchObject({ reconciliation: { type: "UnmatchedCharge" } });
  expect(byRef(8)).toMatchObject({ reconciliation: { type: "Unavailable" } });
  expect(d.detail.mock.calls).toEqual([[[id(7), id(8)]], [[id(7)]], [[id(8)]]]);
  expect(onUnexpected).toHaveBeenCalledTimes(2);
  expect(onUnexpected).toHaveBeenCalledWith(failure);

  // A difference the Payment owner returns nothing for is not shown as an unmatched charge.
  onUnexpected.mockClear();
  d.detail.mockResolvedValue(new Map());
  const missing = await f.read("synthetic-cookie");
  expect(missing.items.map((item) => item.reconciliation)).toEqual([
    { type: "Unavailable" },
    { type: "Unavailable" },
  ]);
  expect(onUnexpected).toHaveBeenCalledTimes(2);
  expect((onUnexpected.mock.calls[0]?.[0] as Error).message).toBe(
    "PAYMENT_RECONCILIATION_DETAIL_MISSING",
  );
});
