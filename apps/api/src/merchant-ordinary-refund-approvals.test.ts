import { beforeEach, expect, it, vi } from "vitest";
import { createMerchantOrdinaryRefundApprovals } from "./merchant-ordinary-refund-approvals.js";

const d = vi.hoisted(() => ({
  scope: vi.fn(),
  queue: vi.fn(),
  authority: vi.fn(),
  maySend: null as null | ((tx: unknown, query: Record<string, string>) => Promise<boolean>),
}));
vi.mock("./merchant-store-scope.js", () => ({ createMerchantStoreScope: () => d.scope }));
vi.mock("./merchant-ordinary-refund-authority.js", () => ({
  createMerchantOrdinaryRefundAuthority: () => d.authority,
}));
vi.mock("@rms/payment", async (original) => ({
  ...(await original<object>()),
  createPostgresOrdinaryRefundApprovalQueueRuntime: (options: {
    requesterMaySend: (tx: unknown, query: Record<string, string>) => Promise<boolean>;
  }) => {
    d.maySend = options.requesterMaySend;
    return d.queue;
  },
}));
const id = (n: number) => "01909990-0000-7000-8000-" + n.toString(16).padStart(12, "0");
const at = "2026-11-10T12:00:00.000Z";

function setup() {
  const queries: string[] = [];
  const transaction = {
    query: vi.fn(async (sql: string) => {
      queries.push(sql);
      return { rows: [], rowCount: 0 };
    }),
  };
  d.scope.mockResolvedValue({
    actorReference: id(2),
    selected: { tenantReference: id(5) },
    context: { brand: { brandReference: id(3) }, resolvedAt: at },
    store: { storeReference: id(4) },
    allowed: async () => true,
    authorizeAction: async () => ({ effect: "Allow" }),
  });
  // The queue asks whether a request recorded before its requester's role was kept may wait.
  d.queue.mockImplementation(async () => {
    results.push(
      await (d.maySend as NonNullable<typeof d.maySend>)(transaction, {
        orderReference: id(6),
        requesterReference: id(7),
        requestedAt: at,
      }),
    );
    return [];
  });
  const results: boolean[] = [];
  const approvals = createMerchantOrdinaryRefundApprovals({
    persistence: {
      transactions: { run: (work: (tx: unknown) => Promise<unknown>) => work(transaction) },
    } as never,
    resolveConfiguration: (async () => ({
      providerAccountReference: id(8),
      environment: "Test",
      businessDate: {},
      workforce: {},
    })) as never,
  });
  return { approvals, queries, results };
}
beforeEach(() => vi.resetAllMocks());

it("WP-2423 M14: a requester role that can't be read is undone in a savepoint and the request waits the usual minute", async () => {
  const f = setup();
  // A SQL error inside the workforce read: it must not abort the business transaction.
  d.authority.mockRejectedValue(Object.assign(new Error("boom"), { code: "42P01" }));
  await f.approvals({ sessionCookie: "synthetic" });
  expect(f.results).toEqual([true]);
  const savepoint = f.queries.filter((sql) => sql.includes("refund_requester_may_send"));
  expect(savepoint).toEqual([
    "SAVEPOINT refund_requester_may_send",
    "ROLLBACK TO SAVEPOINT refund_requester_may_send",
    "RELEASE SAVEPOINT refund_requester_may_send",
  ]);
});

it("WP-2423 M14: a cashier's role read in its savepoint lists the request at once; a manager's waits", async () => {
  for (const [role, waits] of [
    ["Staff", false],
    ["Manager", true],
  ] as const) {
    const f = setup();
    d.authority.mockResolvedValue({ role });
    await f.approvals({ sessionCookie: "synthetic" });
    expect(f.results).toEqual([waits]);
    expect(f.queries.filter((sql) => sql.includes("refund_requester_may_send"))).toEqual([
      "SAVEPOINT refund_requester_may_send",
      "RELEASE SAVEPOINT refund_requester_may_send",
    ]);
  }
});
