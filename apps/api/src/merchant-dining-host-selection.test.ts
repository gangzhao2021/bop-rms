import { beforeEach, expect, it, vi } from "vitest";
import { createMerchantDiningHostSelection } from "./merchant-dining-host-selection.js";
const m = vi.hoisted(() => ({ resolve: vi.fn(), read: vi.fn(), owner: vi.fn() }));
vi.mock("./merchant-store-scope.js", () => ({ createMerchantStoreScope: () => m.resolve }));
vi.mock("@rms/dining", async (original) => ({
  ...(await original<typeof import("@rms/dining")>()),
  createPostgresDiningHostTransferSelection: m.owner,
}));
const id = (n: number) => "0190fa42-0000-7000-8000-" + n.toString(16).padStart(12, "0");
type Options = Parameters<typeof createMerchantDiningHostSelection>[0];
function setup() {
  const tx = {},
    allowed = vi.fn(async () => true);
  m.resolve.mockResolvedValue({
    selected: { tenantReference: id(1) },
    context: { brand: { brandReference: id(2) } },
    store: { storeReference: id(3) },
    allowed,
  });
  m.owner.mockReturnValue({ readCurrent: m.read });
  m.read.mockResolvedValue({ participants: [] });
  const read = createMerchantDiningHostSelection({
    persistence: {
      transactions: { run: async (work: (tx: unknown) => Promise<unknown>) => work(tx) },
      now: () => "2026-09-21T03:55:00.000Z",
    } as unknown as Options["persistence"],
    authentication: {
      authorize: async () => ({ sessionReference: id(4) }),
    } as unknown as Options["authentication"],
  });
  return {
    read,
    allowed,
    tx,
    input: {
      sessionCookie: "synthetic",
      csrf: "synthetic",
      query: { diningSessionReference: id(5) },
    },
  };
}
beforeEach(() => vi.clearAllMocks());
it("requires the current selected-store transfer permission", async () => {
  const f = setup();
  await f.read(f.input);
  expect(m.resolve).toHaveBeenCalledWith(f.tx, "synthetic", "dining.host.transfer", id(4));
  expect(m.read).toHaveBeenCalledWith({ diningSessionReference: id(5) });
});
it.each([
  { storeReference: id(99) },
  { actorReference: id(99) },
  { observedAt: "2026-09-21T03:55:00.000Z" },
])("rejects injected query authority %j", async (extra) => {
  const f = setup();
  await expect(f.read({ ...f.input, query: { ...f.input.query, ...extra } })).rejects.toThrow();
  expect(m.read).not.toHaveBeenCalled();
});
it("denies before lookup and withholds results after revocation", async () => {
  const f = setup();
  f.allowed.mockResolvedValue(false);
  await expect(f.read(f.input)).rejects.toThrow();
  expect(m.read).not.toHaveBeenCalled();
  f.allowed.mockResolvedValueOnce(true).mockResolvedValue(false);
  await expect(f.read(f.input)).rejects.toThrow();
});
