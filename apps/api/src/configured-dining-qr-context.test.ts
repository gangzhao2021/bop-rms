import { createGuestSession, parseCanonicalInstant } from "@bop/identity";
import { createConfiguredDiningGuestContext } from "./configured-dining-guest-context.js";
import { beforeEach, expect, it, vi } from "vitest";
import { fixture, id, now } from "../test-support/customer-entry-composition-fixture.js";
import { createConfiguredDiningQrContext } from "./configured-dining-qr-context.js";
const { resolve, readTable } = vi.hoisted(() => ({ resolve: vi.fn(), readTable: vi.fn() }));
vi.mock("@rms/dining", async (original) => ({
  ...(await original<typeof import("@rms/dining")>()),
  createPostgresDiningPublicTableReader: (options: {
    transaction: unknown;
    authorize: (tx: unknown, input: { tableReference: string }) => Promise<boolean>;
  }) => ({
    read: async (input: { tableReference: string }) => {
      if (!(await options.authorize(options.transaction, input))) return null;
      const result = await readTable(input);
      return (await options.authorize(options.transaction, input)) ? result : null;
    },
  }),
}));
vi.mock("./public-store-resolution.js", () => ({
  createConfiguredPublicStoreResolution: () => ({ resolve }),
}));
beforeEach(() => vi.resetAllMocks());
function setup() {
  const f = fixture();
  const payload = { ...f.payload };
  const tx = { query: vi.fn() };
  const authorizeRegistration = vi.fn(async (...args: unknown[]) => {
    void args;
    return true;
  });
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
      tableReference: id(6),
      state: "Enabled",
      contextEvidenceReference: id(7),
      validFrom: payload.issuedAt,
      validUntil: payload.expiresAt,
    },
    authorizeRegistration,
  } as unknown as Parameters<typeof createConfiguredDiningQrContext>[0];
  resolve.mockResolvedValue(f.resolution);
  readTable.mockResolvedValue({
    tableReference: id(6),
    brandReference: id(1),
    storeReference: id(2),
    qrVersion: 1,
  });
  return {
    tx,
    options,
    authorizeRegistration,
    payload: payload as typeof options.registration.payload,
    source: createConfiguredDiningQrContext(options),
  };
}
it("uses current public organization resolution with a closed request and bounded validity", async () => {
  const x = setup();
  const result = await x.source.resolve(x.payload);
  expect(result).toMatchObject({
    channel: "DineIn",
    brandLifecycle: "Active",
    storeLifecycle: "Active",
    tableReference: id(6),
    publicTableReference: id(5),
    validUntil: x.payload.expiresAt,
  });
  expect(resolve).toHaveBeenCalledExactlyOnceWith({
    publicStoreReference: id(4),
    evaluatedAt: now,
    purpose: "CustomerEntry",
  });
  expect(x.authorizeRegistration).toHaveBeenCalledTimes(5);
  expect(x.authorizeRegistration.mock.calls[0]?.length).toBe(4);
});
it("rejects payload substitutions, revocation and expired registration before internal reads", async () => {
  const x = setup();
  for (const change of [
    { qrReference: id(99) },
    { publicStoreReference: id(99) },
    { locale: "fr-CA" },
    { revocationVersion: 2 },
    { channel: "Pickup", publicTableReference: null },
  ])
    expect(await x.source.resolve({ ...x.payload, ...change } as typeof x.payload)).toBeNull();
  expect(
    await createConfiguredDiningQrContext({
      ...x.options,
      registration: { ...x.options.registration, state: "Revoked" },
    }).resolve(x.payload),
  ).toBeNull();
  expect(
    await createConfiguredDiningQrContext({
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

it("rejects missing or mismatched current table facts and late mapping withdrawal", async () => {
  const x = setup();
  for (const table of [
    null,
    { tableReference: id(6), brandReference: id(1), storeReference: id(2), qrVersion: 2 },
    { tableReference: id(99), brandReference: id(1), storeReference: id(2), qrVersion: 1 },
    { tableReference: id(6), brandReference: id(1), storeReference: id(99), qrVersion: 1 },
  ]) {
    readTable.mockResolvedValueOnce(table);
    expect(await x.source.resolve(x.payload)).toBeNull();
  }
  x.authorizeRegistration
    .mockReset()
    .mockResolvedValueOnce(true)
    .mockResolvedValueOnce(true)
    .mockResolvedValueOnce(true)
    .mockResolvedValueOnce(true)
    .mockResolvedValueOnce(false);
  expect(await x.source.resolve(x.payload)).toBeNull();
});

it("resolves authenticated Dining context with exact session scope and operation purpose", async () => {
  const x = setup();
  const context = createConfiguredDiningGuestContext({
    ...x.options,
    transactions: { run: async (work) => work(x.tx) },
  });
  const session = createGuestSession({
    sessionReference: id(50),
    status: "Active",
    version: 1,
    brandReference: id(1),
    storeReference: id(2),
    publicStoreReference: id(4),
    publicTableReference: id(5),
    channel: "DineIn",
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
  for (const purpose of ["DiningJoin", "DiningAdmission", "GuestSessionBinding"] as const) {
    expect(
      await context.resolve({ session, observedAt: parseCanonicalInstant(now), purpose }),
    ).toMatchObject({ tableReference: id(6), publicTableReference: id(5) });
    expect(readTable).toHaveBeenLastCalledWith({
      tableReference: id(6),
      purpose,
      observedAt: now,
    });
    expect(x.authorizeRegistration.mock.calls.at(-1)?.[3]).toBe(purpose);
    expect(resolve).toHaveBeenLastCalledWith({
      publicStoreReference: id(4),
      evaluatedAt: now,
      purpose: "CustomerCart",
    });
  }
  resolve.mockClear();
  for (const change of [
    { publicTableReference: id(99) },
    { qrReference: id(99) },
    { qrRevocationVersion: 2 },
    { storeReference: id(99) },
  ]) {
    expect(
      await context.validate(
        createGuestSession({ ...session, ...change }),
        parseCanonicalInstant(now),
      ),
    ).toBe("Unavailable");
  }
  expect(resolve).not.toHaveBeenCalled();
  x.authorizeRegistration.mockResolvedValue(false);
  expect(await context.validate(session, parseCanonicalInstant(now))).toBe("Unavailable");
});
