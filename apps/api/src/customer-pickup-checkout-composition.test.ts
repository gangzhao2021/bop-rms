import { describe, expect, it, vi } from "vitest";
import { createGuestSessionCredentialProvider, createGuestSessionRecord } from "@bop/identity";
import { sealAsapCapacityCommitment, type AsapCapacityCommitment } from "@rms/fulfillment";
import {
  createCustomerPickupCheckoutComposition,
  pickupOrderCapacityLinkFromHistory,
  type CustomerPickupCheckoutOptions,
} from "./customer-pickup-checkout-composition.js";
const id = (n: number) => "01902402-0000-7000-8000-" + String(n).padStart(12, "0");
const at = "2026-09-10T12:00:00.000Z";
function fixture() {
  const credentials = createGuestSessionCredentialProvider(new Uint8Array(32).fill(7));
  const sessionCredential = credentials.generateCredential("Session");
  const csrfCredential = credentials.generateCredential("Csrf");
  const guest = createGuestSessionRecord({
    session: {
      sessionReference: id(9),
      status: "Active",
      version: 1,
      brandReference: id(2),
      storeReference: id(3),
      publicStoreReference: id(40),
      publicTableReference: null,
      channel: "Pickup",
      locale: "en-CA",
      qrReference: id(42),
      qrRevocationVersion: 1,
      diningState: "ContextOnly",
      diningSessionReference: null,
      diningParticipantReference: null,
      createdAt: "2026-09-10T11:00:00.000Z",
      lastSeenAt: "2026-09-10T11:00:00.000Z",
      idleExpiresAt: "2026-09-10T15:00:00.000Z",
      absoluteExpiresAt: "2026-09-11T11:00:00.000Z",
      orderClosedAt: null,
      closureExpiresAt: null,
      rotatedFromGuestSessionReference: null,
      revocationReason: null,
      revokedAt: null,
    },
    sessionSelectorHash: credentials.hashCredential("Session", sessionCredential),
    csrfSelectorHash: credentials.hashCredential("Csrf", csrfCredential),
    operationReference: id(44),
    operationIntentHash: credentials.hashOperationIntent("synthetic pickup"),
  });
  let stored: AsapCapacityCommitment | null = null;
  let sequence = 100;
  let now = at;
  let bindingCurrent = true;
  const unexpected = async (): Promise<never> => {
    throw new Error("unexpected synthetic operation");
  };
  const loadSubmission = vi.fn(async () => stored);
  const append = vi.fn(async (input: { record: AsapCapacityCommitment; audit: unknown }) => {
    stored = input.record;
    return { status: "Created", record: stored };
  });
  const source = vi.fn(async (input: { observedAt: string }) => ({
    slot: {
      brandReference: id(2),
      storeReference: id(3),
      fulfillmentType: "Pickup",
      slotReference: id(50),
      configVersion: 1,
      startsAt: at,
      endsAt: "2026-09-10T12:30:00.000Z",
    },
    capacityLimit: 10,
    occupiedUnits: 0,
    units: 1,
    unitsRuleVersion: 1,
    unitsInputDigest: "sha256:" + "a".repeat(64),
    observedAt: input.observedAt,
    validUntil: "2026-09-10T12:05:00.000Z",
  }));
  const generate = vi.fn(() => id(++sequence));
  const options: CustomerPickupCheckoutOptions = {
    scope: { brandReference: id(2), storeReference: id(3) },
    session: {
      credentials,
      binding: { validate: async () => (bindingCurrent ? "Current" : "Unavailable") },
      store: {
        resolve: async (selector) => (selector === guest.sessionSelectorHash ? guest : null),
        resolveOperation: async () => guest,
        create: unexpected,
        touchInteractive: unexpected,
        rotate: unexpected,
        revoke: unexpected,
      },
    },
    capacity: { repository: { loadSubmission, append }, audit: { prepare: async () => ({}) } },
    sources: { resolve: source },
    references: { generate },
    now: () => now,
  };
  const input = {
    sessionCredential,
    csrfCredential,
    intent: {
      submissionReference: id(60),
      cartReference: id(61),
      cartVersion: 1,
      quoteReference: id(62),
    },
  };
  return {
    options,
    input,
    source,
    generate,
    append,
    loadSubmission,
    service: createCustomerPickupCheckoutComposition(options),
    setTime: (value: string) => {
      now = value;
    },
    revoke: () => {
      bindingCurrent = false;
    },
    save: (record: AsapCapacityCommitment) => {
      stored = record;
    },
  };
}
describe("Pickup checkout Identity and CSRF composition", () => {
  it("derives Guest and original IDs server-side and recovers without generating replacements", async () => {
    const f = fixture();
    const first = await f.service.prepareForOrdering(f.input);
    expect(first.record.guestSessionReference).toBe(id(9));
    expect(first.record.submissionReference).toBe(f.input.intent.submissionReference);
    expect(f.generate).toHaveBeenCalledTimes(5);
    expect((await f.service.prepare(f.input)).record).toEqual(first.record);
    expect(f.generate).toHaveBeenCalledTimes(5);
    expect(f.append).toHaveBeenCalledOnce();
  });
  it("rejects bad CSRF before source queries or capacity history disclosure", async () => {
    const f = fixture();
    await expect(
      f.service.prepare({ ...f.input, csrfCredential: "x".repeat(43) }),
    ).rejects.toThrow();
    expect(f.source).not.toHaveBeenCalled();
    expect(f.loadSubmission).not.toHaveBeenCalled();
    expect(f.generate).not.toHaveBeenCalled();
  });
  it.each([
    "guestSessionReference",
    "allocationReference",
    "paymentOperationReference",
    "storeReference",
  ])("rejects injected internal field %s", async (key) => {
    const f = fixture();
    await expect(
      f.service.prepare({ ...f.input, intent: { ...f.input.intent, [key]: id(99) } }),
    ).rejects.toThrow();
    expect(f.generate).not.toHaveBeenCalled();
    expect(f.append).not.toHaveBeenCalled();
  });
  it("recovers original expired history but denies fresh Ordering use", async () => {
    const f = fixture();
    const first = await f.service.prepare(f.input);
    f.setTime("2026-09-10T12:06:00.000Z");
    f.source.mockClear();
    expect((await f.service.prepare(f.input)).record).toEqual(first.record);
    expect(f.source).not.toHaveBeenCalled();
    await expect(f.service.prepareForOrdering(f.input)).rejects.toThrow();
    expect(f.generate).toHaveBeenCalledTimes(5);
  });
  it("recovers the durable original after a lost append response", async () => {
    const f = fixture();
    f.append.mockImplementationOnce(async (request) => {
      f.save(request.record);
      throw new Error("synthetic lost ack");
    });
    const result = await f.service.prepare(f.input);
    expect(result.status).toBe("Existing");
    expect(f.generate).toHaveBeenCalledTimes(5);
  });
  it("denies when current binding is revoked during source resolution", async () => {
    const f = fixture();
    const resolve = f.source.getMockImplementation();
    if (resolve === undefined) throw new Error("missing synthetic source");
    f.source.mockImplementationOnce(async (input) => {
      const result = await resolve(input);
      f.revoke();
      return result;
    });
    await expect(f.service.prepare(f.input)).rejects.toThrow();
    expect(f.generate).not.toHaveBeenCalled();
    expect(f.append).not.toHaveBeenCalled();
  });
  it("does not reuse original submission for another Cart version", async () => {
    const f = fixture();
    await f.service.prepare(f.input);
    await expect(
      f.service.prepare({ ...f.input, intent: { ...f.input.intent, cartVersion: 2 } }),
    ).rejects.toThrow();
    expect(f.append).toHaveBeenCalledOnce();
  });
});

it("maps terminal history to the same original immutable Fulfillment Order link", async () => {
  const f = fixture();
  const prepared = (await f.service.prepare(f.input)).record;
  const link = pickupOrderCapacityLinkFromHistory(prepared);
  expect(link).toMatchObject({
    owner: "Fulfillment",
    commitmentReference: prepared.allocationReference,
    ownerContextReference: prepared.slot.slotReference,
    paymentOperationReference: prepared.paymentOperationReference,
  });
  const terminal = {
    ...prepared,
    state: "Released",
    version: 2,
    terminalAt: "2026-09-10T12:00:01.000Z",
  };
  expect(pickupOrderCapacityLinkFromHistory(terminal)).toEqual(link);
});

it("authorizes the saved pending capacity without reusing an expired Quote as fresh evidence", async () => {
  const f = fixture();
  const prepared = (await f.service.prepare(f.input)).record;
  const {
    slot,
    allocationReference,
    guestSessionReference,
    cartReference,
    quoteReference,
    submissionReference,
    orderReference,
    orderBatchReference,
    fulfillmentReference,
    paymentOperationReference,
    cartVersion,
    intentDigest,
  } = prepared;
  const sealed = sealAsapCapacityCommitment(
    prepared,
    {
      allocationReference,
      guestSessionReference,
      cartReference,
      quoteReference,
      submissionReference,
      orderReference,
      orderBatchReference,
      fulfillmentReference,
      paymentOperationReference,
      brandReference: slot.brandReference,
      storeReference: slot.storeReference,
      cartVersion,
      intentDigest,
      acknowledgedAt: at,
    },
    at,
    at,
  );
  f.save(sealed);
  f.source.mockClear();
  f.setTime("2026-09-10T12:06:00.000Z");
  expect((await f.service.authorizePayment(f.input)).record).toEqual(sealed);
  expect(f.source).not.toHaveBeenCalled();
  f.setTime(sealed.capacityExpiresAt as string);
  await expect(f.service.authorizePayment(f.input)).rejects.toThrow();
  expect((await f.service.prepare(f.input)).record).toEqual(sealed);
  f.revoke();
  await expect(f.service.authorizePayment(f.input)).rejects.toThrow();
});
it("rejects Payment authorization without prior capacity and never generates IDs", async () => {
  const f = fixture();
  await expect(f.service.authorizePayment(f.input)).rejects.toThrow();
  expect(f.generate).not.toHaveBeenCalled();
  expect(f.append).not.toHaveBeenCalled();
});
