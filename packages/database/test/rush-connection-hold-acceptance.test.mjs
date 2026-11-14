// WP-2423 (rush-connection-hold, v15 2026-11-14) on a real isolated PostgreSQL, the code under test
// as a NOBYPASSRLS role holding exactly the rendered pilot ACL, through the pilot's own customer
// API composition (tooling/environment/pilot-api.mjs over the pilot's connection acquire):
//  1. In every rush wave the API's whole pool sat "idle in transaction" for 10-20 s while nothing
//     was answered. The cart read's menu check holds one read-only snapshot connection and, for
//     each line, asked the same pool for a second one (the stock read), which only the waiting
//     snapshots could give back. A burst of guest cart reads against a pool of three now leaves no
//     connection idle in a transaction, and every read is answered promptly.
//  2. A guest check that takes row locks (FOR SHARE) committed nothing, but was taken for a write:
//     the rest of the read then ran unbounded (past its 12 s, its rush turn-aways logged as faults).
//     The request stays bounded after it, and a wait the rush then turns away is noted as the rush.
import assert from "node:assert/strict";
import { setTimeout as sleep } from "node:timers/promises";
import pg from "pg";
import { it, vi } from "vitest";
import { createRuntime } from "../../../tooling/environment/pilot-api.mjs";
import {
  requestWasShed,
  withRequestAcquireBudget,
} from "../../../apps/api/src/request-acquire-budget.ts";
import { remainingRequestAcquireBudgetMs } from "../src/connection-acquire.ts";
import { withIsolatedDatabase } from "../test-support/isolated-database.mjs";
import { prepareRealStaffRoundStore } from "../test-support/real-staff-round-store.mjs";
import { createPilotApiRole } from "../test-support/sole-operator-brand-gate.mjs";

const { Client } = pg;
const id = (n) => "01a7f100-0000-7000-8000-" + n.toString(16).padStart(12, "0");
/** The API pool as small as a busy entry's share of it, with the pilot entry's waits. */
const apiPool = { max: 3, connectionTimeoutMillis: 2000, acquireBudgetMs: 10_000 };
const burst = 30;

it("a burst of guest cart reads leaves no connection idle in a transaction and answers in time", async () => {
  vi.stubEnv("NODE_ENV", "development");
  await withIsolatedDatabase({ caseId: "wp2423_rush_hold" }, async (context) => {
    const admin = new Client(context.clientConfig);
    await admin.connect();
    let store = null;
    let runtime = null;
    try {
      const api = await createPilotApiRole(admin, context, "wp2423_rh");
      store = await prepareRealStaffRoundStore({ admin, context, api, apiPool });
      const { reference: fresh, now, soup, tea } = store;
      const server = await store.staff(id(0x700), [
        "ordering.order.create_staff",
        "dining.operate",
        "dining.session.close",
      ]);
      const counter = await store.counterFor(server);
      const guests = counter.tableGuestPipeline;
      const staff = { sessionCookie: server.sessionCookie, csrf: server.csrf };

      // A seated guest with two dishes in the table's cart (each line is checked on every read).
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
      let version = cart.cartVersion;
      for (const dish of [soup, tea]) {
        const added = await guests.addItem(phone, {
          operationReference: fresh(),
          cartReference: cart.cartReference,
          expectedCartVersion: version,
          sellableReference: dish.skuReference,
          quantity: 1,
          optionSelections: [],
          customerNote: null,
          requestedAt: now(),
        });
        assert.equal(added.status, "Applied");
        version = added.cartVersion;
      }

      // The pilot's customer API, as pilot-api-entry.mjs composes it, on this Store's pool.
      const dependencies = store.customerDependenciesFor(server);
      runtime = await createRuntime(
        { port: 0 },
        {
          ...dependencies,
          createInternalTestResources: async () => store.resources,
          createInternalSimulatedProvider: () =>
            dependencies.createInternalSimulatedProvider({ provision: true }),
          // Not part of a cart read (its business worker is not installed here).
          createInternalDiningRoundWithdraw: undefined,
        },
      );
      await runtime.listen();
      const port = runtime.server.address().port;
      const read = async () => {
        const started = Date.now();
        const response = await globalThis.fetch(`http://127.0.0.1:${port}/bff/customer/cart`, {
          headers: {
            cookie: "__Host-bop-guest=" + phone.sessionCredential,
            "sec-fetch-site": "same-origin",
            "sec-fetch-mode": "cors",
          },
        });
        const body = await response.json();
        return { status: response.status, ms: Date.now() - started, lines: body?.cart?.items };
      };
      const quiet = await read();
      assert.equal(quiet.status, 200, "a quiet read answers");
      assert.equal(quiet.lines?.length, 2, "with both dishes");

      // While the burst runs: how long the API's connections sit in a transaction sending nothing.
      let sampling = true;
      let longestIdleInTransactionMs = 0;
      const sampler = (async () => {
        const watcher = new Client(context.clientConfig);
        await watcher.connect();
        try {
          while (sampling) {
            const row = (
              await watcher.query(
                "SELECT coalesce(max(extract(epoch FROM clock_timestamp()-state_change)*1000),0)::int AS ms FROM pg_stat_activity WHERE datname=current_database() AND application_name=$1 AND state='idle in transaction'",
                [store.apiApplicationName],
              )
            ).rows[0];
            longestIdleInTransactionMs = Math.max(longestIdleInTransactionMs, row.ms);
            await sleep(100);
          }
        } finally {
          await watcher.end();
        }
      })();
      const answers = await Promise.all(Array.from({ length: burst }, read));
      sampling = false;
      await sampler;

      assert.ok(
        longestIdleInTransactionMs < 1000,
        `no API connection sits in a transaction sending nothing (longest ${longestIdleInTransactionMs} ms)`,
      );
      const slowest = Math.max(...answers.map((answer) => answer.ms));
      assert.ok(slowest < 8000, `every read is answered promptly (slowest ${slowest} ms)`);
      for (const answer of answers) {
        assert.equal(answer.status, 200, "every guest's cart is read");
        assert.equal(answer.lines?.length, 2, "with both dishes");
      }
    } finally {
      await new Promise((resolve) =>
        runtime?.server?.listening ? runtime.server.close(resolve) : resolve(),
      );
      await store?.close();
      await admin.end();
    }
  });
});

it("a guest check that only locks rows keeps the read bounded and its rush wait noted", async () => {
  vi.stubEnv("NODE_ENV", "development");
  await withIsolatedDatabase({ caseId: "wp2423_rush_lock" }, async (context) => {
    const admin = new Client(context.clientConfig);
    await admin.connect();
    let store = null;
    const held = [];
    try {
      const api = await createPilotApiRole(admin, context, "wp2423_rl");
      store = await prepareRealStaffRoundStore({ admin, context, api, apiPool });
      // The guest's table, as the guest checks of every cart read read it with a row lock.
      const lockTable = async (tx) => {
        const locked = await tx.query(
          'SELECT table_snapshot AS "table" FROM rms_dining.dining_table WHERE tenant_id=$1 AND brand_id=$2 AND store_id=$3 AND table_id=$4 FOR SHARE',
          [
            store.tenantReference,
            store.scope.brandReference,
            store.scope.storeReference,
            store.tableReference,
          ],
        );
        assert.equal(locked.rowCount, 1, "the table's row is locked");
      };
      await withRequestAcquireBudget(
        async () => {
          // A check that locks a row and writes nothing.
          await store.restricted.run(lockTable);
          assert.ok(
            remainingRequestAcquireBudgetMs() !== undefined,
            "the read is still bounded by its request after a check that only locked rows",
          );
          // The rush: every connection of the pool is out on other work.
          for (let n = 0; n < apiPool.max; n += 1)
            held.push(await store.resources.database.acquire());
          await assert.rejects(store.restricted.run(lockTable));
          assert.equal(
            requestWasShed(),
            true,
            "the wait the rush turned away is noted as the rush",
          );
        },
        { budgetMs: 2500, answerWithinMs: 12_000 },
      );
    } finally {
      for (const client of held) client.release();
      await store?.close();
      await admin.end();
    }
  });
});
