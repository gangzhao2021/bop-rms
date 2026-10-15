import { beforeEach, expect, it, vi } from "vitest";
import { createMerchantMfaStepUp, MerchantStepUpError } from "./merchant-mfa-step-up.js";
const doubles = vi.hoisted(() => ({
  scope: vi.fn(),
  store: vi.fn(),
  record: vi.fn(),
  mfa: vi.fn(),
  latest: vi.fn(),
}));
vi.mock("./merchant-store-scope.js", () => ({ createMerchantStoreScope: () => doubles.scope }));
vi.mock("@bop/identity", async (original) => ({
  ...(await original<object>()),
  createPostgresWorkforceMfaStepUpStore: doubles.store,
  createPostgresCurrentWorkforceMfaSource: doubles.mfa,
  createPostgresLatestWorkforceStepUpSource: doubles.latest,
}));
const id = (n: number) => "01909985-0000-7000-8000-" + n.toString(16).padStart(12, "0");
type Options = Parameters<typeof createMerchantMfaStepUp>[0];
const binding = {
  brandReference: id(3),
  storeReference: id(4),
  actorReference: id(2),
  sessionReference: id(1),
};
function setup() {
  const authorize = vi.fn(async () => ({ sessionReference: id(1) })),
    allowed = vi.fn(async () => true);
  let rolledBack: unknown = null;
  const run = vi.fn(async (work: (tx: object) => Promise<unknown>) =>
    work({ query: vi.fn() }).catch((error: unknown) => {
      rolledBack = error;
      throw error;
    }),
  );
  doubles.scope.mockResolvedValue({
    actorReference: id(2),
    sessionReference: id(1),
    context: { brand: { brandReference: id(3) }, resolvedAt: "2026-10-15T12:00:00.000Z" },
    store: { storeReference: id(4) },
    allowed,
  });
  doubles.store.mockReturnValue(doubles.record);
  doubles.record.mockResolvedValue({ status: "Verified" });
  let next = 10;
  const stepUp = createMerchantMfaStepUp({
    persistence: { transactions: { run } } as unknown as Options["persistence"],
    authentication: { authorize } as unknown as Options["authentication"],
    method: "Totp" as Options["method"],
    verify: vi.fn(),
    newReference: () => id(next++),
    retentionPolicyCode: "TEST",
    retentionPolicyVersion: 1,
  });
  const input = {
    sessionCookie: "synthetic-cookie",
    csrf: "synthetic-csrf",
    command: { purpose: "RefundApproval", code: "123456" },
  };
  return { stepUp, input, allowed, run, rolledBack: () => rolledBack };
}
beforeEach(() => vi.resetAllMocks());
it("WP-2423: records a step-up resolving the caller in full only at the start and before the commit", async () => {
  const f = setup();
  const during: boolean[] = [];
  doubles.record.mockImplementation(async (tx: object) => {
    const owner = doubles.store.mock.calls[0]?.[0];
    // The owner store checks at its start and again after its writes, under the actor's lock.
    during.push(await owner.authorize(tx, binding));
    during.push(await owner.authorize(tx, binding));
    // Not this run's transaction, or another Session: refused without a query.
    during.push(await owner.authorize({ query: vi.fn() }, binding));
    during.push(await owner.authorize(tx, { ...binding, sessionReference: id(99) }));
    return { status: "Verified" };
  });
  await expect(f.stepUp(f.input)).resolves.toEqual({ status: "Verified" });
  expect(during).toEqual([true, true, false, false]);
  expect(doubles.scope).toHaveBeenCalledOnce();
  expect(f.allowed).toHaveBeenCalledTimes(2);
  expect(doubles.record.mock.calls[0]?.[1]).toMatchObject({
    ...binding,
    purposeCode: "PAYMENT_REFUND_APPROVAL",
    code: "123456",
  });
  // The guard ends with the run.
  const tx = doubles.record.mock.calls[0]?.[0];
  expect(await doubles.store.mock.calls[0]?.[0].authorize(tx, binding)).toBe(false);
});
it("WP-2423: refuses a caller without current access before the owner store", async () => {
  const f = setup();
  f.allowed.mockResolvedValue(false);
  await expect(f.stepUp(f.input)).rejects.toMatchObject({ code: "Denied" });
  expect(doubles.record).not.toHaveBeenCalled();
  expect(f.allowed).toHaveBeenCalledOnce();
});
it("WP-2423: a Session ended during the step-up refuses it inside the transaction", async () => {
  const f = setup();
  f.allowed.mockResolvedValueOnce(true).mockResolvedValueOnce(false);
  const error = await f.stepUp(f.input).catch((value: unknown) => value);
  expect(error).toBeInstanceOf(MerchantStepUpError);
  expect(error).toMatchObject({ code: "Denied" });
  // Thrown inside the transaction callback: the recorded step-up does not commit.
  expect(f.rolledBack()).toBeInstanceOf(MerchantStepUpError);
  expect(doubles.record).toHaveBeenCalledOnce();
  expect(f.allowed).toHaveBeenCalledTimes(2);
});
it("WP-2423: the status read resolves the caller twice and its owner reads take the guard", async () => {
  const f = setup();
  const during: boolean[] = [];
  doubles.mfa.mockImplementation(
    (source: { authorize(t: unknown, actor: string): Promise<boolean> }) => async (tx: object) => {
      during.push(await source.authorize(tx, id(2)));
      during.push(await source.authorize(tx, id(99)));
      return { status: "Enrolled", verifiedAt: "2026-10-15T11:59:00.000Z", resetAt: null };
    },
  );
  doubles.latest.mockImplementation(
    (source: { authorize(t: unknown, query: { actorReference: string }): Promise<boolean> }) =>
      async (tx: object) => {
        during.push(await source.authorize(tx, { actorReference: id(2) }));
        return null;
      },
  );
  const status = await f.stepUp.status({ sessionCookie: "synthetic-cookie" });
  expect(status.observedAt).toBe("2026-10-15T12:00:00.000Z");
  expect(during).toEqual([true, false, true]);
  expect(f.allowed).toHaveBeenCalledTimes(2);
  f.allowed.mockResolvedValueOnce(true).mockResolvedValueOnce(false);
  await expect(f.stepUp.status({ sessionCookie: "synthetic-cookie" })).rejects.toMatchObject({
    code: "Denied",
  });
});
