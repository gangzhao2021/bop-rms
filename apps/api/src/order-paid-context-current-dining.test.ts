import { beforeEach, expect, it, vi } from "vitest";
const m = vi.hoisted(() => ({
  captured: vi.fn(),
  original: vi.fn(),
  dining: vi.fn(),
  legacy: vi.fn(),
  acceptance: vi.fn(),
  inventory: vi.fn(),
  version: vi.fn(),
  reader: vi.fn(),
}));
vi.mock("./order-captured-payment-source.js", () => ({
  createOrderCapturedPaymentSource: () => ({ resolve: m.captured }),
}));
vi.mock("./initial-dining-acceptance-source.js", () => ({
  createInitialDiningAcceptanceSource: () => ({ resolve: m.dining }),
}));
vi.mock("./order-paid-capacity-source.js", () => ({ readOrderPaidCapacity: async () => null }));
vi.mock("@rms/ordering", async (load) => ({
  ...(await load<object>()),
  createPostgresOrderCreationQueryStore: (...args: unknown[]) => {
    m.reader(...args);
    return { withCurrentSubmission: m.original };
  },
  readOrderCreationQuoteVersion: m.version,
  createPostgresOrderAcceptanceReader: () => ({ loadByBatch: m.acceptance }),
  createPostgresOrderInitialExecutionReader: () => ({ loadByBatch: m.legacy }),
}));
vi.mock("@rms/inventory", async (load) => ({
  ...(await load<object>()),
  createPostgresSubmissionFinalValidationStore: () => ({ withCurrent: m.inventory }),
}));
import { createOrderPaidContextSource } from "./order-paid-context-source.js";
const id = (n: number) => `0198a107-0000-7000-8000-${n.toString(16).padStart(12, "0")}`;
const at = "2026-09-21T23:30:00.000Z",
  scope = {
    brandReference: id(1),
    storeReference: id(2),
    providerAccountReference: id(3),
    environment: "Test" as const,
  };
const p = {
  orderReference: id(4),
  orderBatchReference: id(5),
  submissionReference: id(6),
  guestSessionReference: id(7),
  sourceCartReference: id(8),
  sourceCartVersion: 1,
  quoteReference: id(9),
};
const tx = { query: vi.fn() };
beforeEach(() => {
  vi.clearAllMocks();
  m.version.mockResolvedValue(null);
  m.captured.mockResolvedValue({ payment: { intent: { preparation: p } } });
  m.original.mockImplementation(async (_s, work) =>
    work(tx, {
      submissionReference: p.submissionReference,
      guestSessionReference: p.guestSessionReference,
      order: {
        orderReference: p.orderReference,
        orderType: "DineIn",
        batches: [{ ...p, submittedAt: at }],
      },
    }),
  );
  m.inventory.mockImplementation(async (_s, work) =>
    work(tx, {
      record: {
        orderReference: p.orderReference,
        cartReference: p.sourceCartReference,
        cartVersion: 1,
        quoteReference: p.quoteReference,
      },
    }),
  );
});
function source(enabled = true) {
  return createOrderPaidContextSource({
    scope,
    tenantReference: id(10),
    quoteVersion: 1,
    currentDiningAcceptance: enabled,
    now: () => at,
    authorize: async () => true,
    authorizeOrder: async () => true,
    authorizeInventory: async () => true,
  });
}
it("retains actual accepted version three without invoking single-batch parser/reader", async () => {
  const acceptance = { acceptedOrderVersion: 3, acceptanceReference: id(11), acceptedAt: at };
  m.acceptance.mockResolvedValue(acceptance);
  m.dining.mockResolvedValue({
    batch: { acceptance, cancellation: null },
    current: { orderVersion: 3 },
  });
  const result = await source().resolve(tx, {});
  expect(result.initialExecution).toMatchObject({
    phase: "Accepted",
    version: 3,
    checkpoint: id(11),
  });
  expect(m.legacy).not.toHaveBeenCalled();
});
it("retains actual cancelled version four and stops capacity/inventory eligibility", async () => {
  m.acceptance.mockResolvedValue(null);
  m.dining.mockResolvedValue({
    batch: {
      cancellation: { cancelledOrderVersion: 4, cancellationReference: id(12), cancelledAt: at },
    },
    current: { orderVersion: 4 },
  });
  const result = await source().resolve(tx, {});
  expect(result.initialExecution).toMatchObject({ phase: "Cancelled", version: 4 });
  expect(result.inventory).toBeNull();
  expect(m.inventory).not.toHaveBeenCalled();
});
it("leaves non-opted-in consumers on the existing initial reader", async () => {
  m.acceptance.mockResolvedValue(null);
  m.legacy.mockResolvedValue({ phase: "Submitted", version: 1, occurredAt: at });
  expect((await source(false).resolve(tx, {})).currentDining).toBeNull();
  expect(m.dining).not.toHaveBeenCalled();
  expect(m.legacy).toHaveBeenCalledOnce();
});

it("WP-2423: reads an Order with the Quote version it was priced with", async () => {
  m.version.mockResolvedValue(1);
  m.legacy.mockResolvedValue(null);
  m.acceptance.mockResolvedValue(null);
  const context = await createOrderPaidContextSource({
    scope,
    tenantReference: id(10),
    quoteVersion: 2,
    now: () => at,
    authorize: async () => true,
    authorizeOrder: async () => true,
    authorizeInventory: async () => true,
  })
    .resolve(tx as never, {})
    .catch(() => null);
  expect(m.version).toHaveBeenCalledWith(tx, expect.anything(), p.submissionReference);
  expect(m.reader.mock.calls[0]?.[2]).toBe(1);
  if (context !== null) expect(context.quoteVersion).toBe(1);
});
