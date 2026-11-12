import assert from "node:assert/strict";
import { setTimeout as sleep } from "node:timers/promises";
import pg from "pg";
import { it, vi } from "vitest";
import { withIsolatedDatabase } from "../test-support/isolated-database.mjs";
import { prepareRealStaffRoundStore } from "../test-support/real-staff-round-store.mjs";
import { createPilotApiRole } from "../test-support/sole-operator-brand-gate.mjs";

const { Client } = pg;
const id = (n) => "01a7ef00-0000-7000-8000-" + n.toString(16).padStart(12, "0");
/** The store fixture's own synthetic references (its allergen list: PEANUT is 0x60). */
const fixtureId = (n) => "01a7ee00-0000-7000-8000-" + n.toString(16).padStart(12, "0");

/** The guest's phone at the store's table, seated by staff (as the customer app's handlers do). */
async function seatedPhone(store, pipeline, staff) {
  const { reference: fresh, now, tableReference } = store;
  const table = await pipeline.openTable(staff, { tableReference });
  assert.equal(table.status, "Opened");
  const entered = await pipeline.enter({ tableReference, requestedAt: now() });
  assert.equal(entered.status, "Established");
  const joined = await pipeline.join(entered.credentials, {
    joinCredential: table.joinCredential,
    operationReference: fresh(),
  });
  return (
    await pipeline.bind(entered.credentials, {
      operationReference: fresh(),
      admissionReference: joined.admissionReference,
    })
  ).credentials;
}

/** One cart round of soups: add, then price/start on demand. */
async function soupRound(
  store,
  pipeline,
  phone,
  quantity,
  sellableReference = store.soup.skuReference,
) {
  const { reference: fresh, now } = store;
  const cart = await pipeline.selectCart(phone, {
    operationReference: fresh(),
    requestedAt: now(),
  });
  assert.equal(cart.status, "Selected");
  const added = await pipeline.addItem(phone, {
    operationReference: fresh(),
    cartReference: cart.cartReference,
    expectedCartVersion: cart.cartVersion,
    sellableReference,
    quantity,
    optionSelections: [],
    customerNote: null,
    requestedAt: now(),
  });
  assert.equal(added.status, "Applied");
  return {
    cartReference: cart.cartReference,
    version: added.cartVersion,
    price: () =>
      pipeline.quote(phone, {
        operationReference: fresh(),
        cartReference: cart.cartReference,
        cartVersion: added.cartVersion,
        requestedAt: now(),
      }),
    start: (quoteReference) =>
      pipeline.startCheckout(phone, {
        createOperationReference: fresh(),
        cartReference: cart.cartReference,
        cartVersion: added.cartVersion,
        quoteReference,
      }),
  };
}

const orderItems = (admin, store) =>
  admin
    .query(
      `SELECT transaction_snapshot_json->'pricing'->>'quoteReference' AS quote,
              transaction_snapshot_json->'pricing'->'unitPrice'->>'amountMinor' AS unit,
              transaction_snapshot_json->'catalog'->'localizedNames'->>'en-CA' AS name
         FROM rms_ordering.order_item WHERE store_id=$1 ORDER BY ordinal`,
      [store.scope.storeReference],
    )
    .then((result) => result.rows);

/**
 * WP-2423 price-hold-dish-changes (DEC-PRICE-HOLD §2 and §3), pay at the end of the meal. Under the
 * restricted NOBYPASSRLS role with the rendered pilot ACL, through the customer app's owner ports
 * and the Owner's real one-page menu commands (the dish's draft product version is edited in place,
 * as on v15):
 * 1. inside the hold the Owner renames the soup and lists it: pricing the cart again (a reload) is a
 *    new quote, not the held one; the held quote no longer starts checkout; a checkout started
 *    before the rename is not sent; once priced again the round is ordered under the new name;
 * 2. inside the hold the Owner lowers the soup and lists it: pricing again is a new quote at the
 *    lower price (the guest pays the lower of the confirmed price and today's), to the cent.
 * Fails before the fix: (1) answers the held quote with its countdown and sends the renamed soup at
 * the held price; (2) keeps charging the higher confirmed price.
 */
it(
  "a dish renamed inside the hold is priced again and shown again; a price cut is passed on",
  { timeout: 900_000 },
  async () => {
    vi.stubEnv("NODE_ENV", "development");
    await withIsolatedDatabase(
      { caseId: "wp2423_ph_dishes", timeoutMs: 800_000 },
      async (context) => {
        const admin = new Client(context.clientConfig);
        await admin.connect();
        let store = null;
        try {
          const api = await createPilotApiRole(admin, context, "wp2423_phd");
          store = await prepareRealStaffRoundStore({ admin, context, api });
          const { reference: fresh, soup, owner } = store;
          const server = await store.staff(id(0x720), [
            "ordering.order.create_staff",
            "dining.operate",
            "dining.session.close",
          ]);
          const counter = await store.counterFor(server);
          const guests = counter.tableGuestPipeline;
          const phone = await seatedPhone(store, guests, {
            sessionCookie: server.sessionCookie,
            csrf: server.csrf,
          });
          const detailsReference = fresh();
          let detailsVersion = 0;
          const saveDetails = async (round, quoteReference) => {
            const saved = await counter.tableGuestDetails.save({
              ...phone,
              command: {
                operationReference: fresh(),
                detailsReference,
                expectedVersion: detailsVersion,
                cartReference: round.cartReference,
                cartVersion: round.version,
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
          const send = (checkoutSessionReference) =>
            guests.submitPayLater(phone, {
              checkoutSessionReference,
              selectionReference: fresh(),
              recordedAfterOutage: false,
            });
          const rename = async (name, nameZh) => {
            await owner.saveDish(name, nameZh, "650", soup.productReference, null);
            await owner.listAll();
          };
          // The Owner's editor keeps the soup's one draft product version (as on v15).
          const versions = async () =>
            (
              await admin.query(
                "SELECT count(*)::int AS n FROM rms_catalog.product_version WHERE product_id=$1",
                [soup.productReference],
              )
            ).rows[0].n;
          const versionsBefore = await versions();

          // 1a. Confirmed at $6.50 x2; the Owner renames the soup and lists it inside the hold.
          const first = await soupRound(store, guests, phone, 2);
          const confirmed = await first.price();
          assert.equal(confirmed.status, "Quoted");
          assert.equal(BigInt(confirmed.subtotalMinor), 1300n);
          await saveDetails(first, confirmed.quoteReference);
          await rename("Hot and sour soup, house style (TEST)", "招牌酸辣汤");
          assert.equal(await versions(), versionsBefore, "renamed in place, same product version");
          const stale = await first.start(confirmed.quoteReference);
          assert.equal(stale.status, "RequoteRequired", "the held quote does not start checkout");
          const reloaded = await first.price();
          assert.equal(reloaded.status, "Quoted");
          assert.notEqual(
            reloaded.quoteReference,
            confirmed.quoteReference,
            "a renamed dish is priced again, never answered with the held quote",
          );
          // The Store tells the guest's page what changed since the dish was first priced.
          assert.deepEqual(
            (reloaded.sinceAdded ?? []).map((line) => [
              String(line.subtotal.amountMinor),
              line.quantity,
              [...line.changes],
            ]),
            [["1300", 2, ["Name"]]],
            "renamed since added: the page names it (after a reload too)",
          );
          // v15 2026-11-11 b10: and which language's name changed, from what to what.
          const renamed = reloaded.sinceAdded?.[0]?.renamed ?? [];
          assert.ok(
            renamed.some(
              (name) =>
                name.locale.startsWith("en") &&
                name.from === "Hot and sour soup (TEST)" &&
                name.to === "Hot and sour soup, house style (TEST)",
            ),
            "the English name before and now",
          );
          assert.ok(
            renamed.some((name) => name.locale.startsWith("zh") && name.to === "招牌酸辣汤"),
            "the Chinese name now",
          );
          await saveDetails(first, reloaded.quoteReference);
          const started = await first.start(reloaded.quoteReference);
          assert.equal(started.status, "Started");

          // 1b. The Owner renames it again between checkout start and the send: nothing is sent.
          await rename("Hot and sour soup (TEST)", "酸辣汤");
          const refused = await send(started.checkoutSessionReference).then(
            () => "Sent",
            (error) => error?.code ?? error?.message ?? "refused",
          );
          assert.notEqual(refused, "Sent", "a dish renamed since checkout start is not sent");
          assert.deepEqual(await orderItems(admin, store), [], "nothing was ordered");

          // 1c. Priced again, the guest sends it: ordered under the name the menu shows now.
          const shown = await first.price();
          assert.equal(shown.status, "Quoted");
          assert.notEqual(shown.quoteReference, reloaded.quoteReference);
          await saveDetails(first, shown.quoteReference);
          const again = await first.start(shown.quoteReference);
          assert.equal(again.status, "Started");
          const sent = await send(again.checkoutSessionReference);
          assert.ok(sent.submissionReference, "the round reached the kitchen");
          assert.deepEqual(
            (await orderItems(admin, store)).map((row) => [row.quote, row.unit, row.name]),
            [[shown.quoteReference, "650", "Hot and sour soup (TEST)"]],
            "one round, at the price confirmed after the guest saw the dish as it is now",
          );

          // 2. A cut inside the hold: confirmed at $6.50, then lowered to $6.00 and listed.
          const second = await soupRound(store, guests, phone, 1);
          const before = await second.price();
          assert.equal(BigInt(before.subtotalMinor), 650n);
          await owner.saveDish("Hot and sour soup (TEST)", "酸辣汤", "600", soup.productReference);
          await owner.listAll();
          const cut = await second.price();
          assert.equal(cut.status, "Quoted");
          assert.notEqual(cut.quoteReference, before.quoteReference, "a new quote for the cut");
          assert.equal(BigInt(cut.subtotalMinor), 600n, "the lower price, to the cent");
          assert.deepEqual(
            (cut.sinceAdded ?? []).map((line) => [
              String(line.subtotal.amountMinor),
              [...line.changes],
            ]),
            [["650", []]],
            "first priced at $6.50: the page lists the cut",
          );
          assert.ok(BigInt(cut.totalMinor) < BigInt(before.totalMinor), "a lower total, with tax");
          // And a rise after it: the price just confirmed is kept (DEC-PRICE-HOLD).
          await owner.saveDish("Hot and sour soup (TEST)", "酸辣汤", "700", soup.productReference);
          await owner.listAll();
          const kept = await second.price();
          assert.equal(kept.quoteReference, cut.quoteReference, "a rise keeps the confirmed price");
          assert.equal(BigInt(kept.subtotalMinor), 600n);

          // 3. (v15 finding: a reload said "up to date") Once the hold ends, pricing again is
          // today's $7.00, and the Store says the line was first priced at $6.50, so the guest's
          // page names the rise and asks before ordering — on any phone, after any reload.
          const { rows } = await admin.query(
            "SELECT expires_at FROM rms_pricing.price_quote WHERE price_quote_id=$1",
            [cut.quoteReference],
          );
          const waitMs = Date.parse(rows[0].expires_at.toISOString()) - Date.now() + 1500;
          if (waitMs > 0) await sleep(waitMs);
          const after = await second.price();
          assert.equal(after.status, "Quoted");
          assert.notEqual(after.quoteReference, cut.quoteReference, "the hold ended");
          assert.equal(BigInt(after.subtotalMinor), 700n, "today's price");
          assert.deepEqual(
            (after.sinceAdded ?? []).map((line) => [
              String(line.subtotal.amountMinor),
              [...line.changes],
            ]),
            [["650", []]],
            "the first price this cart showed for the soup, from the Store's own records",
          );
        } finally {
          await store?.close().catch(() => undefined);
          await admin.end();
        }
      },
    );
  },
);

/**
 * WP-2423 price-hold-dish-changes (DEC-PRICE-HOLD §3), pay first: the guest confirms two soups and
 * starts checkout; staff then set peanuts to "May contain" for the dish in the one-page menu and list
 * it (same name and price) before the guest presses "Pay". The payment step creates no order and charges nothing at
 * the held price; pricing again is a new quote, and the guest pays once the dish is shown as it is
 * now. Same restricted role and pilot compositions; no Provider is reached. Fails before the fix:
 * the order is created at the held price with the new allergen the guest never saw.
 */
it(
  "pay first: a dish given an allergen and listed after checkout start is never charged at the held price",
  { timeout: 900_000 },
  async () => {
    vi.stubEnv("NODE_ENV", "development");
    await withIsolatedDatabase(
      { caseId: "wp2423_ph_allergen", timeoutMs: 800_000 },
      async (context) => {
        const admin = new Client(context.clientConfig);
        await admin.connect();
        let store = null;
        try {
          const api = await createPilotApiRole(admin, context, "wp2423_pha");
          store = await prepareRealStaffRoundStore({
            admin,
            context,
            api,
            paymentTiming: "PayFirst",
          });
          const { reference: fresh, owner } = store;
          const server = await store.staff(id(0x730), [
            "ordering.order.create_staff",
            "dining.operate",
            "dining.session.close",
          ]);
          let pipeline = null;
          const counter = await store.counterFor(server, {
            decorateStaffRoundPipeline: (real) => (pipeline = real),
          });
          const phone = await seatedPhone(store, pipeline, {
            sessionCookie: server.sessionCookie,
            csrf: server.csrf,
          });
          // A dish whose allergens staff declare in the one-page menu (as Wonton on v15).
          const declared = (classification) => [
            { allergenReference: fixtureId(0x60), classification },
          ];
          const wonton = await owner.saveDish(
            "Wonton noodle soup (TEST)",
            "云吞面",
            "650",
            null,
            declared("None"),
          );
          await owner.listAll();
          const round = await soupRound(store, pipeline, phone, 2, wonton.skuReference);
          const confirmed = await round.price();
          assert.equal(confirmed.status, "Quoted");
          const detailsReference = fresh();
          let detailsVersion = 0;
          const details = async (quoteReference) => {
            const saved = await counter.tableGuestDetails.save({
              ...phone,
              command: {
                operationReference: fresh(),
                detailsReference,
                expectedVersion: detailsVersion,
                cartReference: round.cartReference,
                cartVersion: round.version,
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
          await details(confirmed.quoteReference);
          const started = await round.start(confirmed.quoteReference);
          assert.equal(started.status, "Started");

          const disclosures = async () =>
            (
              await admin.query(
                "SELECT DISTINCT allergen_disclosure_json::text AS d FROM rms_catalog.published_menu_projection_sellable WHERE sellable_id=$1",
                [wonton.skuReference],
              )
            ).rows.map((row) => row.d);
          const disclosedBefore = await disclosures();
          assert.equal(disclosedBefore.length, 1, "listed once, with no allergen");
          // Staff set peanuts to "May contain" in the dish editor and list it (same name, same
          // price, the dish's draft product version edited in place).
          await owner.saveDish(
            "Wonton noodle soup (TEST)",
            "云吞面",
            "650",
            wonton.productReference,
            declared("CrossContactPossible"),
          );
          await owner.listAll();
          assert.ok(
            (await disclosures()).length > disclosedBefore.length,
            "the listed menu now tells guests the soup may contain peanuts",
          );

          const pay = () =>
            pipeline.preparePayment(phone, {
              checkoutSessionReference: started.checkoutSessionReference,
              selectionReference: fresh(),
              tip: { amountMinor: 0n, currencyCode: "CAD" },
              recordedAfterOutage: false,
            });
          const refused = await pay().then(
            () => "Prepared",
            (error) => error?.code ?? error?.message ?? "refused",
          );
          assert.notEqual(refused, "Prepared", "no payment at the held price for a changed dish");
          assert.deepEqual(await orderItems(admin, store), [], "no order was created");
          const stale = await round.start(confirmed.quoteReference);
          assert.equal(stale.status, "RequoteRequired");

          // Priced again, the guest pays: the order is the quote confirmed after the change.
          const shown = await round.price();
          assert.equal(shown.status, "Quoted");
          assert.notEqual(shown.quoteReference, confirmed.quoteReference, "priced again");
          assert.equal(BigInt(shown.subtotalMinor), 1300n, "two at $6.50, confirmed again");
          assert.deepEqual(
            (shown.sinceAdded ?? []).map((line) => [...line.changes]),
            [["Allergens"]],
            "the page names the dish's allergens as changed since it was added",
          );
          await details(shown.quoteReference);
          const restarted = await round.start(shown.quoteReference);
          assert.equal(restarted.status, "Started");
          const prepared = await pipeline.preparePayment(phone, {
            checkoutSessionReference: restarted.checkoutSessionReference,
            selectionReference: fresh(),
            tip: { amountMinor: 0n, currencyCode: "CAD" },
            recordedAfterOutage: false,
          });
          assert.equal(String(prepared.quoteReference), shown.quoteReference);
          assert.equal(String(prepared.orderAllocation.amountMinor), String(shown.totalMinor));
          assert.deepEqual(
            (await orderItems(admin, store)).map((row) => row.quote),
            [shown.quoteReference],
            "one order line, at the quote the guest confirmed after the change",
          );
        } finally {
          await store?.close().catch(() => undefined);
          await admin.end();
        }
      },
    );
  },
);
