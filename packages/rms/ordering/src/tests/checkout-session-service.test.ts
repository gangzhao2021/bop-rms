import { describe, expect, it } from "vitest";
import {
  createCheckoutSessionService,
  type CheckoutSessionPorts,
} from "../application/checkout-session-service.js";
import { parseCheckoutSession } from "../domain/checkout-session.js";
const id = (n: number) => `018f5400-0000-7000-8000-${n.toString(16).padStart(12, "0")}`;
const at = "2026-08-02T15:00:00.000Z";
const until = "2026-08-02T15:05:00.000Z";
const hash = `sha256:${"a".repeat(64)}`;
function fixture(quoteVersion = 1) {
  const binding = {
    brandReference: id(1),
    storeReference: id(2),
    cartReference: id(3),
    cartVersion: 4,
    quoteReference: id(4),
    orderType: "Pickup",
    sourceChannel: "Qr",
  };
  return {
    schemaVersion: 1,
    checkoutSessionReference: id(10),
    createOperationReference: id(11),
    submissionReference: id(12),
    paymentOperationReference: id(13),
    createdAt: at,
    validation: {
      ...binding,
      validationReference: id(5),
      validationIntentHash: hash,
      guestSessionReference: id(6),
      quoteVersion,
      quoteInputDigest: hash,
      catalogLines: [
        {
          cartItemReference: id(7),
          sellableReference: id(8),
          menuVersionReference: id(9),
          productVersionReference: id(14),
          validatedAt: at,
        },
      ],
      fulfillment: {
        ...binding,
        status: "Accepted",
        evidenceReference: id(15),
        evidenceVersion: 1,
        evidenceDigest: hash,
        checkedAt: at,
        validUntil: until,
      },
      validatedAt: at,
      validUntil: until,
    },
  };
}

function setup() {
  const input = {
    createOperationReference: id(11),
    cartReference: id(3),
    cartVersion: 4,
    quoteReference: id(4),
    quoteVersion: 1 as const,
  };
  let clock = at,
    next = 20,
    writes = 0,
    validations = 0,
    authCalls = 0;
  let existing: unknown | null = null;
  let denyAt = 0,
    changeAt = 0,
    winner: unknown | null = null;
  const ports: CheckoutSessionPorts = {
    now: () => clock,
    nextReference: () => id(next++),
    authorize: async (_input, observedAt) => {
      authCalls++;
      if (authCalls === denyAt) return null;
      return {
        guestSessionReference: id(authCalls === changeAt ? 90 : 6),
        brandReference: id(1),
        storeReference: id(2),
        checkedAt: observedAt,
        validUntil: "2026-08-03T00:00:00.000Z",
        audit: { synthetic: true },
      };
    },
    validate: async () => {
      validations++;
      return fixture().validation;
    },
    repository: {
      resolveOperation: async () => existing,
      allocate: async (proposed) => {
        if (winner === null) return proposed;
        const original = parseCheckoutSession(winner);
        return {
          ...proposed,
          checkoutSessionReference: original.checkoutSessionReference,
          submissionReference: original.submissionReference,
          paymentOperationReference: original.paymentOperationReference,
        };
      },
      create: async (session) => {
        writes++;
        existing = winner ?? session;
        return { status: winner ? "AlreadyCreated" : "Created", session: existing };
      },
    },
  };
  return {
    input,
    ports,
    service: createCheckoutSessionService(ports),
    counts: () => ({ writes, validations }),
    advance: (value: string) => {
      clock = value;
    },
    deny: (value: number) => {
      denyAt = value;
    },
    change: (value: number) => {
      changeAt = value;
    },
    seed: (value: unknown) => {
      existing = value;
    },
    race: (value: unknown) => {
      winner = value;
    },
  };
}
describe("Checkout Session creation", () => {
  it("creates server identities and recovers original history after validation expires", async () => {
    const f = setup();
    const created = await f.service.create(f.input);
    expect(created.status).toBe("Created");
    expect(created.session.checkoutSessionReference).toBe(id(20));
    f.advance("2026-08-02T16:00:00.000Z");
    const recovered = await f.service.create(f.input);
    expect(recovered).toEqual({ status: "AlreadyCreated", session: created.session });
    expect(f.counts()).toEqual({ writes: 1, validations: 1 });
  });
  it("returns concurrent winner identities", async () => {
    const f = setup(),
      winner = parseCheckoutSession(fixture());
    f.race(winner);
    expect(await f.service.create(f.input)).toEqual({ status: "AlreadyCreated", session: winner });
  });
  it("rejects changed intent on replay", async () => {
    const f = setup();
    f.seed(fixture());
    await expect(f.service.create({ ...f.input, cartVersion: 5 })).rejects.toMatchObject({
      code: "INTENT_CONFLICT",
    });
    expect(f.counts()).toEqual({ writes: 0, validations: 0 });
  });
  it.each([1, 2])("denies authorization loss before save (%s)", async (call) => {
    const f = setup();
    f.deny(call);
    await expect(f.service.create(f.input)).rejects.toMatchObject({ code: "PERMISSION_DENIED" });
    expect(f.counts().writes).toBe(0);
  });
  it("does not return history to a changed actor", async () => {
    const f = setup();
    f.seed(fixture());
    f.change(2);
    await expect(f.service.create(f.input)).rejects.toMatchObject({ code: "PERMISSION_DENIED" });
  });
  it("retains committed history when response authorization is revoked", async () => {
    const f = setup();
    f.deny(3);
    await expect(f.service.create(f.input)).rejects.toMatchObject({ code: "PERMISSION_DENIED" });
    expect((await f.service.create(f.input)).status).toBe("AlreadyCreated");
    expect(f.counts().writes).toBe(1);
  });
  it("does not save expired validation", async () => {
    const f = setup();
    f.advance(until);
    await expect(f.service.create(f.input)).rejects.toMatchObject({
      code: "DEPENDENCY_UNAVAILABLE",
    });
    expect(f.counts().writes).toBe(0);
  });
  it("rejects extra client identities before authorization", async () => {
    const f = setup();
    await expect(
      f.service.create({ ...f.input, submissionReference: id(99) }),
    ).rejects.toMatchObject({ code: "INPUT_INVALID" });
    expect(f.counts()).toEqual({ writes: 0, validations: 0 });
  });
});
