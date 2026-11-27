import { beforeEach, expect, it, vi } from "vitest";
const m = vi.hoisted(() => ({
  identity: vi.fn(),
  authorize: vi.fn(),
  settle: vi.fn(),
  write: vi.fn(),
  tx: [] as unknown[],
}));
vi.mock("@bop/identity", async (original) => ({
  ...(await original<typeof import("@bop/identity")>()),
  GuestSessionService: class {
    authorize(value: unknown) {
      return m.identity(value);
    }
  },
  createPostgresFencedGuestSessionEntryStore: () => ({}),
}));
vi.mock("./dining-cart-replacement-authorization.js", () => ({
  createDiningCartReplacementAuthorization: () => m.authorize,
}));
vi.mock("./dining-cart-replacement-settlement.js", () => ({
  createDiningCartReplacementSettlement: () => ({ clear: m.settle }),
}));
vi.mock("@rms/ordering", async (original) => ({
  ...(await original<typeof import("@rms/ordering")>()),
  createPostgresDiningCartReplacementStore: (
    runner: { run(work: (tx: unknown) => Promise<unknown>): Promise<unknown> },
    options: {
      authorizeAndFence(tx: unknown, c: unknown): Promise<boolean>;
      settlementClear(tx: unknown, c: unknown, at: string): Promise<boolean>;
    },
  ) => ({
    replace: async (command: unknown) =>
      runner.run(async (tx) => {
        m.tx.push(tx);
        if (
          !(await options.authorizeAndFence(tx, command)) ||
          !(await options.settlementClear(tx, {}, "2026-09-20T13:00:00.000Z"))
        )
          throw new Error("denied");
        return m.write(command);
      }),
  }),
}));
import { CartError } from "@rms/ordering";
import { createCustomerDiningCartReplacement } from "./customer-dining-cart-replacement.js";
const id = (n: number) => "0190edb6-0000-7000-8000-" + n.toString(16).padStart(12, "0"),
  at = "2026-09-20T13:00:00.000Z";
const scope = { tenantReference: id(1), brandReference: id(2), storeReference: id(3) };
const input = {
  sessionCredential: "A".repeat(43),
  csrfCredential: "B".repeat(43),
  operationReference: id(4),
  previousCartReference: id(5),
  expectedCartVersion: 2,
};
const session = () => ({
  brandReference: id(2),
  storeReference: id(3),
  sessionReference: id(6),
  channel: "DineIn",
  diningState: "DiningBound",
  diningSessionReference: id(7),
  diningParticipantReference: id(8),
});
function fixture() {
  const tx = { query: vi.fn(async () => ({ rows: [], rowCount: 0 })) },
    run = vi.fn();
  const service = createCustomerDiningCartReplacement({
    scope,
    transactions: {
      run: async (work) => {
        run();
        return work(tx);
      },
    },
    credentials: {} as never,
    binding: () => ({ validate: async () => "Current" }),
    policy: {
      policyVersionReference: id(9),
      policyDigest: "sha256:" + "a".repeat(64),
      idleTimeoutSeconds: 3600,
      absoluteTimeoutSeconds: 86400,
      validFrom: at,
      validUntil: "2026-09-21T13:00:00.000Z",
    },
    payment: { providerAccountReference: id(10), environment: "Test" },
    audit: () => ({}),
    generateReference: () => id(11),
    now: () => at,
  });
  return { service, tx, run };
}
beforeEach(() => {
  vi.clearAllMocks();
  m.tx.length = 0;
  m.identity.mockResolvedValue(session());
  m.authorize.mockResolvedValue(true);
  m.settle.mockResolvedValue(true);
  m.write.mockResolvedValue({ cartReference: id(11) });
});
it("derives authority fields server-side and borrows one transaction for every gate", async () => {
  const f = fixture();
  expect(await f.service.replace(input)).toEqual({ cartReference: id(11) });
  expect(f.run).toHaveBeenCalledTimes(1);
  expect(m.tx).toEqual([f.tx]);
  expect(m.authorize.mock.calls[0]?.[0]).toBe(f.tx);
  expect(m.settle.mock.calls[0]?.[0]).toBe(f.tx);
  expect(m.write).toHaveBeenCalledWith({
    brandReference: id(2),
    storeReference: id(3),
    operationReference: id(4),
    previousCartReference: id(5),
    expectedCartVersion: 2,
    guestSessionReference: id(6),
    diningSessionReference: id(7),
    participantReference: id(8),
    observedAt: at,
  });
});
it.each([
  "guestSessionReference",
  "diningSessionReference",
  "participantReference",
  "brandReference",
  "observedAt",
])("rejects browser-supplied authority %s before transaction", async (field) => {
  const f = fixture();
  await expect(f.service.replace({ ...input, [field]: id(99) })).rejects.toMatchObject({
    code: "CART_INPUT_INVALID",
  });
  expect(f.run).not.toHaveBeenCalled();
});
it.each([
  { channel: "Pickup" },
  { diningState: "ContextOnly" },
  { brandReference: id(99) },
  { diningParticipantReference: null },
])("rejects invalid current identity %j", async (change) => {
  const f = fixture();
  m.identity.mockResolvedValue({ ...session(), ...change });
  await expect(f.service.replace(input)).rejects.toMatchObject({ code: "CART_PERMISSION_DENIED" });
  expect(m.write).not.toHaveBeenCalled();
});
it.each(["authorize", "settle"] as const)("does not write after %s denial", async (gate) => {
  const f = fixture();
  m[gate].mockResolvedValue(false);
  await expect(f.service.replace(input)).rejects.toMatchObject({
    code: "CART_DEPENDENCY_UNAVAILABLE",
  });
  expect(m.write).not.toHaveBeenCalled();
});
it("bounds private dependency failures", async () => {
  const f = fixture();
  m.identity.mockRejectedValue(new Error("private"));
  await expect(f.service.replace(input)).rejects.toMatchObject({
    code: "CART_DEPENDENCY_UNAVAILABLE",
    message: "cart is unavailable",
  });
});

it("preserves known Host refusal without writing", async () => {
  const f = fixture();
  m.authorize.mockRejectedValue(new CartError("CART_REPLACEMENT_FORBIDDEN"));
  await expect(f.service.replace(input)).rejects.toMatchObject({
    code: "CART_REPLACEMENT_FORBIDDEN",
  });
  expect(m.write).not.toHaveBeenCalled();
});
