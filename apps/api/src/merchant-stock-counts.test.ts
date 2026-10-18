import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  createMerchantStockCounts,
  parseStockCountCommandBody,
  redactStockCount,
} from "./merchant-stock-counts.js";
import { createMerchantStoreWaste, parseStoreWasteCommandBody } from "./merchant-store-waste.js";

const id = (n: number) => "01909a1b-0000-7000-8000-" + n.toString(16).padStart(12, "0");
const base = { operationReference: id(1), countReference: id(2), expectedVersion: 3 };
describe("WP-2423 stock count command body", () => {
  it("accepts each count action", () => {
    const bodies = [
      {
        action: "Create",
        operationReference: id(1),
        locationReference: id(4),
        countType: "Cycle",
        assigneeReference: id(5),
      },
      { action: "Start", ...base },
      { action: "Submit", ...base },
      { action: "Refresh", ...base },
      { action: "SendBack", ...base },
      { action: "Cancel", ...base },
      { action: "SaveLine", ...base, lineReference: id(6), countedQuantity: "4.25" },
      {
        action: "ExplainVariance",
        ...base,
        lineReference: id(6),
        varianceReasonCode: "UNRECORDED_WASTE",
      },
      { action: "ApproveAndPost", ...base, postOperationReference: id(7) },
    ];
    expect(bodies.map((body) => parseStockCountCommandBody(body).action)).toEqual(
      bodies.map((body) => body.action),
    );
  });
  it.each([
    [
      "a negative count",
      { action: "SaveLine", ...base, lineReference: id(6), countedQuantity: "-1" },
    ],
    [
      "a client unit",
      { action: "SaveLine", ...base, lineReference: id(6), countedQuantity: "1", unitCode: "KG" },
    ],
    [
      "an unknown variance reason",
      { action: "ExplainVariance", ...base, lineReference: id(6), varianceReasonCode: "BECAUSE" },
    ],
    [
      "a visible-expected count",
      {
        action: "Create",
        operationReference: id(1),
        locationReference: id(4),
        countType: "Cycle",
        assigneeReference: id(5),
        expectedQuantityVisibility: "Visible",
      },
    ],
    ["a separate Post", { action: "Post", ...base }],
    ["a zero version", { action: "Submit", ...base, expectedVersion: 0 }],
  ])("refuses %s", (_name, body) => {
    expect(() => parseStockCountCommandBody(body)).toThrow();
  });
});
describe("WP-2423 waste command body", () => {
  it("accepts recording and reviews with their reasons", () => {
    expect(
      parseStoreWasteCommandBody({
        action: "Record",
        operationReference: id(1),
        wasteReference: id(2),
        lines: [],
      }).action,
    ).toBe("Record");
    expect(
      parseStoreWasteCommandBody({
        action: "Review",
        operationReference: id(1),
        wasteReference: id(2),
        decision: "Voided",
        reasonCode: "ENTERED_IN_ERROR",
      }).action,
    ).toBe("Review");
  });
  it.each([
    [
      "an accept with a void reason",
      {
        action: "Review",
        operationReference: id(1),
        wasteReference: id(2),
        decision: "Accepted",
        reasonCode: "ENTERED_IN_ERROR",
      },
    ],
    [
      "a client recorder",
      {
        action: "Record",
        operationReference: id(1),
        wasteReference: id(2),
        lines: [],
        recordedBy: id(3),
      },
    ],
    [
      "an unknown decision",
      {
        action: "Review",
        operationReference: id(1),
        wasteReference: id(2),
        decision: "Approved",
        reasonCode: "REVIEWED_OK",
      },
    ],
  ])("refuses %s", (_name, body) => {
    expect(() => parseStoreWasteCommandBody(body)).toThrow();
  });
});

describe("WP-2423 blind count redaction", () => {
  const count = (status: string, assignee: string) =>
    ({
      status,
      assigneeReference: assignee,
      expectedQuantityVisibility: "BlindUntilSubmit",
      lines: [{ expectedQuantity: "14", variance: "-0.5", balanceVersion: 3 }],
    }) as never;
  it("hides expected quantities from the counter even when they may approve", () => {
    expect(redactStockCount(count("InProgress", id(9)), true, id(9)).lines[0]).toMatchObject({
      expectedQuantity: null,
      variance: null,
    });
  });
  it("shows them to other approvers, and to everyone once submitted", () => {
    expect(
      redactStockCount(count("InProgress", id(9)), true, id(8)).lines[0]?.expectedQuantity,
    ).toBe("14");
    expect(
      redactStockCount(count("InProgress", id(9)), false, id(8)).lines[0]?.expectedQuantity,
    ).toBeNull();
    expect(
      redactStockCount(count("Submitted", id(9)), false, id(9)).lines[0]?.expectedQuantity,
    ).toBe("14");
  });
  it("never sends ledger versions to the browser", () => {
    expect(
      redactStockCount(count("Posted", id(9)), true, id(8)).lines[0]?.balanceVersion,
    ).toBeUndefined();
  });
});

const d = vi.hoisted(() => ({
  resolve: vi.fn(),
  ports: vi.fn(),
  execute: vi.fn(),
  list: vi.fn(),
  members: vi.fn(async (): Promise<unknown[]> => []),
  names: vi.fn(async (): Promise<Map<string, string>> => new Map()),
  roles:
    vi.fn<
      (
        tx: unknown,
        scope: { storeReference: string | null },
      ) => Promise<{ assignments: unknown[]; pending: unknown[] }>
    >(),
  waste: vi.fn(),
  shortages: vi.fn(async (): Promise<unknown[]> => []),
  orders: vi.fn(async (): Promise<unknown[]> => []),
  lots: vi.fn(async (): Promise<Map<string, unknown>> => new Map()),
}));
vi.mock("./merchant-store-scope.js", () => ({ createMerchantStoreScope: () => d.resolve }));
vi.mock("./merchant-stock-catalog.js", () => ({
  merchantStockCatalog: async () => ({ items: [], locations: [] }),
}));
vi.mock("@bop/membership", async (original) => ({
  ...(await original<object>()),
  listStoreMembers: d.members,
  memberDisplayNames: d.names,
}));
vi.mock("@bop/permission", async (original) => ({
  ...(await original<object>()),
  listStoreRoleAssignments: d.roles,
}));
vi.mock("@rms/inventory", async (original) => ({
  ...(await original<object>()),
  listStoreWaste: d.waste,
  listWasteableStock: async () => [],
  createPostgresStockCountPorts: d.ports,
  executeStockCountCommand: d.execute,
  listStockCounts: d.list,
  listStoreStockShortages: d.shortages,
  stockLotLabels: d.lots,
}));
vi.mock("@rms/ordering", async (original) => ({
  ...(await original<object>()),
  listStoreOrdersOfSubmissions: d.orders,
}));
type Options = Parameters<typeof createMerchantStockCounts>[0];
type Authorize = (request: { action: string; permission: string }) => Promise<unknown>;
const allowAll = async (actions: readonly string[]) =>
  new Map(actions.map((action) => [action, { effect: "Allow" as "Allow" | "Deny" }]));
function setup() {
  const tx = { query: vi.fn() };
  const allowed = vi.fn(async () => true);
  const authorizeActions = vi.fn(allowAll);
  d.resolve.mockResolvedValue({
    selected: { tenantReference: id(7) },
    context: { brand: { brandReference: id(8) } },
    store: { storeReference: id(9) },
    actorReference: id(10),
    allowed,
    authorizeActions,
  });
  d.ports.mockImplementation((_tx: unknown, _owner: unknown, ports: unknown) => ports);
  d.list.mockResolvedValue({ counts: [], hasMore: false });
  d.roles.mockResolvedValue({ assignments: [], pending: [] });
  d.execute.mockImplementation(
    async (
      command: { action: string; permission: string },
      ports: { authorization: { authorize: Authorize } },
    ) => {
      if ((await ports.authorization.authorize(command)) === null) throw new Error("denied");
      return { outcome: "Applied", count: { aggregateVersion: 4 } };
    },
  );
  const run = vi.fn(async (work: (t: object) => Promise<unknown>) => work(tx));
  const service = createMerchantStockCounts({
    persistence: { transactions: { run }, now: () => "2026-10-15T12:00:00.000Z" },
    authentication: { authorize: async () => ({ sessionReference: id(6) }) },
    references: { next: () => id(5) },
    locale: "en-CA",
  } as unknown as Options);
  const input = { sessionCookie: "synthetic-cookie", csrf: "synthetic-csrf" };
  const submit = { ...input, body: { action: "Submit", ...base } };
  return { tx, allowed, authorizeActions, service, input, submit };
}
const role = (actor: number, roleCode: string, roleName: string) => ({
  actorReference: id(actor),
  roleCode,
  roleName,
});
describe("v15 run: stock count people", () => {
  beforeEach(() => vi.clearAllMocks());
  it("names counters from the staff list and the Brand directory, never an identifier fragment", async () => {
    const f = setup();
    d.members.mockResolvedValue([
      { actorReference: id(10), displayName: "Ana", membershipLifecycle: "Active" },
      { actorReference: id(11), displayName: null, membershipLifecycle: "Active" },
      { actorReference: id(12), displayName: null, membershipLifecycle: "Active" },
      { actorReference: id(13), displayName: null, membershipLifecycle: "Active" },
    ]);
    // The Store owner created by Brand provisioning has no recorded name: they are named by role.
    d.roles.mockImplementation(async (_tx, scope) => ({
      assignments:
        scope.storeReference === null
          ? [role(11, "brand_owner", "Brand Owner"), role(258, "brand_owner", "Brand Owner")]
          : [
              role(11, "synthetic_acceptance_0190fa30", "synthetic_acceptance_0190fa30"),
              role(11, "store_owner", "Owner"),
              role(12, "kitchen", "Kitchen"),
              role(13, "internal_pilot_exception_operator", "internal_pilot_exception_operator"),
            ],
      pending: [],
    }));
    d.names.mockResolvedValue(new Map([[id(256), "Mina Chen"]]));
    d.list.mockResolvedValue({
      counts: [
        { assigneeReference: id(256) },
        { assigneeReference: id(257) },
        { assigneeReference: id(258) },
        { assigneeReference: id(10) },
        { assigneeReference: null },
      ],
      hasMore: false,
    });
    const view = (await f.service.query({ ...f.input, countReference: null, before: null })) as {
      staff: unknown;
      people: unknown;
    };
    expect(view.staff).toEqual([
      { actorReference: id(10), label: "You" },
      { actorReference: id(11), label: "Store owner" },
      { actorReference: id(12), label: "Kitchen" },
      { actorReference: id(13), label: "Staff member" },
    ]);
    expect(d.names).toHaveBeenCalledWith(expect.anything(), expect.anything(), [
      id(256),
      id(257),
      id(258),
    ]);
    expect(view.people).toEqual([
      { actorReference: id(256), label: "Mina Chen" },
      { actorReference: id(257), label: "Staff member" },
      { actorReference: id(258), label: "Brand owner" },
    ]);
    expect(JSON.stringify(view)).not.toMatch(/Staff [0-9a-f]{4}|Unnamed/u);
    expect(JSON.stringify([view.staff, view.people])).not.toMatch(/_|Owner"/u);
  });
});
describe("v15 run: waste people", () => {
  beforeEach(() => vi.clearAllMocks());
  it("names recorders and reviewers by name or role, including people no longer on the staff list", async () => {
    const tx = { query: vi.fn() };
    d.resolve.mockResolvedValue({
      selected: { tenantReference: id(7) },
      context: { brand: { brandReference: id(8) } },
      store: { storeReference: id(9) },
      actorReference: id(10),
      allowed: async () => true,
      authorizeActions: allowAll,
      authorizeAction: async () => ({ effect: "Allow" }),
    });
    d.members.mockResolvedValue([
      { actorReference: id(10), displayName: "Mia", membershipLifecycle: "Active" },
      { actorReference: id(11), displayName: null, membershipLifecycle: "Active" },
    ]);
    d.names.mockResolvedValue(new Map([[id(256), "Mina Chen"]]));
    d.roles.mockImplementation(async (_tx, scope) => ({
      assignments: scope.storeReference === null ? [] : [role(11, "store_owner", "Owner")],
      pending: [],
    }));
    d.waste.mockResolvedValue({
      records: [
        { recordedBy: id(256), review: { reviewedBy: id(11) } },
        { recordedBy: id(257), review: null },
        { recordedBy: id(10), review: null },
      ],
      hasMore: false,
    });
    const service = createMerchantStoreWaste({
      persistence: {
        transactions: { run: async (work: (t: object) => Promise<unknown>) => work(tx) },
        now: () => "2026-10-15T12:00:00.000Z",
      },
      authentication: { authorize: async () => ({ sessionReference: id(6) }) },
      references: { next: () => id(5) },
      locale: "en-CA",
    } as unknown as Parameters<typeof createMerchantStoreWaste>[0]);
    const view = (await service.query({
      sessionCookie: "synthetic-cookie",
      csrf: "synthetic-csrf",
      wasteReference: null,
      before: null,
      needsReviewOnly: false,
    })) as { people: unknown };
    expect(d.names).toHaveBeenCalledWith(expect.anything(), expect.anything(), [id(256), id(257)]);
    expect(view.people).toEqual({
      [id(10)]: "You",
      [id(11)]: "Store owner",
      [id(256)]: "Mina Chen",
      [id(257)]: "Staff member",
    });
  });
});
describe("WP-2423 stock count authorization", () => {
  beforeEach(() => vi.clearAllMocks());
  it("lists counts with one start resolution (every count permission) and one recheck", async () => {
    const f = setup();
    const view = await f.service.query({ ...f.input, countReference: null, before: null });
    expect(view.permissions).toEqual({ mayCreate: true, mayCount: true, mayApprove: true });
    expect(f.authorizeActions).toHaveBeenCalledOnce();
    expect(f.allowed).toHaveBeenCalledOnce();
  });
  it("refuses a caller without inventory.count.read before reading counts", async () => {
    const f = setup();
    f.authorizeActions.mockResolvedValue(new Map());
    await expect(
      f.service.query({ ...f.input, countReference: null, before: null }),
    ).rejects.toMatchObject({ code: "PermissionDenied" });
    expect(d.list).not.toHaveBeenCalled();
  });
  it("a permission withdrawn during the read refuses the reply", async () => {
    const f = setup();
    f.allowed.mockResolvedValue(false);
    await expect(
      f.service.query({ ...f.input, countReference: null, before: null }),
    ).rejects.toMatchObject({ code: "PermissionDenied" });
  });
  it("commands use the start decision (true during the run, refused after) and re-check it", async () => {
    const f = setup();
    await expect(f.service.command(f.submit)).resolves.toEqual({ status: "Applied", version: 4 });
    expect(f.authorizeActions).toHaveBeenCalledTimes(2);
    expect(f.authorizeActions.mock.calls[1]?.[0]).toEqual([
      "inventory.count.read",
      "inventory.count.execute",
    ]);
    expect(f.allowed).not.toHaveBeenCalled();
    const ports = d.ports.mock.calls[0]?.[2] as { authorization: { authorize: Authorize } };
    expect(
      await ports.authorization.authorize({
        action: "Submit",
        permission: "inventory.count.execute",
      }),
    ).toBe(null);
  });
  it("a permission withdrawn or Session ended during the command refuses it inside the transaction", async () => {
    const f = setup();
    f.authorizeActions.mockImplementationOnce(allowAll).mockResolvedValue(new Map());
    await expect(f.service.command(f.submit)).rejects.toMatchObject({ code: "PermissionDenied" });
    expect(d.execute).toHaveBeenCalledOnce();
  });
});

describe("DEC-INV-COUNT-SHORT: counts that leave stock short against open orders", () => {
  beforeEach(() => vi.clearAllMocks());
  const short = {
    accountReference: id(40),
    itemReference: id(41),
    locationReference: id(42),
    lotReference: id(43),
    unitCode: "L",
    onHand: "0.1",
    reserved: "0.26",
    shortQuantity: "0.16",
    usedBeyondCount: "0",
    holding: [
      { submissionReference: id(44), quantity: "0.13" },
      { submissionReference: id(45), quantity: "0.13" },
    ],
  };
  const used = {
    ...short,
    accountReference: id(50),
    itemReference: id(51),
    lotReference: null,
    onHand: "0",
    reserved: "0",
    shortQuantity: "0",
    usedBeyondCount: "0.2",
    holding: [],
  };
  it("lists short items with the open orders holding them, by number, and items used beyond the count", async () => {
    const f = setup();
    d.shortages.mockResolvedValue([short, used]);
    d.lots.mockResolvedValue(new Map([[id(43), { lotCode: "MILK-1017", expiryDate: null }]]));
    d.orders.mockResolvedValue([
      {
        submissionReference: id(44),
        orderReference: id(46),
        orderBatchReference: id(47),
        orderNumber: "P-9",
        orderType: "Pickup",
        businessDate: "2026-10-18",
        ended: false,
      },
      {
        submissionReference: id(45),
        orderReference: id(48),
        orderBatchReference: id(49),
        orderNumber: "T-11",
        orderType: "DineIn",
        businessDate: "2026-10-18",
        ended: false,
      },
    ]);
    const view = (await f.service.query({ ...f.input, countReference: null, before: null })) as {
      shortages: unknown;
    };
    expect(d.orders).toHaveBeenCalledWith(
      expect.anything(),
      { brandReference: id(8), storeReference: id(9) },
      [id(44), id(45)],
    );
    expect(view.shortages).toEqual([
      {
        itemReference: id(41),
        locationReference: id(42),
        lotCode: "MILK-1017",
        unitCode: "L",
        onHand: "0.1",
        reserved: "0.26",
        shortQuantity: "0.16",
        usedBeyondCount: "0",
        orders: [
          {
            orderReference: id(46),
            orderNumber: "P-9",
            orderType: "Pickup",
            businessDate: "2026-10-18",
            quantity: "0.13",
            ended: false,
          },
          {
            orderReference: id(48),
            orderNumber: "T-11",
            orderType: "DineIn",
            businessDate: "2026-10-18",
            quantity: "0.13",
            ended: false,
          },
        ],
      },
      {
        itemReference: id(51),
        locationReference: id(42),
        lotCode: null,
        unitCode: "L",
        onHand: "0",
        reserved: "0",
        shortQuantity: "0",
        usedBeyondCount: "0.2",
        orders: [],
      },
    ]);
    // Internal references of accounts and Order rounds never reach the browser.
    expect(JSON.stringify(view)).not.toContain(id(40));
    expect(JSON.stringify(view)).not.toContain(id(44));
  });
  it("reports how many items a posted count left short", async () => {
    const f = setup();
    d.execute.mockResolvedValue({
      outcome: "Applied",
      count: { aggregateVersion: 9 },
      movements: [{}],
    });
    d.shortages.mockResolvedValue([short, used]);
    await expect(
      f.service.command({
        ...f.input,
        body: { action: "ApproveAndPost", ...base, postOperationReference: id(7) },
      }),
    ).resolves.toEqual({ status: "Applied", version: 9, movements: 1, shortItems: 1 });
  });
  it("says Unavailable, not that the count changed, when its sources cannot be written", async () => {
    const f = setup();
    const { StockCountError } = await import("@rms/inventory");
    d.execute.mockRejectedValueOnce(new StockCountError("STOCK_COUNT_DEPENDENCY_UNAVAILABLE"));
    await expect(f.service.command(f.submit)).rejects.toMatchObject({ code: "Unavailable" });
    d.execute.mockRejectedValueOnce(new StockCountError("STOCK_COUNT_CONFLICT"));
    await expect(f.service.command(f.submit)).rejects.toMatchObject({ code: "Conflict" });
  });
});
