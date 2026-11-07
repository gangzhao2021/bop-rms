import { describe, expect, it } from "vitest";
import {
  CheckoutSessionServiceError,
  createCheckoutSessionService,
  type CheckoutSessionPorts,
} from "../application/checkout-session-service.js";
import { parseCheckoutSession } from "../domain/checkout-session.js";
import { CheckoutValidationError } from "../domain/checkout-validation.js";
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
  it("WP-2423: tells which item is short (and how many are left) without creating anything", async () => {
    const f = setup();
    const line = { cartItemReference: id(70) as never, available: 1, sharedStock: true };
    const short = createCheckoutSessionService({
      ...f.ports,
      validate: async () => {
        throw new CheckoutValidationError("CHECKOUT_STOCK_SHORT", line);
      },
    });
    const error = await short.create(f.input).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(CheckoutSessionServiceError);
    expect(error).toMatchObject({ code: "ITEM_SHORT", line });
    const unavailable = createCheckoutSessionService({
      ...f.ports,
      validate: async () => {
        throw new CheckoutValidationError("CHECKOUT_ITEM_UNAVAILABLE", {
          ...line,
          available: null,
          sharedStock: false,
        });
      },
    });
    await expect(unavailable.create(f.input)).rejects.toMatchObject({
      code: "ITEM_UNAVAILABLE",
      line: { cartItemReference: id(70), available: null },
    });
    const other = createCheckoutSessionService({
      ...f.ports,
      validate: async () => {
        throw new CheckoutValidationError("CHECKOUT_DEPENDENCY_UNAVAILABLE");
      },
    });
    await expect(other.create(f.input)).rejects.toMatchObject({ code: "DEPENDENCY_UNAVAILABLE" });
    expect(f.counts().writes).toBe(0);
  });
  it.each([
    "CHECKOUT_CART_VERSION_CONFLICT",
    "CHECKOUT_CART_EMPTY",
    "CHECKOUT_CART_NOT_ACTIVE",
    "CHECKOUT_QUOTE_MISSING",
    "CHECKOUT_QUOTE_EXPIRED",
  ] as const)(
    "WP-2423 item 6: a cart or quote that moved on (%s) is a fixed answer, not an outage",
    async (code) => {
      const f = setup();
      const movedOn = createCheckoutSessionService({
        ...f.ports,
        validate: async () => {
          throw new CheckoutValidationError(code);
        },
      });
      await expect(movedOn.create(f.input)).rejects.toMatchObject({ code: "INTENT_CONFLICT" });
      expect(f.counts().writes).toBe(0);
    },
  );
  it("WP-2423: a menu listed since the Quote (CHECKOUT_REQUOTE_REQUIRED) is its own fixed answer, so the guest is priced again", async () => {
    const f = setup();
    const listed = createCheckoutSessionService({
      ...f.ports,
      validate: async () => {
        throw new CheckoutValidationError("CHECKOUT_REQUOTE_REQUIRED");
      },
    });
    await expect(listed.create(f.input)).rejects.toMatchObject({ code: "REQUOTE_REQUIRED" });
    expect(f.counts().writes).toBe(0);
  });
  it("WP-2423 M03: refuses a checkout of dishes already ordered before allocating anything", async () => {
    const f = setup();
    const asked: unknown[] = [];
    let allocated = 0;
    const ordered = createCheckoutSessionService({
      ...f.ports,
      ordered: async (request, authority) => {
        asked.push([request.cartReference, request.cartVersion, authority.guestSessionReference]);
        return { placedOrder: { orderReference: id(70), orderNumber: "13" } };
      },
      repository: {
        ...f.ports.repository,
        allocate: async (proposed) => {
          allocated++;
          return proposed;
        },
      },
    });
    await expect(ordered.create(f.input)).rejects.toMatchObject({
      code: "ALREADY_ORDERED",
      placedOrder: { orderReference: id(70), orderNumber: "13" },
    });
    expect(asked).toEqual([[id(3), 4, id(6)]]);
    expect(allocated).toBe(0);
    expect(f.counts()).toEqual({ writes: 0, validations: 0 });
  });
  it("WP-2423 M03: a Cart that moved on because its dishes were just ordered says so", async () => {
    const f = setup();
    let orderedYet = false;
    const raced = createCheckoutSessionService({
      ...f.ports,
      ordered: async () => (orderedYet ? { placedOrder: null } : null),
      validate: async () => {
        orderedYet = true;
        throw new CheckoutValidationError("CHECKOUT_CART_VERSION_CONFLICT");
      },
    });
    await expect(raced.create(f.input)).rejects.toMatchObject({
      code: "ALREADY_ORDERED",
      placedOrder: null,
    });
    // The store's Cart lock found the version moved on (the other tab's Order won the race).
    let lookups = 0;
    const storeRaced = createCheckoutSessionService({
      ...f.ports,
      ordered: async () => (++lookups === 1 ? null : { placedOrder: null }),
      repository: {
        ...f.ports.repository,
        create: async () => {
          throw new CheckoutSessionServiceError("INTENT_CONFLICT");
        },
      },
    });
    await expect(storeRaced.create(f.input)).rejects.toMatchObject({ code: "ALREADY_ORDERED" });
    expect(lookups).toBe(2);
    expect(f.counts().writes).toBe(0);
    // Nothing ordered: the original answer stands.
    const plain = createCheckoutSessionService({
      ...f.ports,
      ordered: async () => null,
      validate: async () => {
        throw new CheckoutValidationError("CHECKOUT_CART_VERSION_CONFLICT");
      },
    });
    await expect(plain.create(f.input)).rejects.toMatchObject({ code: "INTENT_CONFLICT" });
  });
  it("WP-2423 item 6: knows the refusal when the pilot's entry loaded Ordering as a second copy", async () => {
    const f = setup();
    const copy = createCheckoutSessionService({
      ...f.ports,
      validate: async () => {
        throw Object.assign(new Error("checkout is unavailable"), {
          name: "CheckoutValidationError",
          code: "CHECKOUT_CART_VERSION_CONFLICT",
        });
      },
    });
    await expect(copy.create(f.input)).rejects.toMatchObject({ code: "INTENT_CONFLICT" });
  });
  it("rejects extra client identities before authorization", async () => {
    const f = setup();
    await expect(
      f.service.create({ ...f.input, submissionReference: id(99) }),
    ).rejects.toMatchObject({ code: "INPUT_INVALID" });
    expect(f.counts()).toEqual({ writes: 0, validations: 0 });
  });
});
