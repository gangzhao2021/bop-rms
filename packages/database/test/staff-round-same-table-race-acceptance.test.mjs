import assert from "node:assert/strict";
import nodeConsole from "node:console";
import { performance } from "node:perf_hooks";
import pg from "pg";
import { it, vi } from "vitest";
import { createRuntime } from "../../../tooling/environment/pilot-api.mjs";
import { INTERNAL_CUSTOMER_ORIGIN } from "../../../tooling/environment/pilot-hosting.mjs";
import {
  BrowserSessionService,
  createPostgresBrowserSessionStore,
} from "../../bop/identity/src/index.ts";
import { withIsolatedDatabase } from "../test-support/isolated-database.mjs";
import { prepareRealStaffRoundStore } from "../test-support/real-staff-round-store.mjs";
import { createPilotApiRole } from "../test-support/sole-operator-brand-gate.mjs";

const { Client } = pg;
const id = (n) => "01a0fd20-0000-7000-8000-" + n.toString(16).padStart(12, "0");
const roundPermissions = ["ordering.order.create_staff", "dining.operate", "dining.session.close"];

/**
 * WP-2423 batch 28 (race-payment-and-signout): same-table races at a real Store. Everything runs
 * through the pilot's real compositions (staff round, the customer API's checkout and payment,
 * Session sign-out) under the restricted NOBYPASSRLS API role holding the rendered pilot ACL.
 * Payment runs on the internal test simulator only. Synthetic TEST references only.
 */

/** What the API process logged as unexpected (pilot-unexpected writes JSON lines to stderr). */
function watchUnexpected() {
  const lines = [];
  const spy = vi.spyOn(nodeConsole, "error").mockImplementation((...values) => {
    lines.push(values.map(String).join(" "));
  });
  return { lines, restore: () => spy.mockRestore() };
}

const roundCommand = (store, lines = 1) => ({
  operationReference: store.reference(),
  tableReference: store.tableReference,
  tip: { kind: "None" },
  recordedAfterOutage: false,
  lines: Array.from({ length: lines }, () => ({
    sellableReference: store.soup.skuReference,
    quantity: 1,
    optionSelections: [],
    note: null,
  })),
});
const answerOf = async (work) => {
  try {
    const value = await work();
    return { status: value.status, value };
  } catch (error) {
    return { status: "Refused", code: error?.code ?? String(error) };
  }
};

/** A guest phone joins the table with the code staff issue for it. */
async function joinPhone(store, guests, asStaff) {
  const { tableReference, reference, now } = store;
  const table = await guests.openTable(asStaff, { tableReference });
  assert.equal(table.status, "Opened");
  const entered = await guests.enter({ tableReference, requestedAt: now() });
  assert.equal(entered.status, "Established");
  const joined = await guests.join(entered.credentials, {
    joinCredential: table.joinCredential,
    operationReference: reference(),
  });
  return (
    await guests.bind(entered.credentials, {
      operationReference: reference(),
      admissionReference: joined.admissionReference,
    })
  ).credentials;
}

function signOut(store, who) {
  const persistence = store.persistenceOf(who);
  const service = new BrowserSessionService({
    ...persistence.identity,
    store: createPostgresBrowserSessionStore({
      ...persistence.identity.configuration,
      transactions: persistence.transactions,
      now: persistence.now,
      currentActor: persistence.currentActor,
    }),
    now: persistence.now,
  });
  return service.logout(who.sessionCookie);
}

it("pay-first table: a staff Send refused because a guest is checking out leaves the guest's payment free to start", async () => {
  await withIsolatedDatabase({ caseId: "wp2423_race_payfirst" }, async (context) => {
    const admin = new Client(context.clientConfig);
    await admin.connect();
    vi.stubEnv("NODE_ENV", "development");
    const api = await createPilotApiRole(admin, context, "wp2423_rpf");
    let store = null;
    let runtime = null;
    const unexpected = watchUnexpected();
    try {
      store = await prepareRealStaffRoundStore({ admin, context, api, paymentTiming: "PayFirst" });
      const { soup, reference, now } = store;
      const server = await store.staff(id(0x730), roundPermissions);
      const host = await store.staff(id(0x731), roundPermissions);
      const counter = await store.counterFor(server);
      const staffRound = (includeTableCart = null) =>
        answerOf(() =>
          counter.staffDiningRound({
            sessionCookie: server.sessionCookie,
            csrf: server.csrf,
            command: {
              ...roundCommand(store),
              ...(includeTableCart === null ? {} : { includeTableCart }),
            },
          }),
        );
      const hostCounter = await store.counterFor(host);
      const guests = hostCounter.tableGuestPipeline;
      const details = hostCounter.tableGuestDetails;
      const dependencies = store.customerDependenciesFor(host);
      runtime = await createRuntime(
        { port: 0 },
        {
          ...dependencies,
          createInternalTestResources: async () => store.resources,
          createInternalSimulatedProvider: () =>
            dependencies.createInternalSimulatedProvider({ provision: true }),
          createInternalDiningRoundWithdraw: undefined,
        },
      );
      await runtime.listen();
      const port = runtime.server.address().port;

      // The table is seated by a first staff round (charged on the card machine later), then a
      // guest's phone joins it, adds a soup and presses "Continue to payment".
      const opening = await staffRound();
      assert.equal(opening.status, "Placed", JSON.stringify(opening));
      const phone = await joinPhone(store, guests, {
        sessionCookie: host.sessionCookie,
        csrf: host.csrf,
      });
      const cart = await guests.selectCart(phone, {
        operationReference: reference(),
        requestedAt: now(),
      });
      assert.equal(cart.status, "Selected");
      const added = await guests.addItem(phone, {
        operationReference: reference(),
        cartReference: cart.cartReference,
        expectedCartVersion: cart.cartVersion,
        sellableReference: soup.skuReference,
        quantity: 1,
        optionSelections: [],
        customerNote: null,
        requestedAt: now(),
      });
      assert.equal(added.status, "Applied");
      // Staff see the guest's soup listed under "From the guests' phones" and leave it to send.
      const seen = await guests.selectCart(phone, {
        operationReference: reference(),
        requestedAt: now(),
      });
      assert.equal(seen.pendingItems.length, 1);
      const quoted = await guests.quote(phone, {
        operationReference: reference(),
        cartReference: cart.cartReference,
        cartVersion: added.cartVersion,
        requestedAt: now(),
      });
      assert.equal(quoted.status, "Quoted");
      await details.save({
        ...phone,
        command: {
          operationReference: reference(),
          detailsReference: reference(),
          expectedVersion: 0,
          cartReference: cart.cartReference,
          cartVersion: added.cartVersion,
          quoteReference: quoted.quoteReference,
          quoteVersion: 2,
          pickupContact: null,
          receipt: { choice: "InSession", email: null },
          policies: [],
        },
      });
      const checkout = await guests.startCheckout(phone, {
        createOperationReference: reference(),
        cartReference: cart.cartReference,
        cartVersion: added.cartVersion,
        quoteReference: quoted.quoteReference,
      });
      assert.equal(checkout.status, "Started");

      // Staff press Send at the same moment: told a guest is ordering or paying on their phone.
      const refused = await staffRound({
        expectedCartVersion: seen.cartVersion,
        lines: [{ cartItemReference: seen.pendingItems[0].cartItemReference, decision: "Send" }],
      });
      assert.deepEqual(
        { status: refused.status, code: refused.code },
        { status: "Refused", code: "STAFF_ROUND_TABLE_CHECKOUT_IN_PROGRESS" },
      );

      // The guest's payment starts at once (the page asks for it with one key, and again).
      const key = reference();
      const pay = async () => {
        const response = await globalThis.fetch(
          `http://127.0.0.1:${port}/api/v1/checkout-sessions/${checkout.checkoutSessionReference}/payment-intents`,
          {
            method: "POST",
            headers: {
              cookie: "__Host-bop-guest=" + phone.sessionCredential,
              "x-csrf-token": phone.csrfCredential,
              "idempotency-key": key,
              origin: INTERNAL_CUSTOMER_ORIGIN,
              "sec-fetch-site": "same-origin",
              "content-type": "application/json",
            },
            body: JSON.stringify({ tip: { amountMinor: "0", currency: "CAD" } }),
          },
        );
        const body = await response.json().catch(() => null);
        return {
          status: response.status,
          code: body?.error?.code ?? null,
          creation: body?.payment?.creationStatus ?? null,
          totalMinor: body?.payment?.total?.amountMinor ?? null,
        };
      };
      const started = performance.now();
      const first = await pay();
      assert.ok(
        first.status === 201 || first.status === 202,
        "the guest's payment started: " + JSON.stringify(first) + " " + unexpected.lines,
      );
      const again = await pay();
      assert.ok(
        again.status === 200 || again.status === 201 || again.status === 202,
        "asked again, the same payment: " + JSON.stringify(again),
      );
      assert.ok(performance.now() - started < 10_000, "the payment started without waiting");
      // The soup and its tax, to the cent, as the guest's round (6.50 + 13% = 7.35).
      assert.equal(first.totalMinor, "735");
      assert.deepEqual(
        unexpected.lines.filter((line) => /"level":50|UNAVAILABLE/u.test(line)),
        [],
        "nothing unexpected was logged",
      );
    } finally {
      unexpected.restore();
      vi.unstubAllEnvs();
      await new Promise((resolve) =>
        runtime?.server?.listening ? runtime.server.close(resolve) : resolve(),
      );
      if (store !== null) await store.close();
      for (const name of [api, api + "_w"]) {
        await admin.query("DROP OWNED BY " + name).catch(() => undefined);
        await admin.query("DROP ROLE " + name).catch(() => undefined);
      }
      await admin.end();
    }
  });
});

it("a staff member signs out mid-round: their round ends its own turn and the next staff round at the table goes at once", async () => {
  await withIsolatedDatabase({ caseId: "wp2423_race_signout" }, async (context) => {
    const admin = new Client(context.clientConfig);
    await admin.connect();
    vi.stubEnv("NODE_ENV", "development");
    const api = await createPilotApiRole(admin, context, "wp2423_rso");
    let store = null;
    const unexpected = watchUnexpected();
    try {
      store = await prepareRealStaffRoundStore({ admin, context, api, paymentTiming: "PayLater" });
      const host = await store.staff(id(0x740), roundPermissions);
      const leaving = await store.staff(id(0x741), roundPermissions);
      const next = await store.staff(id(0x742), roundPermissions);
      const round = (counter, who) =>
        answerOf(() =>
          counter.staffDiningRound({
            sessionCookie: who.sessionCookie,
            csrf: who.csrf,
            command: roundCommand(store),
          }),
        );
      assert.equal((await round(await store.counterFor(host), host)).status, "Placed");
      // The leaving member's round: they sign out in another tab while it is joining the table.
      const signedOutCounter = await store.counterFor(leaving, {
        decorateStaffRoundPipeline: (real) => ({
          ...real,
          join: async (...values) => {
            await signOut(store, leaving);
            return real.join(...values);
          },
        }),
      });
      const refused = await round(signedOutCounter, leaving);
      assert.deepEqual(refused, { status: "Refused", code: "STAFF_ROUND_PERMISSION_DENIED" });
      // Its turn ended with it: nothing was sent.
      const turns = (
        await admin.query(
          `SELECT t.actor_id::text AS actor, e.outcome FROM rms_ordering.staff_dining_round_table_turn t
           LEFT JOIN rms_ordering.staff_dining_round_table_turn_end e ON e.turn_id=t.turn_id
           WHERE t.actor_id=$1`,
          [id(0x741)],
        )
      ).rows;
      assert.deepEqual(turns, [{ actor: id(0x741), outcome: "NotSent" }]);
      // Another staff member's round at the same table goes at once (it waited ten seconds and was
      // told another staff member was sending a round, for two minutes).
      const started = performance.now();
      const placed = await round(await store.counterFor(next), next);
      const ms = performance.now() - started;
      assert.equal(placed.status, "Placed", JSON.stringify(placed));
      assert.ok(ms < 5_000, `the next round went at once (${Math.round(ms)} ms)`);
      assert.deepEqual(
        unexpected.lines.filter((line) => /"level":50/u.test(line)),
        [],
        "the sign-out is not logged as an unexpected failure",
      );
    } finally {
      unexpected.restore();
      vi.unstubAllEnvs();
      if (store !== null) await store.close();
      for (const name of [api, api + "_w"]) {
        await admin.query("DROP OWNED BY " + name).catch(() => undefined);
        await admin.query("DROP ROLE " + name).catch(() => undefined);
      }
      await admin.end();
    }
  });
});
