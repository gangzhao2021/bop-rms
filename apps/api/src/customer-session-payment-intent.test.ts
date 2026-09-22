import { expect, it, vi } from "vitest";
import { createPaymentIntentCreationService } from "@rms/payment";
import { parseCheckoutSession } from "@rms/ordering";
import { createCustomerSessionPaymentIntent } from "./customer-session-payment-intent.js";
import type { CustomerCheckoutSessionAuthorizationOptions } from "./customer-checkout-session-authorization.js";
import {
  at,
  id,
  refs,
  harness,
  command,
  preparation,
} from "../../../packages/rms/payment/src/tests/payment-intent-creation.fixture.js";

const mocks = vi.hoisted(() => ({ read: vi.fn(), build: vi.fn() }));
vi.mock("./customer-checkout-session-read.js", () => ({
  createCustomerCheckoutSessionRead: () => ({ read: mocks.read }),
}));
vi.mock("./customer-payment-preparation-snapshot.js", () => ({
  buildCustomerPaymentPreparationSnapshot: mocks.build,
}));
async function fixture(denied = false) {
  const original = await createPaymentIntentCreationService(
    harness({ prepared: preparation({ committedAt: at }) }).ports,
  ).create(command({ tipSelectionReference: id(30) }));
  const h = harness({ prior: original.record, denied, clockNow: "2026-08-03T17:00:00.000Z" });
  const binding = {
    brandReference: refs.brand,
    storeReference: refs.store,
    cartReference: refs.cart,
    cartVersion: 3,
    quoteReference: refs.quote,
    orderType: "Pickup",
    sourceChannel: "Qr",
  };
  const session = parseCheckoutSession({
    schemaVersion: 1,
    checkoutSessionReference: id(31),
    createOperationReference: id(32),
    submissionReference: refs.submission,
    paymentOperationReference: refs.operation,
    createdAt: at,
    validation: {
      ...binding,
      validationReference: id(33),
      validationIntentHash: "sha256:" + "a".repeat(64),
      guestSessionReference: refs.session,
      quoteVersion: 1,
      quoteInputDigest: "sha256:" + "b".repeat(64),
      catalogLines: [
        {
          cartItemReference: id(34),
          sellableReference: id(35),
          menuVersionReference: id(36),
          productVersionReference: id(37),
          validatedAt: at,
        },
      ],
      fulfillment: {
        ...binding,
        status: "Accepted",
        evidenceReference: refs.capacity,
        evidenceVersion: 1,
        evidenceDigest: "sha256:" + "c".repeat(64),
        checkedAt: at,
        validUntil: "2026-08-03T15:05:00.000Z",
      },
      validatedAt: at,
      validUntil: "2026-08-03T15:05:00.000Z",
    },
  });
  mocks.read.mockReset().mockResolvedValue(session);
  const unused = vi.fn(async () => {
    throw new Error("recovery must not prepare");
  });
  const input = {
    sessionCredential: "s".repeat(43),
    csrfCredential: "c".repeat(43),
    checkoutSessionReference: id(31),
    selectionReference: id(30),
    tip: { amountMinor: 200n, currencyCode: "CAD" },
  };
  const history = { resolveOperation: vi.fn(async () => original.record) };
  const service = createCustomerSessionPaymentIntent({
    // Current session authorization is the mocked boundary in these orchestration tests.
    access: {} as CustomerCheckoutSessionAuthorizationOptions,
    tenantReference: id(40),
    resolveSubmission: unused,
    orders: { create: unused, preparePaymentClock: unused },
    tips: { select: unused },
    inventory: { load: unused },
    nextPreparationReference: () => {
      throw new Error("unused");
    },
    history,
    payment: () => h.ports,
  });
  return { service, input, unused, h, original, history, session };
}
it("recovers after original preparation expiry using actual Payment service without preparing or calling Provider", async () => {
  const f = await fixture();
  const result = await f.service.create(f.input);
  expect(result.status).toBe("AlreadyCreated");
  expect(result.record).toEqual(f.original.record);
  expect(f.unused).not.toHaveBeenCalled();
  expect(f.h.providerCalls()).toBe(0);
  expect(f.h.calls).not.toContain("prepare");
  expect(mocks.read).toHaveBeenCalledTimes(2);
});
it("requires current Payment authorization on recovery", async () => {
  const f = await fixture(true);
  await expect(f.service.create(f.input)).rejects.toMatchObject({
    code: "PAYMENT_INTENT_PERMISSION_DENIED",
  });
  expect(f.unused).not.toHaveBeenCalled();
  expect(f.h.providerCalls()).toBe(0);
});
it("rejects changed tip or selection intent without Provider effects", async () => {
  const f = await fixture();
  await expect(
    f.service.create({ ...f.input, tip: { amountMinor: 201n, currencyCode: "CAD" } }),
  ).rejects.toMatchObject({ code: "INTENT_CONFLICT" });
  await expect(f.service.create({ ...f.input, selectionReference: id(41) })).rejects.toMatchObject({
    code: "PAYMENT_INTENT_IDEMPOTENCY_CONFLICT",
  });
  expect(f.unused).not.toHaveBeenCalled();
  expect(f.h.providerCalls()).toBe(0);
});
it("rejects client internal IDs before any owner reads", async () => {
  const f = await fixture();
  await expect(
    f.service.create({ ...f.input, paymentOperationReference: id(42) }),
  ).rejects.toMatchObject({ code: "INPUT_INVALID" });
  expect(mocks.read).not.toHaveBeenCalled();
  expect(f.history.resolveOperation).not.toHaveBeenCalled();
});
it("does not create a replacement when the original disappears between reads", async () => {
  const f = await fixture();
  f.h.ports.repository.resolveOperation = async () => null;
  await expect(f.service.create(f.input)).rejects.toBeDefined();
  expect(f.unused).not.toHaveBeenCalled();
  expect(f.h.providerCalls()).toBe(0);
});

it.each([
  [false, "FixedAdditional"],
  [true, "FixedAdditional"],
  [false, "Additional"],
  [true, "Additional"],
  [false, "Initial"],
  [true, "Initial"],
] as const)(
  "preserves payment submission ordering (missing=%s, mode=%s)",
  async (missing, mode) => {
    const f = await fixture();
    const session = parseCheckoutSession({
      ...f.session,
      validation: {
        ...f.session.validation,
        orderType: mode === "Initial" ? "Pickup" : "DineIn",
        fulfillment: {
          ...f.session.validation.fulfillment,
          orderType: mode === "Initial" ? "Pickup" : "DineIn",
        },
      },
    });
    mocks.read.mockResolvedValue(session);
    const events: string[] = [];
    const h = harness({ prepared: preparation({ committedAt: at }) });
    const evidence = preparation({ committedAt: at });
    mocks.build.mockReset().mockReturnValue(evidence);
    const options = {
      access: {
        scope: { brandReference: refs.brand, storeReference: refs.store },
      } as CustomerCheckoutSessionAuthorizationOptions,
      tenantReference: id(40),
      orders: {
        create: async (input: unknown) => {
          events.push("submit");
          if (mode === "Initial") expect(input).not.toHaveProperty("tipSelectionReference");
          else expect(input).toMatchObject({ tipSelectionReference: f.input.selectionReference });
          return { status: "Created", record: {}, session };
        },
        preparePaymentClock: async () => {
          events.push("clock");
          return { order: {}, clock: {}, session };
        },
      },
      tips: {
        select: async () => {
          events.push("tip");
          return {
            status: "Created",
            session,
            record: missing
              ? null
              : {
                  selectionReference: f.input.selectionReference,
                  paymentOperationReference: refs.operation,
                  submissionReference: refs.submission,
                  cartReference: refs.cart,
                  cartVersion: 3,
                  quoteReference: refs.quote,
                  guestSessionReference: refs.session,
                  brandReference: refs.brand,
                  storeReference: refs.store,
                  tip: f.input.tip,
                  selectedAt: at,
                },
          };
        },
      },
      inventory: { load: async () => ({}) },
      history: { resolveOperation: async () => null },
      nextPreparationReference: () => refs.preparation,
      payment: () => h.ports,
    };
    const resolveSubmission = vi.fn(async (resolved: typeof session) => {
      expect(resolved).toEqual(session);
      return {
        kind: mode === "Initial" ? ("Initial" as const) : ("Additional" as const),
        orders: options.orders,
        tips: options.tips,
      };
    });
    const service = createCustomerSessionPaymentIntent({
      ...options,
      ...(mode === "FixedAdditional"
        ? { submissionKind: "Additional" as const }
        : { resolveSubmission }),
    });
    if (missing) {
      await expect(service.create(f.input)).rejects.toThrow();
      expect(events).toEqual(mode === "Initial" ? ["submit", "tip"] : ["tip"]);
      expect(h.providerCalls()).toBe(0);
    } else {
      expect((await service.create(f.input)).status).toBe("Created");
      expect(events).toEqual(
        mode === "Initial" ? ["submit", "tip", "clock"] : ["tip", "submit", "clock"],
      );
      expect(mocks.build.mock.calls[0]?.[0]).toMatchObject({
        ...(mode === "Initial" ? {} : { submissionKind: "Additional" }),
        owner: mode === "Initial" ? "AsapPickup" : "Dining",
      });
    }
    expect(resolveSubmission).toHaveBeenCalledTimes(mode === "FixedAdditional" ? 0 : 1);
  },
);

it("rejects an Additional resolver result for Pickup before owner mutations", async () => {
  const f = await fixture();
  const options = {
    access: {} as CustomerCheckoutSessionAuthorizationOptions,
    tenantReference: id(40),
    orders: { create: f.unused, preparePaymentClock: f.unused },
    tips: { select: f.unused },
    inventory: { load: f.unused },
    history: { resolveOperation: async () => null },
    nextPreparationReference: () => refs.preparation,
    payment: () => f.h.ports,
  };
  const resolveSubmission = async () => ({
    kind: "Additional" as const,
    orders: options.orders,
    tips: options.tips,
  });
  const service = createCustomerSessionPaymentIntent({ ...options, resolveSubmission });
  await expect(service.create(f.input)).rejects.toMatchObject({ code: "INTENT_CONFLICT" });
  expect(f.unused).not.toHaveBeenCalled();
  expect(() =>
    createCustomerSessionPaymentIntent({
      ...options,
      resolveSubmission,
      submissionKind: "Additional",
    }),
  ).toThrow();
});
