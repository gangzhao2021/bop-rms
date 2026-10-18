import { beforeEach, expect, it, vi } from "vitest";
import { createMerchantOrderAcceptanceHoldRefund } from "./merchant-order-acceptance-hold-refund.js";
const doubles = vi.hoisted(() => ({ scope: vi.fn(), store: vi.fn(), resolve: vi.fn() }));
vi.mock("./merchant-store-scope.js", () => ({ createMerchantStoreScope: () => doubles.scope }));
vi.mock("@rms/ordering", async (original) => ({
  ...(await original<object>()),
  createPostgresOrderAcceptanceHoldStore: doubles.store,
}));
const id = (n: number) => "01909985-0000-7000-8000-" + n.toString(16).padStart(12, "0");
type Options = Parameters<typeof createMerchantOrderAcceptanceHoldRefund>[0];
const now = "2026-10-15T12:00:00.000Z";
function setup() {
  const authorize = vi.fn(async () => ({ sessionReference: id(1) })),
    allowed = vi.fn(async () => true),
    during: boolean[] = [];
  let rolledBack: unknown = null;
  const run = vi.fn(async (work: (tx: object) => Promise<unknown>) =>
    work({ query: vi.fn() }).catch((error: unknown) => {
      rolledBack = error;
      throw error;
    }),
  );
  doubles.scope.mockResolvedValue({
    actorReference: id(2),
    context: { brand: { brandReference: id(3) } },
    store: { storeReference: id(4) },
    allowed,
  });
  doubles.store.mockReturnValue({ resolve: doubles.resolve });
  doubles.resolve.mockImplementation(async (tx: object) => {
    const owner = doubles.store.mock.calls[0]?.[0] as { authorize(t: unknown): Promise<boolean> };
    during.push(await owner.authorize(tx));
    during.push(await owner.authorize({ query: vi.fn() }));
    return {
      status: "Created",
      hold: { resolutions: [{ resolution: "StaffRefund", recordedAt: now }] },
    };
  });
  const operation = createMerchantOrderAcceptanceHoldRefund({
    persistence: { transactions: { run }, now: () => now } as unknown as Options["persistence"],
    authentication: { authorize } as unknown as Options["authentication"],
    nextReference: () => id(20),
    audit: { retentionPolicyCode: "TEST", retentionPolicyVersion: 1 },
  });
  const input = {
    sessionCookie: "synthetic-cookie",
    csrf: "synthetic-csrf",
    command: { orderReference: id(5), orderBatchReference: id(6), holdReference: id(7) },
  };
  return { operation, input, allowed, during, rolledBack: () => rolledBack };
}
beforeEach(() => vi.resetAllMocks());
it("WP-2423: records the refund decision resolving the caller in full only at the start and before the commit", async () => {
  const f = setup();
  await expect(f.operation(f.input)).resolves.toEqual({
    status: "RefundChosen",
    orderReference: id(5),
    decidedAt: now,
  });
  // The hold store's callback: this run's transaction, then another one.
  expect(f.during).toEqual([true, false]);
  expect(doubles.scope).toHaveBeenCalledOnce();
  expect(f.allowed).toHaveBeenCalledTimes(2);
  // The guard ends with the run.
  const tx = doubles.resolve.mock.calls[0]?.[0];
  const owner = doubles.store.mock.calls[0]?.[0] as { authorize(t: unknown): Promise<boolean> };
  expect(await owner.authorize(tx)).toBe(false);
});
it("WP-2423: refuses a caller without the cancellation permission before the hold store", async () => {
  const f = setup();
  f.allowed.mockResolvedValue(false);
  await expect(f.operation(f.input)).rejects.toMatchObject({
    code: "ACCEPTANCE_HOLD_REFUND_PERMISSION_DENIED",
  });
  doubles.scope.mockRejectedValue(new Error("expired"));
  await expect(f.operation(f.input)).rejects.toMatchObject({
    code: "ACCEPTANCE_HOLD_REFUND_PERMISSION_DENIED",
  });
  expect(doubles.resolve).not.toHaveBeenCalled();
});
it("WP-2423: a permission withdrawn or Session ended during the decision refuses it before commit", async () => {
  const f = setup();
  f.allowed.mockResolvedValueOnce(true).mockResolvedValueOnce(false);
  await expect(f.operation(f.input)).rejects.toMatchObject({
    code: "ACCEPTANCE_HOLD_REFUND_PERMISSION_DENIED",
  });
  // Thrown inside the transaction callback, so the recorded decision does not commit.
  expect(f.rolledBack()).toMatchObject({ code: "ACCEPTANCE_HOLD_REFUND_PERMISSION_DENIED" });
  expect(doubles.resolve).toHaveBeenCalledOnce();
  expect(f.allowed).toHaveBeenCalledTimes(2);
});
