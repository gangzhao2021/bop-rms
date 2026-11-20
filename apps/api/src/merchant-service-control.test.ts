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
// Batch 36: the business-day read's owner reads (configuration and publication proof), each
// authorizing as the real source does; a pause history's length must not matter there either.
vi.mock("./merchant-store-business-day.js", async (original) => ({
  ...(await original<object>()),
  createMerchantStoreBusinessDay:
    (options: { authorize(tx: unknown): Promise<boolean> }) => async (tx: unknown, at: string) => {
      d.stateRead();
      for (let check = 0; check < 6; check += 1)
        d.ownerAuthorizations.push(await options.authorize(tx));
      if (!d.ownerAuthorizations.every((value) => value)) throw new Error("UNAVAILABLE");
      return {
        businessDate: "2026-10-17",
        startsAt: "2026-10-17T08:00:00.000Z",
        endsAt: "2026-10-18T08:00:00.000Z",
        timeZone: "America/Toronto",
        observedAt: at,
        lastOrdersAt: null,
        closesAt: null,
        closedToday: false,
      };
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

it("WP-2423 L1: refuses before any owner read without the read or pause permission", async () => {
  const f = setup();
  f.allowed.mockResolvedValue(false);
  await expect(f.control.read("synthetic-cookie")).rejects.toThrow(
    "STORE_SERVICE_PERMISSION_DENIED",
  );
  expect(d.stateRead).not.toHaveBeenCalled();
  expect(d.ownerAuthorizations).toHaveLength(0);
});

it("DEC-PAID-ORDER-AUTO-ACCEPT: whoever may pause reads whether the Store is paused", async () => {
  const f = setup();
  f.allowed.mockResolvedValueOnce(false);
  await expect(f.control.read("synthetic-cookie")).resolves.toBeDefined();
  expect(d.stateRead).toHaveBeenCalled();
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

it("batch 36: the business day resolves the caller once at the start and once before the reply", async () => {
  const f = setup();
  await expect(f.control.businessDay("synthetic-cookie")).resolves.toMatchObject({
    businessDate: "2026-10-17",
    closesAt: null,
  });
  expect(d.resolve).toHaveBeenCalledOnce();
  expect(d.resolve).toHaveBeenCalledWith(expect.anything(), "synthetic-cookie", "merchant.access");
  // Start and final re-check only; the six owner-read checks take the run's guard.
  expect(f.allowed).toHaveBeenCalledTimes(2);
  expect(d.ownerAuthorizations).toEqual([true, true, true, true, true, true]);
});

it("batch 36: the business day is refused before any owner read, and when access ends during it", async () => {
  const refused = setup();
  refused.allowed.mockResolvedValue(false);
  await expect(refused.control.businessDay("synthetic-cookie")).rejects.toThrow(
    "STORE_SERVICE_PERMISSION_DENIED",
  );
  expect(d.stateRead).not.toHaveBeenCalled();
  const ended = setup();
  ended.allowed.mockResolvedValueOnce(true).mockResolvedValueOnce(false);
  await expect(ended.control.businessDay("synthetic-cookie")).rejects.toThrow(
    "STORE_SERVICE_PERMISSION_DENIED",
  );
  const signedOut = setup();
  signedOut.allowed
    .mockResolvedValueOnce(true)
    .mockRejectedValueOnce(new Error("STORE_SERVICE_PERMISSION_DENIED"));
  await expect(signedOut.control.businessDay("synthetic-cookie")).rejects.toThrow(
    "STORE_SERVICE_PERMISSION_DENIED",
  );
});
