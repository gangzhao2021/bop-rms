import { beforeEach, expect, it, vi } from "vitest";
import { createMerchantOrdinaryRefundRequest } from "./merchant-ordinary-refund-request.js";
const d = vi.hoisted(() => ({
  resolve: vi.fn(),
  workforce: vi.fn(),
  compose: vi.fn(),
  record: vi.fn(),
}));
vi.mock("./merchant-store-scope.js", () => ({ createMerchantStoreScope: () => d.resolve }));
vi.mock("./merchant-workforce-authority-source.js", () => ({
  createMerchantWorkforcePermissionSource: () => d.workforce,
}));
vi.mock("@rms/payment", async (original) => ({
  ...(await original<object>()),
  createPostgresOrdinaryRefundRequestRuntime: d.compose,
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
  f.allowed.mockResolvedValueOnce(true).mockResolvedValueOnce(true).mockResolvedValue(false);
  await expect(f.operation(f.input)).rejects.toThrow("ORDINARY_REFUND_REQUEST_DENIED");
  expect(d.record).toHaveBeenCalledTimes(1);
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
    components: {
      netAmountMinor: "1000",
      taxAmountMinor: "130",
      tipAmountMinor: "0",
      serviceChargeAmountMinor: "0",
      serviceChargeTaxAmountMinor: "0",
    },
  });
});
