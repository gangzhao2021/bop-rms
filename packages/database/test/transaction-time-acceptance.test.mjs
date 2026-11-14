// WP-2423 (logs-and-transaction-time, v15 2026-11-14) on a real isolated PostgreSQL, the code under
// test as a NOBYPASSRLS role holding exactly the rendered pilot ACL, through the pilot's own
// customer API composition (tooling/environment/pilot-api.mjs over the pilot's connection acquire).
// Under a burst the API's transactions stayed open up to 6.1 s (16 at once older than 1 s) while
// no statement waited more than 270 ms: each statement of a transaction costs a turn of the busy
// process, and a guest cart read's menu check sent 79 statements in one read-only snapshot for two
// dishes, about half of them repeats of a read it had already answered. Here the process is kept
// busy as in the rush (a timer that holds the event loop), a burst of cart reads runs on a pool of
// three, and both the statements each transaction sends and how long each stays open are
// measured: no transaction sends more than 40 statements, none stays open for 1 s, and every read
// is answered with both dishes. Before the fix (shown on e3703aa5): 79 statements, the oldest open
// 1159 ms with 3 at once older than 1 s, and 10 of 12 reads answered "busy" at 12 s.
import assert from "node:assert/strict";
import process from "node:process";
import { clearInterval, setInterval } from "node:timers";
import { setTimeout as sleep } from "node:timers/promises";
import pg from "pg";
import { it, vi } from "vitest";
import { createRuntime } from "../../../tooling/environment/pilot-api.mjs";
import { withIsolatedDatabase } from "../test-support/isolated-database.mjs";
import { prepareRealStaffRoundStore } from "../test-support/real-staff-round-store.mjs";
import { createPilotApiRole } from "../test-support/sole-operator-brand-gate.mjs";

const { Client } = pg;
const id = (n) => "01a7f100-0000-7000-8000-" + n.toString(16).padStart(12, "0");
const apiPool = { max: 3, connectionTimeoutMillis: 2000, acquireBudgetMs: 10_000 };
const burst = 12;
/** How long the busy process holds its event loop on each turn of the timer (the rush's lag). */
const busyTurnMs = 15;

/**
 * Counts the statements each transaction of the API's own connections sends (BEGIN to COMMIT or
 * ROLLBACK), by the connections' application name. Measurement only: every call goes on as sent.
 */
function countStatements(applicationName) {
  const transactions = [];
  const original = pg.Client.prototype.query;
  pg.Client.prototype.query = function (config, values, callback) {
    if (this.connectionParameters?.application_name === applicationName) {
      const text = typeof config === "string" ? config : (config?.text ?? "");
      const open = (this.__transactionCount ??= { open: false, statements: 0, first: "" });
      if (/^\s*BEGIN\b/iu.test(text)) {
        open.open = true;
        open.statements = 0;
        open.first = "";
      }
      if (open.open) {
        open.statements += 1;
        if (open.statements === 2) open.first = text.replace(/\s+/gu, " ").slice(0, 60);
        if (/^\s*(?:COMMIT|ROLLBACK)\s*;?\s*$/iu.test(text)) {
          open.open = false;
          transactions.push({ statements: open.statements, first: open.first });
        }
      }
    }
    return Reflect.apply(original, this, [config, values, callback]);
  };
  return {
    transactions,
    restore: () => {
      pg.Client.prototype.query = original;
    },
  };
}

it("under a busy burst of cart reads on a small pool no transaction stays open long or sends many statements", async () => {
  vi.stubEnv("NODE_ENV", "development");
  await withIsolatedDatabase({ caseId: "wp2423_txn_time" }, async (context) => {
    const admin = new Client(context.clientConfig);
    await admin.connect();
    let store = null;
    let runtime = null;
    let sent = null;
    try {
      const api = await createPilotApiRole(admin, context, "wp2423_tt");
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

      sent = countStatements(store.apiApplicationName);
      // The rush: the process is busy, so every statement's answer waits for its turn.
      const busy = setInterval(() => {
        const until = Date.now() + busyTurnMs;
        while (Date.now() < until);
      }, busyTurnMs);
      let sampling = true;
      let oldestMs = 0;
      let overOneSecond = 0;
      const sampler = (async () => {
        const watcher = new Client(context.clientConfig);
        await watcher.connect();
        try {
          while (sampling) {
            const row = (
              await watcher.query(
                "SELECT coalesce(max(extract(epoch FROM clock_timestamp()-xact_start)*1000),0)::int AS ms, count(*) FILTER (WHERE clock_timestamp()-xact_start > interval '1 second')::int AS over FROM pg_stat_activity WHERE datname=current_database() AND application_name=$1 AND xact_start IS NOT NULL",
                [store.apiApplicationName],
              )
            ).rows[0];
            oldestMs = Math.max(oldestMs, row.ms);
            overOneSecond = Math.max(overOneSecond, row.over);
            await sleep(50);
          }
        } finally {
          await watcher.end();
        }
      })();
      let answers;
      try {
        answers = await Promise.all(Array.from({ length: burst }, read));
      } finally {
        clearInterval(busy);
        sampling = false;
        await sampler;
      }
      sent.restore();
      const most = sent.transactions.reduce(
        (top, next) => (next.statements > top.statements ? next : top),
        { statements: 0, first: "" },
      );
      process.stderr.write(
        `transaction-time: ${sent.transactions.length} transactions, most statements ${most.statements} (${most.first}), oldest open ${oldestMs} ms, at once over 1 s ${overOneSecond}\n`,
      );
      for (const answer of answers) {
        assert.equal(answer.status, 200, "every guest's cart is read");
        assert.equal(answer.lines?.length, 2, "with both dishes");
      }
      assert.ok(
        most.statements <= 40,
        `no transaction sends more than 40 statements (most ${most.statements}: ${most.first})`,
      );
      assert.ok(oldestMs < 1000, `no transaction stays open 1 s (oldest ${oldestMs} ms)`);
      assert.equal(overOneSecond, 0, "none at once older than 1 s");
    } finally {
      sent?.restore();
      await new Promise((resolve) =>
        runtime?.server?.listening ? runtime.server.close(resolve) : resolve(),
      );
      await store?.close();
      await admin.end();
    }
  });
});
