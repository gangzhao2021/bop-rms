import { beforeEach, expect, it, vi } from "vitest";
import { createMerchantOrdinaryRefundDecline } from "./merchant-ordinary-refund-decline.js";
import { MerchantRefundApprovalError } from "./merchant-ordinary-refund-approval.js";
const doubles = vi.hoisted(() => ({ scope: vi.fn(), store: vi.fn(), decline: vi.fn() }));
vi.mock("./merchant-store-scope.js", () => ({ createMerchantStoreScope: () => doubles.scope }));
vi.mock("./merchant-ordinary-refund-authority.js", () => ({
  createMerchantOrdinaryRefundAuthority: () => ({}),
}));
vi.mock("@rms/payment", async (original) => ({
  ...(await original<object>()),
  createPostgresOrdinaryRefundDeclineStore: doubles.store,
}));
const id = (n: number) => "01909985-0000-7000-8000-" + n.toString(16).padStart(12, "0");
type Options = Parameters<typeof createMerchantOrdinaryRefundDecline>[0];
type Authorize = (t: unknown, query: Record<string, unknown>) => Promise<boolean>;
const query = {
  tenantReference: id(5),
  brandReference: id(3),
  storeReference: id(4),
  orderReference: id(6),
  requestReference: id(7),
};
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
    selected: { tenantReference: id(5) },
    context: { brand: { brandReference: id(3) } },
    store: { storeReference: id(4) },
    allowed,
  });
  doubles.store.mockReturnValue(doubles.decline);
  doubles.decline.mockImplementation(async (tx: object) => {
    const owner = doubles.store.mock.calls[0]?.[0] as { authorize: Authorize };
    during.push(await owner.authorize(tx, query));
    during.push(await owner.authorize(tx, query));
    // Not this run's transaction, or another request: refused without a query.
    during.push(await owner.authorize({ query: vi.fn() }, query));
    during.push(await owner.authorize(tx, { ...query, requestReference: id(99) }));
    return { status: "Committed", declinedAt: "2026-10-15T12:00:00.000Z" };
  });
  const resolveConfiguration = vi.fn(
    async (_tx: unknown, _scope: unknown, authority: { authorize(): Promise<boolean> }) => {
      during.push(await authority.authorize());
      return { workforce: {} };
    },
  );
  const decline = createMerchantOrdinaryRefundDecline({
    persistence: { transactions: { run } } as unknown as Options["persistence"],
    authentication: { authorize } as unknown as Options["authentication"],
    resolveConfiguration: resolveConfiguration as unknown as Options["resolveConfiguration"],
    retentionPolicyCode: "TEST",
    retentionPolicyVersion: 1,
  });
  const input = {
    sessionCookie: "synthetic-cookie",
    csrf: "synthetic-csrf",
    command: {
      orderReference: id(6),
      requestReference: id(7),
      operationReference: id(8),
      reasonCode: "ENTERED_IN_ERROR",
    },
  };
  return { decline, input, allowed, during, rolledBack: () => rolledBack };
}
beforeEach(() => vi.resetAllMocks());
it("WP-2423: declines resolving the caller in full only at the start and before the commit", async () => {
  const f = setup();
  await expect(f.decline(f.input)).resolves.toEqual({
    status: "Declined",
    declinedAt: "2026-10-15T12:00:00.000Z",
    replayed: false,
  });
  // Configuration, then the decline store (this run twice, another transaction, another request).
  expect(f.during).toEqual([true, true, true, false, false]);
  expect(doubles.scope).toHaveBeenCalledOnce();
  expect(f.allowed).toHaveBeenCalledTimes(2);
  // The guard ends with the run.
  const tx = doubles.decline.mock.calls[0]?.[0];
  const owner = doubles.store.mock.calls[0]?.[0] as { authorize: Authorize };
  expect(await owner.authorize(tx, query)).toBe(false);
});
it("WP-2423: refuses a caller without refund approval before the decline store", async () => {
  const f = setup();
  f.allowed.mockResolvedValue(false);
  await expect(f.decline(f.input)).rejects.toMatchObject({ code: "Denied" });
  expect(doubles.decline).not.toHaveBeenCalled();
});
it("WP-2423: a permission withdrawn or Session ended during the decline refuses it before commit", async () => {
  const f = setup();
  f.allowed.mockResolvedValueOnce(true).mockResolvedValueOnce(false);
  const error = await f.decline(f.input).catch((value: unknown) => value);
  expect(error).toBeInstanceOf(MerchantRefundApprovalError);
  expect(error).toMatchObject({ code: "Denied" });
  // Thrown inside the transaction callback, so the decline does not commit.
  expect(f.rolledBack()).toBeInstanceOf(MerchantRefundApprovalError);
  expect(doubles.decline).toHaveBeenCalledOnce();
  expect(f.allowed).toHaveBeenCalledTimes(2);
});
