import { beforeEach, expect, it, vi } from "vitest";
import { createMerchantCardMachineOrdinaryRefund } from "./merchant-card-machine-ordinary-refund.js";
const doubles = vi.hoisted(() => ({
  scope: vi.fn(),
  access: vi.fn(),
  cards: vi.fn(),
  context: vi.fn(),
  escalation: vi.fn(),
  record: vi.fn(),
}));
vi.mock("./merchant-store-scope.js", () => ({ createMerchantStoreScope: () => doubles.scope }));
vi.mock("./merchant-refund-read-authority.js", () => ({ refundReadAccess: doubles.access }));
vi.mock("./merchant-workforce-authority-source.js", () => ({
  createMerchantWorkforcePermissionSource: () => vi.fn(),
}));
vi.mock("@rms/payment", async (original) => ({
  ...(await original<object>()),
  createPostgresCardMachinePaymentStore: doubles.cards,
  createPostgresOrdinaryRefundRequestContextSource: doubles.context,
  createPostgresOrdinaryRefundCurrentEscalationSource: doubles.escalation,
  createOrdinaryRefundRoleResolver: () => vi.fn(),
  ordinaryRefundClaimKind: () => "Ordinary",
  ordinaryRefundPaymentAmount: () => 500n,
  parseCardMachineRefundRecord: (value: unknown) => value,
}));
const id = (n: number) => "0190a7c6-0000-7000-8000-" + n.toString(16).padStart(12, "0");
type Options = Parameters<typeof createMerchantCardMachineOrdinaryRefund>[0];
type Authorize = (t: unknown, query: Record<string, unknown>) => Promise<boolean>;
const now = "2026-10-15T12:00:00.000Z";
beforeEach(() => vi.resetAllMocks());
function setup() {
  const allowed = vi.fn(async () => true),
    during: boolean[] = [];
  let rolledBack: unknown = null;
  const run = vi.fn(async (work: (tx: object) => Promise<unknown>) =>
    work({ query: vi.fn() }).catch((error: unknown) => {
      rolledBack = error;
      throw error;
    }),
  );
  doubles.scope.mockResolvedValue({
    actorReference: id(4),
    selected: { tenantReference: id(1) },
    context: { brand: { brandReference: id(2) }, resolvedAt: now },
    store: { storeReference: id(3) },
    kdsOperatorProfileAllows: () => true,
    allowed,
  });
  doubles.access.mockResolvedValue({ canRead: true, canRequest: true });
  const leg = { paymentIntentReference: id(8), paymentTransactionReference: id(9) };
  doubles.context.mockImplementation((owner: { authorize: Authorize }) => async () => {
    during.push(await owner.authorize({}, { orderReference: id(6) }));
    during.push(await owner.authorize({}, { orderReference: id(99) }));
    return {
      existing: null,
      declines: new Set(),
      history: [
        {
          requestReference: id(7),
          payments: [leg],
          requestedAt: "2026-10-15T11:00:00.000Z",
          actorReference: id(5),
        },
      ],
    };
  });
  doubles.escalation.mockImplementation((owner: { authorize: Authorize }) => async () => {
    during.push(await owner.authorize({}, { orderReference: id(6), requestReference: id(7) }));
    return { decision: { requiresIndependentApproval: false }, observedAt: now };
  });
  doubles.cards.mockImplementation((owner: { authorize: Authorize }) => ({
    loadRefundByOperation: async () => {
      during.push(await owner.authorize({}, { orderReference: id(6) }));
      return null;
    },
    loadByIntent: async () => ({
      orderReference: id(6),
      cardMachinePaymentReference: id(9),
      takenAt: "2026-10-15T10:00:00.000Z",
    }),
    loadRefundBySource: async () => null,
    recordRefund: async () => {
      during.push(await owner.authorize({}, { orderReference: id(6) }));
      doubles.record();
      return { status: "Created", refund: { amountMinor: 500n, refundedAt: now } };
    },
  }));
  let next = 20;
  const recordRefund = createMerchantCardMachineOrdinaryRefund({
    persistence: { transactions: { run }, now: () => now } as unknown as Options["persistence"],
    authentication: {
      authorize: vi.fn(async () => ({ sessionReference: id(11) })),
    } as unknown as Options["authentication"],
    resolveConfiguration: vi.fn(async () => ({
      providerAccountReference: id(10),
      environment: "Test" as const,
      roleMapping: {},
    })),
    businessDate: {} as Options["businessDate"],
    nextReference: () => id(next++),
  });
  const input = {
    sessionCookie: "synthetic-cookie",
    csrf: "synthetic-csrf",
    command: {
      operationReference: id(12),
      orderReference: id(6),
      requestReference: id(7),
      slipReference: null,
      refundedAt: null,
    },
  };
  return { recordRefund, input, allowed, during, rolledBack: () => rolledBack };
}
it("WP-2423: records resolving the caller and refund-handler role in full only at the start and before the commit", async () => {
  const f = setup();
  await expect(f.recordRefund(f.input)).resolves.toEqual({
    status: "Recorded",
    orderReference: id(6),
    requestReference: id(7),
    amountMinor: "500",
    refundedAt: now,
    receipt: "NoDigitalReceipt",
  });
  // Prior record, request context (this Order, another Order), escalation, record.
  expect(f.during).toEqual([true, true, false, true, true]);
  // v15 2026-10-17 (40P01): the request read takes the Order's refund fence alone.
  expect(doubles.context.mock.calls[0]?.[0]).toMatchObject({ fence: "OrderOnly" });
  expect(doubles.scope).toHaveBeenCalledOnce();
  expect(f.allowed).toHaveBeenCalledTimes(2);
  expect(doubles.access).toHaveBeenCalledTimes(2);
  // The guard ends with the run.
  const owner = doubles.cards.mock.calls[0]?.[0] as { authorize: Authorize };
  expect(await owner.authorize({}, { orderReference: id(6) })).toBe(false);
});
it("WP-2423: refuses someone who is not a refund handler before any owner read", async () => {
  const f = setup();
  doubles.access.mockResolvedValue({ canRead: false, canRequest: false });
  await expect(f.recordRefund(f.input)).rejects.toMatchObject({
    code: "CARD_MACHINE_REFUND_PERMISSION_DENIED",
  });
  expect(doubles.cards).not.toHaveBeenCalled();
});
it.each([
  ["Session ended", "allowed"],
  ["refund role withdrawn", "access"],
] as const)("WP-2423: %s during the record refuses it inside the transaction", async (_, which) => {
  const f = setup();
  if (which === "allowed") f.allowed.mockResolvedValueOnce(true).mockResolvedValueOnce(false);
  else
    doubles.access
      .mockResolvedValueOnce({ canRead: true, canRequest: true })
      .mockResolvedValueOnce({ canRead: false, canRequest: false });
  await expect(f.recordRefund(f.input)).rejects.toMatchObject({
    code: "CARD_MACHINE_REFUND_PERMISSION_DENIED",
  });
  // Thrown inside the transaction callback, so the recorded refund does not commit.
  expect(f.rolledBack()).toMatchObject({ code: "CARD_MACHINE_REFUND_PERMISSION_DENIED" });
  expect(doubles.record).toHaveBeenCalledOnce();
});
