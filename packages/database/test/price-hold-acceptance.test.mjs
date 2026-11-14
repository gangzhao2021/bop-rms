import assert from "node:assert/strict";
import { setTimeout as sleep } from "node:timers/promises";
import pg from "pg";
import { it, vi } from "vitest";
import { withIsolatedDatabase } from "../test-support/isolated-database.mjs";
import { prepareRealStaffRoundStore } from "../test-support/real-staff-round-store.mjs";
import { createPilotApiRole } from "../test-support/sole-operator-brand-gate.mjs";

const { Client } = pg;
const id = (n) => "01a7ef00-0000-7000-8000-" + n.toString(16).padStart(12, "0");

/**
 * Owner #26 / M165 (DEC-PRICE-HOLD): a guest's confirmed price is kept until its hold ends. Under
 * the restricted NOBYPASSRLS role with the rendered pilot ACL, through the owner ports the
 * customer app's handlers call and the Owner's real one-page menu commands:
 * 1. during the hold the Owner raises the price of the dish in the guest's cart and lists it:
 *    pricing the cart again (a reload) answers the confirmed quote, checkout starts on it and the
 *    round is ordered at the confirmed price, to the cent;
 * 2. a replay of the same send places nothing twice;
 * 3. after the hold the old quote no longer starts a checkout, pricing again shows the new price,
 *    and the round is ordered at that price.
 * Fails before DEC-PRICE-HOLD: step 1 is refused as RequoteRequired (the listing forced a new
 * price) and the reload prices the cart anew at the raised price.
 */
it(
  "a confirmed price is honoured until its hold ends, then the guest is priced again",
  { timeout: 900_000 },
  async () => {
    vi.stubEnv("NODE_ENV", "development");
    await withIsolatedDatabase(
      { caseId: "wp2423_price_hold", timeoutMs: 800_000 },
      async (context) => {
        const admin = new Client(context.clientConfig);
        await admin.connect();
        let store = null;
        try {
          const api = await createPilotApiRole(admin, context, "wp2423_ph");
          store = await prepareRealStaffRoundStore({ admin, context, api });
          const { reference: fresh, now, soup, owner } = store;
          const server = await store.staff(id(0x700), [
            "ordering.order.create_staff",
            "dining.operate",
            "dining.session.close",
          ]);
          const counter = await store.counterFor(server);
          const guests = counter.tableGuestPipeline;
          const staff = { sessionCookie: server.sessionCookie, csrf: server.csrf };

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
          const round = async (quantity) => {
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
              quantity,
              optionSelections: [],
              customerNote: null,
              requestedAt: now(),
            });
            assert.equal(added.status, "Applied");
            const price = () =>
              guests.quote(phone, {
                operationReference: fresh(),
                cartReference: cart.cartReference,
                cartVersion: added.cartVersion,
                requestedAt: now(),
              });
            const start = (quoteReference) =>
              guests.startCheckout(phone, {
                createOperationReference: fresh(),
                cartReference: cart.cartReference,
                cartVersion: added.cartVersion,
                quoteReference,
              });
            return { cartReference: cart.cartReference, version: added.cartVersion, price, start };
          };
          // What each ordered line was charged, by the quote that priced it (any round).
          const orderedLines = async (quoteReference) =>
            (
              await admin.query(
                `SELECT transaction_snapshot_json->'pricing'->'unitPrice'->>'amountMinor' AS unit,
                      transaction_snapshot_json->'pricing'->'total'->>'amountMinor' AS total,
                      quantity
                 FROM rms_ordering.order_item
                WHERE store_id=$1 AND transaction_snapshot_json->'pricing'->>'quoteReference'=$2
                ORDER BY ordinal`,
                [store.scope.storeReference, quoteReference],
              )
            ).rows;
          const raise = async (priceMinor) => {
            await owner.saveDish(
              "Hot and sour soup (TEST)",
              "酸辣汤",
              priceMinor,
              soup.productReference,
              null,
            );
            await owner.listAll();
          };

          // 1. Two soups at $6.50, confirmed; the Owner then raises the soup to $8.00 and lists it.
          const first = await round(2);
          const confirmed = await first.price();
          assert.equal(confirmed.status, "Quoted");
          assert.equal(BigInt(confirmed.subtotalMinor), 1300n, "two soups at $6.50");
          await saveDetails(first.cartReference, first.version, confirmed.quoteReference);
          await raise("800");
          const reloaded = await first.price();
          assert.equal(reloaded.status, "Quoted");
          assert.equal(reloaded.quoteReference, confirmed.quoteReference, "the confirmed quote");
          assert.equal(BigInt(reloaded.subtotalMinor), 1300n, "still $13.00 inside the hold");
          assert.equal(reloaded.totalMinor, confirmed.totalMinor, "same total, to the cent");
          const started = await first.start(confirmed.quoteReference);
          assert.equal(started.status, "Started", "the confirmed price checks out");
          const selectionReference = fresh();
          const send = () =>
            guests.submitPayLater(phone, {
              checkoutSessionReference: started.checkoutSessionReference,
              selectionReference,
              recordedAfterOutage: false,
            });
          const sent = await send();
          assert.ok(sent.submissionReference, "the round reached the kitchen");
          const firstLines = await orderedLines(confirmed.quoteReference);
          assert.deepEqual(
            firstLines.map((line) => [line.unit, line.total, line.quantity]),
            [["650", String(confirmed.totalMinor), 2]],
            "ordered at the confirmed $6.50, with the tax as quoted, to the cent",
          );

          // 2. The same send again (a lost answer retried) places nothing twice.
          const replayed = await send();
          assert.equal(replayed.submissionReference, sent.submissionReference, "the same round");

          // 3. A new round priced at $8.00; the Owner raises it to $9.00; the hold then ends.
          const second = await round(1);
          const earlier = await second.price();
          assert.equal(BigInt(earlier.subtotalMinor), 800n, "one soup at the listed $8.00");
          await raise("900");
          const { rows } = await admin.query(
            "SELECT expires_at FROM rms_pricing.price_quote WHERE price_quote_id=$1",
            [earlier.quoteReference],
          );
          const waitMs = Date.parse(rows[0].expires_at.toISOString()) - Date.now() + 1500;
          if (waitMs > 0) await sleep(waitMs);
          const stale = await second.start(earlier.quoteReference).then(
            (value) => value.status,
            (error) => error.code,
          );
          assert.notEqual(stale, "Started", "an ended hold never starts a checkout");
          const repriced = await second.price();
          assert.equal(repriced.status, "Quoted");
          assert.notEqual(repriced.quoteReference, earlier.quoteReference, "a new price");
          assert.equal(BigInt(repriced.subtotalMinor), 900n, "the price now, $9.00");
          await saveDetails(second.cartReference, second.version, repriced.quoteReference);
          const restarted = await second.start(repriced.quoteReference);
          assert.equal(restarted.status, "Started");
          const secondSent = await guests.submitPayLater(phone, {
            checkoutSessionReference: restarted.checkoutSessionReference,
            selectionReference: fresh(),
            recordedAfterOutage: false,
          });
          assert.ok(secondSent.submissionReference);
          const secondLines = await orderedLines(repriced.quoteReference);
          assert.deepEqual(
            secondLines.map((line) => [line.unit, line.total]),
            [["900", String(repriced.totalMinor)]],
            "ordered at the new price once confirmed again",
          );
          const counted = await admin.query(
            "SELECT count(*)::int AS rounds FROM rms_ordering.order_submission_record WHERE store_id=$1",
            [store.scope.storeReference],
          );
          assert.equal(counted.rows[0].rounds, 2, "two rounds, each once");
        } finally {
          await store?.close().catch(() => undefined);
          await admin.end();
        }
      },
    );
  },
);

/**
 * Owner #26 / M165 (DEC-PRICE-HOLD), pay first (a dessert or tea table that pays each round before
 * it goes to the kitchen): the guest confirms two soups at $6.50 and starts checkout; the Owner
 * then raises the soup to $8.00 and lists it before the guest presses "Pay". Payment preparation
 * re-runs checkout validation and creates the order; inside the hold the order and the amount to
 * charge are the confirmed price, to the cent. Same restricted NOBYPASSRLS role, same pilot
 * compositions; no Provider is reached (the card answer is the Provider's, accepted elsewhere).
 * Fails before DEC-PRICE-HOLD: the listing makes payment preparation refuse with
 * CHECKOUT_REQUOTE_REQUIRED, and the guest is asked to price again inside the hold.
 */
it(
  "pay first: a listing between checkout and payment keeps the confirmed price on the order and the charge",
  { timeout: 900_000 },
  async () => {
    vi.stubEnv("NODE_ENV", "development");
    await withIsolatedDatabase(
      { caseId: "wp2423_ph_pay_first", timeoutMs: 800_000 },
      async (context) => {
        const admin = new Client(context.clientConfig);
        await admin.connect();
        let store = null;
        try {
          const api = await createPilotApiRole(admin, context, "wp2423_phf");
          store = await prepareRealStaffRoundStore({
            admin,
            context,
            api,
            paymentTiming: "PayFirst",
          });
          const { reference: fresh, now, soup, owner, tableReference } = store;
          const server = await store.staff(id(0x710), [
            "ordering.order.create_staff",
            "dining.operate",
            "dining.session.close",
          ]);
          const as = { sessionCookie: server.sessionCookie, csrf: server.csrf };
          let pipeline = null;
          await store.counterFor(server, {
            decorateStaffRoundPipeline: (real) => (pipeline = real),
          });

          const table = await pipeline.openTable(as, { tableReference });
          assert.equal(table.status, "Opened");
          const entered = await pipeline.enter({ tableReference, requestedAt: now() });
          assert.equal(entered.status, "Established");
          const joined = await pipeline.join(entered.credentials, {
            joinCredential: table.joinCredential,
            operationReference: fresh(),
          });
          const phone = (
            await pipeline.bind(entered.credentials, {
              operationReference: fresh(),
              admissionReference: joined.admissionReference,
            })
          ).credentials;

          const cart = await pipeline.selectCart(phone, {
            operationReference: fresh(),
            requestedAt: now(),
          });
          assert.equal(cart.status, "Selected");
          const added = await pipeline.addItem(phone, {
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
          const confirmed = await pipeline.quote(phone, {
            operationReference: fresh(),
            cartReference: cart.cartReference,
            cartVersion: added.cartVersion,
            requestedAt: now(),
          });
          assert.equal(confirmed.status, "Quoted");
          assert.equal(BigInt(confirmed.subtotalMinor), 1300n, "two soups at $6.50");
          await pipeline.saveDetails(phone, {
            operationReference: fresh(),
            detailsReference: fresh(),
            cartReference: cart.cartReference,
            cartVersion: added.cartVersion,
            quoteReference: confirmed.quoteReference,
          });
          const started = await pipeline.startCheckout(phone, {
            createOperationReference: fresh(),
            cartReference: cart.cartReference,
            cartVersion: added.cartVersion,
            quoteReference: confirmed.quoteReference,
          });
          assert.equal(started.status, "Started");

          // The Owner raises the soup and lists it while the guest is on the payment step.
          await owner.saveDish(
            "Hot and sour soup (TEST)",
            "酸辣汤",
            "800",
            soup.productReference,
            null,
          );
          await owner.listAll();

          const prepared = await pipeline.preparePayment(phone, {
            checkoutSessionReference: started.checkoutSessionReference,
            selectionReference: fresh(),
            tip: { amountMinor: 0n, currencyCode: "CAD" },
            recordedAfterOutage: false,
          });
          assert.equal(String(prepared.quoteReference), confirmed.quoteReference, "the held quote");
          assert.equal(
            String(prepared.orderAllocation.amountMinor),
            String(confirmed.totalMinor),
            "the charge is the confirmed total, to the cent",
          );
          assert.equal(String(prepared.total.amountMinor), String(confirmed.totalMinor));
          const { rows } = await admin.query(
            `SELECT transaction_snapshot_json->'pricing'->'unitPrice'->>'amountMinor' AS unit,
                    transaction_snapshot_json->'pricing'->'total'->>'amountMinor' AS total,
                    quantity
               FROM rms_ordering.order_item
              WHERE store_id=$1 AND order_id=$2
              ORDER BY ordinal`,
            [store.scope.storeReference, String(prepared.orderReference)],
          );
          assert.deepEqual(
            rows.map((line) => [line.unit, line.total, line.quantity]),
            [["650", String(confirmed.totalMinor), 2]],
            "ordered at the confirmed $6.50 with the quoted tax, to the cent",
          );
        } finally {
          await store?.close().catch(() => undefined);
          await admin.end();
        }
      },
    );
  },
);
