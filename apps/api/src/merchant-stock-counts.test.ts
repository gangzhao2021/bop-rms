import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  createMerchantStockCounts,
  parseStockCountCommandBody,
  redactStockCount,
} from "./merchant-stock-counts.js";
import { parseStoreWasteCommandBody } from "./merchant-store-waste.js";

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
vi.mock("@rms/inventory", async (original) => ({
  ...(await original<object>()),
  createPostgresStockCountPorts: d.ports,
  executeStockCountCommand: d.execute,
  listStockCounts: d.list,
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
describe("v15 run: stock count people", () => {
  beforeEach(() => vi.clearAllMocks());
  it("names counters from the staff list and the Brand directory, never an identifier fragment", async () => {
    const f = setup();
    d.members.mockResolvedValue([
      { actorReference: id(10), displayName: "Ana", membershipLifecycle: "Active" },
      { actorReference: id(11), displayName: null, membershipLifecycle: "Active" },
    ]);
    d.names.mockResolvedValue(new Map([[id(256), "Mina Chen"]]));
    d.list.mockResolvedValue({
      counts: [
        { assigneeReference: id(256) },
        { assigneeReference: id(257) },
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
      { actorReference: id(11), label: "Unnamed staff member" },
    ]);
    expect(d.names).toHaveBeenCalledWith(expect.anything(), expect.anything(), [id(256), id(257)]);
    expect(view.people).toEqual([
      { actorReference: id(256), label: "Mina Chen" },
      { actorReference: id(257), label: "Unnamed staff member" },
    ]);
    expect(JSON.stringify(view)).not.toMatch(/Staff [0-9a-f]{4}/u);
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
