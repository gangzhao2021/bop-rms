import { beforeEach, expect, it, vi } from "vitest";
const d = vi.hoisted(() => ({
  bridge: vi.fn(),
  store: vi.fn(),
  audit: vi.fn(),
  eligibility: vi.fn(),
}));
vi.mock("./merchant-reconciliation-follow-up-transactions.js", () => ({
  createMerchantReconciliationFollowUpTransactions: d.bridge,
}));
vi.mock("@rms/payment", async (original) => ({
  ...(await original<typeof import("@rms/payment")>()),
  createPostgresReconciliationFollowUpStore: d.store,
}));
vi.mock("@bop/membership", async (original) => ({
  ...(await original<typeof import("@bop/membership")>()),
  createPostgresStoreAssigneeEligibility: d.eligibility,
}));
vi.mock("@bop/audit", async (original) => ({
  ...(await original<typeof import("@bop/audit")>()),
  appendAuditRecordInTransaction: d.audit,
}));
import { createMerchantReconciliationFollowUpCommand } from "./merchant-reconciliation-follow-up-command.js";
import type { ReconciliationFollowUpTransition } from "@rms/payment";
type Options = Parameters<typeof createMerchantReconciliationFollowUpCommand>[0];
const id = (n: number) => "0190fa82-0000-7000-8000-" + String(n).padStart(12, "0"),
  at = "2026-09-21T00:00:00.000Z";
beforeEach(() => vi.resetAllMocks());
function fixture(targetActor?: Options["targetActor"]) {
  const scope = { tenantReference: id(1), brandReference: id(2), storeReference: id(3) },
    tx = {};
  let stored: ReconciliationFollowUpTransition | null = null,
    now = at;
  const records = {
    lock: vi.fn(async () => undefined),
    findOperation: vi.fn(async () => stored),
    readCurrent: vi.fn(async () => ({
      ...scope,
      exceptionReference: id(6),
      version: 1,
      status: "Open",
      acknowledgedByReference: null,
      ownerReference: null,
      openedAt: at,
      updatedAt: at,
    })),
    append: vi.fn(async (_t: unknown, value: ReconciliationFollowUpTransition) => {
      stored = value;
    }),
  };
  d.store.mockReturnValue(records);
  d.bridge.mockResolvedValue({
    scope,
    actorReference: id(4),
    transactions: { run: async (work: (t: object) => Promise<unknown>) => work(tx) },
    authorize: async () => true,
  });
  const authenticate = vi.fn(async () => ({ sessionReference: id(5) }));
  const command = createMerchantReconciliationFollowUpCommand({
    persistence: {} as Options["persistence"],
    authentication: { authorize: authenticate } as unknown as Options["authentication"],
    now: () => now,
    reference: () => id(8),
    ...(targetActor ? { targetActor } : {}),
  });
  const input = {
    sessionCookie: "synthetic-cookie",
    csrf: "synthetic-csrf",
    command: {
      exceptionReference: id(6),
      action: "Acknowledge",
      assigneeReference: null,
      expectedVersion: 1,
      operationReference: id(7),
    },
  };
  return {
    command,
    input,
    authenticate,
    records,
    later: () => {
      now = "2026-09-21T00:01:00.000Z";
    },
  };
}
it("derives named User Audit and returns only follow-up facts", async () => {
  const f = fixture();
  const result = await f.command(f.input);
  expect(f.authenticate).toHaveBeenCalledWith(f.input);
  expect(result).toMatchObject({ status: "Created", version: 2, followUpStatus: "Acknowledged" });
  expect(result).not.toHaveProperty("tenantReference");
  expect(d.audit.mock.calls[0]?.[1]).toMatchObject({
    actor: { type: "User", reference: id(4) },
    correlationId: id(7),
    occurredAt: at,
    sourceChannel: "OPERATIONS",
  });
});
it("reuses committed timestamp on a later retry without writing another Audit", async () => {
  const f = fixture();
  await f.command(f.input);
  f.later();
  expect(await f.command(f.input)).toMatchObject({ status: "Duplicate", updatedAt: at });
  expect(d.audit).toHaveBeenCalledOnce();
  expect(f.records.append).toHaveBeenCalledOnce();
});
it("rejects replay with changed assignment intent", async () => {
  const f = fixture();
  await f.command(f.input);
  await expect(
    f.command({
      ...f.input,
      command: { ...f.input.command, action: "Assign", assigneeReference: id(9) },
    }),
  ).rejects.toThrow("CONFLICT");
  expect(d.audit).toHaveBeenCalledOnce();
});
it("rejects client identity and fails before scope resolution when authentication fails", async () => {
  const f = fixture();
  await expect(
    f.command({ ...f.input, command: { ...f.input.command, actorReference: id(99) } }),
  ).rejects.toThrow();
  expect(d.bridge).not.toHaveBeenCalled();
  f.authenticate.mockRejectedValue(new Error("DENIED"));
  await expect(f.command(f.input)).rejects.toThrow("DENIED");
  expect(d.bridge).not.toHaveBeenCalled();
});

it("uses current authenticated self identity without inventing a target login", async () => {
  const target = vi.fn();
  const f = fixture(target);
  await f.command(f.input);
  const actor = { actorReference: id(4), authenticatedAt: at };
  const authorize = vi.fn(async () => true);
  const bridge = await d.bridge.mock.results[0]?.value;
  bridge.resolveAuthority = vi.fn(async () => ({ context: { actor, resolvedAt: at }, authorize }));
  const seen: unknown[] = [];
  d.eligibility.mockImplementation(
    (options) => async (tx: object, input: { assigneeReference: string }) => {
      seen.push(await options.targetActor(tx, input.assigneeReference));
      seen.push(await options.targetActor(tx, input.assigneeReference));
      return options.authorize();
    },
  );
  const verify = d.bridge.mock.calls[0]?.[0].verifyAssignee;
  expect(await verify({}, { assigneeReference: id(4) })).toBe(true);
  expect(seen).toEqual([actor, actor]);
  expect(target).not.toHaveBeenCalled();
  expect(bridge.resolveAuthority).toHaveBeenCalledTimes(3);
});
it("rejects unconfigured other employee and rechecks self permission", async () => {
  const f = fixture();
  await f.command(f.input);
  const authorize = vi.fn(async () => true);
  const bridge = await d.bridge.mock.results[0]?.value;
  bridge.resolveAuthority = vi.fn(async () => ({
    context: { actor: { actorReference: id(4) }, resolvedAt: at },
    authorize,
  }));
  d.eligibility.mockImplementation(
    (options) => async (tx: object, input: { assigneeReference: string }) =>
      options.targetActor(tx, input.assigneeReference),
  );
  const verify = d.bridge.mock.calls[0]?.[0].verifyAssignee;
  await expect(verify({}, { assigneeReference: id(9) })).rejects.toThrow("PERMISSION_DENIED");
  authorize.mockResolvedValue(false);
  await expect(verify({}, { assigneeReference: id(4) })).rejects.toThrow("PERMISSION_DENIED");
});
it("uses explicit Identity resolver for another employee at the current observation time", async () => {
  const actor = { actorReference: id(9) };
  const target = vi.fn(async () => actor) as unknown as Options["targetActor"];
  const f = fixture(target);
  await f.command(f.input);
  const bridge = await d.bridge.mock.results[0]?.value;
  bridge.resolveAuthority = vi.fn(async () => ({
    context: { actor: { actorReference: id(4) }, resolvedAt: at },
    authorize: async () => true,
  }));
  d.eligibility.mockImplementation(
    (options) => async (tx: object, input: { assigneeReference: string }) =>
      options.targetActor(tx, input.assigneeReference),
  );
  const tx = {};
  expect(await d.bridge.mock.calls[0]?.[0].verifyAssignee(tx, { assigneeReference: id(9) })).toBe(
    actor,
  );
  expect(target).toHaveBeenCalledWith(tx, id(9), at);
});

it("maps AssignSelf to authenticated actor and replays canonical assignment", async () => {
  const f = fixture();
  const input = { ...f.input, command: { ...f.input.command, action: "AssignSelf" } };
  expect(await f.command(input)).toMatchObject({
    status: "Created",
    followUpStatus: "Assigned",
    ownerReference: id(4),
  });
  expect(f.records.append.mock.calls[0]?.[1].command).toMatchObject({
    action: "Assign",
    actorReference: id(4),
    assigneeReference: id(4),
  });
  f.later();
  expect(await f.command(input)).toMatchObject({ status: "Duplicate", ownerReference: id(4) });
  expect(d.audit).toHaveBeenCalledOnce();
});
it("rejects caller-supplied assignee on AssignSelf before scope or persistence", async () => {
  const f = fixture();
  await expect(
    f.command({
      ...f.input,
      command: { ...f.input.command, action: "AssignSelf", assigneeReference: id(9) },
    }),
  ).rejects.toThrow("INVALID");
  expect(d.bridge).not.toHaveBeenCalled();
  expect(f.records.append).not.toHaveBeenCalled();
});
