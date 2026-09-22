import { expect, it } from "vitest";
import { createGuestSessionRecord } from "@bop/identity";
import type { CartQueryTransaction } from "@rms/ordering";
import {
  fixture as identityFixture,
  at,
  id,
} from "../test-support/dining-order-submission-fixture.js";
import { orderWriteFixture } from "../../../packages/rms/ordering/src/tests/order-creation-store.fixture.js";
import { createCustomerCheckoutSessionRead } from "./customer-checkout-session-read.js";

function fixture() {
  const f = orderWriteFixture({ at }),
    identity = identityFixture();
  let guest = createGuestSessionRecord({
    ...identity.identityRecord,
    session: {
      ...identity.identityRecord.session,
      ...f.scope,
      sessionReference: f.cart.createdByActorReference,
      channel: "Pickup",
      diningState: "ContextOnly",
      publicTableReference: null,
      diningSessionReference: null,
      diningParticipantReference: null,
    },
  });
  let available = true,
    binding = true,
    clock = at,
    transactions = 0;
  let afterRead: () => void = () => undefined;
  let missing = false,
    foreignCart = false;
  const v = f.request.checkoutValidationEvidence;
  const session = {
    schemaVersion: 1,
    checkoutSessionReference: id(210),
    createOperationReference: id(211),
    submissionReference: id(212),
    paymentOperationReference: id(213),
    createdAt: v.validatedAt,
    validation: v,
  };
  const tx: CartQueryTransaction = {
    async query(sql, values) {
      if (sql.includes("set_config")) return { rows: [] };
      if (sql.includes("FROM rms_ordering.cart c"))
        return { rows: foreignCart ? [] : [{ cart: f.cart }] };
      if (sql.includes("clock_timestamp")) return { rows: [{ observed_at: clock }] };
      if (sql.includes("FROM rms_ordering.checkout_session_record")) {
        expect(values).toEqual([
          f.scope.brandReference,
          f.scope.storeReference,
          id(210),
          guest.session.sessionReference,
        ]);
        afterRead();
        return { rows: missing ? [] : [{ snapshot_json: session }] };
      }
      if (sql.includes("session_selector_hash")) {
        return {
          rows: available && values[2] === guest.sessionSelectorHash ? [{ record: guest }] : [],
        };
      }
      throw new Error("unexpected synthetic query");
    },
  };
  const options = {
    scope: f.scope,
    transactions: {
      async run<T>(work: (tx: CartQueryTransaction) => Promise<T>) {
        transactions++;
        return work(tx);
      },
    },
    credentials: identity.credentials,
    binding: (actual: CartQueryTransaction) => ({
      async validate() {
        expect(actual).toBe(tx);
        return binding ? ("Current" as const) : ("Unavailable" as const);
      },
    }),
    now: () => clock,
  };
  const credentials = {
    sessionCredential: identity.input.sessionCredential,
    csrfCredential: identity.input.csrfCredential,
    cartReference: String(f.cart.cartReference),
  };
  const input = {
    sessionCredential: credentials.sessionCredential,
    csrfCredential: credentials.csrfCredential,
    checkoutSessionReference: id(210),
  };
  const port = createCustomerCheckoutSessionRead(options);
  return {
    port,
    session,
    afterRead: (callback: () => void) => {
      afterRead = callback;
    },
    missing: () => {
      missing = true;
    },
    foreignCart: () => {
      foreignCart = true;
    },
    input,
    tx,
    options,
    credentials,
    transactions: () => transactions,
    deny: () => {
      available = false;
    },
    stale: () => {
      binding = false;
    },
    rewind: () => {
      clock = "2026-09-10T11:59:00.000Z";
    },
    change: () => {
      guest = createGuestSessionRecord({
        ...guest,
        session: { ...guest.session, version: guest.session.version + 1 },
      });
    },
  };
}
it("reads owner history with actual credential verification on one transaction without renewing validation", async () => {
  const f = fixture();
  expect(await f.port.read(f.input)).toEqual(f.session);
  expect(f.transactions()).toBe(1);
});
it.each(["deny", "stale", "change", "rewind", "foreignCart"] as const)(
  "rejects %s occurring after owner lookup",
  async (mode) => {
    const f = fixture();
    f.afterRead(f[mode]);
    await expect(f.port.read(f.input)).rejects.toMatchObject({ code: "PERMISSION_DENIED" });
  },
);
it("does not reveal absent sessions", async () => {
  const f = fixture();
  f.missing();
  await expect(f.port.read(f.input)).rejects.toMatchObject({ code: "PERMISSION_DENIED" });
});
it("rejects incorrect CSRF and client-provided scope", async () => {
  const f = fixture();
  await expect(
    f.port.read({ ...f.input, csrfCredential: f.options.credentials.generateCredential("Csrf") }),
  ).rejects.toMatchObject({ code: "PERMISSION_DENIED" });
  await expect(f.port.read({ ...f.input, storeReference: id(999) })).rejects.toMatchObject({
    code: "INPUT_INVALID",
  });
});
