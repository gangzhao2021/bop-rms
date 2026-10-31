import { beforeEach, expect, it, vi } from "vitest";
import { createMerchantPickupProof } from "./merchant-pickup-proof.js";
const doubles = vi.hoisted(() => ({
  scope: vi.fn(),
  store: vi.fn(),
  lock: vi.fn(),
  recover: vi.fn(),
  verify: vi.fn(),
  validate: vi.fn(),
}));
vi.mock("./merchant-store-scope.js", () => ({ createMerchantStoreScope: () => doubles.scope }));
vi.mock("@rms/fulfillment", async (original) => ({
  ...(await original<object>()),
  createPostgresPickupProofStore: doubles.store,
  validatePickupProof: doubles.validate,
}));
const id = (n: number) => "01909985-0000-7000-8000-" + n.toString(16).padStart(12, "0");
type Options = Parameters<typeof createMerchantPickupProof>[0];
function setup() {
  const authorize = vi.fn(async () => ({ sessionReference: id(1) })),
    allowed = vi.fn(async () => true),
    consumeAttempt = vi.fn(async () => true);
  const run = vi.fn(async (work: (tx: object) => Promise<unknown>) =>
    work({ query: vi.fn(async () => ({ rows: [], rowCount: 0 })) }),
  );
  doubles.scope.mockResolvedValue({
    actorReference: id(2),
    context: { brand: { brandReference: id(3) } },
    store: { storeReference: id(4) },
    allowed,
  });
  doubles.store.mockReturnValue({
    lockByOrder: doubles.lock,
    resolveByIdempotency: doubles.recover,
    verify: doubles.verify,
  });
  doubles.lock.mockResolvedValue({
    source: { fulfillmentReference: id(6), aggregateVersion: 3n },
    capability: { kind: "HumanCode", pepperVersion: 1, selectorHash: "h" },
  });
  doubles.recover.mockResolvedValue(null);
  doubles.validate.mockReturnValue({});
  doubles.verify.mockResolvedValue({
    status: "Applied",
    record: { verificationReference: id(20), fulfillmentReference: id(6), generation: 1 },
  });
  const operation = createMerchantPickupProof({
    persistence: {
      transactions: { run },
      now: () => "2026-10-15T12:00:00.000Z",
    } as unknown as Options["persistence"],
    authentication: { authorize } as unknown as Options["authentication"],
    store: {} as Options["store"],
    appendAudit: vi.fn(async () => undefined),
    installContext: vi.fn(async () => undefined),
    nextReference: () => id(20),
    consumeAttempt,
    hashCredential: vi.fn(async () => "selector"),
  });
  const input = {
    sessionCookie: "synthetic-cookie",
    csrf: "synthetic-csrf",
    command: {
      orderReference: id(5),
      storeReference: id(4),
      fulfillmentReference: id(6),
      generation: 1,
      kind: "HumanCode",
      credential: "123-456",
      idempotencyReference: id(11),
      correlationReference: id(12),
    },
  };
  return { operation, input, allowed, run, consumeAttempt };
}
beforeEach(() => vi.resetAllMocks());
it("WP-2423: verifies a code and resolves the caller in full only at the start and before the commit", async () => {
  const f = setup();
  const during: boolean[] = [];
  const access = { access: "Verify", orderReference: id(5) };
  doubles.verify.mockImplementation(async (request: { transaction: object }) => {
    const store = doubles.store.mock.calls[0]?.[0];
    during.push(await store.authorize(request.transaction, access));
    // Not this run's transaction, another order or an issue request: refused without a query.
    during.push(await store.authorize({ query: vi.fn() }, access));
    during.push(await store.authorize(request.transaction, { ...access, orderReference: id(99) }));
    during.push(await store.authorize(request.transaction, { ...access, access: "Issue" }));
    return {
      status: "Applied",
      record: { verificationReference: id(20), fulfillmentReference: id(6), generation: 1 },
    };
  });
  await expect(f.operation(f.input)).resolves.toEqual({
    status: "Applied",
    verificationReference: id(20),
    fulfillmentReference: id(6),
    expectedAggregateVersion: "3",
    generation: 1,
    grantsCompletionAuthority: false,
  });
  expect(during).toEqual([true, false, false, false]);
  expect(doubles.scope).toHaveBeenCalledOnce();
  expect(f.allowed).toHaveBeenCalledTimes(2);
  // The attempt budget is still spent before the owner reads the proof.
  expect(f.consumeAttempt.mock.invocationCallOrder[0]).toBeLessThan(
    doubles.lock.mock.invocationCallOrder[0] ?? 0,
  );
  // The guard ends with the run.
  const transaction = doubles.verify.mock.calls[0]?.[0].transaction;
  expect(await doubles.store.mock.calls[0]?.[0].authorize(transaction, access)).toBe(false);
});
it("WP-2423: refuses another Store and a withdrawn permission before spending an attempt", async () => {
  const f = setup();
  await expect(
    f.operation({ ...f.input, command: { ...f.input.command, storeReference: id(99) } }),
  ).rejects.toMatchObject({ code: "PICKUP_HANDOFF_PERMISSION_DENIED" });
  f.allowed.mockResolvedValue(false);
  await expect(f.operation(f.input)).rejects.toMatchObject({
    code: "PICKUP_HANDOFF_PERMISSION_DENIED",
  });
  expect(f.consumeAttempt).not.toHaveBeenCalled();
  expect(doubles.store).not.toHaveBeenCalled();
});
it("WP-2423: a permission withdrawn or Session ended during the check refuses it before commit", async () => {
  const f = setup();
  f.allowed.mockResolvedValueOnce(true).mockResolvedValueOnce(false);
  let rolledBack: unknown = null;
  f.run.mockImplementation(async (work: (tx: object) => Promise<unknown>) =>
    work({ query: vi.fn(async () => ({ rows: [], rowCount: 0 })) }).catch((error: unknown) => {
      rolledBack = error;
      throw error;
    }),
  );
  await expect(f.operation(f.input)).rejects.toMatchObject({
    code: "PICKUP_HANDOFF_PERMISSION_DENIED",
  });
  // The refusal is thrown inside the transaction callback, so nothing it wrote commits.
  expect(rolledBack).toMatchObject({ code: "PICKUP_HANDOFF_PERMISSION_DENIED" });
  expect(doubles.verify).toHaveBeenCalledOnce();
  expect(f.allowed).toHaveBeenCalledTimes(2);
});
it("WP-2423: a wrong code is reported after the run's final check", async () => {
  const f = setup();
  doubles.verify.mockResolvedValue({ status: "Rejected", locked: true });
  await expect(f.operation(f.input)).rejects.toMatchObject({ code: "PICKUP_PROOF_LOCKED" });
  expect(f.allowed).toHaveBeenCalledTimes(2);
});
