import { expect, it, vi, beforeEach } from "vitest";
import { createMerchantDiningSessionStart } from "./merchant-dining-session-start.js";
const mock = vi.hoisted(() => ({
  resolve: vi.fn(),
  service: vi.fn(),
  start: vi.fn(),
  table: vi.fn(),
  session: vi.fn(),
}));
vi.mock("./merchant-store-scope.js", () => ({ createMerchantStoreScope: () => mock.resolve }));
vi.mock("@rms/dining", async (original) => ({
  ...(await original<typeof import("@rms/dining")>()),
  createDiningSessionService: mock.service,
  createPostgresDiningTableStore: () => ({ loadTable: mock.table }),
  createPostgresDiningSessionStartStore: () => ({ loadSession: mock.session }),
}));
const id = (n: number) => "01909988-0000-7000-8000-" + n.toString(16).padStart(12, "0");
type Options = Parameters<typeof createMerchantDiningSessionStart>[0];
const at = "2026-09-20T17:00:00.000Z";
function setup() {
  const allowed = vi.fn(async () => true),
    authorizeAction = vi.fn(async () => ({ effect: "Allow" }));
  mock.resolve.mockResolvedValue({
    selected: { tenantReference: id(1) },
    context: { brand: { brandReference: id(2) }, resolvedAt: at },
    store: { storeReference: id(3) },
    actorReference: id(7),
    allowed,
    authorizeAction,
  });
  mock.service.mockReturnValue({ start: mock.start });
  mock.table.mockResolvedValue({
    tableReference: id(4),
    aggregateVersion: 2,
    activeDiningSessionReference: null,
    lifecycle: "Published",
    operationalState: "Available",
  });
  mock.start.mockResolvedValue({
    status: "Issued",
    session: {
      diningSessionReference: id(5),
      tableReference: id(4),
      version: 1,
      tableAssignmentVersion: 2,
    },
    capability: { kind: "HumanCode", selectorHash: "private" },
    joinCredential: "123456",
  });
  const input = {
    sessionCookie: "synthetic",
    csrf: "synthetic",
    command: {
      tableReference: id(4),
      expectedAssignmentVersion: 2,
      operationReference: id(6),
      joinKind: "HumanCode",
    },
  };
  const read = createMerchantDiningSessionStart({
    persistence: {
      transactions: { run: async (work: (tx: unknown) => unknown) => work({}) },
    } as unknown as Options["persistence"],
    authentication: {
      authorize: vi.fn(async () => ({ sessionReference: id(8) })),
    } as unknown as Options["authentication"],
    credentials: {} as Options["credentials"],
    pepperVersion: 1,
    newReference: () => id(9),
    retentionPolicyCode: "AUDIT_DEFAULT",
    retentionPolicyVersion: 1,
  });
  return { read, input, allowed, authorizeAction };
}
beforeEach(() => vi.clearAllMocks());
it("uses server time and emits credential only on first issue", async () => {
  const f = setup(),
    result = await f.read(f.input);
  expect(mock.resolve.mock.calls[0]?.slice(1)).toEqual(["synthetic", "dining.operate", id(8)]);
  expect(mock.start).toHaveBeenCalledWith({ ...f.input.command, requestedAt: at });
  expect(result).toMatchObject({ status: "Issued", joinCredential: "123456" });
  expect(result).not.toHaveProperty("capability");
  const old = await mock.start.mock.results[0]?.value;
  mock.start.mockResolvedValue({ ...old, status: "AlreadyApplied" });
  expect(await f.read(f.input)).not.toHaveProperty("joinCredential");
});
it.each([{ requestedAt: at }, { actorReference: id(9) }, { storeReference: id(9) }])(
  "rejects injected authority %j",
  async (extra) => {
    const f = setup();
    await expect(
      f.read({ ...f.input, command: { ...f.input.command, ...extra } }),
    ).rejects.toThrow();
    expect(mock.start).not.toHaveBeenCalled();
  },
);
it("denies before work and rechecks before returning", async () => {
  const f = setup();
  f.allowed.mockResolvedValue(false);
  await expect(f.read(f.input)).rejects.toThrow();
  expect(mock.start).not.toHaveBeenCalled();
  f.allowed.mockResolvedValueOnce(true).mockResolvedValueOnce(false);
  await expect(f.read(f.input)).rejects.toThrow();
});
it("does not load the table when dining.operate is denied", async () => {
  const f = setup();
  await f.read(f.input);
  f.authorizeAction.mockResolvedValue({ effect: "Deny" });
  const ports = mock.service.mock.calls[0]?.[0];
  expect(
    await ports.staff.authorize({
      operation: "StartSession",
      tableReference: id(4),
      operationReference: id(6),
      observedAt: at,
    }),
  ).toBeNull();
  expect(mock.table).not.toHaveBeenCalled();
});
it("builds scoped staff evidence and does not treat missing occupant as empty", async () => {
  const f = setup();
  await f.read(f.input);
  const ports = mock.service.mock.calls[0]?.[0];
  const request = {
    operation: "StartSession",
    tableReference: id(4),
    operationReference: id(6),
    observedAt: at,
  };
  expect(await ports.staff.authorize(request)).toMatchObject({
    table: { assignmentVersion: 2, tableState: "Eligible" },
    audit: {
      actor: { type: "User", reference: id(7) },
      actionCode: "DINING_SESSION_START",
      sourceChannel: "MERCHANT_WEB",
      correlationId: id(6),
    },
  });
  expect(f.authorizeAction).toHaveBeenCalledWith("dining.operate");
  mock.table.mockResolvedValue({
    ...(await mock.table.mock.results[0]?.value),
    activeDiningSessionReference: id(10),
  });
  mock.session.mockResolvedValue(null);
  expect(await ports.staff.authorize(request)).toBeNull();
});
