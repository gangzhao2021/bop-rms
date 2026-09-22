import { beforeEach, expect, it, vi } from "vitest";
const d = vi.hoisted(() => ({
  scope: vi.fn(),
  source: vi.fn(),
  store: vi.fn(),
  resolve: vi.fn(),
  record: vi.fn(),
}));
vi.mock("./merchant-store-scope.js", () => ({ createMerchantStoreScope: () => d.scope }));
vi.mock("@rms/payment", async (original) => ({
  ...(await original<typeof import("@rms/payment")>()),
  createPostgresPaymentCompensationReconciliationSource: () => d.source,
  createPostgresPaymentCompensationOperationsStore: d.store,
}));
import { createMerchantCompensationReconciliationCommand } from "./merchant-compensation-reconciliation-command.js";
type Options = Parameters<typeof createMerchantCompensationReconciliationCommand>[0];
const id = (n: number) => "0190fa82-0000-7000-8000-" + String(n).padStart(12, "0"),
  at = "2026-09-21T00:00:00.000Z",
  digest = "sha256:" + "a".repeat(64);
function fixture() {
  const state = { allowed: true };
  d.scope.mockImplementation(async () => ({
    selected: { tenantReference: id(1) },
    context: { brand: { brandReference: id(2) } },
    store: { storeReference: id(3) },
    actorReference: id(4),
    allowed: async () => state.allowed,
  }));
  const authenticate = vi.fn(async () => ({ sessionReference: id(5) }));
  const command = createMerchantCompensationReconciliationCommand({
    persistence: {
      transactions: { run: async (work: (t: object) => Promise<unknown>) => work({}) },
    } as unknown as Options["persistence"],
    authentication: { authorize: authenticate } as unknown as Options["authentication"],
    now: () => at,
  });
  const input = {
    sessionCookie: "synthetic-cookie",
    csrf: "synthetic-csrf",
    command: {
      orderReference: id(6),
      caseReference: id(7),
      receiptReference: id(8),
      auditReference: id(9),
      expectedCaseVersion: 2,
    },
  };
  return { state, authenticate, command, input };
}
beforeEach(() => {
  vi.resetAllMocks();
  d.source.mockResolvedValue({
    caseRecord: { orderReference: id(6), caseReference: id(7), version: 2 },
    refund: { refundReference: id(10), evidenceDigest: digest, providerConfirmedAt: at },
  });
  d.resolve.mockResolvedValue(null);
  d.record.mockImplementation(async ({ receipt }) => ({ status: "Created", receipt }));
  d.store.mockReturnValue({ resolve: d.resolve, record: d.record });
});
it("uses current exception permission and server-derived User Audit without refund execution", async () => {
  const f = fixture();
  expect(await f.command(f.input)).toEqual({ status: "Created", reconciledAt: at });
  expect(d.scope.mock.calls.every((call) => call[2] === "operations.order-exception.manage")).toBe(
    true,
  );
  expect(f.authenticate).toHaveBeenCalledWith(f.input);
  const receipt = d.record.mock.calls[0]?.[0].receipt;
  expect(receipt.actorReference).toBe(id(4));
  expect(receipt.refundEvidenceDigest).toBe(digest);
  expect(receipt.audit.actor).toEqual({ type: "User", reference: id(4) });
});
it("replays exact acknowledgment without changing its timestamp or appending again", async () => {
  const f = fixture();
  await f.command(f.input);
  const receipt = d.record.mock.calls[0]?.[0].receipt;
  d.resolve.mockResolvedValue(receipt);
  expect(await f.command(f.input)).toEqual({ status: "Duplicate", reconciledAt: at });
  expect(d.record).toHaveBeenCalledOnce();
  d.resolve.mockResolvedValue({ ...receipt, actorReference: id(99) });
  await expect(f.command(f.input)).rejects.toThrow("CONFLICT");
});
it("denies forged fields and wrong-order persisted evidence", async () => {
  const f = fixture();
  await expect(
    f.command({ ...f.input, command: { ...f.input.command, actorReference: id(99) } }),
  ).rejects.toThrow();
  d.source.mockResolvedValue({ caseRecord: { orderReference: id(99) }, refund: {} });
  await expect(f.command(f.input)).rejects.toThrow("UNAVAILABLE");
  expect(d.record).not.toHaveBeenCalled();
});
it("denies missing evidence or lost permission", async () => {
  const f = fixture();
  d.source.mockResolvedValue(null);
  await expect(f.command(f.input)).rejects.toThrow("UNAVAILABLE");
  f.state.allowed = false;
  await expect(f.command(f.input)).rejects.toThrow();
  expect(d.record).not.toHaveBeenCalled();
});
it("revalidates current refund digest and actor inside record transaction", async () => {
  const f = fixture();
  d.store.mockImplementation((opts) => ({
    resolve: d.resolve,
    record: async ({ receipt }: { receipt: unknown }) => {
      const tx = d.source.mock.calls[0]?.[0];
      expect(await opts.validateEvidence(tx, { receipt, caseRecord: { version: 2 } })).toBe(true);
      expect(
        await opts.validateEvidence(tx, {
          receipt: { ...(receipt as object), actorReference: id(99) },
          caseRecord: { version: 2 },
        }),
      ).toBe(false);
      expect(await opts.validateEvidence(tx, { receipt, caseRecord: { version: 3 } })).toBe(false);
      return { status: "Created", receipt };
    },
  }));
  await f.command(f.input);
});
