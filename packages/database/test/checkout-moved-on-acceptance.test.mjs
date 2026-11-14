import assert from "node:assert/strict";
import pg from "pg";
import { it, vi } from "vitest";
import { withIsolatedDatabase } from "../test-support/isolated-database.mjs";
import { prepareRealStaffRoundStore } from "../test-support/real-staff-round-store.mjs";
import { createPilotApiRole } from "../test-support/sole-operator-brand-gate.mjs";

const { Client } = pg;
const id = (n) => "01a7ef00-0000-7000-8000-" + n.toString(16).padStart(12, "0");

/**
 * WP-2423 item 6: two guests share a table's Cart, and the one-tap order runs quote, details and
 * checkout as separate requests. When another guest's add lands between them, opening the checkout
 * can never succeed as asked. It used to answer 503 with Retry-After: a guest waited 45 seconds and
 * was told the order might have been placed, for ever. It answers a conflict now. Another guest's
 * Quote of the same cart version while its price is held answers the held Quote (Owner #26,
 * DEC-PRICE-HOLD), so it no longer moves the checkout on.
 *
 * The pilot's own composition (tooling/environment: table QR entry, join, binding, the table's Cart,
 * configured Quote, details, dine-in checkout with its later-round path), as the restricted
 * NOBYPASSRLS API role holding only the rendered pilot ACL. The HTTP status of each refusal is the
 * session handler's table (customer-checkout-session.test.ts: INTENT_CONFLICT is 409).
 */
it("a checkout after another guest's add is told the cart moved on, and her Quote of the same version answers the held one, for a first and a later round", async () => {
  await withIsolatedDatabase({ caseId: "wp2423_moved_on" }, async (context) => {
    const admin = new Client(context.clientConfig);
    await admin.connect();
    vi.stubEnv("NODE_ENV", "development");
    const api = await createPilotApiRole(admin, context, "wp2423_mo");
    let store = null;
    try {
      store = await prepareRealStaffRoundStore({ admin, context, api });
      const { soup, tableReference, reference, now } = store;
      const server = await store.staff(id(0x710), [
        "ordering.order.create_staff",
        "dining.operate",
        "dining.session.close",
      ]);
      const steps = (await store.counterFor(server)).tableGuestSteps;
      assert.ok(steps, "the pilot composes the table guest's steps");
      const counts = async () =>
        (
          await admin.query(
            "SELECT (SELECT count(*)::int FROM rms_ordering.checkout_session_record) AS sessions,(SELECT count(*)::int FROM rms_ordering.order_batch) AS batches",
          )
        ).rows[0];

      const quoteCounts = async () =>
        (
          await admin.query(
            "SELECT (SELECT count(*)::int FROM rms_pricing.price_quote) AS quotes,(SELECT count(*)::int FROM rms_pricing.price_quote_request) AS requests,(SELECT count(*)::int FROM rms_ordering.cart_quote_attachment) AS attachments",
          )
        ).rows[0];

      /** A guest's phone at the table: scans its code and joins, as anyone at the table does. */
      const seat = async () => {
        const table = await steps.openTable(
          { sessionCookie: server.sessionCookie, csrf: server.csrf },
          { tableReference },
        );
        assert.equal(table.status, "Opened");
        const entered = await steps.enter({ tableReference, requestedAt: now() });
        assert.equal(entered.status, "Established");
        const joined = await steps.join(entered.credentials, {
          joinCredential: table.joinCredential,
          operationReference: reference(),
        });
        const bound = await steps.bind(entered.credentials, {
          operationReference: reference(),
          admissionReference: joined.admissionReference,
        });
        return bound.credentials;
      };

      for (const round of ["first", "later"]) {
        const credentials = await seat();
        const add = async (cart) => {
          const added = await steps.addItem(credentials, {
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
          return { cartReference: cart.cartReference, cartVersion: added.cartVersion };
        };
        const quote = async (cart) => {
          const quoted = await steps.quote(credentials, {
            operationReference: reference(),
            cartReference: cart.cartReference,
            cartVersion: cart.cartVersion,
            requestedAt: now(),
          });
          assert.equal(quoted.status, "Quoted");
          return quoted.quoteReference;
        };
        const open = (cart, quoteReference, createOperationReference = reference()) =>
          steps.startCheckout(credentials, {
            createOperationReference,
            cartReference: cart.cartReference,
            cartVersion: cart.cartVersion,
            quoteReference,
          });
        const refusedAsMovedOn = (attempt) => assert.rejects(attempt, { code: "INTENT_CONFLICT" });

        const selected = await steps.selectCart(credentials, {
          operationReference: reference(),
          requestedAt: now(),
        });
        assert.equal(selected.status, "Selected");
        const before = await counts();
        let cart = await add(selected);

        // Dad's quote, then Mom's tap prices the same cart version while its price is held: she
        // is answered Dad's price (Owner #26, DEC-PRICE-HOLD), and no other price is made, so
        // Dad's quote is still the cart's.
        const dadsQuote = await quote(cart);
        const priced = await quoteCounts();
        assert.equal(
          await quote(cart),
          dadsQuote,
          `Mom is answered Dad's held price (${round} round)`,
        );
        assert.deepEqual(await quoteCounts(), priced, `no other price was made (${round} round)`);

        // Mom adds a dish before Dad's phone opens the checkout: he is told the cart moved on.
        const dadsCart = cart;
        cart = await add(cart);
        const operation = reference();
        await refusedAsMovedOn(open(dadsCart, dadsQuote, operation));

        // Dad's phone asks again with the same key: the same fixed answer, never an outage to
        // wait out, and the same request can't go through later.
        await refusedAsMovedOn(open(dadsCart, dadsQuote, operation));

        // A key never asked before, for a cart version that had already moved on.
        await refusedAsMovedOn(open(dadsCart, dadsQuote));
        assert.deepEqual(await counts(), before, `nothing was created (${round} round)`);

        // Dad's next tap starts from the cart as it stands, and the round is placed once.
        const quoteReference = await quote(cart);
        await steps.saveDetails(credentials, {
          operationReference: reference(),
          detailsReference: reference(),
          cartReference: cart.cartReference,
          cartVersion: cart.cartVersion,
          quoteReference,
        });
        const session = await open(cart, quoteReference);
        assert.equal(session.status, "Started");
        await steps.submitPayLater(credentials, {
          checkoutSessionReference: session.checkoutSessionReference,
          selectionReference: reference(),
          recordedAfterOutage: false,
        });
        const after = await counts();
        assert.equal(after.batches, before.batches + 1, `${round} round placed once`);
      }
    } finally {
      vi.unstubAllEnvs();
      await store?.close();
      await admin.end();
    }
  });
});
