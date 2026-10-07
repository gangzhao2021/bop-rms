import { beforeEach, expect, it, vi } from "vitest";
import { createMerchantKitchenRelease } from "./merchant-kitchen-release.js";
const doubles = vi.hoisted(() => ({ scope: vi.fn(), store: vi.fn(), release: vi.fn() }));
vi.mock("./merchant-store-scope.js", () => ({ createMerchantStoreScope: () => doubles.scope }));
vi.mock("@rms/kitchen", async (original) => ({
  ...(await original<object>()),
  createPostgresKdsOperatorShiftStore: doubles.store,
}));
const id = (n: number) => "01909985-0000-7000-8000-" + n.toString(16).padStart(12, "0");
type Options = Parameters<typeof createMerchantKitchenRelease>[0];
const kds = {
  sessionReference: id(9),
  version: 3,
  policy: { code: "NamedKdsOperator" },
  idleExpiresAt: "2026-09-19T13:00:00.000Z",
  absoluteExpiresAt: "2026-09-19T23:00:00.000Z",
};
function setup(session: object = kds) {
  const allowed = vi.fn(async () => true),
    authorize = vi.fn(async () => session);
  const run = vi.fn(async (work: (tx: object) => Promise<unknown>) => work({ query: vi.fn() }));
  doubles.scope.mockResolvedValue({
    actorReference: id(2),
    context: { brand: { brandReference: id(3) } },
    store: { storeReference: id(4) },
    allowed,
  });
  doubles.store.mockReturnValue({ release: doubles.release });
  const release = createMerchantKitchenRelease({
    persistence: {
      transactions: { run },
      now: () => "2026-09-19T12:00:00.000Z",
    } as unknown as Options["persistence"],
    authentication: { authorize } as unknown as Options["authentication"],
    references: { next: () => id(7) },
  });
  return { release, allowed, authorize, run };
}
const input = { sessionCookie: "synthetic-cookie", csrf: "synthetic-csrf" };
beforeEach(() => vi.resetAllMocks());
it("records the current named operator Release with server-derived scope", async () => {
  const f = setup();
  await f.release(input);
  expect(doubles.scope.mock.calls[0]?.[2]).toBe("kitchen.operate");
  expect(doubles.store).toHaveBeenCalledWith(
    expect.objectContaining({ brandReference: id(3), storeReference: id(4) }),
  );
  expect(doubles.release.mock.calls[0]?.[0]).toMatchObject({
    releasedAt: "2026-09-19T12:00:00.000Z",
    session: {
      sessionReference: id(9),
      actorReference: id(2),
      brandReference: id(3),
      storeReference: id(4),
      sessionVersion: 3,
      sessionKind: "NamedKdsOperator",
      state: "Active",
      validUntil: "2026-09-19T13:00:00.000Z",
    },
  });
});
it("refuses ordinary Workforce Sessions before any transaction", async () => {
  const f = setup({ ...kds, policy: { code: "WorkforceStandard" } });
  await expect(f.release(input)).rejects.toMatchObject({ code: "KITCHEN_QUEUE_PERMISSION_DENIED" });
  expect(f.run).not.toHaveBeenCalled();
});
it("refuses a current Kitchen permission denial before writing", async () => {
  const f = setup();
  f.allowed.mockResolvedValue(false);
  await expect(f.release(input)).rejects.toMatchObject({ code: "KITCHEN_QUEUE_PERMISSION_DENIED" });
  expect(doubles.release).not.toHaveBeenCalled();
});
it("authenticates before reading Store scope", async () => {
  const f = setup();
  f.authorize.mockRejectedValue(new Error("denied"));
  await expect(f.release(input)).rejects.toThrow();
  expect(f.run).not.toHaveBeenCalled();
});
