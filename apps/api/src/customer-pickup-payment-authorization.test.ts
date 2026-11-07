import { expect, it } from "vitest";
import { createGuestSessionRecord } from "@bop/identity";
import {
  createOrderNumberAllocation,
  parseOrderCreationRecord,
  parseOrderCapacityLink,
} from "@rms/ordering";
import { parsePaymentInstant } from "@rms/payment";
import {
  fixture as diningFixture,
  at,
  id,
} from "../test-support/dining-order-submission-fixture.js";
import {
  orderWriteFixture,
  orderCapacityLinkFixture,
} from "../../../packages/rms/ordering/src/tests/order-creation-store.fixture.js";
import {
  createCustomerPickupPaymentAuthorization,
  type CustomerPickupPaymentAuthorizationOptions,
} from "./customer-pickup-payment-authorization.js";

function fixture() {
  const f = orderWriteFixture({ at });
  const identity = diningFixture();
  let guest = createGuestSessionRecord({
    ...identity.identityRecord,
    session: {
      ...identity.identityRecord.session,
      ...f.scope,
      sessionReference: f.request.record.guestSessionReference,
      channel: "Pickup",
      diningState: "ContextOnly",
      publicTableReference: null,
      diningSessionReference: null,
      diningParticipantReference: null,
    },
  });
  const record = parseOrderCreationRecord({
    ...f.request.record,
    orderNumberAllocation: createOrderNumberAllocation({
      orderReference: f.request.record.order.orderReference,
      allocatedAt: f.request.record.createdAt,
      sequence: 1n,
      businessDateResolution: f.request.businessDateResolution,
    }),
  });
  const link = orderCapacityLinkFixture(f);
  let available = true,
    now = at,
    reads = 0;
  const options: CustomerPickupPaymentAuthorizationOptions = {
    preparation: {
      scope: f.scope,
      now: () => now,
      session: {
        ...identity.options.session,
        store: {
          ...identity.options.session.store,
          resolve: async (selector) =>
            available && selector === guest.sessionSelectorHash ? guest : null,
        },
      },
    },
    ordering: {
      resolveSubmission: async () => {
        reads++;
        return record;
      },
      resolveCapacityLink: async () => link,
    },
  };
  const credentials = {
    sessionCredential: identity.input.sessionCredential,
    csrfCredential: identity.input.csrfCredential,
  };
  const request = {
    action: "CreatePaymentIntent" as const,
    submissionReference: String(link.submissionReference),
    paymentOperationReference: String(link.paymentOperationReference),
    observedAt: parsePaymentInstant(at),
  };
  return {
    options,
    credentials,
    request,
    record,
    link,
    reads: () => reads,
    port: () => createCustomerPickupPaymentAuthorization(options, credentials),
    revoke: () => {
      available = false;
    },
    advance: () => {
      now = "2026-09-10T12:06:00.000Z";
    },
    changeIdentity: () => {
      guest = createGuestSessionRecord({
        ...guest,
        session: { ...guest.session, version: guest.session.version + 1 },
      });
    },
  };
}
it("binds actual Pickup Identity and original Fulfillment-owned Order operation", async () => {
  const f = fixture();
  expect(await f.port().authorize(f.request)).toEqual({
    action: "CreatePaymentIntent",
    guestSessionReference: String(f.record.guestSessionReference),
    brandReference: String(f.record.order.brandReference),
    storeReference: String(f.record.order.storeReference),
  });
});
it("denies CSRF mismatch before original history reads", async () => {
  const f = fixture();
  const port = createCustomerPickupPaymentAuthorization(f.options, {
    ...f.credentials,
    csrfCredential: "x".repeat(43),
  });
  expect(await port.authorize(f.request)).toBeNull();
  expect(f.reads()).toBe(0);
});
it("denies wrong original operation, Guest, Store and capacity owner", async () => {
  const f = fixture();
  expect(await f.port().authorize({ ...f.request, paymentOperationReference: id(999) })).toBeNull();
  for (const change of [
    { guestSessionReference: id(999) },
    { storeReference: id(999) },
    { owner: "Dining" },
  ]) {
    f.options.ordering.resolveCapacityLink = async () =>
      parseOrderCapacityLink({ ...f.link, ...change });
    expect(await f.port().authorize(f.request)).toBeNull();
  }
});
it("denies persisted identity loss during original history read", async () => {
  const f = fixture();
  f.options.ordering.resolveCapacityLink = async () => {
    f.revoke();
    return f.link;
  };
  expect(await f.port().authorize(f.request)).toBeNull();
});
it("pins complete identity and original operation across authorization calls", async () => {
  const f = fixture(),
    port = f.port();
  expect(await port.authorize(f.request)).not.toBeNull();
  expect(await port.authorize({ ...f.request, submissionReference: id(999) })).toBeNull();
  f.changeIdentity();
  expect(await port.authorize(f.request)).toBeNull();
});
it("preserves historical access after preparation expiry without granting fresh capacity", async () => {
  const f = fixture();
  f.advance();
  expect(
    await f
      .port()
      .authorize({ ...f.request, observedAt: parsePaymentInstant("2026-09-10T12:06:00.000Z") }),
  ).not.toBeNull();
  f.revoke();
  expect(await f.port().authorize(f.request)).toBeNull();
});
