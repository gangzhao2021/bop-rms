import { expect, it } from "vitest";
import { createGuestSessionRecord } from "@bop/identity";
import type { CartQueryTransaction } from "@rms/ordering";
import {
  fixture as identityFixture,
  at,
  id,
} from "../test-support/dining-order-submission-fixture.js";
import { orderWriteFixture } from "../../../packages/rms/ordering/src/tests/order-creation-store.fixture.js";
import { createCustomerCheckoutSessionAuthorization } from "./customer-checkout-session-authorization.js";

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
  const tx: CartQueryTransaction = {
    async query(sql, values) {
      if (sql.includes("set_config")) return { rows: [] };
      if (sql.includes("FROM rms_ordering.cart c")) return { rows: [{ cart: f.cart }] };
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
    createOperationReference: id(200),
    cartReference: String(f.cart.cartReference),
    cartVersion: f.cart.aggregateVersion,
    quoteReference: id(201),
    quoteVersion: 1 as const,
  };
  const port = createCustomerCheckoutSessionAuthorization(options, credentials);
  return {
    port,
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
it("uses actual Identity credential verification and owner readers on the supplied transaction", async () => {
  const f = fixture(),
    authority = await f.port.authorize(f.input, at);
  expect(authority).not.toBeNull();
  if (authority === null) throw new Error("expected synthetic authority");
  expect(authority).not.toHaveProperty("sessionCredential");
  expect(authority).not.toHaveProperty("csrfCredential");
  const count = f.transactions();
  expect(await f.port.authorizeInTransaction(f.tx, authority, at)).toBe(true);
  expect(f.transactions()).toBe(count);
});
it("rejects incorrect CSRF with the actual credential provider", async () => {
  const f = fixture();
  const port = createCustomerCheckoutSessionAuthorization(f.options, {
    ...f.credentials,
    csrfCredential: f.options.credentials.generateCredential("Csrf"),
  });
  expect(await port.authorize(f.input, at)).toBeNull();
});
it.each(["deny", "stale", "change", "rewind"] as const)(
  "rejects %s after initial authorization",
  async (mode) => {
    const f = fixture(),
      authority = await f.port.authorize(f.input, at);
    expect(authority).not.toBeNull();
    if (authority === null) throw new Error("expected synthetic authority");
    f[mode]();
    expect(await f.port.authorizeInTransaction(f.tx, authority, at)).toBe(false);
  },
);
it("rejects a different Cart before opening a transaction", async () => {
  const f = fixture();
  expect(await f.port.authorize({ ...f.input, cartReference: id(999) }, at)).toBeNull();
  expect(f.transactions()).toBe(0);
});
