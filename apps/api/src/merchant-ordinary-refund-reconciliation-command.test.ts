import { beforeEach, expect, it, vi } from "vitest";
import { createMerchantOrdinaryRefundReconciliationCommand } from "./merchant-ordinary-refund-reconciliation-command.js";
const f = vi.hoisted(() => ({
  scope: vi.fn(),
  compose: vi.fn(),
  receipt: vi.fn(),
  lookup: vi.fn(),
  refresh: vi.fn(),
}));
vi.mock("./merchant-store-scope.js", () => ({ createMerchantStoreScope: () => f.scope }));
vi.mock("@rms/payment", () => ({ createPostgresOrdinaryRefundReconciliationRuntime: f.compose }));
type Options = Parameters<typeof createMerchantOrdinaryRefundReconciliationCommand>[0];
type Runtime = Parameters<
  typeof import("@rms/payment").createPostgresOrdinaryRefundReconciliationRuntime
>[0];
const id = (n: number) => "01909974-0000-7000-8000-" + n.toString(16).padStart(12, "0");
beforeEach(() => {
  vi.resetAllMocks();
  f.refresh.mockResolvedValue({ freshAfter: "2026-09-21T07:00:00.000Z" });
});
function receiptResult() {
  const money = (amountMinor: bigint) => ({ amountMinor, currencyCode: "CAD" });
  return {
    status: "Existing",
    record: {
      recordReference: id(20),
      version: 1,
      kind: "Original",
      recordedAt: "2026-09-21T06:00:00.000Z",
      previousRecordReference: null,
      reasonCode: null,
      snapshot: {
        receiptReference: id(21),
        orderReference: id(7),
        guestSessionReference: id(22),
        operatingEntityReference: id(23),
        operatingEntityDisplayName: "Synthetic Entity",
        brandReference: id(2),
        storeReference: id(3),
        storeDisplayName: "Synthetic Store",
        orderNumber: "1001",
        issuedAt: "2026-09-21T06:00:00.000Z",
        locale: "en-CA",
        templateVersion: "RECEIPT_V1",
        lines: [
          {
            lineReference: id(24),
            displayName: "Synthetic bowl",
            quantity: 1,
            lineTotal: money(1000n),
          },
        ],
        subtotal: money(1000n),
        tax: money(130n),
        tip: money(0n),
        total: money(1130n),
        paymentStatus: "Paid",
        refundedTotal: money(0n),
      },
    },
  };
}
function setup() {
  const state = { allowed: true };
  const transactions: object[] = [];
  f.scope.mockImplementation(async () => ({
    selected: { tenantReference: id(1) },
    context: { brand: { brandReference: id(2) } },
    store: { storeReference: id(3) },
    actorReference: id(4),
    allowed: async () => state.allowed,
  }));
  const run = vi.fn(async (work: (tx: object) => Promise<unknown>) => {
    const tx = { number: transactions.length };
    transactions.push(tx);
    return work(tx);
  });
  const execute = createMerchantOrdinaryRefundReconciliationCommand({
    persistence: { transactions: { run } } as unknown as Options["persistence"],
    authentication: {
      authorize: async () => ({ sessionReference: id(5) }),
    } as unknown as Options["authentication"],
    resolveConfiguration: async () => ({
      providerAccountReference: id(6),
      environment: "Test",
      provider: { lookupRefund: f.lookup },
      refreshReceiptSources: f.refresh,
      issueRefundReceipt: f.receipt,
    }),
  });
  const command = {
    orderReference: id(7),
    operationReference: id(8),
    observationReference: id(9),
    auditReference: id(10),
  };
  return {
    state,
    run,
    execute,
    input: { sessionCookie: "synthetic-cookie", csrf: "synthetic-csrf", command },
  };
}
it("retries receipt failure on the same committed observation and never introduces send fields", async () => {
  const x = setup();
  let committed = false;
  const seen: unknown[] = [];
  f.compose.mockImplementation((options: Runtime) => async (command: unknown) => {
    seen.push(command);
    const status = committed ? "AlreadyCommitted" : "Created";
    if (!committed) {
      await options.transactions.run(async () => undefined);
      f.lookup();
      committed = true;
    }
    return { status };
  });
  f.receipt
    .mockRejectedValueOnce(new Error("RECEIPT_UNAVAILABLE"))
    .mockResolvedValueOnce(receiptResult());
  await expect(x.execute(x.input)).rejects.toThrow("RECEIPT_UNAVAILABLE");
  await expect(x.execute(x.input)).resolves.toEqual({
    result: { status: "AlreadyCommitted" },
    receipt: { status: "Existing", version: 1, kind: "Original" },
  });
  expect(seen).toEqual([x.input.command, x.input.command]);
  expect(f.lookup).toHaveBeenCalledTimes(1);
  expect(f.receipt.mock.calls.map((call) => call[1])).toEqual([
    { orderReference: id(7), freshAfter: "2026-09-21T07:00:00.000Z" },
    { orderReference: id(7), freshAfter: "2026-09-21T07:00:00.000Z" },
  ]);
});
it("does not issue a receipt after reconciliation fails", async () => {
  const x = setup();
  f.compose.mockReturnValue(async () => {
    throw new Error("UNAVAILABLE");
  });
  await expect(x.execute(x.input)).rejects.toThrow("UNAVAILABLE");
  expect(f.receipt).not.toHaveBeenCalled();
});
it("denies receipt transaction when current permission is withdrawn", async () => {
  const x = setup();
  f.compose.mockReturnValue(async () => {
    x.state.allowed = false;
    return { status: "Created" };
  });
  await expect(x.execute(x.input)).rejects.toThrow("ORDINARY_REFUND_SEND_DENIED");
  expect(f.receipt).not.toHaveBeenCalled();
});
it("rejects a Provider outcome or amount supplied by the caller", async () => {
  const x = setup();
  await expect(
    x.execute({ ...x.input, command: { ...x.input.command, outcome: "Succeeded" } }),
  ).rejects.toThrow();
  expect(x.run).not.toHaveBeenCalled();
});

it("does not issue a refund receipt when current payment source refresh fails", async () => {
  const x = setup();
  f.compose.mockReturnValue(async () => ({ status: "AlreadyCommitted" }));
  f.refresh.mockRejectedValue(new Error("SOURCE_UNAVAILABLE"));
  await expect(x.execute(x.input)).rejects.toThrow("SOURCE_UNAVAILABLE");
  expect(f.receipt).not.toHaveBeenCalled();
});
it("rejects malformed refresh evidence before receipt issuance", async () => {
  const x = setup();
  f.compose.mockReturnValue(async () => ({ status: "AlreadyCommitted" }));
  f.refresh.mockResolvedValue({ freshAfter: "invalid" });
  await expect(x.execute(x.input)).rejects.toThrow();
  expect(f.receipt).not.toHaveBeenCalled();
});

it.each(["orderReference", "brandReference", "storeReference"] as const)(
  "rejects a receipt bound to a different %s after durable reconciliation",
  async (field) => {
    const x = setup();
    f.compose.mockReturnValue(async () => ({ status: "AlreadyCommitted" }));
    const receipt = receiptResult();
    receipt.record.snapshot[field] = id(99);
    f.receipt.mockResolvedValue(receipt);
    await expect(x.execute(x.input)).rejects.toThrow("REFUND_RECEIPT_RESULT_INVALID");
  },
);
it("does not label an original receipt as newly created by refund reconciliation", async () => {
  const x = setup();
  f.compose.mockReturnValue(async () => ({ status: "AlreadyCommitted" }));
  f.receipt.mockResolvedValue({ ...receiptResult(), status: "Created" });
  await expect(x.execute(x.input)).rejects.toThrow("REFUND_RECEIPT_RESULT_INVALID");
});
it("rejects incomplete receipt results instead of acknowledging receipt recovery", async () => {
  const x = setup();
  f.compose.mockReturnValue(async () => ({ status: "AlreadyCommitted" }));
  f.receipt.mockResolvedValue({ status: "Issued" });
  await expect(x.execute(x.input)).rejects.toThrow();
});
