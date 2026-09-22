import { beforeEach, expect, it, vi } from "vitest";
import { createPostgresPickupProofIssuer } from "../infrastructure/persistence/pickup-proof-issuer.js";
import { createPickupCredentialProvider } from "../infrastructure/crypto/pickup-credential-provider.js";
const mocks = vi.hoisted(() => ({
  lockByOrder: vi.fn(),
  resolveByIdempotency: vi.fn(),
  issue: vi.fn(),
}));
vi.mock("../infrastructure/persistence/pickup-proof-store.js", () => ({
  createPostgresPickupProofStore: () => mocks,
}));
const id = (n: number) => `01900000-0000-7000-8000-${String(n).padStart(12, "0")}`;
beforeEach(() => vi.resetAllMocks());
function setup() {
  const credentials = createPickupCredentialProvider([
    {
      version: 1,
      derivationKey: new Uint8Array(32).fill(11),
      selectorKey: new Uint8Array(32).fill(22),
    },
  ]);
  const authorize = vi.fn(async () => true),
    now = () => "2026-09-19T12:05:00.000Z";
  const source = {
    fulfillmentReference: id(3),
    brandReference: id(1),
    storeReference: id(2),
    fulfillmentType: "Pickup",
    canonicalPhase: "Ready",
    aggregateVersion: 3n,
    readyAt: "2026-09-19T12:00:00.000Z",
    currentProofGeneration: null,
    currentProofCapabilityReference: null,
    lockedAt: now(),
    items: [
      {
        fulfillmentItemReference: id(4),
        orderedQuantity: 2,
        readyQuantity: 2,
        handedOverQuantity: 0,
        state: "Ready",
      },
    ],
  };
  mocks.lockByOrder.mockResolvedValue({ source, capability: null });
  mocks.resolveByIdempotency.mockResolvedValue(null);
  mocks.issue.mockImplementation(async (input) => ({ status: "Applied", effect: input.effect }));
  let next = 10;
  const issuer = createPostgresPickupProofIssuer({
    store: {
      brandReference: id(1),
      storeReference: id(2),
      now,
      authorize,
      sha256: () => "",
      validateCurrentSource: async () => true,
      appendAudit: async () => undefined,
    },
    credentials,
    pepperVersion: 1,
    nextReference: () => id(next++),
    publicOrderReference: () => "A".repeat(22),
  });
  const input = {
    transaction: { query: async () => ({ rows: [], rowCount: 0 }) },
    orderReference: id(5),
    idempotencyReference: id(6),
    correlationReference: id(7),
  };
  return { issuer, input, authorize, credentials, source };
}
it("issues only selector history and returns no raw credential", async () => {
  const f = setup();
  expect(await f.issuer.ensureIssued(f.input)).toEqual({
    status: "Issued",
    capabilityReference: id(10),
    generation: 1,
  });
  const effect = mocks.issue.mock.calls[0]?.[0].effect;
  expect(effect.generation).toMatchObject({
    kind: "Opaque",
    generation: 1,
    expiresAt: "2026-09-19T13:00:00.000Z",
  });
  expect(effect.generation.selectorHash).toMatch(/^[0-9a-f]{64}$/);
  expect(
    JSON.stringify(effect, (_key, value) => (typeof value === "bigint" ? String(value) : value)),
  ).not.toContain("credential");
});
it("reuses a valid existing generation without issuing or extending expiry", async () => {
  const f = setup();
  await f.issuer.ensureIssued(f.input);
  const g = mocks.issue.mock.calls[0]?.[0].effect.generation;
  const { issuedAt: _issuedAt, brandReference: _brandReference, ...fields } = g;
  void _issuedAt;
  void _brandReference;
  mocks.lockByOrder.mockResolvedValue({
    source: f.source,
    capability: {
      ...fields,
      purpose: "PickupHandoff",
      status: "Active",
      version: 1,
      revokedAt: null,
    },
  });
  expect(await f.issuer.ensureIssued(f.input)).toEqual({
    status: "AlreadyAvailable",
    capabilityReference: id(10),
    generation: 1,
  });
  expect(mocks.issue).toHaveBeenCalledTimes(1);
});
it("denies before source access and rejects a verification idempotency collision", async () => {
  const f = setup();
  f.authorize.mockResolvedValueOnce(false);
  await expect(f.issuer.ensureIssued(f.input)).rejects.toMatchObject({
    code: "PICKUP_PROOF_UNAVAILABLE",
  });
  expect(mocks.lockByOrder).not.toHaveBeenCalled();
  mocks.resolveByIdempotency.mockResolvedValue({ kind: "Verify" });
  await expect(f.issuer.ensureIssued(f.input)).rejects.toMatchObject({
    code: "PICKUP_PROOF_VERSION_CONFLICT",
  });
  expect(mocks.issue).not.toHaveBeenCalled();
});
