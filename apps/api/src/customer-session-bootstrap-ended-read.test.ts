import { beforeEach, expect, it, vi } from "vitest";
// Batch 45 (v15 b44 live, guest-menu-wait-recheck extra finding): how the visit restore answers a
// dine-in guest whose table's visit ended, read by read. The loaders are stubbed with the shapes
// the pilot returned (TM2 names, "V44 A (TEST)"); the queries themselves are unchanged.
const f = vi.hoisted(() => ({
  resolve: vi.fn(),
  recoverEnded: vi.fn(),
  profile: vi.fn(),
  merged: vi.fn(),
  settled: vi.fn(),
  moved: vi.fn(),
  orders: vi.fn(),
  mergedIn: vi.fn(),
}));
vi.mock("@bop/identity", async (original) => ({
  ...(await original<typeof import("@bop/identity")>()),
  GuestSessionService: class {
    resolve = f.resolve;
    recoverEndedVisitCsrf = f.recoverEnded;
  },
  createPostgresGuestSessionEntryStore: vi.fn(),
}));
vi.mock("@rms/ordering", async (original) => ({
  ...(await original<typeof import("@rms/ordering")>()),
  listStoreDiningSessionOrders: f.orders,
}));
vi.mock("@rms/dining", async (original) => ({
  ...(await original<typeof import("@rms/dining")>()),
  listDiningSessionMergedInto: f.merged,
  listDiningSessionsMergedIn: f.mergedIn,
  loadDiningParticipantSettledTable: f.settled,
  loadDiningParticipantMove: f.moved,
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
  channel: "DineIn",
  locale: "zh-Hans",
  diningState: "DiningBound",
  diningSessionReference: ref(5),
  diningParticipantReference: ref(6),
};
const tx = { query: vi.fn() };
const options = {
  scope: { brandReference: ref(1), storeReference: ref(2) },
  transactions: { run: async (work: (t: typeof tx) => Promise<unknown>) => work(tx) },
  credentials: {},
  binding: vi.fn(),
  now: () => "2026-11-21T01:39:00.000Z",
  publicProfile: {},
} as unknown as Parameters<typeof createCustomerSessionBootstrapRead>[0];
const tm2 = {
  brandDisplayName: "Test Merchant 2 - not production",
  storeDisplayName: "Test Merchant 2 Main - not production",
};
beforeEach(() => {
  vi.clearAllMocks();
  f.resolve.mockResolvedValue(guest);
  f.recoverEnded.mockResolvedValue({ session: guest, csrfCredential: "C".repeat(43) });
  f.profile.mockResolvedValue({ status: "Available", profile: tm2 });
  f.merged.mockResolvedValue(new Map());
  f.moved.mockResolvedValue(null);
  f.settled.mockResolvedValue({ tableLabel: "V44 A (TEST)", tableReference: ref(7) });
  f.orders.mockResolvedValue(new Map());
  f.mergedIn.mockResolvedValue([]);
});

it("a table closed with nothing ordered says so with the Store's names, and gives nothing to act with", async () => {
  const answer = await createCustomerSessionBootstrapRead(options).readSettledTable("A".repeat(43));
  // Before: null, so the phone heard "no visit" and asked the guest for a join code.
  expect(answer).toEqual({ tableLabel: "V44 A (TEST)", nothingOrdered: true, store: tm2 });
  expect(JSON.stringify(answer)).not.toContain("C".repeat(43));
  // An unreadable profile leaves the names out, never the answer.
  f.profile.mockResolvedValue({ status: "Unavailable" });
  expect(
    await createCustomerSessionBootstrapRead(options).readSettledTable("A".repeat(43)),
  ).toEqual({ tableLabel: "V44 A (TEST)", nothingOrdered: true });
});

it("a settled table with orders keeps its receipt access (unchanged)", async () => {
  f.orders.mockResolvedValue(new Map([[ref(5), [{ orderReference: ref(8) }]]]));
  expect(
    await createCustomerSessionBootstrapRead(options).readSettledTable("A".repeat(43)),
  ).toEqual({
    tableLabel: "V44 A (TEST)",
    tableReference: ref(7),
    csrfToken: "C".repeat(43),
    store: tm2,
  });
});

it("a party merged into a table that then closed is thanked there, with the Store's names", async () => {
  // The merged table had ordered (its Order is on the table the party was merged into).
  f.orders.mockResolvedValue(new Map([[ref(9), ref(8)]]));
  f.merged.mockResolvedValue(
    new Map([
      [
        ref(5),
        { diningSessionReference: ref(9), tableLabel: "H4", fromTableLabel: "H3", phase: "Closed" },
      ],
    ]),
  );
  expect(
    await createCustomerSessionBootstrapRead(options).readSettledTable("A".repeat(43)),
  ).toEqual({ tableLabel: "H4", csrfToken: "C".repeat(43), store: tm2 });
});

it("a party moved or merged into an open table is told where, with the Store's names", async () => {
  // The party had ordered (batch 46: one that hadn't is told so, below).
  f.orders.mockResolvedValue(new Map([[ref(5), ref(8)]]));
  f.moved.mockResolvedValue({ tableLabel: "V44 B (TEST)", fromTableLabel: "V44 A (TEST)" });
  expect(await createCustomerSessionBootstrapRead(options).readMovedTable("A".repeat(43))).toEqual({
    tableLabel: "V44 B (TEST)",
    store: tm2,
  });
  f.merged.mockResolvedValue(
    new Map([
      [
        ref(5),
        { diningSessionReference: ref(9), tableLabel: "H4", fromTableLabel: "H3", phase: "Active" },
      ],
    ]),
  );
  expect(await createCustomerSessionBootstrapRead(options).readMovedTable("A".repeat(43))).toEqual({
    tableLabel: "H4",
    merged: true,
    store: tm2,
  });
  f.profile.mockRejectedValue(new Error("profile read failed"));
  expect(await createCustomerSessionBootstrapRead(options).readMovedTable("A".repeat(43))).toEqual({
    tableLabel: "H4",
    merged: true,
  });
});

// Batch 46 (v15 b45 live, b-merged-then-closed-G4-390.png): a party merged into E45 A (TEST),
// which then closed with nothing ordered by anyone, was thanked "for dining with us" with no
// receipt. It is told what a table of its own is told: the visit ended, nothing was charged.
it("a party merged into a table that then closed with nothing ordered is told nothing was charged", async () => {
  f.merged.mockResolvedValue(
    new Map([
      [
        ref(5),
        {
          diningSessionReference: ref(9),
          tableLabel: "E45 A (TEST)",
          fromTableLabel: "E45 C (TEST)",
          phase: "Closed",
        },
      ],
    ]),
  );
  f.mergedIn.mockResolvedValue([ref(5)]);
  const answer = await createCustomerSessionBootstrapRead(options).readSettledTable("A".repeat(43));
  expect(answer).toEqual({ tableLabel: "E45 A (TEST)", nothingOrdered: true, store: tm2 });
  expect(JSON.stringify(answer)).not.toContain("C".repeat(43));
  // Every party at that table was asked about: the target and the parties merged into it.
  expect(f.mergedIn).toHaveBeenCalledWith(tx, options.scope, ref(9));
  expect(f.orders).toHaveBeenCalledWith(tx, options.scope, [ref(9), ref(5)]);
  // An Order of the merged-in party alone still keeps the receipt.
  f.orders.mockResolvedValue(new Map([[ref(5), ref(8)]]));
  expect(
    await createCustomerSessionBootstrapRead(options).readSettledTable("A".repeat(43)),
  ).toEqual({ tableLabel: "E45 A (TEST)", csrfToken: "C".repeat(43), store: tm2 });
});

it("a moved or merged party that ordered nothing is told so (no 'everything you ordered')", async () => {
  f.merged.mockResolvedValue(
    new Map([
      [
        ref(5),
        {
          diningSessionReference: ref(9),
          tableLabel: "E45 A (TEST)",
          fromTableLabel: "E45 C (TEST)",
          phase: "Active",
        },
      ],
    ]),
  );
  expect(await createCustomerSessionBootstrapRead(options).readMovedTable("A".repeat(43))).toEqual({
    tableLabel: "E45 A (TEST)",
    merged: true,
    nothingOrdered: true,
    store: tm2,
  });
  expect(f.orders).toHaveBeenCalledWith(tx, options.scope, [ref(5)]);
  f.orders.mockResolvedValue(new Map([[ref(5), ref(8)]]));
  expect(await createCustomerSessionBootstrapRead(options).readMovedTable("A".repeat(43))).toEqual({
    tableLabel: "E45 A (TEST)",
    merged: true,
    store: tm2,
  });
  f.merged.mockResolvedValue(new Map());
  f.moved.mockResolvedValue({ tableLabel: "E45 B (TEST)", fromTableLabel: "E45 A (TEST)" });
  f.orders.mockResolvedValue(new Map());
  expect(await createCustomerSessionBootstrapRead(options).readMovedTable("A".repeat(43))).toEqual({
    tableLabel: "E45 B (TEST)",
    nothingOrdered: true,
    store: tm2,
  });
});
