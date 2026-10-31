import { beforeEach, expect, it, vi } from "vitest";

// WP-2423 L1: the Hours & ordering panel's service status read. The Store scope and the Store
// owner sources are doubles; the read's authorization sequence is the real code.
const d = vi.hoisted(() => ({
  resolve: vi.fn(),
  ownerAuthorizations: [] as boolean[],
  stateRead: vi.fn(),
}));
vi.mock("./merchant-store-scope.js", () => ({ createMerchantStoreScope: () => d.resolve }));
vi.mock("@rms/store", async (original) => ({
  ...(await original<object>()),
  createPostgresStoreBusinessDateSource:
    (options: {
      authorize(): Promise<boolean>;
      publicationProof(tx: unknown, candidate: unknown, at: string): Promise<unknown>;
    }) =>
    async (tx: unknown, at: string) => {
      d.ownerAuthorizations.push(await options.authorize());
      await options.publicationProof(tx, { configurationReference: id(7) }, at);
    },
  createPostgresCurrentStorePublicationProof:
    (options: { authorize(): Promise<boolean> }) => async () => {
      d.ownerAuthorizations.push(await options.authorize());
      return {
        contentDigest: "sha256:" + "0".repeat(64),
        businessDayStartSource: "Store",
        configuration: {
          configurationReference: id(7),
          enabledServiceModes: ["DineIn", "Pickup"],
          source: "StoreOverride",
          effectiveFrom: "2026-10-01T00:00:00.000Z",
          effectiveUntil: null,
          businessDayStartLocalTime: "04:00:00",
          weeklySchedule: [],
          exceptions: [],
        },
      };
    },
  // Every recorded pause or resume is verified with its audit binding, which authorizes twice.
  createPostgresStoreServiceControlState:
    (options: { authorize(): Promise<boolean> }) => async (_tx: unknown, at: string) => {
      d.stateRead();
      for (let operation = 0; operation < 20 * 2 + 2; operation += 1)
        d.ownerAuthorizations.push(await options.authorize());
      return { expectedVersion: 20, activePauses: [], observedAt: at };
    },
}));
const { createMerchantServiceControl } = await import("./merchant-service-control.js");

const id = (n: number) => "01909974-0000-7000-8000-" + n.toString(16).padStart(12, "0");
const at = "2026-10-17T17:58:41.000Z";
type Options = Parameters<typeof createMerchantServiceControl>[0];
function setup() {
  const tx = { query: vi.fn() };
  const allowed = vi.fn(async () => true);
  d.resolve.mockResolvedValue({
    selected: { tenantReference: id(1) },
    context: { brand: { brandReference: id(2) }, resolvedAt: at },
    store: { storeReference: id(3), timeZone: "America/Toronto" },
    actorReference: id(4),
    allowed,
  });
  const control = createMerchantServiceControl({
    persistence: {
      transactions: { run: async (work: (t: object) => Promise<unknown>) => work(tx) },
      publication: {},
      now: () => at,
    } as unknown as Options["persistence"],
    authentication: { authorize: async () => ({ sessionReference: id(5) }) } as never,
    audit: {} as Options["audit"],
  });
  return { allowed, control };
}
beforeEach(() => {
  vi.clearAllMocks();
  d.ownerAuthorizations = [];
});

it("WP-2423 L1: resolves the caller once at the start and once before the reply, whatever the pause history", async () => {
  const f = setup();
  const state = await f.control.read("synthetic-cookie");
  expect(state).toMatchObject({
    screenId: "STORE-HOURS-SERVICE",
    storeReference: id(3),
    configurationReference: id(7),
    expectedVersion: 20,
    activePauses: [],
  });
  expect(d.resolve).toHaveBeenCalledOnce();
  expect(d.resolve).toHaveBeenCalledWith(
    expect.anything(),
    "synthetic-cookie",
    "store.service.read",
  );
  // Start and final re-check only; the 44 owner-read checks take the run's guard.
  expect(f.allowed).toHaveBeenCalledTimes(2);
  expect(d.ownerAuthorizations).toHaveLength(44);
  expect(d.ownerAuthorizations.every((value) => value)).toBe(true);
});

it("WP-2423 L1: refuses before any owner read without the read permission", async () => {
  const f = setup();
  f.allowed.mockResolvedValueOnce(false);
  await expect(f.control.read("synthetic-cookie")).rejects.toThrow(
    "STORE_SERVICE_PERMISSION_DENIED",
  );
  expect(d.stateRead).not.toHaveBeenCalled();
  expect(d.ownerAuthorizations).toHaveLength(0);
});

it("WP-2423 L1: refuses the reply when the permission or Session ends during the read", async () => {
  const f = setup();
  f.allowed.mockResolvedValueOnce(true).mockResolvedValueOnce(false);
  await expect(f.control.read("synthetic-cookie")).rejects.toThrow(
    "STORE_SERVICE_PERMISSION_DENIED",
  );
  const ended = setup();
  ended.allowed
    .mockResolvedValueOnce(true)
    .mockRejectedValueOnce(new Error("STORE_SERVICE_PERMISSION_DENIED"));
  await expect(ended.control.read("synthetic-cookie")).rejects.toThrow(
    "STORE_SERVICE_PERMISSION_DENIED",
  );
});
