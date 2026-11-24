import { beforeEach, describe, expect, it, vi } from "vitest";
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
  writeOffs: vi.fn(),
  onlinePayments: vi.fn(),
  onlineRefunds: vi.fn(),
  settlementScope: vi.fn(),
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
vi.mock("@rms/payment", async (original) => ({
  ...(await original<typeof import("@rms/payment")>()),
  createPostgresDiningTableSettlementStore: (options: unknown) => {
    f.settlementScope(options);
    return {
      listWriteOffsByOrders: f.writeOffs,
      listOnlinePaymentsByOrders: f.onlinePayments,
      listOnlineRefundsByOrders: f.onlineRefunds,
    };
  },
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
  f.writeOffs.mockResolvedValue([]);
  f.onlinePayments.mockResolvedValue([]);
  f.onlineRefunds.mockResolvedValue([]);
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

// Batch 55 review (v15 b54, TM2 L54 GB2 (TEST), order 59): staff recorded "Guests left without
// paying" and then closed the table. The restore gave the settled table's receipt access, so
// Menu, dish pages and Cart said "Thank you for dining with us … See the receipt", and Your table
// showed nothing (the settled receipt read refuses a written-off bill). The write-off record is
// Payment's, in the shape v15 holds (priced 1413, captured 0, written off 1413).
describe("a bill staff closed when the guests left", () => {
  const withTenant = {
    ...options,
    publicProfile: { binding: { tenantReference: ref(10) } },
  } as unknown as Parameters<typeof createCustomerSessionBootstrapRead>[0];
  const writeOff = (captured: bigint, priced = 1413n) => ({
    orderReference: ref(8),
    reasonCode: "GUEST_LEFT_UNPAID",
    pricedOrderTotalMinor: priced,
    capturedOrderAllocationMinor: captured,
    writtenOffMinor: priced - captured,
  });
  beforeEach(() => {
    f.orders.mockResolvedValue(new Map([[ref(5), ref(8)]]));
  });

  it("nothing paid (order 59): says so, with no receipt access", async () => {
    f.writeOffs.mockResolvedValue([writeOff(0n)]);
    const answer = await createCustomerSessionBootstrapRead(withTenant).readSettledTable(
      "A".repeat(43),
    );
    expect(answer).toEqual({ tableLabel: "V44 A (TEST)", closedByStaff: "Nothing", store: tm2 });
    expect(JSON.stringify(answer)).not.toContain("C".repeat(43));
    // Payment's own record of this table's Order, under the Store's tenant.
    expect(f.writeOffs).toHaveBeenCalledWith(tx, [ref(8)]);
    expect(f.settlementScope).toHaveBeenCalledWith(
      expect.objectContaining({
        scope: { tenantReference: ref(10), brandReference: ref(1), storeReference: ref(2) },
      }),
    );
  });

  it("a dish another guest paid first (order 55, $14.13 of $28.25): what was paid, no receipt access", async () => {
    f.writeOffs.mockResolvedValue([writeOff(1413n, 2825n)]);
    const answer = await createCustomerSessionBootstrapRead(withTenant).readSettledTable(
      "A".repeat(43),
    );
    expect(answer).toEqual({ tableLabel: "V44 A (TEST)", closedByStaff: "Some", store: tm2 });
    expect(JSON.stringify(answer)).not.toContain("C".repeat(43));
  });

  // Batch 56 (v15 b55 live, L55 CB2/CB3 orders 76 and 80): Payment's record of the phone
  // payments on that bill, in the shape v15 holds (part 1 of the split plan, captured 1413).
  const phonePayment = (guestSessionReference: string, status: string) => ({
    onlinePaymentReference: ref(20),
    orderReference: ref(8),
    guestSessionReference,
    roundsMinor: 1413n,
    tipMinor: 0n,
    totalMinor: 1413n,
    part: { splitPlanReference: ref(21), partNumber: 1 },
    outcome: {
      status,
      capturedMinor: status === "Captured" ? 1413n : null,
      providerTransactionReference: null,
      occurredAt: "2026-11-24T00:34:40.000Z",
      recordedAt: "2026-11-24T00:34:40.000Z",
    },
  });
  it("batch 56: the phone that paid part of it is told what it paid, with its own receipt's access", async () => {
    f.writeOffs.mockResolvedValue([writeOff(1413n, 2825n)]);
    f.onlinePayments.mockResolvedValue([phonePayment(guest.sessionReference, "Captured")]);
    const answer = await createCustomerSessionBootstrapRead(withTenant).readSettledTable(
      "A".repeat(43),
    );
    // Before: { tableLabel, closedByStaff: "Some", store } — nothing said the $14.13 was theirs.
    expect(answer).toEqual({
      tableLabel: "V44 A (TEST)",
      closedByStaff: "Some",
      store: tm2,
      yourPayment: { amountMinor: "1413", method: "Online" },
      csrfToken: "C".repeat(43),
    });
    expect(f.onlinePayments).toHaveBeenCalledWith(tx, [ref(8)]);
  });

  // Batch 57 (WP-2423 Q36): staff refunded part of that phone payment to its card. Payment's
  // refund records, in v15's shape: $5.00 Succeeded, $3.00 still on its way (no answer), $2.00
  // the Provider refused; and $4.00 of another guest's payment. Before: amountMinor 1413 only.
  const refund = (payment: string, amountMinor: bigint, status: "Succeeded" | "Failed" | null) => ({
    onlineRefundReference: ref(40 + Number(amountMinor % 97n)),
    onlinePaymentReference: payment,
    orderReference: ref(8),
    amountMinor,
    requestedAt: "2026-11-24T00:40:17.521Z",
    outcome:
      status === null
        ? null
        : {
            status,
            providerRefundReference: null,
            providerCreatedAt: null,
            recordedAt: "2026-11-24T00:40:17.565Z",
          },
  });
  it("batch 57: the payer is told what went back to its card; refused and other guests' refunds are not", async () => {
    f.writeOffs.mockResolvedValue([writeOff(1413n, 2825n)]);
    f.onlinePayments.mockResolvedValue([
      phonePayment(guest.sessionReference, "Captured"),
      { ...phonePayment(ref(30), "Captured"), onlinePaymentReference: ref(31) },
    ]);
    f.onlineRefunds.mockResolvedValue([
      refund(ref(20), 500n, "Succeeded"),
      refund(ref(20), 300n, null),
      refund(ref(20), 200n, "Failed"),
      refund(ref(31), 400n, "Succeeded"),
    ]);
    const answer = await createCustomerSessionBootstrapRead(withTenant).readSettledTable(
      "A".repeat(43),
    );
    expect(answer).toEqual({
      tableLabel: "V44 A (TEST)",
      closedByStaff: "Some",
      store: tm2,
      yourPayment: { amountMinor: "1413", method: "Online", refundedMinor: "800" },
      csrfToken: "C".repeat(43),
    });
    expect(f.onlineRefunds).toHaveBeenCalledWith(tx, [ref(8)]);
    // Only refused refunds: nothing went back, nothing is said.
    f.onlineRefunds.mockResolvedValue([refund(ref(20), 200n, "Failed")]);
    expect(
      await createCustomerSessionBootstrapRead(withTenant).readSettledTable("A".repeat(43)),
    ).toMatchObject({ yourPayment: { amountMinor: "1413", method: "Online" } });
    expect(
      JSON.stringify(
        await createCustomerSessionBootstrapRead(withTenant).readSettledTable("A".repeat(43)),
      ),
    ).not.toContain("refundedMinor");
  });

  it("batch 56: another guest's payment, or a declined one, is never this phone's", async () => {
    f.writeOffs.mockResolvedValue([writeOff(1413n, 2825n)]);
    f.onlinePayments.mockResolvedValue([
      phonePayment(ref(30), "Captured"),
      phonePayment(guest.sessionReference, "Failed"),
    ]);
    const answer = await createCustomerSessionBootstrapRead(withTenant).readSettledTable(
      "A".repeat(43),
    );
    expect(answer).toEqual({ tableLabel: "V44 A (TEST)", closedByStaff: "Some", store: tm2 });
    expect(JSON.stringify(answer)).not.toContain("C".repeat(43));
  });

  it("a party merged into a table whose bill staff closed is told the same", async () => {
    f.merged.mockResolvedValue(
      new Map([
        [
          ref(5),
          {
            diningSessionReference: ref(9),
            tableLabel: "H4",
            fromTableLabel: "H3",
            phase: "Closed",
          },
        ],
      ]),
    );
    f.orders.mockResolvedValue(new Map([[ref(9), ref(8)]]));
    f.writeOffs.mockResolvedValue([writeOff(0n)]);
    expect(
      await createCustomerSessionBootstrapRead(withTenant).readSettledTable("A".repeat(43)),
    ).toEqual({ tableLabel: "H4", closedByStaff: "Nothing", store: tm2 });
  });

  it("a settled bill (no write-off) keeps its receipt access", async () => {
    expect(
      await createCustomerSessionBootstrapRead(withTenant).readSettledTable("A".repeat(43)),
    ).toEqual({
      tableLabel: "V44 A (TEST)",
      tableReference: ref(7),
      csrfToken: "C".repeat(43),
      store: tm2,
    });
  });
});
