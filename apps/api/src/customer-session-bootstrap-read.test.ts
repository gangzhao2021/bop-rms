import { beforeEach, expect, it, vi } from "vitest";
const f = vi.hoisted(() => ({
  resolve: vi.fn(),
  recover: vi.fn(),
  latest: vi.fn(),
  factory: vi.fn(),
  profile: vi.fn(),
}));
vi.mock("@bop/identity", async (original) => ({
  ...(await original<typeof import("@bop/identity")>()),
  GuestSessionService: class {
    resolve = f.resolve;
    recoverForegroundCsrf = f.recover;
  },
  createPostgresGuestSessionEntryStore: vi.fn(),
}));
vi.mock("@rms/ordering", async (original) => ({
  ...(await original<typeof import("@rms/ordering")>()),
  createPostgresGuestCheckoutRecovery: f.factory,
}));
vi.mock("@rms/store", async (original) => ({
  ...(await original<typeof import("@rms/store")>()),
  createPublicStoreProfileService: () => ({ getPublicStore: f.profile }),
}));
vi.mock("./persistent-public-store-profile.js", () => ({
  createPersistentPublicStoreProfilePorts: vi.fn(),
}));
import { createCustomerSessionBootstrapRead } from "./customer-session-bootstrap.js";
const ref = (n: number) => `0190fa21-0000-7000-8000-${String(n).padStart(12, "0")}`;
const guest = {
  brandReference: ref(1),
  storeReference: ref(2),
  sessionReference: ref(3),
  publicStoreReference: ref(4),
  channel: "Pickup",
  locale: "en-CA",
};
const tx = { query: vi.fn() };
const options = {
  scope: { brandReference: ref(1), storeReference: ref(2) },
  transactions: { run: async (work: (t: typeof tx) => Promise<unknown>) => work(tx) },
  credentials: {},
  binding: vi.fn(),
  now: () => "2026-09-21T06:00:00.000Z",
  publicProfile: {},
} as unknown as Parameters<typeof createCustomerSessionBootstrapRead>[0];
beforeEach(() => {
  vi.clearAllMocks();
  f.resolve.mockResolvedValue(guest);
  f.recover.mockResolvedValue("B".repeat(43));
  f.profile.mockResolvedValue({
    status: "Available",
    profile: { brandDisplayName: "Brand", storeDisplayName: "Store" },
  });
  f.factory.mockReturnValue({ latest: f.latest });
  f.latest.mockImplementation(async (transaction, input) => {
    const auth = f.factory.mock.calls[0]?.[0].authorize;
    if (!(await auth(transaction, input))) throw new Error("denied");
    return { checkoutSessionReference: ref(5), paymentOperationReference: ref(6) };
  });
});
it("binds discovery to the current Guest and projects only checkout identity", async () => {
  const result = await createCustomerSessionBootstrapRead(options).read("A".repeat(43));
  expect(result).toMatchObject({ checkoutSessionReference: ref(5) });
  expect(result).not.toHaveProperty("paymentOperationReference");
  expect(f.latest).toHaveBeenCalledWith(tx, {
    guestSessionReference: ref(3),
    observedAt: options.now(),
  });
});
it("denies a scope mismatch before returning recovery", async () => {
  f.resolve.mockResolvedValue({ ...guest, storeReference: ref(9) });
  await expect(createCustomerSessionBootstrapRead(options).read("A".repeat(43))).rejects.toThrow();
});
it("denies identity replacement during discovery", async () => {
  f.resolve.mockResolvedValueOnce(guest).mockResolvedValue({ ...guest, sessionReference: ref(9) });
  await expect(createCustomerSessionBootstrapRead(options).read("A".repeat(43))).rejects.toThrow();
});
it("denies identity replacement after discovery", async () => {
  f.resolve
    .mockResolvedValueOnce(guest)
    .mockResolvedValueOnce(guest)
    .mockResolvedValue({ ...guest, sessionReference: ref(9) });
  await expect(createCustomerSessionBootstrapRead(options).read("A".repeat(43))).rejects.toThrow();
});
it("returns ordinary menu bootstrap when no checkout exists", async () => {
  f.latest.mockResolvedValue(null);
  const result = await createCustomerSessionBootstrapRead(options).read("A".repeat(43));
  expect(result).toHaveProperty("menuContext");
  expect(result).not.toHaveProperty("checkoutSessionReference");
});
