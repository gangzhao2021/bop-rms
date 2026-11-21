import { randomBytes } from "node:crypto";
import {
  createGuestSession,
  createGuestSessionCredentialProvider,
  GuestSessionService,
  parseGuestRawCredential,
  type GuestSessionRecord,
} from "@bop/identity";
import { createCustomerCartViewQuery, createPickupCartReadService } from "@rms/ordering";
import { expect, it, vi } from "vitest";
import { createConfiguredPickupSessionBinding } from "./configured-pickup-session-binding.js";
import { createCustomerCartReadPort } from "./customer-cart-read-composition.js";
import { fixture, id, now } from "../test-support/customer-entry-composition-fixture.js";

/**
 * WP-2423 (outage-reads-and-retry, v15 2026-11-11): in a rush of 443 requests, 10 of 75 pickup
 * cart reads answered 401 "session expired" and the phone dropped its cart: the Store's QR
 * records couldn't be read (no free connection), and that was taken as "this session is no longer
 * valid". Composed as the pilot does: the Guest Session store answers, the QR records don't.
 */
it("a cart read whose Store records can't be read is 'busy, try again', never an ended session", async () => {
  const f = fixture();
  const payload = { ...f.payload, channel: "Pickup", publicTableReference: null };
  const credentials = createGuestSessionCredentialProvider(randomBytes(32));
  const sessionCredential = parseGuestRawCredential(credentials.generateCredential("Session"));
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
    qrReference: payload.qrReference,
    qrRevocationVersion: payload.revocationVersion,
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
  const record: GuestSessionRecord = {
    session,
    sessionSelectorHash: credentials.hashCredential("Session", sessionCredential),
    csrfSelectorHash: credentials.hashCredential(
      "Csrf",
      parseGuestRawCredential(credentials.generateCredential("Csrf")),
    ),
    operationReference: id(51),
    operationIntentHash: credentials.hashOperationIntent("Create:" + id(52)),
  } as GuestSessionRecord;
  const binding = createConfiguredPickupSessionBinding({
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
      payload: payload as never,
      state: "Enabled",
      contextEvidenceReference: id(7),
      validFrom: payload.issuedAt,
      validUntil: payload.expiresAt,
    },
    authorizeRegistration: async () => true,
    transactions: {
      run: async () => {
        throw Object.assign(new Error("tenant database connection is unavailable"), {
          code: "TENANT_DATABASE_ACQUIRE_FAILED",
        });
      },
    },
  });
  const sessions = new GuestSessionService({
    credentials,
    binding,
    admission: { consume: async () => null },
    now: () => now,
    store: {
      resolve: async () => record,
      resolveOperation: async () => null,
      create: vi.fn(),
      touchInteractive: vi.fn(),
      rotate: vi.fn(),
      revoke: vi.fn(),
    } as never,
  });
  const cartBinding = { current: vi.fn(async () => null) };
  const port = createCustomerCartReadPort(
    createCustomerCartViewQuery({
      reads: createPickupCartReadService({
        sessions,
        binding: cartBinding,
        scope: { brandReference: id(1), storeReference: id(2) },
        now: () => now,
      }),
      catalog: { load: vi.fn() } as never,
      stores: { resolvePublic: vi.fn() } as never,
      quotes: { loadLatest: async () => null },
    } as never),
  );
  const write = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
  try {
    const result = await port.getCurrentCart({ guestCredential: sessionCredential } as never);
    expect(result).toEqual({ status: "Unavailable" });
    // Logged as the outage it is, with its cause.
    expect(String(write.mock.calls.at(-1)?.[0])).toContain("CUSTOMER_CART_READ_UNAVAILABLE");
  } finally {
    write.mockRestore();
  }
  expect(cartBinding.current).not.toHaveBeenCalled();
});
