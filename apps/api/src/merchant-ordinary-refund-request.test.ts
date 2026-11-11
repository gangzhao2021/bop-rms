import { beforeEach, expect, it, vi } from "vitest";
import { createMerchantOrdinaryRefundRequest } from "./merchant-ordinary-refund-request.js";
const d = vi.hoisted(() => ({
  cards: (): unknown => ({
    loadByIntent: async () => null,
    loadByBatch: async () => null,
  }),
  resolve: vi.fn(),
  workforce: vi.fn(),
  compose: vi.fn(),
  record: vi.fn(),
  capture: vi.fn(),
  cancelledRound: vi.fn(),
  accepted: vi.fn(),
  units: vi.fn(),
  claimed: vi.fn(),
  requesterRole: vi.fn(async () => undefined),
  order: [] as string[],
  fence: vi.fn(),
  withdrawals: vi.fn(),
  applyRecords: vi.fn(),
}));
// WP-2423 M10: the Order's disposition fence, Ordering's withdrawals and the records they change.
vi.mock("./order-refund-withdrawal-records.js", () => ({
  applyRefundWithdrawalRecords: d.applyRecords,
}));
vi.mock("@rms/ordering", async (original) => ({
  ...(await original<object>()),
  createPostgresOrderAcceptanceReader: () => ({ loadByBatch: d.accepted }),
  acquireOrderDispositionFence: d.fence,
  recordOrderItemRefundWithdrawals: d.withdrawals,
}));
// WP-2423 M10: the units of a round nobody accepted, and the units refunds claim.
vi.mock("./order-batch-refund-coverage.js", async (original) => ({
  ...(await original<object>()),
  readBatchUnits: d.units,
  readClaimedRefundUnits: d.claimed,
}));
vi.mock("./merchant-round-cancellation-refund.js", () => ({
  createRoundCancellationRefundSource: () => d.cancelledRound,
}));
vi.mock("./merchant-store-scope.js", () => ({ createMerchantStoreScope: () => d.resolve }));
vi.mock("./merchant-workforce-authority-source.js", () => ({
  createMerchantWorkforcePermissionSource: () => d.workforce,
}));
vi.mock("@rms/payment", async (original) => ({
  ...(await original<object>()),
  // WP-2423 item 4: no card-machine payment unless a test says so.
  createPostgresCardMachinePaymentStore: () => d.cards(),
  createPostgresOrdinaryRefundRequestRuntime: d.compose,
  createPostgresCapturedBatchPaymentSource: () => ({ load: d.capture }),
  // WP-2423 M14: the requester's role kept with the request (its own tests check the record).
  recordOrdinaryRefundRequesterRole: d.requesterRole,
  observeOrdinaryRefundOrderAfterFence: async (
    _tx: unknown,
    _s: unknown,
    _o: unknown,
    at: string,
  ) => at,
}));
const id = (n: number) => "01909974-0000-7000-8000-" + n.toString(16).padStart(12, "0");
type Options = Parameters<typeof createMerchantOrdinaryRefundRequest>[0];
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
  const operation = createMerchantOrdinaryRefundRequest({
    persistence: { transactions: { run } } as unknown as Options["persistence"],
    authentication: { authorize } as unknown as Options["authentication"],
    resolveConfiguration: configure,
    newAuditReference: () => id(7),
    retentionPolicyCode: "FINANCIAL_COMPLIANCE",
    retentionPolicyVersion: 1,
  });
  const input = {
    sessionCookie: "synthetic-cookie",
    csrf: "synthetic-csrf",
    command: {
      orderReference: id(8),
      requestReference: id(9),
      operationReference: id(10),
      expectedClaimVersion: 0,
      reasonCode: "CUSTOMER_REQUEST",
      items: [{ orderBatchReference: id(11), orderItemReference: id(12), quantity: 1 }],
    },
  };
  return { tx, allowed, run, authorize, configure, operation, input };
}
beforeEach(() => {
  vi.clearAllMocks();
  d.cancelledRound.mockResolvedValue(false);
  // Accepted unless a test says otherwise.
  d.accepted.mockResolvedValue({ acceptedOrderVersion: 2 });
  d.units.mockResolvedValue(new Map([[id(12), 1]]));
  d.claimed.mockResolvedValue(new Map());
  d.capture.mockResolvedValue({
    paymentEvent: { eventId: id(14) },
    paymentIntentReference: id(15),
  });
  d.workforce.mockResolvedValue({ decision: { effect: "Allow" }, activeRoleCodes: ["manager"] });
  d.record.mockImplementation(async (_tx, value) => ({
    status: "Created",
    claimVersion: 1,
    request: {
      ...value,
      currencyCode: "CAD",
      amountMinor: 1130n,
      payments: [
        {
          paymentAttemptReference: id(13),
          items: [
            {
              components: {
                netAmountMinor: 1000n,
                taxAmountMinor: 130n,
                tipAmountMinor: 0n,
                serviceChargeAmountMinor: 0n,
                serviceChargeTaxAmountMinor: 0n,
              },
            },
          ],
        },
      ],
      auditReference: id(7),
      internal: "hidden",
    },
  }));
  d.compose.mockImplementation((options) => {
    const run = async (tx: unknown, value: Record<string, unknown>) => {
      if (!(await options.authorize(tx, { ...options.scope, ...value, observedAt: options.now() })))
        throw new Error("DENIED");
      return d.record(tx, value);
    };
    return Object.assign(run, {
      preview: async (tx: unknown, value: Record<string, unknown>) => ({
        ...(await run(tx, value)),
        status: "Previewed",
        claimVersion: 0,
      }),
    });
  });
});
it("binds authenticated Manager and current Store, computes server time, and limits output", async () => {
  const f = setup();
  expect(await f.operation(f.input)).toEqual({
    status: "Created",
    requestReference: id(9),
    operationReference: id(10),
    claimVersion: 1,
    currencyCode: "CAD",
    amountMinor: "1130",
    paymentAttemptReferences: [id(13)],
    approvalRequired: null,
    escalationReasons: [],
    approveAlone: false,
  });
  expect(d.resolve).toHaveBeenCalledWith(
    f.tx,
    f.input.sessionCookie,
    "payment.refund.request",
    id(5),
  );
  expect(d.record.mock.calls[0]?.[1]).toEqual({ ...f.input.command, actorReference: id(4) });
  const opts = d.compose.mock.calls[0]?.[0];
  expect(opts.now()).toBe(at);
  expect(
    await opts.authorize(
      {},
      { ...opts.scope, orderReference: id(8), actorReference: id(99), observedAt: at },
    ),
  ).toBe(false);
});
it.each(["actorReference", "amountMinor", "requestedAt", "auditReference", "roleMapping"])(
  "rejects injected %s before entering a transaction",
  async (key) => {
    const f = setup();
    await expect(
      f.operation({ ...f.input, command: { ...f.input.command, [key]: id(99) } }),
    ).rejects.toThrow();
    expect(f.run).not.toHaveBeenCalled();
  },
);
it("rejects authentication failure before transaction", async () => {
  const f = setup();
  f.authorize.mockRejectedValue(new Error("denied"));
  await expect(f.operation(f.input)).rejects.toThrow();
  expect(f.run).not.toHaveBeenCalled();
});
it("requires Manager eligibility even when action policy allows Owner", async () => {
  const f = setup();
  d.workforce.mockResolvedValue({ decision: { effect: "Allow" }, activeRoleCodes: ["owner"] });
  await expect(f.operation(f.input)).rejects.toThrow();
  expect(d.record).not.toHaveBeenCalled();
});
it("rechecks authority before commit", async () => {
  const f = setup();
  // WP-2423: a permission withdrawn or Session ended during the request records nothing; the
  // refusal is raised inside the transaction callback after the write, so it rolls back.
  f.allowed.mockResolvedValueOnce(true).mockResolvedValue(false);
  await expect(f.operation(f.input)).rejects.toThrow("ORDINARY_REFUND_REQUEST_DENIED");
  expect(d.record).toHaveBeenCalledTimes(1);
  expect(f.allowed).toHaveBeenCalledTimes(2);
});

it("WP-2423: resolves the requester in full twice and their role once plus once before commit", async () => {
  const f = setup();
  await f.operation(f.input);
  expect(d.resolve).toHaveBeenCalledTimes(1);
  expect(f.allowed).toHaveBeenCalledTimes(2);
  expect(d.workforce).toHaveBeenCalledTimes(2);
  // A role withdrawn during the request refuses it before commit.
  d.workforce
    .mockResolvedValueOnce({ decision: { effect: "Allow" }, activeRoleCodes: ["manager"] })
    .mockResolvedValueOnce({ decision: { effect: "Deny" }, activeRoleCodes: [] });
  await expect(f.operation(f.input)).rejects.toThrow("ORDINARY_REFUND_REQUEST_DENIED");
});

it("previews server component amounts without reporting a committed request", async () => {
  const f = setup();
  expect(await f.operation.preview(f.input)).toEqual({
    status: "Previewed",
    requestReference: id(9),
    operationReference: id(10),
    claimVersion: 0,
    currencyCode: "CAD",
    amountMinor: "1130",
    paymentAttemptReferences: [id(13)],
    approvalRequired: null,
    escalationReasons: [],
    approveAlone: false,
    components: {
      netAmountMinor: "1000",
      taxAmountMinor: "130",
      tipAmountMinor: "0",
      serviceChargeAmountMinor: "0",
      serviceChargeTaxAmountMinor: "0",
    },
  });
});

it("WP-2423 Q5: accepts only the listed reasons and reports why approval is needed", async () => {
  for (const reasonCode of ["OTHER", "SYNTHETIC_FREE_CODE", "customer_request"]) {
    const f = setup();
    await expect(
      f.operation({ ...f.input, command: { ...f.input.command, reasonCode } }),
    ).rejects.toThrow("ORDINARY_REFUND_REQUEST_DENIED");
    expect(f.run).not.toHaveBeenCalled();
  }
  const f = setup();
  d.record.mockImplementationOnce(async (_tx, value) => ({
    status: "Created",
    claimVersion: 1,
    escalation: {
      requiresIndependentApproval: true,
      reasons: ["MoreThan24Hours", "OrderOrdinaryTotalAboveCad100"],
    },
    request: {
      ...value,
      currencyCode: "CAD",
      amountMinor: 12000n,
      payments: [{ paymentAttemptReference: id(13), items: [] }],
    },
  }));
  const result = await f.operation({
    ...f.input,
    command: { ...f.input.command, reasonCode: "QUALITY_ISSUE" },
  });
  expect(result).toMatchObject({
    approvalRequired: true,
    escalationReasons: ["MoreThan24Hours", "OrderOrdinaryTotalAboveCad100"],
  });
  expect(d.record.mock.calls[0]?.[1]).toMatchObject({ reasonCode: "QUALITY_ISSUE" });
});

it("WP-2423 Q5: Other requires a short note and no other reason carries one", async () => {
  for (const command of [
    { reasonCode: "OTHER", note: "" },
    { reasonCode: "OTHER", note: "x".repeat(201) },
    { reasonCode: "WRONG_ITEM", note: "Not allowed" },
  ]) {
    const f = setup();
    await expect(
      f.operation({ ...f.input, command: { ...f.input.command, ...command } }),
    ).rejects.toThrow("ORDINARY_REFUND_REQUEST_DENIED");
    expect(f.run).not.toHaveBeenCalled();
  }
  const f = setup();
  await f.operation({
    ...f.input,
    command: { ...f.input.command, reasonCode: "OTHER", note: " Customer left early " },
  });
  expect(d.record.mock.calls[0]?.[1]).toMatchObject({
    reasonCode: "OTHER",
    note: " Customer left early ",
  });
});

it("WP-2423: refuses an item refund on a round its cancellation refunds whole", async () => {
  const f = setup();
  d.cancelledRound.mockResolvedValue(true);
  await expect(f.operation(f.input)).rejects.toThrow(
    "ORDINARY_REFUND_ROUND_REFUNDED_BY_CANCELLATION",
  );
  await expect(f.operation.preview(f.input)).rejects.toThrow(
    "ORDINARY_REFUND_ROUND_REFUNDED_BY_CANCELLATION",
  );
  expect(d.cancelledRound).toHaveBeenCalledWith({
    orderBatchReference: id(11),
    paymentEventReference: id(14),
  });
  expect(d.record).not.toHaveBeenCalled();
});

it("WP-2423 M10: refunding every dish of a paid order nobody accepted is refused, a part is not", async () => {
  const f = setup();
  d.accepted.mockResolvedValue(null);
  d.units.mockResolvedValue(
    new Map([
      [id(12), 1],
      [id(16), 1],
    ]),
  );
  d.record.mockImplementation(async (_tx, value) => ({
    status: "Created",
    claimVersion: 1,
    request: {
      ...value,
      requestedAt: at,
      currencyCode: "CAD",
      amountMinor: 1130n,
      payments: [
        {
          paymentAttemptReference: id(13),
          items: [
            {
              orderItemReference: id(12),
              refundUnitOrdinals: [1],
              components: {
                netAmountMinor: 1000n,
                taxAmountMinor: 130n,
                tipAmountMinor: 0n,
                serviceChargeAmountMinor: 0n,
                serviceChargeTaxAmountMinor: 0n,
              },
            },
          ],
        },
      ],
    },
  }));
  // One of two dishes: the order goes ahead.
  await expect(f.operation(f.input)).resolves.toMatchObject({ status: "Created" });
  // The other one was refunded earlier: this makes it every dish, tip or not.
  d.claimed.mockResolvedValue(new Map([[id(16), new Set([1])]]));
  await expect(f.operation(f.input)).rejects.toThrow("ORDINARY_REFUND_ORDER_NOT_ACCEPTED");
  // Accepted: a full refund is an ordinary refund.
  d.accepted.mockResolvedValue({ acceptedOrderVersion: 2 });
  await expect(f.operation(f.input)).resolves.toMatchObject({ status: "Created" });
});

it("WP-2423 M10: stop making it too takes the Order's fence before the refund, changes the records with it, and is refused while the refund needs approval", async () => {
  const f = setup();
  d.fence.mockImplementation(async () => void d.order.push("fence"));
  const original = d.record.getMockImplementation();
  // The request claims unit 1 of the dish it stops.
  const recordOnce = async (tx: unknown, value: unknown) => {
    const result = await original?.(tx, value);
    return {
      ...result,
      request: {
        ...result.request,
        payments: result.request.payments.map((payment: { items: object[] }) => ({
          ...payment,
          items: payment.items.map((item) => ({
            ...item,
            orderItemReference: id(12),
            refundUnitOrdinals: [1],
          })),
        })),
      },
    };
  };
  d.record.mockImplementation(async (tx, value) => {
    d.order.push("refund");
    return recordOnce(tx, value);
  });
  const row = { withdrawalReference: id(40), orderItemReference: id(12) };
  d.withdrawals.mockImplementation(async () => {
    d.order.push("withdrawals");
    return [row];
  });
  d.applyRecords.mockImplementation(async () => {
    d.order.push("records");
    return { kitchenCancelled: [id(12)], markedOnTicket: [] };
  });
  const operation = createMerchantOrdinaryRefundRequest({
    persistence: {
      transactions: { run: f.run },
      now: () => at,
    } as unknown as Options["persistence"],
    authentication: { authorize: f.authorize } as unknown as Options["authentication"],
    resolveConfiguration: f.configure,
    newAuditReference: () => id(7),
    retentionPolicyCode: "FINANCIAL_COMPLIANCE",
    retentionPolicyVersion: 1,
    nextReference: () => id(41),
  });
  d.resolve.mockResolvedValue({
    ...(await d.resolve.getMockImplementation()?.()),
    selected: { tenantReference: id(1) },
    context: { brand: { brandReference: id(2) }, resolvedAt: at },
    store: { storeReference: id(3) },
    actorReference: id(4),
    allowed: async () => true,
    authorizeAction: async () => ({ effect: "Allow" }),
  });
  const input = {
    ...f.input,
    command: { ...f.input.command, withdraw: [{ orderItemReference: id(12), quantity: 1 }] },
  };
  await expect(operation(input)).resolves.toMatchObject({ status: "Created" });
  expect(d.order).toEqual(["fence", "refund", "withdrawals", "records"]);
  expect(d.applyRecords.mock.calls[0]?.[1]).toMatchObject({
    orderReference: id(8),
    actorReference: id(4),
    withdrawals: [row],
  });
  // The manager's refund role is kept with the request.
  expect((d.requesterRole.mock.calls[0] as unknown[] | undefined)?.[2]).toMatchObject({
    requestReference: id(9),
    role: "Manager",
  });
  // A refund that waits for the owner's approval may still be declined: nothing is stopped.
  d.order.length = 0;
  d.applyRecords.mockClear();
  d.record.mockImplementation(async (tx, value) => ({
    ...(await recordOnce(tx, value)),
    escalation: { requiresIndependentApproval: true, reasons: ["AMOUNT"] },
  }));
  await expect(operation(input)).rejects.toThrow("ORDINARY_REFUND_WITHDRAW_NEEDS_APPROVAL");
  expect(d.applyRecords).not.toHaveBeenCalled();
  expect(d.order).toEqual(["fence"]);
});
