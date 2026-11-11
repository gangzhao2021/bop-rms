import assert from "node:assert/strict";
import pg from "pg";
import { it, vi } from "vitest";
import { withIsolatedDatabase } from "../test-support/isolated-database.mjs";
import { prepareRealStaffRoundStore } from "../test-support/real-staff-round-store.mjs";
import { createPilotApiRole } from "../test-support/sole-operator-brand-gate.mjs";

const { Client } = pg;
const id = (n) => "01a7ef00-0000-7000-8000-" + n.toString(16).padStart(12, "0");

/**
 * WP-2423 DEC-MERCHANT-LOCK-SCOPE: an owner can now list at 7 pm with the tables full. A guest who
 * already has dishes in the cart must still be able to send them, seeing the price that is true
 * now, without touching a line; a listing while the guest's price is held keeps that price
 * (Owner #26, DEC-PRICE-HOLD). Under the restricted role with the rendered pilot ACL, through the
 * same owner ports the customer app's handlers call, and the Owner's real one-page menu commands.
 */
it("a guest's open cart still sends after the owner lists a change to another dish", async () => {
  vi.stubEnv("NODE_ENV", "development");
  await withIsolatedDatabase({ caseId: "wp2423_open_cart" }, async (context) => {
    const admin = new Client(context.clientConfig);
    await admin.connect();
    let store = null;
    try {
      const api = await createPilotApiRole(admin, context, "wp2423_oc");
      store = await prepareRealStaffRoundStore({ admin, context, api });
      const { reference: fresh, now, tea, soup, owner } = store;
      const server = await store.staff(id(0x700), [
        "ordering.order.create_staff",
        "dining.operate",
        "dining.session.close",
      ]);
      const counter = await store.counterFor(server);
      const guests = counter.tableGuestPipeline;
      const staff = { sessionCookie: server.sessionCookie, csrf: server.csrf };

      // A guest scans at a seated table and puts the soup in the table's cart.
      const table = await guests.openTable(staff, { tableReference: store.tableReference });
      assert.equal(table.status, "Opened");
      const entered = await guests.enter({
        tableReference: store.tableReference,
        requestedAt: now(),
      });
      assert.equal(entered.status, "Established");
      const joined = await guests.join(entered.credentials, {
        joinCredential: table.joinCredential,
        operationReference: fresh(),
      });
      const bound = await guests.bind(entered.credentials, {
        operationReference: fresh(),
        admissionReference: joined.admissionReference,
      });
      const phone = bound.credentials;
      const cart = await guests.selectCart(phone, {
        operationReference: fresh(),
        requestedAt: now(),
      });
      assert.equal(cart.status, "Selected");
      const added = await guests.addItem(phone, {
        operationReference: fresh(),
        cartReference: cart.cartReference,
        expectedCartVersion: cart.cartVersion,
        sellableReference: soup.skuReference,
        quantity: 2,
        optionSelections: [],
        customerNote: null,
        requestedAt: now(),
      });
      assert.equal(added.status, "Applied");

      // The Owner changes the tea's price and lists: a new menu version, another dish.
      await owner.saveDish(
        "Tea charge (TEST)",
        "茶位",
        "175",
        tea.productReference,
        "NoIngredients",
      );
      await owner.listAll();

      // The checkout page saves its details again at the next version whenever it is priced again.
      const detailsReference = fresh();
      let detailsVersion = 0;
      const saveDetails = async (cartReference, version, quoteReference) => {
        const saved = await counter.tableGuestDetails.save({
          ...phone,
          command: {
            operationReference: fresh(),
            detailsReference,
            expectedVersion: detailsVersion,
            cartReference,
            cartVersion: version,
            quoteReference,
            quoteVersion: 2,
            pickupContact: null,
            receipt: { choice: "InSession", email: null },
            policies: [],
          },
        });
        assert.equal(saved.status, "Saved");
        detailsVersion += 1;
      };

      // The same guest goes on, as the checkout page does: it prices the cart, then sends.
      const cartVersion = added.cartVersion;
      const quoted = await guests.quote(phone, {
        operationReference: fresh(),
        cartReference: cart.cartReference,
        cartVersion,
        requestedAt: now(),
      });
      assert.equal(quoted.status, "Quoted", "the guest's cart prices again");
      assert.equal(BigInt(quoted.subtotalMinor), 1300n, "two soups, unchanged");
      await saveDetails(cart.cartReference, cartVersion, quoted.quoteReference);
      const checkout = await guests.startCheckout(phone, {
        createOperationReference: fresh(),
        cartReference: cart.cartReference,
        cartVersion,
        quoteReference: quoted.quoteReference,
      });
      assert.equal(checkout.status, "Started");
      const sent = await guests.submitPayLater(phone, {
        checkoutSessionReference: checkout.checkoutSessionReference,
        selectionReference: fresh(),
        recordedAfterOutage: false,
      });
      assert.ok(sent.submissionReference, "the round reached the kitchen");

      // The guest's next round: priced, and the Owner lists before the guest presses send.
      const nextCart = await guests.selectCart(phone, {
        operationReference: fresh(),
        requestedAt: now(),
      });
      assert.equal(nextCart.status, "Selected");
      const second = await guests.addItem(phone, {
        operationReference: fresh(),
        cartReference: nextCart.cartReference,
        expectedCartVersion: nextCart.cartVersion,
        sellableReference: soup.skuReference,
        quantity: 1,
        optionSelections: [],
        customerNote: null,
        requestedAt: now(),
      });
      assert.equal(second.status, "Applied");
      const priced = async () => {
        const result = await guests.quote(phone, {
          operationReference: fresh(),
          cartReference: nextCart.cartReference,
          cartVersion: second.cartVersion,
          requestedAt: now(),
        });
        assert.equal(result.status, "Quoted", "the cart prices again");
        await saveDetails(nextCart.cartReference, second.cartVersion, result.quoteReference);
        return result;
      };
      const startFor = (result) =>
        guests.startCheckout(phone, {
          createOperationReference: fresh(),
          cartReference: nextCart.cartReference,
          cartVersion: second.cartVersion,
          quoteReference: result.quoteReference,
        });
      // Owner #26 (DEC-PRICE-HOLD): the guest's price is kept while the Owner lists, so the
      // checkout starts on the price the guest confirmed and the round is sent once.
      const held = await priced();
      await owner.saveDish(
        "Tea charge (TEST)",
        "茶位",
        "180",
        tea.productReference,
        "NoIngredients",
      );
      await owner.listAll();
      const again = await priced();
      assert.equal(again.quoteReference, held.quoteReference, "priced again: the confirmed price");
      const started = await startFor(held);
      assert.equal(
        started.status,
        "Started",
        "a listing inside the hold never asks to price again",
      );
      await owner.saveDish(
        "Tea charge (TEST)",
        "茶位",
        "185",
        tea.productReference,
        "NoIngredients",
      );
      await owner.listAll();
      // A listing between checkout start and send: the page is told to price again, which
      // answers the same confirmed price (still held), starts again and sends it, once.
      const send = (checkoutSessionReference) =>
        guests.submitPayLater(phone, {
          checkoutSessionReference,
          selectionReference: fresh(),
          recordedAfterOutage: false,
        });
      await assert.rejects(
        () => send(started.checkoutSessionReference),
        (error) => error.code === "CHECKOUT_REQUOTE_REQUIRED",
        "price again",
      );
      const still = await priced();
      assert.equal(still.quoteReference, held.quoteReference, "the same confirmed price");
      assert.equal(still.totalMinor, held.totalMinor, "to the cent");
      const restarted = await startFor(still);
      assert.equal(restarted.status, "Started", "a stale checkout does not block the new one");
      const secondSent = await send(restarted.checkoutSessionReference);
      assert.ok(secondSent.submissionReference, "the second round reached the kitchen");
      const { rows } = await admin.query(
        "SELECT count(*)::int AS rounds FROM rms_ordering.order_submission_record WHERE store_id=$1",
        [store.scope.storeReference],
      );
      assert.equal(rows[0].rounds, 2, "two rounds, each once");
    } finally {
      await store?.close().catch(() => undefined);
      await admin.end();
    }
  });
});
