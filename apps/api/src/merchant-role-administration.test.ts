import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  createMerchantRoleAdministration,
  generatedRoleCode,
  parsePresetOfferDecline,
  parseRoleCommandInput,
  presetUpdateOf,
  roleCommandIntentDigest,
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
    // WP-2423 role presets: staff type a name only; the server makes the code.
    expect(parseRoleCommandInput(command({ operation: "Duplicate", draft })).draft).toEqual(draft);
    expect(
      parseRoleCommandInput(
        command({ operation: "Create", roleReference: null, expectedVersion: null, draft }),
      ).roleReference,
    ).toBeNull();
    expect(
      parseRoleCommandInput({ ...command({ operation: "ApproveAlone" }), confirmed: true })
        .operation,
    ).toBe("ApproveAlone");
    expect(parseRoleCommandInput(command({ operation: "Revise", draft })).operation).toBe("Revise");
    expect(parseRoleCommandInput(command({ operation: "RestoreDefault" })).draft).toBeNull();
    expect(generatedRoleCode(id(2))).toMatch(/^custom_[0-9a-f]{12}$/u);
    expect(generatedRoleCode(id(2))).toBe(generatedRoleCode(id(2)));
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
    [
      "typed role code",
      command({ operation: "Duplicate", draft: { ...draft, code: "shift_lead" } }),
    ],
    ["Create of an existing role", command({ operation: "Create", draft })],
    ["ApproveAlone not confirmed", command({ operation: "ApproveAlone" })],
    [
      "ApproveAlone confirmed false",
      { ...command({ operation: "ApproveAlone" }), confirmed: false },
    ],
    ["draft on a restore", command({ operation: "RestoreDefault", draft })],
    ["blank name", command({ operation: "Revise", draft: { ...draft, displayName: "  " } })],
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
  prior: vi.fn(),
}));
vi.mock("./merchant-staff-labels.js", () => ({
  createStaffLabels: async () => (actor: string) => (actor === id(5) ? "You" : "Mia"),
}));
vi.mock("@bop/membership", async (original) => ({
  ...(await original<object>()),
  listStoreMembers: async () => [{ actorReference: id(8), displayName: "Mia" }],
}));
vi.mock("./merchant-store-scope.js", () => ({ createMerchantStoreScope: () => d.resolve }));
vi.mock("@bop/permission", async (original) => ({
  ...(await original<object>()),
  listRoleAdministration: d.list,
  loadRoleAdministration: d.load,
  createPostgresRoleAdministrationPorts: d.ports,
  planRoleAdministrationChange: d.plan,
  executeRoleAdministration: d.execute,
  findRoleAdministrationOperation: d.prior,
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
  authoredByReference: id(5),
  submittedByReference: null,
  approvedByReference: null,
  reasonCode: "ROLE_DRAFT_SAVED",
  changedAt: "2026-10-15T11:00:00.000Z",
  approvalMode: "Independent",
};
const roleView = (overrides: Record<string, unknown> = {}) => ({
  record,
  effective: null,
  opening: record,
  memberCount: 0,
  openAssignmentChanges: 0,
  decisions: [],
  ...overrides,
});
function setup() {
  // The Store's naming lock is free unless a test says otherwise.
  const tx = {
    query: vi.fn<(sql: string, values?: unknown) => Promise<{ rows: unknown[] }>>(async () => ({
      rows: [{ locked: true }],
    })),
  };
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
  d.list.mockResolvedValue([roleView()]);
  d.load.mockResolvedValue(roleView());
  d.prior.mockResolvedValue(null);
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
    // A draft nobody has turned on yet: its author edits, sends or withdraws it.
    expect(view.roles[0]?.operations).toEqual(["SaveDraft", "Submit", "Withdraw"]);
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
  it("refuses a name another role here already has", async () => {
    const f = setup();
    d.list.mockResolvedValue([
      roleView(),
      roleView({
        record: { ...record, roleReference: id(9), displayName: "Counter staff" },
      }),
    ]);
    await expect(
      f.service.command({
        ...f.input,
        body: command({
          operation: "SaveDraft",
          draft: { ...draft, displayName: "counter STAFF" },
        }),
      }),
    ).rejects.toMatchObject({ code: "NameTaken" });
    expect(d.execute).not.toHaveBeenCalled();
  });
  it("a naming while another is being saved at the Store backs off and is retried, never waited on", async () => {
    const f = setup();
    f.tx.query.mockResolvedValue({ rows: [{ locked: false }] });
    await expect(
      f.service.command({ ...f.input, body: command({ operation: "SaveDraft", draft }) }),
    ).rejects.toMatchObject({ code: "TENANT_DATABASE_TRANSACTION_CONFLICT" });
    expect(f.tx.query.mock.calls[0]?.[0]).toMatch(/pg_try_advisory_xact_lock/u);
    expect(d.list).not.toHaveBeenCalled();
  }, 10_000);
  const waitingChange = (submittedBy: string) => {
    const pending = {
      ...record,
      lifecycle: "InReview",
      submittedByReference: submittedBy,
      selections: [{ action: "ordering.order.read" }, { action: "payment.refund.approve" }],
    };
    return roleView({
      record: pending,
      opening: pending,
      effective: {
        ...record,
        lifecycle: "Active",
        selections: [{ action: "ordering.order.read" }],
      },
    });
  };
  it("an approver who lacks a flagged permission the change adds cannot approve it", async () => {
    const f = setup();
    d.load.mockResolvedValue(waitingChange(id(8)));
    f.authorizeActions.mockImplementation(
      async (actions: readonly string[]) =>
        new Map(
          actions.map((action) => [
            action,
            Object.freeze({
              effect: (action === "payment.refund.approve" ? "Deny" : "Allow") as "Allow" | "Deny",
              action,
              scopeKind: "Store",
            }),
          ]),
        ),
    );
    await expect(
      f.service.command({ ...f.input, body: command({ operation: "Approve" }) }),
    ).rejects.toMatchObject({ code: "ApproverLacksAccess" });
    await expect(
      f.service.command({
        ...f.input,
        body: { ...command({ operation: "ApproveAlone" }), confirmed: true },
      }),
    ).rejects.toMatchObject({ code: "WouldWidenOwnAccess" });
    expect(d.execute).not.toHaveBeenCalled();
  });
  it("answers a retried command from what the first attempt recorded", async () => {
    const f = setup();
    d.prior.mockResolvedValue({
      commandType: "Submit",
      actorReference: id(5),
      intentDigest: roleCommandIntentDigest(parseRoleCommandInput(command())),
      roleReference: id(1),
      version: 3,
      lifecycle: "InReview",
    });
    await expect(f.service.command({ ...f.input, body: command() })).resolves.toEqual({
      roleReference: id(1),
      version: 3,
      status: "InReview",
    });
    expect(d.execute).not.toHaveBeenCalled();
    d.prior.mockResolvedValue({
      commandType: "Submit",
      actorReference: id(8),
      intentDigest: roleCommandIntentDigest(parseRoleCommandInput(command())),
      roleReference: id(1),
      version: 3,
      lifecycle: "InReview",
    });
    await expect(f.service.command({ ...f.input, body: command() })).rejects.toMatchObject({
      code: "Conflict",
    });
  });
  it("a retry under the same operation reference with other content is a conflict, never the first answer", async () => {
    const f = setup();
    const first = command({ operation: "SaveDraft", draft });
    d.prior.mockResolvedValue({
      commandType: "SaveDraft",
      actorReference: id(5),
      intentDigest: roleCommandIntentDigest(parseRoleCommandInput(first)),
      roleReference: id(1),
      version: 3,
      lifecycle: "Draft",
    });
    await expect(f.service.command({ ...f.input, body: first })).resolves.toEqual({
      roleReference: id(1),
      version: 3,
      status: "Draft",
    });
    // The same actions in another order ask for the same thing.
    await expect(
      f.service.command({
        ...f.input,
        body: command({
          operation: "SaveDraft",
          draft: { ...draft, actions: [...draft.actions].reverse() },
        }),
      }),
    ).resolves.toMatchObject({ status: "Draft" });
    for (const other of [
      command({ operation: "SaveDraft", draft: { ...draft, displayName: "Night lead" } }),
      command({
        operation: "SaveDraft",
        draft: { ...draft, actions: [...draft.actions, "ordering.order.accept"] },
      }),
      command({ operation: "SaveDraft", draft, roleReference: id(9) }),
      command({ operation: "SaveDraft", draft, expectedVersion: 1 }),
    ])
      await expect(f.service.command({ ...f.input, body: other })).rejects.toMatchObject({
        code: "Conflict",
      });
    expect(d.execute).not.toHaveBeenCalled();
    // The digest recorded with the first attempt is the request's.
    d.prior.mockResolvedValue(null);
    await f.service.command({ ...f.input, body: command() });
    expect(d.ports.mock.calls.at(-1)?.[0]).toMatchObject({
      intentDigest: roleCommandIntentDigest(parseRoleCommandInput(command())),
    });
  });
  it("lists another person's waiting change for an approver, never the viewer's own without the gate", async () => {
    const f = setup();
    d.list.mockResolvedValue([waitingChange(id(8)), waitingChange(id(5))]);
    const result = await f.service.waiting(f.input);
    expect(result.changes).toEqual([
      {
        roleReference: id(1),
        name: "Shift lead",
        added: 1,
        removed: 0,
        by: "Mia",
        at: record.changedAt,
        action: "Approve",
      },
    ]);
  });
  it("refuses to turn on an approved restore once BOP has changed the preset (check it again)", async () => {
    const f = setup();
    // Approved as the Front of House preset of its day, which no longer equals the preset now.
    const approved = {
      ...record,
      code: "front_of_house",
      lifecycle: "Approved",
      submittedByReference: id(8),
      approvedByReference: id(5),
      reasonCode: "ROLE_APPROVED",
      selections: [{ action: "merchant.access" }],
    };
    d.load.mockResolvedValue(
      roleView({
        record: approved,
        opening: { ...approved, lifecycle: "Draft", reasonCode: "ROLE_PRESET_RESTORE" },
        effective: { ...record, code: "front_of_house", lifecycle: "Active" },
      }),
    );
    await expect(
      f.service.command({ ...f.input, body: command({ operation: "Activate" }) }),
    ).rejects.toMatchObject({ code: "PresetChanged" });
    expect(d.execute).not.toHaveBeenCalled();
  });
});

describe("WP-2423 role presets: what BOP changed in a preset since the Store made it its own", () => {
  const version = (overrides: Record<string, unknown>) => ({
    ...record,
    code: "inventory_manager",
    lifecycle: "Active",
    ...overrides,
  });
  const selected = (...codes: string[]) => codes.map((action) => ({ action }));
  // The Inventory Manager preset now: stock codes and recipe.read (no orders).
  const preset = version({
    roleType: "System",
    version: 3,
    selections: selected("inventory.item.read", "merchant.access", "ordering.order.read"),
  });
  const mine = version({
    roleType: "Custom",
    version: 5,
    selections: selected("inventory.item.read", "merchant.access", "ordering.order.read"),
  });
  const view = (overrides: Record<string, unknown> = {}) =>
    roleView({ record: mine, effective: mine, opening: null, presetVersion: preset, ...overrides });
  it("offers what the preset gained and no longer has, minus what the Store kept without", () => {
    const offer = presetUpdateOf(view() as never);
    expect(offer?.added).toContain("recipe.read");
    expect(offer?.added).not.toContain("inventory.item.read");
    expect(offer?.removed).toEqual(["ordering.order.read"]);
    const kept = presetUpdateOf(
      view({
        declinedOffers: [
          ...(offer?.added ?? []).map((action) => ({ kind: "Add", action })),
          { kind: "Remove", action: "ordering.order.read" },
        ],
      }) as never,
    );
    expect(kept).toBeNull();
  });
  it("offers nothing on a preset, while a change waits, or once the Store has it", () => {
    expect(presetUpdateOf(view({ presetVersion: null }) as never)).toBeNull();
    expect(
      presetUpdateOf(view({ record: { ...mine, version: 6, lifecycle: "Draft" } }) as never),
    ).toBeNull();
    expect(
      presetUpdateOf(view({ record: { ...mine, code: "custom_0123456789ab" } }) as never),
    ).toBeNull();
  });
  it("accepts a closed decline only", () => {
    const body = {
      roleReference: id(1),
      expectedVersion: 5,
      operationReference: id(2),
      kind: "Add",
      actions: ["recipe.read"],
    };
    expect(parsePresetOfferDecline(body).kind).toBe("Add");
    for (const bad of [
      { ...body, kind: "Delete" },
      { ...body, actions: [] },
      { ...body, actions: ["anything.at.all"] },
      { ...body, extra: true },
    ])
      expect(() => parsePresetOfferDecline(bad)).toThrow(/Invalid/u);
  });
});
