import { beforeEach, expect, it, vi } from "vitest";

const mock = vi.hoisted(() => ({
  resolve: vi.fn(),
  load: vi.fn(),
  change: vi.fn(),
}));
vi.mock("./merchant-store-scope.js", () => ({ createMerchantStoreScope: () => mock.resolve }));
vi.mock("@rms/dining", async (original) => ({
  ...(await original<typeof import("@rms/dining")>()),
  loadDiningServiceSetting: mock.load,
  changeDiningServiceSetting: mock.change,
}));
import { DiningSessionError } from "@rms/dining";
import {
  createMerchantGuestTableStartOff,
  guestTableStartOffPermission,
} from "./merchant-dining-guest-table-start.js";

const id = (n: number) => "0190fad7-0000-7000-8000-" + String(n).padStart(12, "0");
function setup(allowed = true) {
  mock.resolve.mockResolvedValue({
    selected: { tenantReference: id(1) },
    context: { brand: { brandReference: id(2) } },
    store: { storeReference: id(3) },
    actorReference: id(4),
    allowed: async () => allowed,
  });
  mock.load.mockResolvedValue({
    version: 4,
    staffCall: true,
    chaseDish: false,
    askPartySize: true,
    guestTableStart: true,
  });
  mock.change.mockResolvedValue({ version: 5, guestTableStart: false });
  return createMerchantGuestTableStartOff({
    persistence: {
      transactions: { run: (work: (tx: unknown) => unknown) => work({ query: vi.fn() }) },
      now: () => "2026-11-05T12:00:00.000Z",
    } as never,
    authentication: { authorize: async () => ({ sessionReference: id(9) }) } as never,
  });
}
const input = (command: unknown = { operationReference: id(6), expectedVersion: 4 }) => ({
  sessionCookie: "cookie",
  csrf: "csrf",
  command,
});
beforeEach(() => vi.resetAllMocks());

it("whoever may pause ordering stops guests starting tables, keeping every other switch", async () => {
  await expect(setup()(input())).resolves.toEqual({ guestTableStart: false, version: 5 });
  expect(mock.resolve.mock.calls[0]?.[2]).toBe(guestTableStartOffPermission);
  expect(guestTableStartOffPermission).toBe("operations.ordering.pause");
  expect(mock.change.mock.calls[0]?.[2]).toMatchObject({
    operationReference: id(6),
    expectedVersion: 4,
    staffCall: true,
    chaseDish: false,
    guestTableStart: false,
    actorReference: id(4),
  });
});

it("turning it on stays with the owner: only the Store features command can, under its own permission", async () => {
  const { storeFeaturesPermission } = await import("./merchant-store-features.js");
  expect(storeFeaturesPermission).toBe("organization.manage");
  expect(guestTableStartOffPermission).not.toBe(storeFeaturesPermission);
});

it("there is no way to turn it on from here, whatever is sent", async () => {
  await expect(
    setup()(input({ operationReference: id(6), expectedVersion: 4, guestTableStart: true })),
  ).rejects.toThrow();
  expect(mock.change).not.toHaveBeenCalled();
});

it("someone without the permission changes nothing", async () => {
  await expect(setup(false)(input())).rejects.toMatchObject({ code: "Denied" });
  expect(mock.change).not.toHaveBeenCalled();
});

it("a change made meanwhile is told apart from a failure", async () => {
  const run = setup();
  mock.change.mockRejectedValueOnce(new DiningSessionError("DINING_SESSION_IDEMPOTENCY_CONFLICT"));
  await expect(run(input())).rejects.toMatchObject({ code: "Changed" });
  mock.change.mockRejectedValueOnce(new Error("database"));
  await expect(run(input())).rejects.toMatchObject({ code: "Unavailable" });
});
