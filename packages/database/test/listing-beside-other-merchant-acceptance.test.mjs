import assert from "node:assert/strict";
import { setTimeout as sleep } from "node:timers/promises";
import pg from "pg";
import { it, vi } from "vitest";
import { createMerchantAvailability } from "../../../apps/api/src/merchant-availability.ts";
import { createMerchantDiningTeaCharge } from "../../../apps/api/src/merchant-dining-tea-charge.ts";
import { createMerchantDiningUnpaidItemRemoval } from "../../../apps/api/src/merchant-dining-unpaid-item-removal.ts";
import { withIsolatedDatabase } from "../test-support/isolated-database.mjs";
import { prepareRealStaffRoundStore } from "../test-support/real-staff-round-store.mjs";
import { createPilotApiRole } from "../test-support/sole-operator-brand-gate.mjs";

const { Client } = pg;

/** What a merchant's staff and guests do during a service, through the pilot's real compositions. */
async function serviceOf(store, person) {
  const fresh = store.reference;
  const now = store.now;
  const server = await store.staff(person(0x700), [
    "ordering.order.create_staff",
    "dining.operate",
    "dining.session.close",
    "catalog.sku.sold_out.mark",
    "catalog.sku.availability.manage",
    "catalog.sku.read",
  ]);
  const as = { sessionCookie: server.sessionCookie, csrf: server.csrf };
  const counter = await store.counterFor(server);
  const guests = counter.tableGuestPipeline;
  await store.setTeaCharge();

  // A party is seated and a guest has scanned; the same phone sends every round.
  const table = await guests.openTable(as, { tableReference: store.tableReference });
  assert.equal(table.status, "Opened");
  const entered = await guests.enter({ tableReference: store.tableReference, requestedAt: now() });
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

  const availability = createMerchantAvailability({
    persistence: store.persistenceOf(server),
    authentication: server.authentication,
    references: { next: fresh },
    locale: "en-CA",
  });
  const teaCharge = createMerchantDiningTeaCharge({
    persistence: store.persistenceOf(server),
    authentication: server.authentication,
    now,
    placeRound: counter.staffDiningRound,
    removeItems: createMerchantDiningUnpaidItemRemoval({
      persistence: store.persistenceOf(server),
      authentication: server.authentication,
      nextReference: fresh,
      installContext: async (tx, selected) => {
        await tx.query(
          "SELECT set_config('bop.tenant_id',$1,true),set_config('bop.brand_id',$2,true),set_config('bop.store_id',$3,true)",
          [selected.tenantReference, selected.brandReference, selected.storeReference],
        );
      },
    }),
  });

  const addToCart = async () => {
    const cart = await guests.selectCart(phone, {
      operationReference: fresh(),
      requestedAt: now(),
    });
    assert.equal(cart.status, "Selected");
    const added = await guests.addItem(phone, {
      operationReference: fresh(),
      cartReference: cart.cartReference,
      expectedCartVersion: cart.cartVersion,
      sellableReference: store.soup.skuReference,
      quantity: 1,
      optionSelections: [],
      customerNote: null,
      requestedAt: now(),
    });
    assert.equal(added.status, "Applied");
    return { cart, added };
  };

  let signIns = 0;
  return {
    server,
    table,
    /** The menu a guest and the counter read (one composition); it reads the public profile too. */
    menuRead: async () => {
      const read = await counter.counterMenu({ ...as, orderType: "DineIn" });
      assert.equal(read.menu.status, "Found");
    },
    /** A new person signs in: a real Session, membership and role at this merchant. */
    signIn: async () => {
      signIns += 1;
      await store.staff(person(0x800 + signIns), ["dining.operate"]);
    },
    /** The Store proof the staff workspace reads at sign-in decides whether orders are taken. */
    takesOrders: async () => {
      assert.equal(await guests.takesOrder({ recordedAfterOutage: false }), true);
    },
    /** The guest adds a dish to the table's cart. */
    addToCart,
    /** The guest adds a soup (Catalog, stock) and sends it: price, details, checkout, kitchen. */
    guestRound: async () => {
      const { cart, added } = await addToCart();
      const quoted = await guests.quote(phone, {
        operationReference: fresh(),
        cartReference: cart.cartReference,
        cartVersion: added.cartVersion,
        requestedAt: now(),
      });
      assert.equal(quoted.status, "Quoted");
      await counter.tableGuestDetails.save({
        ...phone,
        command: {
          operationReference: fresh(),
          detailsReference,
          expectedVersion: detailsVersion,
          cartReference: cart.cartReference,
          cartVersion: added.cartVersion,
          quoteReference: quoted.quoteReference,
          quoteVersion: 2,
          pickupContact: null,
          receipt: { choice: "InSession", email: null },
          policies: [],
        },
      });
      detailsVersion += 1;
      const started = await guests.startCheckout(phone, {
        createOperationReference: fresh(),
        cartReference: cart.cartReference,
        cartVersion: added.cartVersion,
        quoteReference: quoted.quoteReference,
      });
      assert.equal(started.status, "Started");
      const sent = await guests.submitPayLater(phone, {
        checkoutSessionReference: started.checkoutSessionReference,
        selectionReference: fresh(),
        recordedAfterOutage: false,
      });
      assert.ok(sent.submissionReference, "the round reached the kitchen");
    },
    /** A server sends a round from the table screen. */
    staffRound: async () => {
      const round = await counter.staffDiningRound({
        ...as,
        command: {
          operationReference: fresh(),
          tableReference: store.tableReference,
          lines: [
            {
              sellableReference: store.soup.skuReference,
              quantity: 1,
              optionSelections: [],
              note: null,
            },
          ],
          tip: { kind: "None" },
          recordedAfterOutage: false,
        },
      });
      assert.equal(round.status, "Placed");
    },
    /** The per-head charge is read and matched to the party on the table screen. */
    teaSync: async () => {
      const read = await teaCharge({
        ...as,
        command: {
          action: "Sync",
          diningSessionReference: table.diningSessionReference,
          operationReference: fresh(),
        },
      });
      assert.ok(read.problem === null || read.problem === undefined, "no problem: " + read.problem);
    },
    /** The kitchen shouts: staff mark a dish sold out and back at once. */
    soldOutAndBack: async () => {
      await availability.command({
        ...as,
        body: {
          action: "SoldOut",
          operationReference: fresh(),
          skuReference: store.soup.skuReference,
          until: "UntilBack",
        },
      });
      await availability.command({
        ...as,
        body: {
          action: "BackInStock",
          operationReference: fresh(),
          skuReference: store.soup.skuReference,
        },
      });
    },
  };
}

/**
 * WP-2423 DEC-MERCHANT-LOCK-SCOPE: an owner presses List it. Held just before the COMMIT of each
 * step of the listing, another merchant's staff and guests, and the listing merchant's own, do what
 * a service does through the pilot's real compositions, under the restricted role with the rendered
 * pilot ACL. Nothing fails and nothing waits on the held step, and the listing then completes.
 */
it("a listing stops nobody: not another merchant, and not its own guests and staff", async () => {
  vi.stubEnv("NODE_ENV", "development");
  await withIsolatedDatabase({ caseId: "wp2423_beside", timeoutMs: 540_000 }, async (context) => {
    const admin = new Client(context.clientConfig);
    await admin.connect();
    const monitor = new Client(context.clientConfig);
    await monitor.connect();
    let listing = null,
      other = null;
    try {
      const api = await createPilotApiRole(admin, context, "wp2423_bs");
      listing = await prepareRealStaffRoundStore({ admin, context, api });
      other = await prepareRealStaffRoundStore({ admin, context, api, merchant: 1 });
      const personOf = (merchant) => (n) =>
        (0x01a7ef10 + merchant).toString(16).padStart(8, "0") +
        "-0000-7000-8000-" +
        n.toString(16).padStart(12, "0");
      const own = await serviceOf(listing, personOf(0));
      const beside = await serviceOf(other, personOf(1));
      const { owner, tea } = listing;
      const held = owner.backendPid();
      const quick = (who) => [
        [who + ".menuRead", who === "beside" ? beside.menuRead : own.menuRead],
        [who + ".takesOrders", who === "beside" ? beside.takesOrders : own.takesOrders],
      ];
      const whole = (who) => {
        const service = who === "beside" ? beside : own;
        return [
          [who + ".guestRound", service.guestRound],
          [who + ".staffRound", service.staffRound],
          [who + ".teaSync", service.teaSync],
          [who + ".soldOutAndBack", service.soldOutAndBack],
        ];
      };

      // What a service does at a hold. A failure, or a wait on the held step, is recorded with it.
      const failures = [],
        waits = [];
      const during = async (step, name, work) => {
        let done = false;
        const watching = (async () => {
          while (!done) {
            const { rows } = await monitor.query(
              "SELECT left(query,80) AS query FROM pg_stat_activity WHERE $1=ANY(pg_blocking_pids(pid))",
              [held],
            );
            for (const row of rows) waits.push({ step, name, query: row.query });
            await sleep(25);
          }
        })();
        try {
          await work();
        } catch (error) {
          failures.push({ step, name, code: error?.code, message: String(error?.message) });
        } finally {
          done = true;
          await watching;
        }
      };

      // Each of them works with nothing beside it (the comparison for everything below).
      for (const [name, work] of [
        ...quick("beside"),
        ["beside.signIn", beside.signIn],
        ...whole("beside"),
        ...quick("own"),
        ...whole("own"),
      ])
        await during(0, name, work);
      assert.deepEqual(failures, [], "every action works with nothing beside it");

      /** Whether the held step holds the audit chain of the listing merchant's Store. */
      const holdsStoreAudit = async () => {
        await monitor.query("BEGIN");
        try {
          await monitor.query(
            "SELECT 1 FROM platform_audit.audit_chain_head WHERE brand_id=$1 AND store_id=$2 FOR UPDATE NOWAIT",
            [listing.scope.brandReference, listing.scope.storeReference],
          );
          return false;
        } catch (error) {
          if (error.code === "55P03") return true;
          throw error;
        } finally {
          await monitor.query("ROLLBACK");
        }
      };

      // The Owner changes the tea's price and presses List it; each step holds before its COMMIT.
      await owner.saveDish(
        "Tea charge (TEST)",
        "茶位",
        "175",
        tea.productReference,
        "NoIngredients",
      );
      const steps = [];
      const afterCommit = [];
      owner.hooks.atCommit = async () => {
        const step = steps.length + 1;
        const { rows } = await monitor.query(
          `SELECT (SELECT count(*)::int FROM pg_locks WHERE pid=$1 AND locktype='advisory') AS fences,
             (SELECT (extract(epoch FROM clock_timestamp()-xact_start)*1000)::int
                FROM pg_stat_activity WHERE pid=$1) AS "elapsedMs"`,
          [held],
        );
        const here = { step, ...rows[0], storeAudit: await holdsStoreAudit() };
        steps.push(here);
        for (const [name, work] of [
          ...quick("beside"),
          ["beside.signIn", beside.signIn],
          ...quick("own"),
        ])
          await during(step, name, work);
        // A step holding nothing stops nobody; the whole service runs at each step that holds.
        if (here.fences === 0 && !here.storeAudit) return;
        for (const [name, work] of whole("beside")) await during(step, name, work);
        if (!here.storeAudit) {
          for (const [name, work] of whole("own")) await during(step, name, work);
          return;
        }
        // This step writes to the Store's own audit chain. A write of the same Store takes its turn
        // in that chain, so it waits for this COMMIT, however short, and then goes through.
        afterCommit.push(
          (async () => {
            await during(step, "own.guestRound", own.guestRound);
            await during(step, "own.soldOutAndBack", own.soldOutAndBack);
          })(),
        );
        const began = Date.now();
        while (Date.now() - began < 1500) {
          const { rows: queued } = await monitor.query(
            "SELECT 1 FROM pg_stat_activity WHERE $1=ANY(pg_blocking_pids(pid))",
            [held],
          );
          if (queued.length > 0) break;
          await sleep(10);
        }
      };
      const listed = await owner.listAll();
      owner.hooks.atCommit = null;
      assert.equal(listed.status, "Listed", "the listing finishes after everything beside it");
      await Promise.all(afterCommit);

      assert.deepEqual(failures, [], "nothing failed at any step of the listing");
      assert.ok(steps.filter((row) => row.fences > 0).length >= 4, "the steps hold real fences");
      const atOwnAudit = steps.filter((row) => row.storeAudit);
      assert.equal(
        atOwnAudit.length,
        1,
        "one step, the price assignment, writes the Store's chain",
      );
      // The turn a same-Store write waits for is shorter than the 2 s it would give up after.
      assert.ok(atOwnAudit[0].elapsedMs < 2000, "the step took " + atOwnAudit[0].elapsedMs + " ms");
      assert.deepEqual(
        waits.filter(
          (wait) =>
            !(
              wait.step === atOwnAudit[0].step &&
              wait.name.startsWith("own.") &&
              wait.query.includes("audit_chain_head")
            ),
        ),
        [],
        "nobody else waits on the held step: not another merchant, and not its own guests and staff",
      );

      // Without holds, as it really runs: a guest reads the menu and adds to the cart right through
      // Publish. They see the whole old menu or the whole new one, never "Menu is unavailable".
      await owner.saveDish(
        "Tea charge (TEST)",
        "茶位",
        "180",
        tea.productReference,
        "NoIngredients",
      );
      const crossing = [];
      let finished = false,
        reads = 0;
      const guestsLoop = (async () => {
        while (!finished) {
          try {
            await own.menuRead();
            await own.addToCart();
            reads += 1;
          } catch (error) {
            crossing.push({ code: error?.code, message: String(error?.message) });
          }
          await sleep(5);
        }
      })();
      // As long as a larger menu's steps take (no step holds anyone here).
      owner.hooks.atCommit = () => sleep(150);
      await owner.listAll();
      owner.hooks.atCommit = null;
      finished = true;
      await guestsLoop;
      assert.deepEqual(crossing, [], "a guest is never refused across the go-live");
      assert.ok(reads > 3, "the guest was busy throughout (" + reads + " rounds of read and add)");
      await own.guestRound();
    } finally {
      await listing?.close().catch(() => undefined);
      await other?.close().catch(() => undefined);
      await monitor.end();
      await admin.end();
    }
  });
});
