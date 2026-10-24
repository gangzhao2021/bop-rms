import { expect, it, vi, beforeEach } from "vitest";
import { createMerchantDiningJoinRegenerate } from "./merchant-dining-join-regenerate.js";
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
  createPostgresDiningJoinRegenerationStore: () => ({}),
}));
const id = (n: number) => "01909988-0000-7000-8000-" + n.toString(16).padStart(12, "0");
type Options = Parameters<typeof createMerchantDiningJoinRegenerate>[0];
const at = "2026-09-20T17:00:00.000Z";
function setup() {
  let thrownInside = false;
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
  mock.service.mockReturnValue({ regenerate: mock.start });
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
    capability: { kind: "HumanCode", selectorHash: "private", generation: 2, version: 1 },
    joinCredential: "123456",
  });
  const input = {
    sessionCookie: "synthetic",
    csrf: "synthetic",
    command: {
      tableReference: id(4),
      expectedAssignmentVersion: 2,
      operationReference: id(6),
      diningSessionReference: id(5),
      expectedSessionVersion: 1,
      expectedCapabilityVersion: 1,
      expectedGeneration: 1,
    },
  };
  const read = createMerchantDiningJoinRegenerate({
    persistence: {
      transactions: {
        run: async (work: (tx: unknown) => unknown) => {
          try {
            return await work({});
          } catch (error) {
            thrownInside = true;
            throw error;
          }
        },
      },
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
  return { read, input, allowed, authorizeAction, thrownInside: () => thrownInside };
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
it("denies before work when dining.operate is denied at the start", async () => {
  const f = setup();
  f.authorizeAction.mockResolvedValue({ effect: "Deny" });
  await expect(f.read(f.input)).rejects.toThrow("DINING_JOIN_REGENERATE_UNAVAILABLE");
  expect(mock.start).not.toHaveBeenCalled();
  expect(mock.table).not.toHaveBeenCalled();
});
it("WP-2423: a permission withdrawn or Session ended during the command refuses it before commit", async () => {
  const f = setup();
  f.allowed.mockResolvedValue(false);
  await expect(f.read(f.input)).rejects.toThrow("DINING_JOIN_REGENERATE_UNAVAILABLE");
  expect(mock.start).toHaveBeenCalledOnce();
  // Resolved in full twice: the permission at the start, the re-check before the commit.
  expect(f.authorizeAction).toHaveBeenCalledOnce();
  expect(f.allowed).toHaveBeenCalledOnce();
  // The refusal is thrown inside the transaction callback, so nothing it wrote commits.
  expect(f.thrownInside()).toBe(true);
});
it("WP-2423: the staff callback takes the run's guard, builds scoped evidence and ends with the run", async () => {
  const f = setup();
  const request = {
    operation: "RegenerateJoinCredential",
    tableReference: id(4),
    operationReference: id(6),
    observedAt: at,
  };
  const during: unknown[] = [];
  const issued = await mock.start();
  mock.start.mockClear();
  mock.start.mockImplementation(async () => {
    const ports = mock.service.mock.calls[0]?.[0];
    during.push(await ports.staff.authorize(request));
    mock.table.mockResolvedValueOnce({
      ...(await mock.table.mock.results[0]?.value),
      activeDiningSessionReference: id(10),
    });
    mock.session.mockResolvedValueOnce(null);
    // A missing occupant is not treated as an empty table.
    during.push(await ports.staff.authorize(request));
    during.push(await ports.staff.authorize({ ...request, operation: "Other" }));
    return issued;
  });
  await f.read(f.input);
  expect(during[0]).toMatchObject({
    permission: { effect: "Allow" },
    table: { assignmentVersion: 2, tableState: "Eligible" },
    audit: {
      actor: { type: "User", reference: id(7) },
      actionCode: "DINING_JOIN_CREDENTIAL_REGENERATE",
      sourceChannel: "MERCHANT_WEB",
      correlationId: id(6),
    },
  });
  expect(during.slice(1)).toEqual([null, null]);
  expect(f.authorizeAction).toHaveBeenCalledExactlyOnceWith("dining.operate");
  expect(f.allowed).toHaveBeenCalledOnce();
  // After the run the guard refuses without loading the table.
  mock.table.mockClear();
  const ports = mock.service.mock.calls[0]?.[0];
  expect(await ports.staff.authorize(request)).toBeNull();
  expect(mock.table).not.toHaveBeenCalled();
});
