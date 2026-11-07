import assert from "node:assert/strict";
import pg from "pg";
import { it, vi } from "vitest";
import { createMerchantDiningTeaCharge } from "../../../apps/api/src/merchant-dining-tea-charge.ts";
import { createMerchantDiningUnpaidItemRemoval } from "../../../apps/api/src/merchant-dining-unpaid-item-removal.ts";
import { withStaffContentLocale } from "../../../apps/api/src/staff-content-locale.ts";
import { recordDiningPartySize } from "../../rms/dining/src/index.ts";
import { withIsolatedDatabase } from "../test-support/isolated-database.mjs";
import { prepareRealStaffRoundStore } from "../test-support/real-staff-round-store.mjs";
import { createPilotApiRole } from "../test-support/sole-operator-brand-gate.mjs";

const { Client } = pg;
const id = (n) => "01a7ef20-0000-7000-8000-" + n.toString(16).padStart(12, "0");

/**
 * WP-2423 DEC-MERCHANT-LOCK-SCOPE, money: a server changes the party size while the system is busy,
 * and one step of adding the per-head charge meets a lock timeout. Through the pilot's real staff
 * round under the restricted role with the rendered pilot ACL, at each step in turn: the table
 * screen says it isn't confirmed, the server presses Match, and the bill then has the charge once,
 * never twice. A step fails once; everything around it is real.
 */
it("a busy moment while adding the per-head charge never charges twice or leaves it stuck", async () => {
  vi.stubEnv("NODE_ENV", "development");
  await withIsolatedDatabase({ caseId: "wp2423_tea_busy" }, async (context) => {
    const admin = new Client(context.clientConfig);
    await admin.connect();
    let store = null;
    try {
      const api = await createPilotApiRole(admin, context, "wp2423_tb");
      store = await prepareRealStaffRoundStore({ admin, context, api });
      const { ownerScope, now, reference: fresh, tea: teaDish } = store;
      const actor = id(0x700);
      const server = await store.staff(actor, [
        "ordering.order.create_staff",
        "dining.operate",
        "dining.session.close",
        "ordering.order.cancel",
      ]);
      const as = { sessionCookie: server.sessionCookie, csrf: server.csrf };
      await store.setTeaCharge();
      // The pilot's own round, on the pilot's own steps; one of them is interrupted below.
      let pipeline = null;
      const counter = await store.counterFor(server, {
        decorateStaffRoundPipeline: (real) => (pipeline = { ...real }),
      });
      const seated = await store.seatTable(server);
      assert.equal(seated.status, "Issued");
      const session = String(seated.session.diningSessionReference);
      const real = store.persistenceOf(server);
      // A transaction of this request may meet a lock: `busyTransactions` of them do.
      let busyTransactions = 0;
      const persistence = {
        ...real,
        transactions: {
          run: (work) => {
            if (busyTransactions === 0) return real.transactions.run(work);
            busyTransactions -= 1;
            return Promise.reject(
              Object.assign(new Error("transaction conflict"), {
                code: "TENANT_DATABASE_TRANSACTION_CONFLICT",
              }),
            );
          },
        },
      };
      const tea = (command) =>
        createMerchantDiningTeaCharge({
          persistence,
          authentication: server.authentication,
          now,
          placeRound: counter.staffDiningRound,
          removeItems: createMerchantDiningUnpaidItemRemoval({
            persistence,
            authentication: server.authentication,
            nextReference: fresh,
            installContext: async (tx, selected) => {
              await tx.query(
                "SELECT set_config('bop.tenant_id',$1,true),set_config('bop.brand_id',$2,true),set_config('bop.store_id',$3,true)",
                [selected.tenantReference, selected.brandReference, selected.storeReference],
              );
            },
          }),
        })({ ...as, command });
      const match = () =>
        tea({ action: "Sync", diningSessionReference: session, operationReference: fresh() });
      let partyVersion = 0;
      const guests = async (size) => {
        await store.asApi((tx) =>
          recordDiningPartySize(tx, ownerScope, {
            diningSessionReference: session,
            operationReference: fresh(),
            expectedVersion: partyVersion,
            partySize: size,
            actorReference: actor,
            observedAt: now(),
          }),
        );
        partyVersion += 1;
      };
      /** Servings of the charge on the table's orders, from the owner's own rows. */
      const onTheBill = async () =>
        (
          await admin.query(
            `SELECT coalesce(sum(i.quantity),0)::int AS servings
               FROM rms_ordering.order_item i
              WHERE i.brand_id=$1 AND i.store_id=$2
                AND i.transaction_snapshot_json->'catalog'->>'sellableReference'=$3`,
            [ownerScope.brandReference, ownerScope.storeReference, teaDish.skuReference],
          )
        ).rows[0].servings;

      await guests(2);
      const first = await match();
      assert.equal(first.status, "Charged");
      assert.equal(await onTheBill(), 2);

      // Staff read the item's own name, in their language: a hotpot's sauce is not tea.
      assert.equal(first.itemName, "Tea charge (TEST)");
      const read = () => tea({ action: "Read", diningSessionReference: session });
      assert.equal((await withStaffContentLocale("zh-Hans", read)).itemName, "茶位");

      // A read that meets a lock reads again, up to three tries; then it says so, not a guess.
      busyTransactions = 2;
      assert.equal((await read()).status, "Charged", "two busy reads are absorbed");
      busyTransactions = 3;
      await assert.rejects(read, (error) => error.code === "DINING_TEA_CHARGE_UNAVAILABLE");
      busyTransactions = 0;

      const conflict = () =>
        Object.assign(new Error("transaction conflict"), {
          code: "TENANT_DATABASE_TRANSACTION_CONFLICT",
        });
      /** The named step meets a lock timeout once; `after`: it did its work and the reply was lost. */
      const failOnce = (step, { after = false } = {}) => {
        const real = pipeline[step];
        pipeline[step] = async (...call) => {
          pipeline[step] = real;
          if (after) await real(...call);
          throw conflict();
        };
      };
      for (const [size, step, options] of [
        [3, "takesOrder", {}],
        [4, "selectCart", {}],
        [5, "addItem", {}],
        [6, "quote", {}],
        [7, "startCheckout", {}],
        [8, "submitPayLater", {}],
        [9, "submitPayLater", { after: true }],
      ]) {
        const label = step + (options.after ? " after its work" : "");
        await guests(size);
        failOnce(step, options);
        const busy = await match();
        if (options.after) {
          // The round went through; only its answer was lost. It counts, once.
          assert.equal(busy.status, "Charged", label + ": the round that went through counts");
        } else {
          assert.deepEqual(
            [busy.status, busy.problem],
            ["Mismatch", "Unavailable"],
            label + ": the screen says it isn't confirmed",
          );
          assert.equal(await onTheBill(), size - 1, label + ": nothing was added");
          const again = await match();
          assert.deepEqual(
            [again.status, again.problem],
            ["Charged", null],
            label + ": Match works at once",
          );
        }
        assert.equal(await onTheBill(), size, label + ": charged for each guest, once");
      }
    } finally {
      await store?.close().catch(() => undefined);
      await admin.end();
    }
  });
});
