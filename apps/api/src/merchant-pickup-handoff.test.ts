import { beforeEach, expect, it, vi } from "vitest";
import { createMerchantPickupHandoff } from "./merchant-pickup-handoff.js";
const doubles = vi.hoisted(() => ({
  scope: vi.fn(),
  store: vi.fn(),
  recover: vi.fn(),
  current: vi.fn(),
  complete: vi.fn(),
}));
vi.mock("./merchant-store-scope.js", () => ({ createMerchantStoreScope: () => doubles.scope }));
vi.mock("@rms/fulfillment", async (original) => ({
  ...(await original<object>()),
  createPostgresPickupHandoffStore: doubles.store,
}));
const id = (n: number) => "01909985-0000-7000-8000-" + n.toString(16).padStart(12, "0");
type Options = Parameters<typeof createMerchantPickupHandoff>[0];
function setup() {
  const authorize = vi.fn(async () => ({ sessionReference: id(1) })),
    allowed = vi.fn(async () => true),
    installContext = vi.fn(async () => undefined),
    nextReference = vi.fn(() => id(20));
  const tx = { query: vi.fn(async () => ({ rows: [], rowCount: 0 })) };
  const run = vi.fn(async (work: (tx: object) => Promise<unknown>) => work(tx));
  doubles.scope.mockResolvedValue({
    actorReference: id(2),
    context: { brand: { brandReference: id(3) } },
    store: { storeReference: id(4) },
    allowed,
  });
  doubles.store.mockReturnValue({
    resolveByIdempotency: doubles.recover,
    lockByOrder: doubles.current,
    complete: doubles.complete,
  });
  doubles.recover.mockResolvedValue(null);
  const verification = { verificationReference: id(7) };
  doubles.current.mockResolvedValue({ verifications: [verification] });
  doubles.complete.mockResolvedValue({
    status: "Applied",
    effect: {
      record: { handoffReference: id(20), fulfillmentReference: id(6) },
      nextAggregateVersion: 9007199254740994n,
      nextPhase: "Completed",
    },
  });
  const operation = createMerchantPickupHandoff({
    persistence: {
      transactions: { run },
      now: () => "2026-09-19T12:00:00.000Z",
    } as unknown as Options["persistence"],
    authentication: { authorize } as unknown as Options["authentication"],
    store: {} as Options["store"],
    installContext,
    nextReference,
  });
  const input = {
    sessionCookie: "synthetic-cookie",
    csrf: "synthetic-csrf",
    command: {
      orderReference: id(5),
      storeReference: id(4),
      fulfillmentReference: id(6),
      expectedAggregateVersion: "9007199254740993",
      verificationReference: id(7),
      recipientType: "Customer",
      recipientDisplayMask: "S***",
      pickupLocationReference: id(8),
      deviceReference: id(9),
      quantities: [{ fulfillmentItemReference: id(10), quantity: 2 }],
      idempotencyReference: id(11),
      correlationReference: id(12),
    },
  };
  return { operation, input, authorize, allowed, run, installContext, nextReference, verification };
}
beforeEach(() => vi.resetAllMocks());
it("authenticates before any business transaction", async () => {
  const f = setup();
  f.authorize.mockRejectedValue(new Error("denied"));
  await expect(f.operation(f.input)).rejects.toThrow();
  expect(f.run).not.toHaveBeenCalled();
});
it.each(["actorReference", "actorPermissions", "verification", "handedOverAt"])(
  "rejects browser-supplied authority %s",
  async (field) => {
    const f = setup();
    await expect(
      f.operation({ ...f.input, command: { ...f.input.command, [field]: id(99) } }),
    ).rejects.toMatchObject({ code: "PICKUP_HANDOFF_INPUT_INVALID" });
    expect(doubles.store).not.toHaveBeenCalled();
  },
);
it("rejects changed selected Store and withdrawn permission before owner access", async () => {
  const f = setup();
  await expect(
    f.operation({ ...f.input, command: { ...f.input.command, storeReference: id(99) } }),
  ).rejects.toMatchObject({ code: "PICKUP_HANDOFF_PERMISSION_DENIED" });
  f.allowed.mockResolvedValue(false);
  await expect(f.operation(f.input)).rejects.toMatchObject({
    code: "PICKUP_HANDOFF_PERMISSION_DENIED",
  });
  expect(doubles.store).not.toHaveBeenCalled();
});
it("uses current identity and persisted proof, preserving exact versions and minimizing response", async () => {
  const f = setup();
  expect(await f.operation(f.input)).toEqual({
    status: "Applied",
    handoffReference: id(20),
    fulfillmentReference: id(6),
    nextAggregateVersion: "9007199254740994",
    nextPhase: "Completed",
  });
  expect(doubles.complete.mock.calls[0]?.[0].command).toMatchObject({
    actorReference: id(2),
    brandReference: id(3),
    actorPermissions: ["fulfillment.pickup.complete"],
    verification: f.verification,
    expectedAggregateVersion: 9007199254740993n,
    handedOverAt: "2026-09-19T12:00:00.000Z",
  });
  expect(f.installContext).toHaveBeenCalledTimes(1);
  expect(doubles.current.mock.invocationCallOrder[0]).toBeLessThan(
    doubles.recover.mock.invocationCallOrder[0] ?? 0,
  );
  f.allowed.mockResolvedValue(false);
  expect(
    await doubles.store.mock.calls[0]?.[0].authorize(
      {},
      { actorReference: id(2), orderReference: id(5), permission: "fulfillment.pickup.complete" },
    ),
  ).toBe(false);
});
it("refuses unrecorded proof without attempting completion", async () => {
  const f = setup();
  doubles.current.mockResolvedValue({ verifications: [] });
  await expect(f.operation(f.input)).rejects.toMatchObject({
    code: "PICKUP_HANDOFF_VERIFICATION_FAILED",
  });
  expect(doubles.complete).not.toHaveBeenCalled();
});
it("reuses original server references and time for recovery while preserving submitted intent", async () => {
  const f = setup();
  doubles.recover.mockResolvedValue({
    record: { handoffReference: id(30), handedOverAt: "2026-09-19T11:59:00.000Z" },
    operation: { operationReference: id(31) },
    audit: { auditReference: id(32) },
  });
  await f.operation({ ...f.input, command: { ...f.input.command, recipientDisplayMask: "T***" } });
  expect(f.nextReference).not.toHaveBeenCalled();
  expect(doubles.complete.mock.calls[0]?.[0].command).toMatchObject({
    handoffReference: id(30),
    operationReference: id(31),
    auditReference: id(32),
    handedOverAt: "2026-09-19T11:59:00.000Z",
    recipientDisplayMask: "T***",
    idempotencyReference: id(11),
    expectedAggregateVersion: 9007199254740993n,
  });
});
it("WP-2423: builds an in-person verification for the current staff member and proof state", async () => {
  const f = setup();
  const command: Record<string, unknown> = {
    ...f.input.command,
    identityCheck: "OrderNumberAndPhoneLast4",
  };
  delete command.verificationReference;
  doubles.current.mockResolvedValue({ verifications: [], inPerson: [], capability: null });
  await f.operation({ ...f.input, command });
  expect(doubles.complete.mock.calls[0]?.[0].command.verification).toEqual({
    verificationReference: id(20),
    correlationReference: id(12),
    fulfillmentReference: id(6),
    brandReference: id(3),
    storeReference: id(4),
    verificationMethod: "InPerson",
    identityCheck: "OrderNumberAndPhoneLast4",
    reason: "ProofNotIssued",
    verifiedByActorReference: id(2),
    verifiedAt: "2026-09-19T12:00:00.000Z",
  });
  doubles.current.mockResolvedValue({
    verifications: [],
    inPerson: [],
    capability: { expiresAt: "2026-09-19T11:00:00.000Z" },
  });
  await f.operation({ ...f.input, command });
  expect(doubles.complete.mock.calls[1]?.[0].command.verification.reason).toBe("ProofExpired");
  await expect(
    f.operation({ ...f.input, command: { ...command, identityCheck: "LooksFamiliar" } }),
  ).rejects.toMatchObject({ code: "PICKUP_HANDOFF_INPUT_INVALID" });
  await expect(
    f.operation({
      ...f.input,
      command: { ...command, verificationReference: id(7) },
    }),
  ).rejects.toMatchObject({ code: "PICKUP_HANDOFF_INPUT_INVALID" });
});
