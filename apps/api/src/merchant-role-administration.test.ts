import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  createMerchantRoleAdministration,
  parseRoleCommandInput,
} from "./merchant-role-administration.js";

const id = (n: number) => "01909a0a-0000-7000-8000-" + n.toString(16).padStart(12, "0");
const command = (overrides: Record<string, unknown> = {}) => ({
  operation: "Submit",
  roleReference: id(1),
  expectedVersion: 2,
  operationReference: id(2),
  reasonCode: "ROLE_SUBMITTED",
  draft: null,
  ...overrides,
});
const draft = {
  displayName: "Shift lead",
  description: "Orders and kitchen",
  actions: ["merchant.access", "ordering.order.read"],
};

describe("WP-2423 role administration command input", () => {
  it("accepts closed commands and drafts of catalog codes only", () => {
    expect(parseRoleCommandInput(command()).operation).toBe("Submit");
    expect(
      parseRoleCommandInput(command({ operation: "SaveDraft", draft })).draft?.actions,
    ).toEqual(draft.actions);
    expect(
      parseRoleCommandInput(
        command({ operation: "Duplicate", draft: { ...draft, code: "shift_lead" } }),
      ).draft?.code,
    ).toBe("shift_lead");
  });
  it.each([
    ["unknown operation", command({ operation: "Delete" })],
    ["draft on a decision", command({ draft })],
    ["missing draft", command({ operation: "SaveDraft" })],
    [
      "legacy code selected directly",
      command({ operation: "SaveDraft", draft: { ...draft, actions: ["kitchen.operate"] } }),
    ],
    [
      "unknown code",
      command({ operation: "SaveDraft", draft: { ...draft, actions: ["anything.at.all"] } }),
    ],
    [
      "duplicate code",
      command({
        operation: "SaveDraft",
        draft: { ...draft, actions: ["merchant.access", "merchant.access"] },
      }),
    ],
    ["code on save", command({ operation: "SaveDraft", draft: { ...draft, code: "x_y" } })],
    ["bad role code", command({ operation: "Duplicate", draft: { ...draft, code: "Shift-Lead" } })],
    ["extra field", { ...command(), actor: id(9) }],
    ["bad version", command({ expectedVersion: 0 })],
    ["bad reason", command({ reasonCode: "submitted" })],
  ])("refuses %s", (_label, value) => {
    expect(() => parseRoleCommandInput(value)).toThrow(/Invalid/u);
  });
});

const d = vi.hoisted(() => ({
  resolve: vi.fn(),
  list: vi.fn(),
  load: vi.fn(),
  ports: vi.fn(),
  plan: vi.fn(),
  execute: vi.fn(),
}));
vi.mock("./merchant-store-scope.js", () => ({ createMerchantStoreScope: () => d.resolve }));
vi.mock("@bop/permission", async (original) => ({
  ...(await original<object>()),
  listRoleAdministration: d.list,
  loadRoleAdministration: d.load,
  createPostgresRoleAdministrationPorts: d.ports,
  planRoleAdministrationChange: d.plan,
  executeRoleAdministration: d.execute,
}));
type Options = Parameters<typeof createMerchantRoleAdministration>[0];
const record = {
  roleReference: id(1),
  brandReference: id(3),
  storeReference: id(4),
  code: "shift_lead",
  displayName: "Shift lead",
  description: "Orders",
  lifecycle: "Draft",
  roleType: "Custom",
  version: 2,
  selections: [],
  submittedByReference: null,
  approvedByReference: null,
};
function setup() {
  const tx = { query: vi.fn() };
  const allowed = vi.fn(async () => true);
  const authorizeActions = vi.fn(
    async (actions: readonly string[]) =>
      new Map(
        actions.map((action) => [
          action,
          Object.freeze({ effect: "Allow" as "Allow" | "Deny", action, scopeKind: "Store" }),
        ]),
      ),
  );
  const scope = {
    context: { brand: { brandReference: id(3) } },
    store: { storeReference: id(4) },
    actorReference: id(5),
    allowed,
    authorizeActions,
  };
  d.resolve.mockResolvedValue(scope);
  d.list.mockResolvedValue([{ record, memberCount: 0, decisions: [] }]);
  d.load.mockResolvedValue({ record, memberCount: 0, decisions: [] });
  d.ports.mockImplementation(() => ({ policy: { currentVersion: async () => 1 } }));
  d.plan.mockReturnValue({ ...record, version: 3 });
  d.execute.mockImplementation(async (_input: unknown, ports: unknown) => {
    const options = d.ports.mock.calls[0]?.[0] as {
      authorization: { authorize(request: { action: string }): Promise<{ effect: string }> };
    };
    const decision = await options.authorization.authorize({ action: "identity.role.change" });
    if (decision.effect !== "Allow") throw new Error("denied");
    void ports;
    return { roleReference: id(1), version: 3, lifecycle: "InReview" };
  });
  const run = vi.fn(async (work: (t: object) => Promise<unknown>) => work(tx));
  const service = createMerchantRoleAdministration({
    persistence: { transactions: { run }, now: () => "2026-10-15T12:00:00.000Z" },
    authentication: { authorize: async () => ({ sessionReference: id(6) }) },
    references: { next: () => id(7) },
  } as unknown as Options);
  const input = { sessionCookie: "synthetic-cookie", csrf: "synthetic-csrf" };
  return { tx, allowed, authorizeActions, scope, service, input };
}

describe("WP-2423 role administration authorization", () => {
  beforeEach(() => vi.clearAllMocks());
  it("lists roles with one start resolution (read and every role action) and one recheck", async () => {
    const f = setup();
    const view = await f.service.list(f.input);
    expect(view.mayManage).toBe(true);
    expect(view.roles[0]?.operations).toEqual(["SaveDraft", "Submit", "Duplicate"]);
    expect(d.resolve).toHaveBeenCalledWith(f.tx, "synthetic-cookie", "identity.role.read", id(6));
    expect(f.authorizeActions).toHaveBeenCalledOnce();
    expect(f.authorizeActions.mock.calls[0]?.[0]).toEqual([
      "identity.role.read",
      "identity.role.create",
      "identity.role.change",
      "identity.role.approve",
      "identity.role.activate",
      "identity.role.deactivate",
    ]);
    expect(f.allowed).toHaveBeenCalledOnce();
  });
  it("refuses a caller without identity.role.read before reading roles", async () => {
    const f = setup();
    f.authorizeActions.mockResolvedValue(new Map());
    await expect(f.service.list(f.input)).rejects.toMatchObject({ code: "PermissionDenied" });
    expect(d.list).not.toHaveBeenCalled();
  });
  it("a permission withdrawn during the role detail read refuses the reply", async () => {
    const f = setup();
    f.allowed.mockResolvedValue(false);
    await expect(f.service.detail({ ...f.input, roleReference: id(1) })).rejects.toMatchObject({
      code: "PermissionDenied",
    });
    expect(d.load).toHaveBeenCalledOnce();
  });
  it("commands take the start decision (no query) and are re-checked in full before commit", async () => {
    const f = setup();
    await expect(f.service.command({ ...f.input, body: command() })).resolves.toEqual({
      roleReference: id(1),
      version: 3,
      status: "InReview",
    });
    expect(f.authorizeActions).toHaveBeenCalledTimes(2);
    expect(f.authorizeActions.mock.calls[0]?.[0]).toEqual([
      "identity.role.read",
      "identity.role.change",
    ]);
    expect(f.allowed).not.toHaveBeenCalled();
    const options = d.ports.mock.calls[0]?.[0] as {
      authorization: { authorize(request: { action: string }): Promise<unknown> };
    };
    // The guard ends with the run.
    await expect(
      options.authorization.authorize({ action: "identity.role.change" }),
    ).rejects.toMatchObject({ code: "PermissionDenied" });
  });
  it("refuses a request for another action than the command's", async () => {
    const f = setup();
    d.execute.mockImplementation(async () => {
      const options = d.ports.mock.calls[0]?.[0] as {
        authorization: { authorize(request: { action: string }): Promise<unknown> };
      };
      return options.authorization.authorize({ action: "identity.role.approve" });
    });
    await expect(f.service.command({ ...f.input, body: command() })).rejects.toMatchObject({
      code: "PermissionDenied",
    });
  });
  it("a permission withdrawn or Session ended during the command refuses it inside the transaction", async () => {
    const f = setup();
    f.authorizeActions
      .mockImplementationOnce(
        async (actions: readonly string[]) =>
          new Map(
            actions.map((action) => [
              action,
              Object.freeze({ effect: "Allow" as "Allow" | "Deny", action, scopeKind: "Store" }),
            ]),
          ),
      )
      .mockResolvedValue(new Map());
    await expect(f.service.command({ ...f.input, body: command() })).rejects.toMatchObject({
      code: "PermissionDenied",
    });
    expect(d.execute).toHaveBeenCalledOnce();
  });
});
