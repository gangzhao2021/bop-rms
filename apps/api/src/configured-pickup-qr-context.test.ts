import { createGuestSession, parseCanonicalInstant } from "@bop/identity";
import { createConfiguredPickupSessionBinding } from "./configured-pickup-session-binding.js";
import { beforeEach, expect, it, vi } from "vitest";
import { fixture, id, now } from "../test-support/customer-entry-composition-fixture.js";
import { createConfiguredPickupQrContext } from "./configured-pickup-qr-context.js";
const resolve = vi.hoisted(() => vi.fn());
vi.mock("./public-store-resolution.js", () => ({
  createConfiguredPublicStoreResolution: () => ({ resolve }),
}));
beforeEach(() => vi.resetAllMocks());
function setup() {
  const f = fixture();
  const payload = { ...f.payload, channel: "Pickup", publicTableReference: null };
  const tx = { query: vi.fn() };
  const authorizeRegistration = vi.fn(async () => true);
  const options = {
    transaction: tx,
    evaluatedAt: now,
    binding: {
      tenantReference: id(40),
      publicStoreReference: id(4),
      brandReference: id(1),
      storeReference: id(2),
      lookupEvidenceReference: id(8),
      validFrom: payload.issuedAt,
      validUntil: payload.expiresAt,
    },
    authorize: async () => true,
    registration: {
      payload,
      state: "Enabled",
      contextEvidenceReference: id(7),
      validFrom: payload.issuedAt,
      validUntil: payload.expiresAt,
    },
    authorizeRegistration,
  } as unknown as Parameters<typeof createConfiguredPickupQrContext>[0];
  resolve.mockResolvedValue(f.resolution);
  return {
    tx,
    options,
    authorizeRegistration,
    payload: payload as typeof options.registration.payload,
    source: createConfiguredPickupQrContext(options),
  };
}
it("uses current public organization resolution with a closed request and bounded validity", async () => {
  const x = setup();
  const result = await x.source.resolve(x.payload);
  expect(result).toMatchObject({
    channel: "Pickup",
    brandLifecycle: "Active",
    storeLifecycle: "Active",
    tableReference: null,
    publicTableReference: null,
    validUntil: x.payload.expiresAt,
  });
  expect(resolve).toHaveBeenCalledExactlyOnceWith({
    publicStoreReference: id(4),
    evaluatedAt: now,
    purpose: "CustomerEntry",
  });
  expect(x.authorizeRegistration).toHaveBeenCalledTimes(2);
  expect(x.authorizeRegistration.mock.calls[0]?.length).toBe(3);
});
it("rejects payload substitutions, revocation and expired registration before internal reads", async () => {
  const x = setup();
  for (const change of [
    { qrReference: id(99) },
    { publicStoreReference: id(99) },
    { locale: "fr-CA" },
    { revocationVersion: 2 },
    { channel: "DineIn", publicTableReference: id(9) },
  ])
    expect(await x.source.resolve({ ...x.payload, ...change } as typeof x.payload)).toBeNull();
  expect(
    await createConfiguredPickupQrContext({
      ...x.options,
      registration: { ...x.options.registration, state: "Revoked" },
    }).resolve(x.payload),
  ).toBeNull();
  expect(
    await createConfiguredPickupQrContext({
      ...x.options,
      evaluatedAt: x.options.registration.validUntil,
    }).resolve(x.payload),
  ).toBeNull();
  expect(resolve).not.toHaveBeenCalled();
});
it("requires current registration permission before and after the organization read", async () => {
  const x = setup();
  x.authorizeRegistration.mockResolvedValueOnce(false);
  expect(await x.source.resolve(x.payload)).toBeNull();
  expect(resolve).not.toHaveBeenCalled();
  x.authorizeRegistration.mockResolvedValueOnce(true).mockResolvedValueOnce(false);
  expect(await x.source.resolve(x.payload)).toBeNull();
  resolve.mockRejectedValueOnce(new Error("unavailable"));
  expect(await x.source.resolve(x.payload)).toBeNull();
});

function sessionSetup() {
  const x = setup();
  const run = vi.fn();
  const source = createConfiguredPickupSessionBinding({
    ...x.options,
    transactions: {
      run: async (work) => {
        run();
        return work(x.tx);
      },
    },
  });
  const session = createGuestSession({
    sessionReference: id(50),
    status: "Active",
    version: 1,
    brandReference: id(1),
    storeReference: id(2),
    publicStoreReference: id(4),
    publicTableReference: null,
    channel: "Pickup",
    locale: "en-CA",
    qrReference: x.payload.qrReference,
    qrRevocationVersion: x.payload.revocationVersion,
    diningState: "ContextOnly",
    diningSessionReference: null,
    diningParticipantReference: null,
    createdAt: now,
    lastSeenAt: now,
    idleExpiresAt: "2026-01-15T16:00:00.000Z",
    absoluteExpiresAt: "2026-01-16T12:00:00.000Z",
    orderClosedAt: null,
    closureExpiresAt: null,
    rotatedFromGuestSessionReference: null,
    revocationReason: null,
    revokedAt: null,
  });
  return { ...x, run, source, session };
}
it("validates an existing Pickup session with current Tenant/QR facts and CustomerCart purpose", async () => {
  const x = sessionSetup();
  expect(await x.source.validate(x.session, parseCanonicalInstant(now))).toBe("Current");
  expect(resolve).toHaveBeenCalledExactlyOnceWith({
    publicStoreReference: id(4),
    evaluatedAt: now,
    purpose: "CustomerCart",
  });
  expect(x.authorizeRegistration).toHaveBeenCalledTimes(2);
  expect(x.run).toHaveBeenCalledOnce();
});
it("rejects foreign session scope, QR versions and expired sessions before reads", async () => {
  const x = sessionSetup();
  for (const change of [
    { storeReference: id(99) },
    { brandReference: id(99) },
    { publicStoreReference: id(99) },
    { qrReference: id(99) },
    { qrRevocationVersion: 2 },
    { channel: "DineIn", publicTableReference: id(5) },
  ])
    expect(
      await x.source.validate(
        createGuestSession({ ...x.session, ...change }),
        parseCanonicalInstant(now),
      ),
    ).toBe("Unavailable");
  expect(await x.source.validate(x.session, x.session.idleExpiresAt)).toBe("Unavailable");
  expect(x.run).not.toHaveBeenCalled();
});
it("fails closed for revoked registration, withdrawn authority, inactive Tenant and reader failure", async () => {
  const x = sessionSetup();
  x.authorizeRegistration.mockResolvedValueOnce(false);
  expect(await x.source.validate(x.session, parseCanonicalInstant(now))).toBe("Unavailable");
  expect(resolve).not.toHaveBeenCalled();
  resolve.mockResolvedValueOnce({ ...fixture().resolution, storeLifecycle: "Suspended" });
  expect(await x.source.validate(x.session, parseCanonicalInstant(now))).toBe("Unavailable");
  x.authorizeRegistration.mockResolvedValueOnce(true).mockResolvedValueOnce(false);
  expect(await x.source.validate(x.session, parseCanonicalInstant(now))).toBe("Unavailable");
  resolve.mockRejectedValueOnce(new Error("private source failure"));
  expect(await x.source.validate(x.session, parseCanonicalInstant(now))).toBe("Unavailable");
});
