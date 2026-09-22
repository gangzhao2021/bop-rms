import { expect, it, vi } from "vitest";
import { createPaymentIntentCreationService } from "@rms/payment";
import { parseCheckoutSession } from "@rms/ordering";
import { createCustomerSessionPaymentHandoff } from "./customer-session-payment-handoff.js";
import type { CustomerCheckoutSessionAuthorizationOptions } from "./customer-checkout-session-authorization.js";
import {
  at,
  id,
  refs,
  harness,
  command,
  preparation,
} from "../../../packages/rms/payment/src/tests/payment-intent-creation.fixture.js";
const mocks = vi.hoisted(() => ({ read: vi.fn() }));
vi.mock("./customer-checkout-session-read.js", () => ({
  createCustomerCheckoutSessionRead: () => ({ read: mocks.read }),
}));
async function fixture() {
  const original = await createPaymentIntentCreationService(
    harness({ prepared: preparation({ committedAt: at }) }).ports,
  ).create(command({ tipSelectionReference: id(30) }));
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

  let now = at;
  const history = { resolveOperation: vi.fn(async () => original.record) };
  const admit = vi.fn(async (): Promise<boolean | { validUntil: string }> => true);
  const allowConfirmation = vi.fn(async () => true);
  const provider = {
    retrieve: vi.fn(async () => {
      const snapshot = original.record.providerOutcome;
      if (snapshot?.kind !== "Snapshot") throw new Error("fixture invalid");
      return { snapshot, clientSecret: snapshot.providerIntentReference + "_secret_SYNTHETICONLY" };
    }),
  };
  const service = createCustomerSessionPaymentHandoff({
    access: { now: () => now } as CustomerCheckoutSessionAuthorizationOptions,
    history,
    transactions: {
      run: async (work) =>
        work({
          query: async () => {
            throw new Error("unexpected query");
          },
        }),
    },
    currentAdmission: () => ({ admit }),
    allowConfirmation,
    provider,
  });
  const input = {
    sessionCredential: "s".repeat(43),
    csrfCredential: "c".repeat(43),
    checkoutSessionReference: session.checkoutSessionReference,
  };
  return {
    service,
    input,
    history,
    admit,
    allowConfirmation,
    provider,
    session,
    setTime(value: string) {
      now = value;
    },
  };
}
it("binds current session and owner history before and after Provider access", async () => {
  const f = await fixture();
  expect(Object.keys(await f.service.retrieve(f.input))).toEqual(["clientSecret"]);
  expect(f.admit).toHaveBeenCalledTimes(2);
  expect(f.allowConfirmation).toHaveBeenCalledTimes(2);
  expect(f.provider.retrieve).toHaveBeenCalledTimes(1);
});
it.each(["admission", "policy"] as const)(
  "withholds credentials when %s denies",
  async (source) => {
    const f = await fixture();
    if (source === "admission") f.admit.mockResolvedValue(false);
    else f.allowConfirmation.mockResolvedValue(false);
    await expect(f.service.retrieve(f.input)).rejects.toMatchObject({ code: "NOT_READY" });
    expect(f.provider.retrieve).not.toHaveBeenCalled();
  },
);
it("rejects Payment history bound to another session Store", async () => {
  const f = await fixture();
  const other = {
    ...f.session,
    validation: {
      ...f.session.validation,
      storeReference: id(90),
      fulfillment: { ...f.session.validation.fulfillment, storeReference: id(90) },
    },
  };
  mocks.read.mockResolvedValue(other);
  await expect(f.service.retrieve(f.input)).rejects.toMatchObject({ code: "NOT_READY" });
  expect(f.provider.retrieve).not.toHaveBeenCalled();
});
it("withholds credential if session access is revoked during Provider retrieval", async () => {
  const f = await fixture();
  const result = await f.provider.retrieve();
  f.provider.retrieve.mockImplementation(async () => {
    mocks.read.mockRejectedValue(new Error("revoked"));
    return result;
  });
  await expect(f.service.retrieve(f.input)).rejects.toMatchObject({ code: "UNAVAILABLE" });
});
it("rechecks earlier Inventory deadline after an asynchronous policy lookup", async () => {
  const f = await fixture();
  const deadline = "2026-08-03T15:00:01.000Z";
  f.admit.mockResolvedValue({ validUntil: deadline });
  f.allowConfirmation.mockImplementation(async () => {
    f.setTime(deadline);
    return true;
  });
  await expect(f.service.retrieve(f.input)).rejects.toMatchObject({ code: "NOT_READY" });
  expect(f.provider.retrieve).not.toHaveBeenCalled();
});
