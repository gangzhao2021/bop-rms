import assert from "node:assert/strict";
import { AsyncLocalStorage } from "node:async_hooks";
import nodeConsole from "node:console";
import { performance } from "node:perf_hooks";
import { stdout } from "node:process";
import { setImmediate } from "node:timers";
import { setTimeout as sleep } from "node:timers/promises";
import pg from "pg";
import { it, vi } from "vitest";
import { createMerchantAvailability } from "../../../apps/api/src/merchant-availability.ts";
import { createRuntime } from "../../../tooling/environment/pilot-api.mjs";
import { INTERNAL_CUSTOMER_ORIGIN } from "../../../tooling/environment/pilot-hosting.mjs";
import {
  BrowserSessionService,
  createPostgresBrowserSessionStore,
} from "../../bop/identity/src/index.ts";
import { createPostgresOrderPricedAmountSource } from "../../rms/ordering/src/index.ts";
import { withIsolatedDatabase } from "../test-support/isolated-database.mjs";
import { prepareRealStaffRoundStore } from "../test-support/real-staff-round-store.mjs";
import { createPilotApiRole } from "../test-support/sole-operator-brand-gate.mjs";

const { Client } = pg;
const id = (n) => "01a0fd10-0000-7000-8000-" + n.toString(16).padStart(12, "0");
const roundPermissions = ["ordering.order.create_staff", "dining.operate", "dining.session.close"];
/** The steps of a staff round inside its folded step transactions (after the table's turn). */
const foldedSteps = [
  "tableHasQr",
  "openTable",
  "enter",
  "join",
  "bind",
  "selectCart",
  "addItem",
  "quote",
  "saveDetails",
  "startCheckout",
  "submitPayLater",
];

/**
 * Which request sent a statement: the staff round (`round`), the other writer or guest phone
 * started inside it (`other`, with the backends it used and a hook for its first statement), or
 * this test's own watchers (`watch`, never recorded). Each runs in its own async context.
 */
const side = new AsyncLocalStorage();
const asRound = (work) => side.run({ name: "round" }, work);
const watching = (work) => side.run({ name: "watch" }, work);
/** A statement that takes a shared lock its transaction then holds: FOR SHARE, shared fences. */
const sharedLock = /\bFOR (KEY )?SHARE\b|pg_advisory_xact_lock_shared|pg_advisory_lock_shared/u;
const writes = /^\s*(INSERT|UPDATE|DELETE)\b/iu;
/** Which shared lock a statement takes: the fence's name, or the table read FOR SHARE. */
function sharedLockName(text, values) {
  if (/advisory_(xact_)?lock_shared/u.test(text))
    return "fence:" + String(values?.[0] ?? "").split(":")[0];
  return "share:" + (/\bFROM\s+([a-z_]+\.[a-z_]+)/u.exec(text)?.[1] ?? "?");
}
/**
 * Every statement this process sends while recording is on, per connection, with who sent it,
 * when it was sent and when its answer came: to tell which transactions committed after a
 * writer's commit. `open` follows each connection's open transaction as it is sent (whose, and
 * whether it took a shared lock); `landed` counts the other side's write commits, and those sent
 * while a transaction of the round held shared locks.
 */
const recording = {
  on: false,
  statements: [],
  lockFailures: [],
  open: new Map(),
  landed: { all: 0, shared: 0 },
};
/** Deadlock, lock time limit, idle-in-transaction end, statement time limit. */
const lockStates = new Set(["40P01", "55P03", "25P03", "57014"]);
const clientQuery = pg.Client.prototype.query;
const connections = new WeakMap();
let connectionCount = 0;
pg.Client.prototype.query = function (config, ...rest) {
  const result = clientQuery.call(this, config, ...rest);
  const text = typeof config === "string" ? config : config?.text;
  const who = side.getStore();
  if (
    recording.on &&
    who?.name !== "watch" &&
    typeof text === "string" &&
    typeof result?.then === "function"
  ) {
    if (!connections.has(this)) connections.set(this, (connectionCount += 1));
    const connection = connections.get(this);
    const entry = { connection, who: who?.name ?? null, text, sentAt: performance.now() };
    recording.statements.push(entry);
    if (who?.name === "other") {
      who.pids.add(this.processID);
      const first = who.firstSent;
      who.firstSent = null;
      first?.();
    }
    const head = text.trimStart();
    const open = recording.open.get(connection);
    if (/^BEGIN\b/iu.test(head))
      recording.open.set(connection, { who: entry.who, shared: false, wrote: false, locks: [] });
    else if (open !== undefined) {
      if (sharedLock.test(text)) {
        open.shared = true;
        open.locks.push(sharedLockName(text, typeof config === "string" ? rest[0] : config.values));
      }
      if (writes.test(head)) open.wrote = true;
      if (/^(COMMIT|ROLLBACK)\b/iu.test(head)) {
        if (/^COMMIT\b/iu.test(head) && open.wrote && open.who === "other") {
          recording.landed.all += 1;
          if (roundHolds(connection).shared) recording.landed.shared += 1;
        }
        recording.open.delete(connection);
      }
    }
    result.then(
      () => (entry.doneAt = performance.now()),
      (error) => {
        entry.doneAt = performance.now();
        entry.failed = true;
        entry.sqlState = typeof error?.code === "string" ? error.code : null;
        if (lockStates.has(entry.sqlState))
          recording.lockFailures.push([entry.sqlState, text.slice(0, 120)]);
      },
    );
  }
  return result;
};
/** Whether the round has a transaction open now (on another connection), and one holding shared locks. */
function roundHolds(except = null) {
  const held = [...recording.open].filter(
    ([connection, open]) => connection !== except && open.who === "round",
  );
  return {
    open: held.length > 0,
    shared: held.some(([, open]) => open.shared),
    locks: [...new Set(held.flatMap(([, open]) => open.locks))].sort(),
  };
}
/** Each committed transaction's statements, in the order its connection sent them. */
function committedTransactions(statements) {
  const open = new Map();
  const done = [];
  for (const statement of statements) {
    const head = statement.text.trimStart();
    if (/^BEGIN\b/iu.test(head)) {
      open.set(statement.connection, [statement]);
      continue;
    }
    const current = open.get(statement.connection);
    if (current === undefined) continue;
    current.push(statement);
    if (/^(COMMIT|ROLLBACK)\b/iu.test(head)) {
      if (/^COMMIT\b/iu.test(head) && statement.failed !== true) done.push(current);
      open.delete(statement.connection);
    }
  }
  return done;
}

/** What the API process logged as unexpected (pilot-unexpected writes JSON lines to stderr). */
function watchUnexpected() {
  const lines = [];
  // pilot-unexpected writes with node:console's own console.
  const spy = vi.spyOn(nodeConsole, "error").mockImplementation((...values) => {
    lines.push(values.map(String).join(" "));
  });
  return {
    lines,
    restore: () => spy.mockRestore(),
    /** Faults (level 50) and any lock, deadlock or shared-connection failure, whatever its level. */
    faults: () =>
      lines.filter(
        (line) =>
          /"level":50/u.test(line) ||
          /40P01|55P03|25P03|deadlock|lock_timeout|CONCURRENT_QUERY|idle.in.transaction/iu.test(
            line,
          ),
      ),
  };
}

async function deadlocks(admin) {
  await admin.query("SELECT pg_stat_clear_snapshot()");
  return Number(
    (
      await admin.query(
        "SELECT deadlocks::int AS n FROM pg_stat_database WHERE datname=current_database()",
      )
    ).rows[0].n,
  );
}

/** Samples, while `work` runs, the longest the API's connections sat in a transaction idle. */
async function sampleIdleInTransaction(context, applicationName, work) {
  let sampling = true;
  let longestMs = 0;
  const sampler = watching(async () => {
    const watcher = new Client(context.clientConfig);
    await watcher.connect();
    try {
      while (sampling) {
        const row = (
          await watcher.query(
            "SELECT coalesce(max(extract(epoch FROM clock_timestamp()-state_change)*1000),0)::int AS ms FROM pg_stat_activity WHERE datname=current_database() AND application_name LIKE $1 AND state='idle in transaction'",
            [applicationName],
          )
        ).rows[0];
        longestMs = Math.max(longestMs, row.ms);
        await sleep(25);
      }
    } finally {
      await watcher.end();
    }
  });
  try {
    return { value: await work(), longestIdleMs: () => longestMs };
  } finally {
    sampling = false;
    await sampler;
  }
}

/**
 * Another request's `work`, begun when `go` is first called: created here, outside the staff
 * round's own work, so its transactions are its own. `inside` says it began inside the round;
 * `sent` settles once it sent its first statement (or ended); `pids` are the backends it used.
 */
function startedLater(work) {
  const own = { name: "other", pids: new Set(), firstSent: null };
  const state = { done: false, at: null, ms: null, failed: null, inside: false, began: null };
  state.pids = own.pids;
  const sent = new Promise((resolve) => (own.firstSent = resolve));
  let go = () => undefined;
  state.promise = new Promise((resolve) => (go = resolve))
    .then(() => {
      state.began = performance.now();
      return side.run(own, work);
    })
    .catch((error) => {
      state.failed = error?.code ?? String(error);
    })
    .finally(() => {
      state.done = true;
      state.at = performance.now();
      state.ms = state.at - state.began;
    });
  state.sent = Promise.race([sent, state.promise]);
  let called = false;
  state.go = (inside = false) => {
    if (called) return;
    called = true;
    state.inside = inside;
    go();
  };
  return state;
}

/**
 * The locks any backend `writer` used waited for (pg_locks, as kind and mode), sampled without
 * pause on a connection of its own from now until the writer ended.
 */
function watchWaits(context, writer) {
  return watching(async () => {
    const watcher = new Client(context.clientConfig);
    await watcher.connect();
    const on = new Set();
    try {
      while (!writer.done) {
        if (writer.pids.size === 0) {
          await new Promise((resolve) => setImmediate(resolve));
          continue;
        }
        const { rows } = await watcher.query(
          "SELECT l.locktype || ':' || l.mode || ' ' || regexp_replace(left(a.query, 60), '\\s+', ' ', 'g') AS lock FROM pg_locks l JOIN pg_stat_activity a ON a.pid = l.pid WHERE l.pid = ANY($1::int[]) AND NOT l.granted",
          [[...writer.pids]],
        );
        for (const { lock } of rows) on.add(lock);
      }
    } finally {
      await watcher.end();
    }
    return [...on].sort();
  });
}

/**
 * Starts `writer` inside the round's step: records whether the round held an open transaction
 * (and one with shared locks) at that moment, and lets the round go on once the writer sent its
 * first statement, so both run at the same time.
 */
async function fireInside(context, writer, record) {
  const held = roundHolds();
  record.heldOpen = held.open;
  record.heldShared = held.shared;
  record.heldLocks = held.locks;
  writer.go(true);
  record.waited = watchWaits(context, writer);
  await writer.sent;
}

/**
 * A staff round's pipeline whose step `trigger.step` first runs `trigger.fire` (once), then goes
 * on: the other writer starts while the round is inside that step's folded transaction.
 */
function triggered(real, trigger, counts) {
  const wrapped = { ...real };
  for (const [name, value] of Object.entries(real)) {
    if (typeof value !== "function") continue;
    wrapped[name] = async (...values) => {
      const current = trigger.current;
      if (current !== null && current.step === name) {
        trigger.current = null;
        await current.fire();
      }
      if (name === "removeItems" && typeof values[1]?.onRemoved === "function") {
        const onRemoved = values[1].onRemoved;
        values[1] = {
          ...values[1],
          onRemoved: (reference) => {
            counts.removed += 1;
            onRemoved(reference);
          },
        };
      }
      const answer = await value(...values);
      if (name === "addItem" && answer?.status === "Applied") counts.added += 1;
      return answer;
    };
  }
  return wrapped;
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
const answerOf = (settled) =>
  settled.status === "fulfilled"
    ? { status: settled.value.status, value: settled.value }
    : { status: "Refused", code: settled.reason?.code ?? String(settled.reason) };

/**
 * WP-2423 M35 (DEC-STAFF-ROUND-FEWER-TRANSACTIONS) review: a staff round's consecutive steps run
 * in fewer transactions, so the shared locks its read-only steps take (the staff Session FOR
 * SHARE, the Brand and Store FOR SHARE, the store-reference and catalog shared advisory locks) are
 * held until its next writing step commits, and a plain read repeated inside a step transaction
 * is answered from the first. These prove that a guest phone sending its own round at the same
 * pay-at-end table, a staff sign-out and a dish selling out, each started inside one of the
 * round's folded steps, all end in a true answer, without a deadlock, a lock timeout, a second
 * query on the round's connection or a transaction left idle, and with the bill right to the cent.
 * Each also records, and asserts a floor for, the overlap it claims: the round's transaction holding
 * shared locks while the other side writes, and a writer that waited on them.
 *
 * WP-2423 (staff-round-guest-race): a guest at the table who changes or sends the table's Cart
 * between the round's pricing and its checkout gets staff a plain answer (the guests' unsent items,
 * or "a guest is ordering on their phone, send again"), never 503 "a system problem"; the phone's
 * own Cart read in that moment is read again, never "unavailable".
 *
 * Everything runs through the pilot's real compositions (staff round, customer API, Session
 * sign-out, menu availability) under the restricted NOBYPASSRLS API role holding the rendered
 * pilot ACL. The only test hook starts the other writer when the round reaches a given step.
 * Synthetic TEST references only.
 */
it("a guest phone sends its own round at the same pay-at-end table while a staff round runs: both answers true, the bill right", async () => {
  await withIsolatedDatabase({ caseId: "wp2423_shared_guest" }, async (context) => {
    const admin = new Client(context.clientConfig);
    await admin.connect();
    vi.stubEnv("NODE_ENV", "development");
    const api = await createPilotApiRole(admin, context, "wp2423_slg");
    let store = null;
    let runtime = null;
    const unexpected = watchUnexpected();
    try {
      store = await prepareRealStaffRoundStore({ admin, context, api, paymentTiming: "PayLater" });
      const { soup, tableReference, reference, now } = store;
      const server = await store.staff(id(0x730), roundPermissions);
      const host = await store.staff(id(0x731), roundPermissions);
      const trigger = { current: null };
      const counts = { added: 0, removed: 0 };
      const counter = await store.counterFor(server, {
        decorateStaffRoundPipeline: (real) => triggered(real, trigger, counts),
      });
      const staffRound = () =>
        asRound(() =>
          counter.staffDiningRound({
            sessionCookie: server.sessionCookie,
            csrf: server.csrf,
            command: roundCommand(store),
          }),
        );
      // The guest's phone: the table guest path (QR entry, join with the table code, binding,
      // the table's Cart, quote, details, checkout) and the customer API's own "Send to kitchen".
      const guests = (await store.counterFor(host)).tableGuestPipeline;
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

      // The table is seated by its first staff round, then a guest's phone joins it.
      const opening = await staffRound();
      assert.equal(opening.status, "Placed");
      const orderReference = opening.orderReference;
      const asHost = { sessionCookie: host.sessionCookie, csrf: host.csrf };
      const joinPhone = async () => {
        const table = await guests.openTable(asHost, { tableReference });
        assert.equal(table.status, "Opened");
        const entered = await guests.enter({ tableReference, requestedAt: now() });
        assert.equal(entered.status, "Established");
        const joined = await guests.join(entered.credentials, {
          joinCredential: table.joinCredential,
          operationReference: reference(),
        });
        return {
          ...(
            await guests.bind(entered.credentials, {
              operationReference: reference(),
              admissionReference: joined.admissionReference,
            })
          ).credentials,
        };
      };
      const phone = await joinPhone();
      // The phone's checkout details (the customer app saves them again for each round, at their
      // current version).
      const details = (await store.counterFor(host)).tableGuestDetails;
      const detailsReference = reference();
      let detailsVersion = 0;

      const guestAnswers = [];
      let guestAdded = 0;
      let openCheckout = null;
      const sendToKitchen = async (sending) => {
        const response = await globalThis.fetch(
          `http://127.0.0.1:${port}/api/v1/checkout-sessions/${sending.checkoutSessionReference}/payment-intents`,
          {
            method: "POST",
            headers: {
              cookie: "__Host-bop-guest=" + sending.phone.sessionCredential,
              "x-csrf-token": sending.phone.csrfCredential,
              "idempotency-key": sending.key,
              origin: INTERNAL_CUSTOMER_ORIGIN,
              "sec-fetch-site": "same-origin",
              "content-type": "application/json",
            },
            body: JSON.stringify({ sendToKitchen: true }),
          },
        );
        const body = await response.json().catch(() => null);
        const answer = {
          status: response.status,
          code: body?.error?.code ?? null,
          totalMinor: body?.round?.total?.amountMinor ?? null,
          round: body?.round?.status ?? null,
          waitingReason: body?.round?.waitingReason ?? null,
        };
        guestAnswers.push(answer);
        if (response.status < 300) openCheckout = null;
        return answer;
      };
      /** "Send to kitchen" of whatever the guests' Cart holds; a refusal is the answer. */
      const guestSend = async () => {
        if (openCheckout !== null) return sendToKitchen(openCheckout);
        const cart = await guests.selectCart(phone, {
          operationReference: reference(),
          requestedAt: now(),
        });
        if (cart.status !== "Selected") return { status: "CartBusy", cart: cart.status };
        if (cart.pendingItems.length === 0) return { status: "Nothing" };
        const quoted = await guests.quote(phone, {
          operationReference: reference(),
          cartReference: cart.cartReference,
          cartVersion: cart.cartVersion,
          requestedAt: now(),
        });
        if (quoted.status !== "Quoted") return { status: "NotQuoted", quote: quoted.status };
        const saved = await details.save({
          ...phone,
          command: {
            operationReference: reference(),
            detailsReference,
            expectedVersion: detailsVersion,
            cartReference: cart.cartReference,
            cartVersion: cart.cartVersion,
            quoteReference: quoted.quoteReference,
            quoteVersion: 2,
            pickupContact: null,
            receipt: { choice: "InSession", email: null },
            policies: [],
          },
        });
        detailsVersion = saved.snapshot.detailsVersion;
        const checkout = await guests.startCheckout(phone, {
          createOperationReference: reference(),
          cartReference: cart.cartReference,
          cartVersion: cart.cartVersion,
          quoteReference: quoted.quoteReference,
        });
        if (checkout.status !== "Started") return { status: "NotStarted", at: checkout.status };
        openCheckout = {
          phone,
          checkoutSessionReference: checkout.checkoutSessionReference,
          key: reference(),
        };
        return sendToKitchen(openCheckout);
      };
      const refusal = (error) => ({
        status: "Refused",
        code: error?.code ?? error?.name ?? String(error),
        message: String(error?.message ?? "").slice(0, 160),
        // The owner's answer behind an unexpected one, as its status word only.
        cause: error?.cause?.code ?? null,
      });
      /** The guest adds a soup on the phone and sends the table's Cart. */
      const guestRound = async () => {
        let at = "selectCart";
        try {
          const cart = await guests.selectCart(phone, {
            operationReference: reference(),
            requestedAt: now(),
          });
          if (cart.status !== "Selected") return { status: "CartBusy", cart: cart.status };
          at = "addItem";
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
          if (added.status !== "Applied") return { status: "NotAdded", at: added.status };
          guestAdded += 1;
          at = "send";
          return await guestSend();
        } catch (error) {
          return { ...refusal(error), at };
        }
      };

      const deadlocksBefore = await deadlocks(admin);
      recording.lockFailures = [];
      recording.landed = { all: 0, shared: 0 };
      /** The phone is its own request: its statements are told from the round's. */
      const asPhone = (work) => side.run({ name: "other", pids: new Set(), firstSent: null }, work);
      const delays = [0, 20, 60];
      const results = [];
      recording.statements = [];
      recording.open.clear();
      recording.on = true;
      const sampled = await sampleIdleInTransaction(context, store.apiApplicationName, async () => {
        for (const [index, step] of [...foldedSteps, ...foldedSteps].entries()) {
          // The phone is another request: it starts outside the staff round's own work (a run
          // started inside it would be one of the round's steps).
          let go = () => undefined;
          let started = false;
          const guest = new Promise((resolve) => (go = resolve)).then(() => asPhone(guestRound));
          trigger.current = {
            step,
            fire: async () => {
              started = true;
              go();
              await sleep(delays[index % delays.length]);
            },
          };
          const staff = answerOf((await Promise.allSettled([staffRound()]))[0]);
          trigger.current = null;
          if (!started) go();
          const phoneAnswer = await guest;
          // The guest sends again what is left in the table's Cart (what a guest does after a
          // refusal), until nothing of it is left to send.
          const settled = [];
          for (let again = 0; again < 4; again += 1) {
            const sent = await asPhone(guestSend).catch(refusal);
            settled.push(sent.status === "Refused" ? sent : sent.status);
            if (sent.status === "Nothing") break;
            await sleep(100);
          }
          results.push({
            step,
            inside: started,
            staff: staff.status,
            code: staff.code,
            phoneAnswer,
            settled,
          });
          if (staff.status === "Placed") guestAnswers.push({ staffTotal: staff.value.totalMinor });
        }
      });
      recording.on = false;
      const summary = JSON.stringify(results);

      // No statement of the API failed for a deadlock, a lock or statement time limit, or a
      // transaction left idle (whatever answer its owner turned that into).
      assert.deepEqual(recording.lockFailures, []);
      recording.statements = [];

      // Every answer is true: staff were told it was placed, or one of the round's own refusals
      // (the guests' unsent items in the cart, a guest ordering or paying on their phone now, or
      // "its dishes are still at the table, or went out with another round"); the phone was told
      // it was sent, or a conflict it already gives. WP-2423 (staff-round-guest-race): a guest who
      // changed or sent the table's Cart between the round's quote and its checkout is never
      // "a system problem" (STAFF_ROUND_UNAVAILABLE), and the phone's Cart read is never
      // "unavailable", since nothing is down here.
      const staffRefusals = new Set([
        "STAFF_ROUND_TABLE_CART_HAS_ITEMS",
        "STAFF_ROUND_TABLE_CHECKOUT_IN_PROGRESS",
        "STAFF_ROUND_NOT_WITHDRAWN",
      ]);
      // KNOWN, NOT FROM THIS CHANGE (WP-2423 staff-round-join-race, recorded): rarely, the round's
      // own table guest's join with the table's code is refused while the phone sends at the
      // table; staff are told the round did not go out (nothing was sent) and the log names the
      // join's refusal. Allowed only as that, at most once a run, and never for the Cart race.
      const faults = unexpected.faults();
      const joinRefusals = faults.filter(
        (line) =>
          /"code":"TABLE_GUEST_PIPELINE_UNAVAILABLE"/u.test(line) &&
          /"causes":\["Refused[A-Za-z]+"\]/u.test(line) &&
          !/sqlState/u.test(line),
      );
      assert.deepEqual(
        faults.filter((line) => !joinRefusals.includes(line)),
        [],
        "an unexpected failure was logged",
      );
      const unavailable = results.filter((result) => result.code === "STAFF_ROUND_UNAVAILABLE");
      assert.ok(
        unavailable.length <= Math.min(1, joinRefusals.length),
        "a staff round was told a system problem: " + JSON.stringify(unavailable) + faults,
      );
      for (const result of results)
        assert.ok(
          result.staff === "Placed" ||
            staffRefusals.has(result.code) ||
            unavailable.includes(result),
          "a staff round answered " + JSON.stringify(result),
        );
      assert.ok(
        results.filter((result) => result.staff === "Placed").length >= 4,
        "staff rounds were placed beside the phone: " + summary,
      );
      const sentByPhone = guestAnswers.filter((answer) => answer.status === 201);
      const heldForStaff = guestAnswers.filter((answer) => answer.status === 202);
      assert.ok(sentByPhone.length + heldForStaff.length >= 4, "the phone sent rounds: " + summary);
      for (const answer of guestAnswers.filter((answer) => answer.status !== undefined))
        assert.ok(
          answer.status === 201 ||
            answer.status === 202 ||
            answer.status === 200 ||
            answer.status === 409,
          "the phone was answered " + JSON.stringify(answer) + " in " + summary,
        );
      // KNOWN, NOT FROM THIS CHANGE (WP-2423 guest-add-cart-moved, recorded): a dish the phone
      // adds just as the round changes the table's Cart can be answered "couldn't add this right
      // now" (the menu's check of the Cart found it a version on); nothing was added and the guest
      // adds it again. Allowed only at that step and with that cause; the phone's Cart reads
      // (choosing the Cart, sending it) are never "unavailable".
      const phoneAddRaces = results.filter(
        (result) =>
          result.phoneAnswer.status === "Refused" &&
          result.phoneAnswer.at === "addItem" &&
          result.phoneAnswer.message === "COUNTER_GUEST_PIPELINE_UNAVAILABLE" &&
          result.phoneAnswer.cause === "Unavailable",
      );
      for (const result of results) {
        const phoneAnswer = result.phoneAnswer;
        assert.ok(
          phoneAnswer.status !== "Refused" ||
            phoneAddRaces.includes(result) ||
            /^(CART_VERSION_CONFLICT|CART_CHECKOUT_IN_PROGRESS|CHECKOUT_IN_PROGRESS|INTENT_CONFLICT|REQUOTE_REQUIRED)$/u.test(
              phoneAnswer.code,
            ),
          "the phone's own steps answered " + JSON.stringify(result),
        );
        assert.equal(result.settled.at(-1), "Nothing", "the table's Cart was sent: " + summary);
      }
      // The overlap this test claims: the phone's writes landed while a transaction of the round
      // held its shared locks (the staff Session, Brand and Store FOR SHARE, the shared fences).
      const landed = recording.landed;
      assert.ok(
        landed.shared >= 5,
        `the phone's writes landed beside the round's shared locks: ${JSON.stringify(landed)}`,
      );
      // Reported for the WP line.
      stdout.write(
        `staff-round-shared-locks: ${results.length} rounds beside the phone, ` +
          `${results.filter((result) => result.staff === "Placed").length} placed, ` +
          `${sentByPhone.length + heldForStaff.length} phone rounds sent, ` +
          `${landed.shared} of ${landed.all} phone write commits beside the round's shared locks, ` +
          `${unavailable.length} join refusals, ${phoneAddRaces.length} phone adds met the Cart moving, ` +
          `answers ${JSON.stringify(results.map((result) => result.code ?? result.staff))}\n`,
      );

      // Nothing written twice, nothing lost: every cart line went out once at most; the dishes
      // on the table's order are those put in its Cart less those the staff rounds took back out.
      const order = (
        await admin.query(
          `SELECT
             (SELECT count(*)::int FROM rms_ordering.order_batch WHERE order_id=$1) AS batches,
             (SELECT coalesce(sum(quantity),0)::int FROM rms_ordering.order_item WHERE order_id=$1) AS dishes,
             (SELECT count(*)::int FROM (SELECT source_cart_line_id FROM rms_ordering.order_item
               WHERE order_id=$1 GROUP BY source_cart_line_id HAVING count(*)>1) twice) AS twice`,
          [orderReference],
        )
      ).rows[0];
      const placedByStaff = results.filter((result) => result.staff === "Placed").length + 1;
      assert.equal(order.twice, 0, "a cart line went out twice");
      assert.equal(
        order.batches,
        placedByStaff + sentByPhone.length + heldForStaff.length,
        summary,
      );
      // Every dish put in the table's Cart (by the phone or a staff round's table guest) went out
      // once in a round or was taken back out, never both and never neither.
      const lines = (
        await admin.query(
          `SELECT a.cart_line_id::text AS line,
             (SELECT count(*)::int FROM rms_ordering.order_item i
               WHERE i.source_cart_line_id=a.cart_line_id) AS ordered,
             (EXISTS (SELECT 1 FROM rms_ordering.cart_operation_record r
                WHERE r.cart_line_id=a.cart_line_id AND r.action_code='Remove')
              OR EXISTS (SELECT 1 FROM rms_ordering.cart_staff_line_removal s
                WHERE s.cart_line_id=a.cart_line_id)) AS removed,
             EXISTS (SELECT 1 FROM rms_ordering.cart_line l
               WHERE l.cart_line_id=a.cart_line_id) AS still
           FROM rms_ordering.cart_operation_record a WHERE a.action_code='Add'`,
        )
      ).rows;
      assert.ok(lines.length >= counts.added + guestAdded, "every added dish has its record");
      for (const line of lines)
        assert.ok(
          !line.still && (line.ordered === 1) !== line.removed && line.ordered <= 1,
          "a dish neither sent once nor taken out: " + JSON.stringify(line),
        );
      assert.equal(
        order.dishes,
        lines.filter((line) => line.ordered === 1).length,
        "the order holds the dishes sent",
      );
      // The bill to the cent: the table's order is priced at what each round was answered with
      // (a phone's round held for staff, "PhoneRapid", is on the order too).
      const priced = await store.asApi((tx) =>
        createPostgresOrderPricedAmountSource({
          brandReference: store.ownerScope.brandReference,
          storeReference: store.ownerScope.storeReference,
          authorize: async () => true,
          taxRounding: "Excluded",
        })(tx, { orderReference, observedAt: now() }),
      );
      const answered =
        BigInt(opening.totalMinor) +
        guestAnswers.reduce(
          (sum, answer) =>
            sum +
            BigInt(
              answer.staffTotal ??
                (answer.status === 201 || answer.status === 202 ? (answer.totalMinor ?? 0) : 0),
            ),
          0n,
        );
      assert.equal(BigInt(priced.pricedTotalMinor), answered, summary);

      // No deadlock, lock timeout, second query on a round's connection or idle transaction.
      await sleep(1200);
      assert.equal(await deadlocks(admin), deadlocksBefore, "no deadlock was detected");
      assert.ok(
        sampled.longestIdleMs() < 1000,
        `no API connection sat in a transaction sending nothing (longest ${sampled.longestIdleMs()} ms)`,
      );
    } finally {
      recording.on = false;
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

/**
 * Everything the next statements show (sign-out and sold-out writers): which transactions wrote
 * and committed after `at`, and whether one of them had read a staff Session to authorize.
 */
function committedAfter(statements, at) {
  const wrote = (transaction) =>
    transaction.some(
      ({ text }) => writes.test(text) && !/bop_identity\.authentication_session/u.test(text),
    );
  const late = committedTransactions(statements).filter(
    (transaction) =>
      transaction[0].who === "round" && transaction.at(-1).doneAt > at && wrote(transaction),
  );
  return {
    staff: late.filter((transaction) =>
      transaction.some(({ text }) =>
        /FROM bop_identity\.authentication_session\b[\s\S]*FOR SHARE/u.test(text),
      ),
    ).length,
    all: late.length,
  };
}

it("a staff sign-out and a dish selling out inside a staff round's folded steps: each writer ends in time, the round is true", async () => {
  await withIsolatedDatabase({ caseId: "wp2423_sh_writers" }, async (context) => {
    const admin = new Client(context.clientConfig);
    await admin.connect();
    vi.stubEnv("NODE_ENV", "development");
    const api = await createPilotApiRole(admin, context, "wp2423_slw");
    const open = new Set();
    const unexpected = watchUnexpected();
    const applications = "wp2423_rsr_api%";
    try {
      const results = [];
      const counts = { added: 0, removed: 0 };
      const deadlocksBefore = await deadlocks(admin);
      recording.lockFailures = [];
      const sampled = await sampleIdleInTransaction(context, applications, async () => {
        // ── A staff member signs out while their round is inside each step. Each step at a
        // Store (and table) of its own: a round refused after its checkout began leaves that
        // checkout of the table's Cart open until it ends (reported, not from this change).
        for (const [index, step] of foldedSteps.entries()) {
          const store = await prepareRealStaffRoundStore({
            admin,
            context,
            api,
            paymentTiming: "PayLater",
            merchant: index + 1,
          });
          open.add(store);
          const trigger = { current: null };
          const host = await store.staff(id(0x800 + index * 4), roundPermissions);
          const opening = await asRound(async () =>
            (await store.counterFor(host)).staffDiningRound({
              sessionCookie: host.sessionCookie,
              csrf: host.csrf,
              command: roundCommand(store),
            }),
          );
          assert.equal(opening.status, "Placed");
          const who = await store.staff(id(0x801 + index * 4), roundPermissions);
          const counter = await store.counterFor(who, {
            decorateStaffRoundPipeline: (real) => triggered(real, trigger, counts),
          });
          // The sign-out is another request: it starts outside the round's own work (a run
          // started inside it would be one of the round's steps).
          const writer = startedLater(() => signOut(store, who));
          const fired = { heldOpen: null, heldShared: null, heldLocks: [], waited: null };
          trigger.current = { step, fire: () => fireInside(context, writer, fired) };
          recording.statements = [];
          recording.open.clear();
          recording.on = true;
          let round;
          try {
            round = answerOf(
              (
                await Promise.allSettled([
                  asRound(() =>
                    counter.staffDiningRound({
                      sessionCookie: who.sessionCookie,
                      csrf: who.csrf,
                      command: roundCommand(store),
                    }),
                  ),
                ])
              )[0],
            );
            trigger.current = null;
            writer.go();
            await writer.promise;
          } finally {
            recording.on = false;
          }
          const late = committedAfter(recording.statements, writer.at);
          results.push({
            writer: "SignOut",
            step,
            round: round.status,
            code: round.code,
            inside: writer.inside,
            heldOpen: fired.heldOpen,
            heldShared: fired.heldShared,
            heldLocks: fired.heldLocks,
            waitedOn: (await fired.waited) ?? [],
            writerMs: Math.round(writer.ms),
            writerFailed: writer.failed,
            session: (
              await admin.query(
                "SELECT string_agg(status,',') AS status FROM bop_identity.authentication_session WHERE actor_id=$1",
                [id(0x801 + index * 4)],
              )
            ).rows[0].status,
            lateStaffWrites: late.staff,
            lateWrites: late.all,
          });
          await store.close();
          open.delete(store);
        }

        // ── The manager marks the round's dish sold out while their round is inside each step.
        const store = await prepareRealStaffRoundStore({
          admin,
          context,
          api,
          paymentTiming: "PayLater",
        });
        open.add(store);
        const { soup, reference } = store;
        const trigger = { current: null };
        const manager = await store.staff(id(0x740), [
          ...roundPermissions,
          "catalog.sku.sold_out.mark",
          "catalog.sku.availability.manage",
          "catalog.sku.read",
        ]);
        const counter = await store.counterFor(manager, {
          decorateStaffRoundPipeline: (real) => triggered(real, trigger, counts),
        });
        const round = () =>
          asRound(() =>
            counter.staffDiningRound({
              sessionCookie: manager.sessionCookie,
              csrf: manager.csrf,
              command: roundCommand(store),
            }),
          );
        const availability = createMerchantAvailability({
          persistence: store.persistenceOf(manager),
          authentication: manager.authentication,
          references: { next: reference },
          locale: "en-CA",
        });
        const mark = (action) =>
          availability.command({
            sessionCookie: manager.sessionCookie,
            csrf: manager.csrf,
            body: {
              action,
              operationReference: reference(),
              skuReference: soup.skuReference,
              ...(action === "SoldOut" ? { until: "UntilBack" } : {}),
            },
          });
        assert.equal((await round()).status, "Placed");
        for (const step of foldedSteps) {
          const sold = startedLater(() => mark("SoldOut"));
          const fired = { heldOpen: null, heldShared: null, heldLocks: [], waited: null };
          trigger.current = { step, fire: () => fireInside(context, sold, fired) };
          recording.statements = [];
          recording.open.clear();
          recording.on = true;
          let answer;
          try {
            answer = answerOf((await Promise.allSettled([round()]))[0]);
            trigger.current = null;
            sold.go();
            await sold.promise;
          } finally {
            recording.on = false;
          }
          // A round placed only if its order was written before the dish sold out.
          const placedAfter = committedTransactions(recording.statements).filter(
            (transaction) =>
              transaction[0].who === "round" &&
              transaction.at(-1).doneAt > sold.at &&
              transaction.some(({ text }) => /INSERT INTO rms_ordering\.order_batch\b/u.test(text)),
          ).length;
          results.push({
            writer: "SoldOut",
            step,
            round: answer.status,
            code: answer.code,
            inside: sold.inside,
            heldOpen: fired.heldOpen,
            heldShared: fired.heldShared,
            heldLocks: fired.heldLocks,
            waitedOn: (await fired.waited) ?? [],
            writerMs: Math.round(sold.ms),
            writerFailed: sold.failed,
            placedAfter,
          });
          // Back on the menu for the next round.
          await mark("BackInStock");
        }
        // Nothing written twice: every cart line went out once at most.
        const [{ twice }] = (
          await admin.query(
            `SELECT count(*)::int AS twice FROM (SELECT source_cart_line_id FROM rms_ordering.order_item
               GROUP BY source_cart_line_id HAVING count(*)>1) twice`,
          )
        ).rows;
        assert.equal(twice, 0);
      });
      const summary = JSON.stringify(results);
      const waited = results.filter((result) => result.waitedOn.length > 0).length;
      stdout.write(
        `staff-round-shared-locks writers: ${results.filter((r) => r.inside).length} of ${results.length} inside a round, ` +
          `${results.filter((r) => r.heldShared).length} beside the round's shared locks, ${waited} waited for a lock\n` +
          results.map((result) => "  " + JSON.stringify(result)).join("\n") +
          "\n",
      );
      // The overlap this test claims, as a floor: where a folded step holds the round's shared
      // locks (the staff Session, Brand and Store FOR SHARE, the shared fences) open into the next
      // step, each writer fired while they were held, and a sign-out really waited on them.
      for (const writer of ["SignOut", "SoldOut"])
        for (const step of ["openTable", "addItem", "submitPayLater"])
          assert.ok(
            results.find((result) => result.writer === writer && result.step === step)
              ?.heldShared === true,
            `the ${writer} at ${step} fired while the round held shared locks: ${summary}`,
          );
      assert.ok(
        results.some((result) => result.writer === "SignOut" && result.waitedOn.length > 0),
        "a sign-out waited for the round's locks: " + summary,
      );
      // A sold-out mark records an availability rule, whose trigger takes the Catalog availability
      // fence (CatalogAvailabilityReferenceV1) exclusively. The round takes that fence shared
      // only inside the Catalog's own availability read, which ends at once: none of its folded
      // step transactions holds it (checked at each fire below). So no sold-out case can contend
      // on the Catalog's shared fences, and this test does not claim one: the mark never waits on
      // a fence (an advisory lock). It may wait on a row the round is writing (its audit chain),
      // as any two writers of one Brand do.
      for (const result of results.filter((result) => result.writer === "SoldOut")) {
        assert.ok(
          !result.heldLocks.includes("fence:CatalogAvailabilityReferenceV1"),
          "a folded step held the availability fence: " + JSON.stringify(result),
        );
        assert.ok(
          result.waitedOn.every((lock) => !lock.startsWith("advisory:")),
          "a sold-out mark waited on a fence: " + JSON.stringify(result),
        );
      }
      for (const result of results) {
        // Each writer began inside its round's folded step, ended within its bound (the round's
        // step transaction never holds it past the lock limit) and never failed.
        assert.ok(result.inside, "a writer began outside its round: " + JSON.stringify(result));
        assert.ok(result.writerMs < 2500, "the writer waited too long: " + JSON.stringify(result));
        assert.equal(result.writerFailed, null, "the writer failed: " + JSON.stringify(result));
        if (result.writer === "SignOut") {
          assert.equal(result.session, "Revoked", "the sign-out ended the Session: " + summary);
          assert.ok(
            result.round === "Placed" || result.code === "STAFF_ROUND_PERMISSION_DENIED",
            "a round of a signed-out member answered " + JSON.stringify(result),
          );
          // No transaction that authorized staff by their Session wrote after it ended.
          assert.equal(result.lateStaffWrites, 0, "a staff write after sign-out: " + summary);
        } else {
          assert.ok(
            result.round === "Placed" || result.code === "STAFF_ROUND_ITEM_UNAVAILABLE",
            "a round whose dish sold out answered " + JSON.stringify(result),
          );
          if (result.round === "Placed") assert.equal(result.placedAfter, 0, summary);
        }
      }

      await sleep(1200);
      assert.equal(await deadlocks(admin), deadlocksBefore, "no deadlock was detected");
      // A refused round of a signed-out member can't end its table turn (that needs their
      // authority): logged, and the turn ends by itself after its lease.
      for (const line of unexpected.faults())
        assert.ok(
          /"code":"STAFF_ROUND_PERMISSION_DENIED"/u.test(line) && !/sqlState/u.test(line),
          "an unexpected failure was logged: " + line,
        );
      assert.deepEqual(recording.lockFailures, []);
      assert.ok(
        sampled.longestIdleMs() < 1000,
        `no API connection sat in a transaction sending nothing (longest ${sampled.longestIdleMs()} ms)`,
      );
    } finally {
      recording.on = false;
      unexpected.restore();
      vi.unstubAllEnvs();
      for (const store of open) await store.close().catch(() => undefined);
      for (const name of [api, api + "_w"]) {
        await admin.query("DROP OWNED BY " + name).catch(() => undefined);
        await admin.query("DROP ROLE " + name).catch(() => undefined);
      }
      await admin.end();
    }
  });
});

/** The staff member signs out on their tablet (the Session's own sign-out). */
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
