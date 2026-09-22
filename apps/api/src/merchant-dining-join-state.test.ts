import { expect, it, vi, beforeEach } from "vitest";
import { createMerchantDiningJoinState } from "./merchant-dining-join-state.js";
const m = vi.hoisted(() => ({ resolve: vi.fn(), fence: vi.fn(), state: vi.fn() }));
vi.mock("./merchant-store-scope.js", () => ({ createMerchantStoreScope: () => m.resolve }));
vi.mock("@rms/dining", async (original) => ({
  ...(await original<typeof import("@rms/dining")>()),
  createPostgresDiningClosingFence: () => m.fence,
  createPostgresDiningJoinRegenerationStore: () => ({ resolveActiveJoin: m.state }),
}));
const id = (n: number) => "01909988-0000-7000-8000-" + n.toString(16).padStart(12, "0");
type Options = Parameters<typeof createMerchantDiningJoinState>[0];
function setup() {
  const allowed = vi.fn(async () => true);
  m.resolve.mockResolvedValue({
    selected: { tenantReference: id(1) },
    context: { brand: { brandReference: id(2) }, resolvedAt: "2026-09-20T18:00:00.000Z" },
    store: { storeReference: id(3) },
    allowed,
  });
  const session = {
    diningSessionReference: id(4),
    tableReference: id(5),
    version: 2,
    tableAssignmentVersion: 1,
    phase: "Active",
  };
  m.fence.mockResolvedValue(session);
  m.state.mockResolvedValue({
    session,
    capability: { version: 3, generation: 2, kind: "HumanCode", selectorHash: "private" },
  });
  return {
    allowed,
    session,
    input: {
      sessionCookie: "synthetic",
      csrf: "synthetic",
      query: { diningSessionReference: id(4) },
    },
    read: createMerchantDiningJoinState({
      persistence: {
        transactions: { run: async (work: (tx: unknown) => unknown) => work({}) },
      } as unknown as Options["persistence"],
      authentication: {
        authorize: async () => ({ sessionReference: id(9) }),
      } as unknown as Options["authentication"],
      credentials: {} as Options["credentials"],
    }),
  };
}
beforeEach(() => vi.clearAllMocks());
it("returns exact versions without secret material", async () => {
  const f = setup();
  expect(await f.read(f.input)).toEqual({
    diningSessionReference: id(4),
    tableReference: id(5),
    sessionVersion: 2,
    tableAssignmentVersion: 1,
    capabilityVersion: 3,
    generation: 2,
    joinKind: "HumanCode",
  });
});
it.each(["Closing", "Closed"])("rejects %s session", async (phase) => {
  const f = setup();
  m.fence.mockResolvedValue({ ...f.session, phase });
  await expect(f.read(f.input)).rejects.toThrow();
  expect(m.state).not.toHaveBeenCalled();
});
it("rejects owner drift", async () => {
  const f = setup();
  m.state.mockResolvedValue({ session: { ...f.session, version: 3 }, capability: {} });
  await expect(f.read(f.input)).rejects.toThrow();
});
it("denies authority loss and injected scope", async () => {
  const f = setup();
  f.allowed.mockResolvedValue(false);
  await expect(f.read(f.input)).rejects.toThrow();
  expect(m.fence).not.toHaveBeenCalled();
  f.allowed.mockResolvedValueOnce(true).mockResolvedValueOnce(false);
  await expect(f.read(f.input)).rejects.toThrow();
  await expect(
    f.read({ ...f.input, query: { ...f.input.query, storeReference: id(8) } }),
  ).rejects.toThrow();
});
