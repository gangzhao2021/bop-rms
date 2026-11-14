import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import process from "node:process";
import { setTimeout as delay } from "node:timers/promises";
import { URL } from "node:url";
import pg from "pg";
import { it, vi } from "vitest";
import { appendAuditRecordInTransaction } from "../../bop/audit/src/index.ts";
import { createDiningTable, parseDiningSession } from "../../rms/dining/src/index.ts";
import {
  createFulfillmentReadinessService,
  createPickupFulfillmentService,
  createPostgresFulfillmentReadinessStore,
  createPostgresPickupFulfillmentStore,
} from "../../rms/fulfillment/src/index.ts";
import { parseKitchenItemReadyEnvelope } from "../../rms/kitchen/src/index.ts";
import {
  acquireOrderDispositionFence,
  createOrderFulfillmentSourceEvidenceBinding,
  createOrderFulfillmentSourceLineBinding,
  parseConfirmedOrderFulfillmentSourceEvidence,
  parseOrderConfirmedEnvelope,
} from "../../rms/ordering/src/index.ts";
import { createMerchantPickupQuery } from "../../../apps/api/src/merchant-pickup-query.ts";
import { createMerchantDiningTables } from "../../../apps/api/src/merchant-dining-tables.ts";
import { renderPilotAclSql } from "../../../tooling/environment/pilot-acl-render.mjs";
import { createTenantTransactionRunner } from "../src/transaction-runner.ts";
import { withIsolatedDatabase } from "../test-support/isolated-database.mjs";
import { seedMerchantAcceptanceSession } from "../test-support/merchant-acceptance-session.mjs";

const { Client, Pool } = pg;
const id = (n) => "01a0f070-0000-7000-8000-" + n.toString(16).padStart(12, "0");
const sha = (value) => "sha256:" + createHash("sha256").update(value).digest("hex");
const derive = (prefix) => (purpose, identity) => {
  const digest = createHash("sha256")
    .update(purpose + identity)
    .digest("hex");
  return (
    prefix +
    "-" +
    digest.slice(0, 4) +
    "-7" +
    digest.slice(4, 7) +
    "-8" +
    digest.slice(7, 10) +
    "-" +
    digest.slice(10, 22)
  );
};
const minutes = (base, n) => new Date(Date.parse(base) + n * 60_000).toISOString();
const percentile = (values, p) => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted.length === 0
    ? 0
    : sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)];
};

/**
 * WP-2423 (v15 2026-10-18 10:03–10:04Z, 55P03): with the Orders list and the pickup queue polled
 * from several screens, every list read took each listed Order's disposition fence (and its
 * pickup's lock) until it ended, so reads queued behind each other and behind commands: 9 lock
 * timeouts and 1.5–2.9 s reads. Polled lists now read one REPEATABLE READ, READ ONLY snapshot
 * (`runSnapshot`) without fences or row locks; commands keep theirs.
 *
 * Everything runs through the application's own transaction runner (`createTenantTransactionRunner`,
 * pilot statement/lock timeouts 5 s/2 s) as a restricted NOBYPASSRLS role holding the rendered pilot
 * API grants, with a real merchant session and the merchant pickup query as the API composes it.
 * Test-only stand-ins (labelled): Ordering confirmation evidence and Kitchen ready events are
 * synthetic; the pickup's current-source check takes Ordering's disposition fence and accepts the
 * source (the pilot check fences the same Order, then validates it); each kitchen-ready command
 * holds its transaction 400 ms after writing, standing in for the rest of a real staff command.
 */
it("serves polled pickup lists from one snapshot without fences: no lock timeouts or deadlocks under concurrent screens and commands, no torn reads, and commands still serialize", async () => {
  vi.stubEnv("NODE_ENV", "development");
  await withIsolatedDatabase({ caseId: "wp2423_snapread" }, async (context) => {
    const admin = new Client(context.clientConfig);
    await admin.connect();
    const api = "wp2423_sr_" + context.runId,
      worker = "wp2423_sr_w_" + context.runId;
    const pool = new Pool({
      ...context.clientConfig,
      max: 24,
      connectionTimeoutMillis: 5000,
      query_timeout: 10_000,
    });
    try {
      for (const name of [api, worker])
        await admin.query(
          "CREATE ROLE " + name + " NOLOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE",
        );
      const root = new URL("../../../docs/spec/", import.meta.url);
      const matrices = await Promise.all(
        ["pilot-acl-matrix.json", "pilot-acl-additions.json"].map(async (file) =>
          JSON.parse(await readFile(new URL(file, root), "utf8")),
        ),
      );
      await admin.query(renderPilotAclSql(matrices, { api, worker }));

      const brand = id(1),
        store = id(2),
        tenant = id(3),
        scope = { brandReference: brand, storeReference: store };
      const t0 = new Date(Math.floor((Date.now() - 4 * 3_600_000) / 1000) * 1000).toISOString();
      const now = () => new Date().toISOString();

      /** The application runner, as the restricted API role (pilot timeouts). */
      const tenantRunner = createTenantTransactionRunner(pool, { brandId: brand, storeId: store });
      const asApi = (work) => async (tx) => {
        await tx.query("SET LOCAL ROLE " + api, []);
        return work(tx);
      };
      const runner = {
        run: (work) => tenantRunner.run(asApi(work)),
        runSnapshot: (work) => tenantRunner.runSnapshot(asApi(work)),
      };
      const asOwner = async (work) => {
        const client = new Client(context.clientConfig);
        await client.connect();
        try {
          await client.query("BEGIN");
          await client.query(
            "SELECT set_config('bop.brand_id',$1,true),set_config('bop.store_id',$2,true)",
            [brand, store],
          );
          const result = await work({
            query: (sql, values) => client.query(sql, values === undefined ? [] : [...values]),
          });
          await client.query("COMMIT");
          return result;
        } catch (error) {
          await client.query("ROLLBACK").catch(() => undefined);
          throw error;
        } finally {
          await client.end();
        }
      };
      const audit = {
        append: ({ record, transaction: tx }) => appendAuditRecordInTransaction(tx, record),
      };
      // Test-only stand-in for the pilot current-source check: Ordering's fence of the Order.
      const fenced = async (tx, orderReference) => {
        await acquireOrderDispositionFence(tx, { ...scope, orderReference });
        return true;
      };
      const readinessStore = (now_) =>
        createPostgresFulfillmentReadinessStore({
          ...scope,
          sha256: sha,
          now: now_,
          authorizeQueue: async () => true,
          authorize: async () => true,
          validateCurrentSource: fenced,
        });

      /** A confirmed two-item pickup Order (synthetic evidence); item 1 is ready. */
      async function pickup(n) {
        const order = id(0x1000 * n + 1),
          batch = id(0x1000 * n + 2),
          confirmation = id(0x1000 * n + 3),
          confirmedAt = minutes(t0, n - 10);
        const event = parseOrderConfirmedEnvelope({
          eventId: id(0x1000 * n + 4),
          eventType: "OrderConfirmed",
          schemaVersion: 1,
          occurredAt: confirmedAt,
          producerModule: "@rms/ordering",
          tenantId: brand,
          storeId: store,
          aggregateType: "Order",
          aggregateId: order,
          aggregateVersion: 2n,
          correlationId: id(0x1000 * n + 6),
          causationId: id(0x1000 * n + 7),
          actor: { type: "System" },
          payload: {
            confirmationReference: confirmation,
            orderReference: order,
            orderBatchReference: batch,
            sourceSnapshotDigest: sha("order" + n),
            confirmedAt,
          },
          redactionClassification: "indirect_identifier",
          replayMetadata: { replaySafe: true },
        });
        const items = [1, 2].map((ordinal) => {
          const line = {
            orderItemReference: id(0x1000 * n + 0x10 + ordinal),
            ordinal,
            quantity: 1,
            lineDigest: sha("x"),
          };
          line.lineDigest = sha(createOrderFulfillmentSourceLineBinding(line));
          return line;
        });
        const raw = {
          evidenceReference: id(0x1000 * n + 8),
          ...scope,
          orderReference: order,
          orderBatchReference: batch,
          confirmationReference: confirmation,
          sourceEventReference: event.eventId,
          sourceAggregateVersion: 2n,
          sourceSnapshotDigest: sha("order" + n),
          orderType: "Pickup",
          capturedAt: confirmedAt,
          evidenceVersion: 1,
          items,
          evidenceDigest: sha("x"),
        };
        raw.evidenceDigest = sha(createOrderFulfillmentSourceEvidenceBinding(raw));
        const source = parseConfirmedOrderFulfillmentSourceEvidence(raw);
        const created = await asOwner((tx) =>
          createPickupFulfillmentService({
            authorization: { authorize: async () => true },
            orderingSource: { resolve: async () => source },
            references: { derive: derive("01a0f071") },
            digests: { sha256: sha },
            repository: createPostgresPickupFulfillmentStore({
              ...scope,
              sha256: sha,
              authorize: async () => true,
              validateCurrentSource: async () => true,
            }),
            audit,
          }).consume(tx, event),
        );
        assert.equal(created.status, "Created");
        const value = {
          n,
          order,
          batch,
          fulfillment: created.effect.aggregate.fulfillmentReference,
          items: created.effect.aggregate.items.map((item) => item.orderItemReference),
        };
        await asOwner((tx) => ready(tx, value, 0, minutes(t0, n - 5)));
        return value;
      }
      /** Kitchen marks one item ready: Fulfillment's readiness command (fence, lock, write). */
      async function ready(tx, value, index, readyAt) {
        const n = value.n * 4 + index;
        const applied = await createFulfillmentReadinessService({
          authorization: { authorize: async () => true },
          repository: readinessStore(now),
          digests: { sha256: sha },
          references: { derive: derive("01a0f072") },
          audit,
        }).consume(
          tx,
          parseKitchenItemReadyEnvelope({
            eventId: id(0x80000 + n * 8 + 1),
            eventType: "KitchenItemReady",
            schemaVersion: 1,
            occurredAt: readyAt,
            producerModule: "@rms/kitchen",
            tenantId: brand,
            storeId: store,
            aggregateType: "KitchenOrderItemReadyResult",
            aggregateId: id(0x80000 + n * 8 + 2),
            aggregateVersion: 1n,
            correlationId: id(0x80000 + n * 8 + 3),
            causationId: id(0x80000 + n * 8 + 4),
            actor: { type: "System" },
            payload: {
              kitchenTicketReference: id(0x80000 + n * 8 + 5),
              orderReference: value.order,
              orderBatchReference: value.batch,
              orderItemReference: value.items[index],
              readyResultReference: id(0x80000 + n * 8 + 2),
              readyQuantity: 1,
              requiredQuantity: 1,
              readyAt,
            },
            redactionClassification: "indirect_identifier",
            replayMetadata: { replaySafe: true },
          }),
        );
        assert.equal(applied.status, "Applied");
      }
      /** The command as staff/worker run it: the restricted runner, held 400 ms after writing. */
      const complete = (value) =>
        runner.run(async (tx) => {
          await ready(tx, value, 1, now());
          await tx.query("SELECT pg_sleep(0.4)", []);
        });

      // 12 pickups already Ready and 2 × 8 still waiting for their second item.
      const readyNow = [],
        pendingA = [],
        pendingB = [],
        pendingC = [];
      for (let n = 1; n <= 30; n++) {
        const value = await pickup(n);
        if (n <= 12) await asOwner((tx) => ready(tx, value, 1, minutes(t0, n - 4)));
        (n <= 12 ? readyNow : n <= 20 ? pendingA : n <= 28 ? pendingB : pendingC).push(value);
      }

      const session = await seedMerchantAcceptanceSession({
        admin,
        runner,
        role: api,
        scope: { tenantReference: tenant, ...scope },
        actor: id(0x900),
        at: now(),
        pickupPermission: true,
        referencePrefix: "01a0f073",
        sessionReferencePrefix: "01a0f074",
      });
      const pickupQuery = (transactions) =>
        createMerchantPickupQuery({
          persistence: { ...session.persistence, transactions, now },
          authentication: session.authentication,
          store: { sha256: sha, validateCurrentSource: fenced },
          installContext: async (tx, selected) => {
            await tx.query(
              "SELECT set_config('bop.brand_id',$1,true),set_config('bop.store_id',$2,true)",
              [selected.brandReference, selected.storeReference],
            );
          },
        });
      const read = (query) =>
        query({
          sessionCookie: session.sessionCookie,
          csrf: session.csrf,
          query: { afterFulfillmentReference: null, limit: 50, includeCompleted: false },
        });
      // Before: the same query in ordinary transactions (the fenced read v15 ran).
      const fencedQuery = pickupQuery({ run: runner.run });
      const snapshotQuery = pickupQuery(runner);
      const listed = (page) => page.items.map((item) => String(item.fulfillmentReference)).sort();
      const readyRefs = readyNow.map((value) => value.fulfillment).sort();
      assert.deepEqual(listed(await read(snapshotQuery)), readyRefs);
      assert.deepEqual(listed(await read(fencedQuery)), readyRefs);

      const advisoryWaits = async (key) =>
        Number(
          (
            await admin.query(
              "SELECT count(*)::int AS n FROM pg_locks WHERE locktype='advisory' AND NOT granted AND " +
                "((classid::bigint<<32)|objid::bigint)=hashtextextended($1,0)",
              [key],
            )
          ).rows[0].n,
        );
      const fenceKey = (order) => "OrderingOrderDisposition:" + brand + ":" + store + ":" + order;
      const deadlocks = async () =>
        Number(
          (
            await admin.query(
              "SELECT deadlocks::int AS n FROM pg_stat_database WHERE datname=current_database()",
            )
          ).rows[0].n,
        );
      const deadlocksBefore = await deadlocks();

      // 1. A staff command is in progress on a listed Order (it holds the Order's fence 2.6 s).
      //    The fenced list read waits for it and fails at the 2 s lock timeout (v15's 55P03); the
      //    snapshot read returns at once; a second command on that Order still waits its turn.
      const held = readyNow[0];
      let release;
      const holding = new Promise((resolve) => (release = resolve));
      let fenceTaken;
      const taken = new Promise((resolve) => (fenceTaken = resolve));
      const command = runner.run(async (tx) => {
        await acquireOrderDispositionFence(tx, { ...scope, orderReference: held.order });
        fenceTaken();
        await holding;
      });
      await taken;
      const snapshotStarted = Date.now();
      const duringCommand = await read(snapshotQuery);
      const snapshotMs = Date.now() - snapshotStarted;
      assert.deepEqual(listed(duringCommand), readyRefs, "the snapshot read lists every pickup");
      const fencedStarted = Date.now();
      const fencedOutcome = await read(fencedQuery).then(
        () => null,
        (error) => error,
      );
      const fencedMs = Date.now() - fencedStarted;
      assert.equal(fencedOutcome?.code, "TENANT_DATABASE_TRANSACTION_CONFLICT");
      assert.equal(fencedOutcome?.diagnostic?.sqlState, "55P03");
      // Commands still serialize: another command on the same Order waits for the first.
      const second = runner.run(async (tx) => {
        await acquireOrderDispositionFence(tx, { ...scope, orderReference: held.order });
        return Date.now();
      });
      for (let i = 0; i < 80 && (await advisoryWaits(fenceKey(held.order))) === 0; i++)
        await delay(25);
      assert.equal(await advisoryWaits(fenceKey(held.order)), 1, "the second command waits");
      const releasedAt = Date.now();
      release();
      await command;
      assert.ok((await second) >= releasedAt, "the second command ran after the first ended");
      assert.ok(snapshotMs < 1500, "the snapshot read never waited for the command");

      // 2. One snapshot for the whole read: a command committing while the read is open is not
      //    seen by its later statements (no torn view); the fenced read's later statements see it.
      const reread = async (mode, value) =>
        runner[mode](async (tx) => {
          const store_ = readinessStore(now);
          const page = () =>
            store_.listPickupQueue({
              transaction: tx,
              afterFulfillmentReference: null,
              limit: 50,
              includeCompleted: false,
            });
          const first = await page();
          await asOwner((owner) => ready(owner, value, 1, now()));
          const later = await page();
          return [listed(first), listed(later)];
        });
      const [snapshotFirst, snapshotLater] = await reread("runSnapshot", pendingC[0]);
      assert.deepEqual(snapshotFirst, readyRefs);
      assert.deepEqual(snapshotLater, snapshotFirst, "a snapshot read never changes mid-read");
      const withC0 = [...readyRefs, pendingC[0].fulfillment].sort();
      assert.deepEqual(listed(await read(snapshotQuery)), withC0, "the next read sees it");
      const [fencedFirst, fencedLater] = await reread("run", pendingC[1]);
      assert.deepEqual(fencedFirst, withC0);
      assert.deepEqual(
        fencedLater,
        [...withC0, pendingC[1].fulfillment].sort(),
        "control: an ordinary read's later statements see a command committed mid-read",
      );
      const baseline = [...withC0, pendingC[1].fulfillment].sort();

      // 3. Load: 8 screens polling the pickup queue back to back while kitchen-ready commands
      //    complete 8 pickups one after another; first with fenced reads, then snapshot reads.
      async function load(query, pending, base) {
        const stopAt = { value: false };
        const latencies = [],
          errors = {},
          order = pending.map((value) => value.fulfillment);
        let torn = 0,
          reads = 0;
        const screen = async () => {
          let seen = 0;
          while (!stopAt.value) {
            const started = Date.now();
            try {
              const page = await read(query);
              latencies.push(Date.now() - started);
              reads += 1;
              const refs = listed(page);
              // Consistent: every listed pickup is Ready with every item ready, and the newly
              // ready ones are exactly the first k commands (commands commit in this order).
              const fresh = refs.filter((ref) => !base.includes(ref));
              const k = fresh.length;
              if (
                !base.every((ref) => refs.includes(ref)) ||
                [...fresh].sort().join() !== [...order.slice(0, k)].sort().join() ||
                k < seen ||
                page.items.some(
                  (item) =>
                    item.phase !== "Ready" ||
                    item.items.some((line) => line.readyQuantity !== line.orderedQuantity),
                )
              )
                torn += 1;
              seen = Math.max(seen, k);
            } catch (error) {
              const key = (error?.code ?? "UNKNOWN") + ":" + (error?.diagnostic?.sqlState ?? "");
              errors[key] = (errors[key] ?? 0) + 1;
            }
          }
        };
        const commandLatencies = [],
          commandErrors = {};
        const commands = (async () => {
          for (const value of pending) {
            const started = Date.now();
            // A command that lost a lock wait is retried, as the worker retries its consumer.
            for (let attempt = 1; ; attempt++)
              try {
                await complete(value);
                break;
              } catch (error) {
                const key = (error?.code ?? "UNKNOWN") + ":" + (error?.diagnostic?.sqlState ?? "");
                commandErrors[key] = (commandErrors[key] ?? 0) + 1;
                if (attempt === 10 || error?.code !== "TENANT_DATABASE_TRANSACTION_CONFLICT")
                  throw error;
              }
            commandLatencies.push(Date.now() - started);
          }
          await delay(300);
          stopAt.value = true;
        })();
        const screens = Array.from({ length: 8 }, () => screen());
        const startedAt = Date.now();
        await commands;
        await Promise.all(screens);
        return {
          reads,
          seconds: (Date.now() - startedAt) / 1000,
          errors,
          torn,
          p50: percentile(latencies, 50),
          p95: percentile(latencies, 95),
          max: Math.max(0, ...latencies),
          commandP50: percentile(commandLatencies, 50),
          commandMax: Math.max(0, ...commandLatencies),
          commandErrors,
        };
      }
      const before = await load(fencedQuery, pendingA, baseline);
      const afterBase = [...baseline, ...pendingA.map((value) => value.fulfillment)].sort();
      const after = await load(snapshotQuery, pendingB, afterBase);
      const deadlocksAfter = await deadlocks();
      const report = {
        commandInProgress: { snapshotMs, fencedMs, fencedSqlState: "55P03" },
        fencedReads: before,
        snapshotReads: after,
        deadlocks: deadlocksAfter - deadlocksBefore,
      };
      if (process.env.WP2423_SNAPSHOT_LOAD_REPORT)
        await writeFile(process.env.WP2423_SNAPSHOT_LOAD_REPORT, JSON.stringify(report, null, 2));
      assert.deepEqual(after.errors, {}, "no snapshot read failed (no 55P03/40P01)");
      assert.deepEqual(after.commandErrors, {}, "no command waited out its lock timeout");
      assert.equal(after.torn, 0, "every snapshot read was one consistent state");
      assert.equal(before.torn, 0);
      assert.ok(after.reads > 0 && before.reads > 0);
      assert.equal(deadlocksAfter, deadlocksBefore, "no deadlock");
      assert.ok(after.p95 < before.p95, "snapshot reads are faster than fenced reads under load");
      // Every command still completed and the final list has every Ready pickup.
      assert.deepEqual(
        listed(await read(snapshotQuery)),
        [...afterBase, ...pendingB.map((value) => value.fulfillment)].sort(),
      );
    } finally {
      await pool.end().catch(() => undefined);
      await admin.end();
    }
  });
});

/**
 * WP-2423 (v15 2026-10-18): the Tables page is polled by every floor screen. Its read only selects,
 * but as an ordinary transaction it holds the caller's session row FOR SHARE and the membership and
 * permission tables IN SHARE MODE until it ends, and its statements each see the latest commit.
 * It now reads one REPEATABLE READ, READ ONLY snapshot (`runSnapshot`) like the Orders list.
 *
 * Same composition as above: the application runner (pilot timeouts 5 s/2 s) as a restricted
 * NOBYPASSRLS role with the rendered pilot API grants, a real merchant session, and the Tables read
 * as the API composes it. Test-only stand-ins (labelled): 30 tables with 20 open sessions are owner
 * rows; a session close is the owner committing the Closed session and the freed table together
 * (as the close command does); a Staff-settings role change is an owner UPDATE of the caller's
 * role row held 400 ms, then rolled back.
 */
it("serves the polled Tables page from one snapshot: no wait behind a role change, no torn view of a session closed mid-read, and faster under concurrent screens", async () => {
  vi.stubEnv("NODE_ENV", "development");
  await withIsolatedDatabase({ caseId: "wp2423_snaptables" }, async (context) => {
    const admin = new Client(context.clientConfig);
    await admin.connect();
    const api = "wp2423_st_" + context.runId,
      worker = "wp2423_st_w_" + context.runId;
    const pool = new Pool({
      ...context.clientConfig,
      max: 24,
      connectionTimeoutMillis: 5000,
      query_timeout: 10_000,
    });
    try {
      for (const name of [api, worker])
        await admin.query(
          "CREATE ROLE " + name + " NOLOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE",
        );
      const root = new URL("../../../docs/spec/", import.meta.url);
      const matrices = await Promise.all(
        ["pilot-acl-matrix.json", "pilot-acl-additions.json"].map(async (file) =>
          JSON.parse(await readFile(new URL(file, root), "utf8")),
        ),
      );
      await admin.query(renderPilotAclSql(matrices, { api, worker }));

      const ref = (n) => "01a0f080-0000-7000-8000-" + n.toString(16).padStart(12, "0");
      const brand = ref(1),
        store = ref(2),
        tenant = ref(3),
        scope = { brandReference: brand, storeReference: store };
      const now = () => new Date().toISOString();
      const tenantRunner = createTenantTransactionRunner(pool, { brandId: brand, storeId: store });
      const asApi = (work) => async (tx) => {
        await tx.query("SET LOCAL ROLE " + api, []);
        return work(tx);
      };
      const runner = {
        run: (work) => tenantRunner.run(asApi(work)),
        runSnapshot: (work) => tenantRunner.runSnapshot(asApi(work)),
      };
      const referencePrefix = "01a0f083";
      const session = await seedMerchantAcceptanceSession({
        admin,
        runner,
        role: api,
        scope: { tenantReference: tenant, ...scope },
        actor: ref(0x900),
        at: now(),
        extraPermissions: [
          "dining.operate",
          "dining.session.close",
          "order.close",
          "dining.item.serve",
          "dining.host.transfer",
          "ordering.order.cancel",
        ],
        referencePrefix,
        sessionReferencePrefix: "01a0f084",
      });
      const roleReference =
        referencePrefix + "-0000-7000-8000-" + (4).toString(16).padStart(12, "0");

      // 30 tables, the first 20 occupied (test-only owner rows).
      const startedAt = new Date(
        Math.floor((Date.now() - 30 * 60_000) / 1000) * 1000,
      ).toISOString();
      const tables = [];
      for (let n = 1; n <= 30; n++) {
        const tableReference = ref(0x1000 + n),
          sessionReference = n <= 20 ? ref(0x2000 + n) : null;
        const table = createDiningTable({
          tenantReference: tenant,
          ...scope,
          tableReference,
          stableLabel: "SYNTHETIC-" + n,
          areaReference: ref(0x3000),
          areaCode: "ROOM",
          capacity: 4,
          accessibilityAttributes: [],
          lifecycle: "Published",
          qrStatus: "Active",
          qrVersion: 1,
          operationalState: "Available",
          blockReasonCode: null,
          activeDiningSessionReference: sessionReference,
          aggregateVersion: 1,
          createdAt: startedAt,
          observedAt: startedAt,
        });
        await admin.query(
          "INSERT INTO rms_dining.dining_table (table_id,tenant_id,brand_id,store_id,version,table_snapshot,created_at,observed_at) VALUES ($1,$2,$3,$4,1,$5::jsonb,$6,$6)",
          [tableReference, tenant, brand, store, JSON.stringify(table), startedAt],
        );
        if (sessionReference !== null) {
          const dining = parseDiningSession({
            diningSessionReference: sessionReference,
            brandReference: brand,
            storeReference: store,
            tableReference,
            tableAssignmentVersion: 1,
            phase: "Active",
            version: 2,
            startedByActorReference: ref(0x900),
            startedAt,
            hostParticipantReference: null,
          });
          await admin.query(
            "INSERT INTO rms_dining.dining_session (session_id,tenant_id,brand_id,store_id,table_id,version,phase,session_snapshot,started_at) VALUES ($1,$2,$3,$4,$5,2,'Active',$6::jsonb,$7)",
            [
              sessionReference,
              tenant,
              brand,
              store,
              tableReference,
              JSON.stringify(dining),
              startedAt,
            ],
          );
        }
        tables.push({ tableReference, sessionReference });
      }
      /** The close command's committed effect: the session Closed and its table free, at once. */
      const closeSession = async ({ tableReference, sessionReference }) => {
        await admin.query("BEGIN");
        await admin.query(
          "UPDATE rms_dining.dining_session SET phase='Closed',version=version+1,session_snapshot=session_snapshot||jsonb_build_object('phase','Closed','version',version+1) WHERE session_id=$1",
          [sessionReference],
        );
        await admin.query(
          "UPDATE rms_dining.dining_table SET version=version+1,table_snapshot=table_snapshot||jsonb_build_object('activeDiningSessionReference',NULL::text,'aggregateVersion',version+1) WHERE table_id=$1",
          [tableReference],
        );
        await admin.query("COMMIT");
      };

      const tablesRead = (transactions) =>
        createMerchantDiningTables({
          persistence: { ...session.persistence, transactions, now },
          authentication: session.authentication,
          tableAvailabilityCommandEnabled: true,
        });
      const read = (query) =>
        query({
          sessionCookie: session.sessionCookie,
          csrf: session.csrf,
          query: { afterTableReference: null, limit: 100 },
        });
      // Before: the same read in ordinary transactions (the locking read v15 ran).
      const lockingTables = tablesRead({ run: runner.run });
      const snapshotTables = tablesRead(runner);
      const occupied = (view) =>
        view.items
          .filter((item) => item.currentDiningSessionReference !== null)
          .map((item) => String(item.tableReference))
          .sort();
      const firstSnapshot = await read(snapshotTables);
      assert.equal(firstSnapshot.items.length, 30);
      assert.equal(firstSnapshot.canCloseSessions, true);
      assert.deepEqual(
        occupied(firstSnapshot),
        tables.filter((t) => t.sessionReference !== null).map((t) => t.tableReference),
      );
      assert.deepEqual(await read(lockingTables), firstSnapshot, "both reads show the same page");

      // 1. A Staff-settings role change is in progress (owner UPDATE of the caller's role, held).
      //    The locking read waits for its permission-table SHARE lock and fails at the 2 s lock
      //    timeout; the snapshot read returns at once with the same page.
      const changer = new Client(context.clientConfig);
      await changer.connect();
      let lockingMs, snapshotMs, lockingOutcome;
      try {
        await changer.query("BEGIN");
        await changer.query("UPDATE bop_permission.role SET version=version WHERE role_id=$1", [
          roleReference,
        ]);
        const snapshotStarted = Date.now();
        assert.deepEqual(await read(snapshotTables), firstSnapshot);
        snapshotMs = Date.now() - snapshotStarted;
        const lockingStarted = Date.now();
        lockingOutcome = await read(lockingTables).then(
          () => null,
          (error) => error,
        );
        lockingMs = Date.now() - lockingStarted;
      } finally {
        await changer.query("ROLLBACK").catch(() => undefined);
        await changer.end();
      }
      assert.ok(
        lockingOutcome !== null,
        "the locking read could not finish behind the role change",
      );
      assert.ok(lockingMs >= 1900, "the locking read waited for the role change " + lockingMs);
      assert.ok(snapshotMs < 1500, "the snapshot read never waited " + snapshotMs);

      // 2. One snapshot for the whole read: a session closed (and its table freed) by a command
      //    committing between the table list and the session read is not seen half-way.
      const closingMidRead = (base, target) => {
        let pending = target;
        const wrap = (work) => (tx) =>
          work({
            query: async (sql, values) => {
              const result = await tx.query(sql, values);
              if (pending !== null && /FROM rms_dining\.dining_table WHERE/u.test(sql)) {
                const closing = pending;
                pending = null;
                await closeSession(closing);
              }
              return result;
            },
          });
        return tablesRead({
          run: (work) => base.run(wrap(work)),
          ...(base.runSnapshot ? { runSnapshot: (work) => base.runSnapshot(wrap(work)) } : {}),
        });
      };
      const [closedA, closedB] = [tables[0], tables[1]];
      const duringClose = await read(closingMidRead(runner, closedA));
      assert.deepEqual(occupied(duringClose), occupied(firstSnapshot), "the read's own snapshot");
      assert.equal(
        duringClose.items.find((item) => item.tableReference === closedA.tableReference)?.session
          ?.phase,
        "Active",
      );
      const afterClose = await read(snapshotTables);
      assert.equal(
        afterClose.items.find((item) => item.tableReference === closedA.tableReference)
          ?.currentDiningSessionReference,
        null,
        "the next read shows the table free",
      );
      // Control: the ordinary read's session read sees the close its table list did not.
      const tornOutcome = await read(closingMidRead({ run: runner.run }, closedB)).then(
        () => null,
        (error) => error,
      );
      assert.ok(tornOutcome !== null, "control: the ordinary read saw half of the close");

      // 3. Timing. (a) One screen, 20 sequential reads each way on an idle database.
      const sequential = async (query) => {
        const latencies = [];
        for (let i = 0; i < 20; i++) {
          const started = Date.now();
          await read(query);
          latencies.push(Date.now() - started);
        }
        return { p50: percentile(latencies, 50), p95: percentile(latencies, 95) };
      };
      const idleLocking = await sequential(lockingTables);
      const idleSnapshot = await sequential(snapshotTables);
      // (b) 8 screens polling back to back while 6 role changes (each held 400 ms) run one after
      //     another; first with locking reads, then snapshot reads.
      async function load(query) {
        const stop = { value: false };
        const latencies = [],
          errors = {},
          changeLatencies = [];
        const screen = async () => {
          while (!stop.value) {
            const started = Date.now();
            try {
              const view = await read(query);
              if (view.items.length !== 30) errors.page = (errors.page ?? 0) + 1;
              latencies.push(Date.now() - started);
            } catch (error) {
              const key =
                (error?.code ?? error?.message ?? "UNKNOWN") +
                ":" +
                (error?.diagnostic?.sqlState ?? "");
              errors[key] = (errors[key] ?? 0) + 1;
            }
          }
        };
        const changes = (async () => {
          await delay(200);
          for (let i = 0; i < 6; i++) {
            const client = new Client(context.clientConfig);
            await client.connect();
            const started = Date.now();
            try {
              await client.query("BEGIN");
              await client.query("SET LOCAL lock_timeout='10s'");
              await client.query(
                "UPDATE bop_permission.role SET version=version WHERE role_id=$1",
                [roleReference],
              );
              changeLatencies.push(Date.now() - started);
              await client.query("SELECT pg_sleep(0.4)");
            } finally {
              await client.query("ROLLBACK").catch(() => undefined);
              await client.end();
            }
            await delay(100);
          }
          await delay(200);
          stop.value = true;
        })();
        const screens = Array.from({ length: 8 }, () => screen());
        await changes;
        await Promise.all(screens);
        return {
          reads: latencies.length,
          errors,
          p50: percentile(latencies, 50),
          p95: percentile(latencies, 95),
          max: Math.max(0, ...latencies),
          roleChangeWaitP50: percentile(changeLatencies, 50),
          roleChangeWaitMax: Math.max(0, ...changeLatencies),
        };
      }
      const before = await load(lockingTables);
      const after = await load(snapshotTables);
      const report = {
        tables: 30,
        openSessions: 20,
        roleChangeInProgress: {
          snapshotMs,
          lockingMs,
          lockingError: lockingOutcome?.message ?? String(lockingOutcome),
        },
        idleSequential: { locking: idleLocking, snapshot: idleSnapshot },
        lockingReads: before,
        snapshotReads: after,
      };
      if (process.env.WP2423_SNAPSHOT_TABLES_REPORT)
        await writeFile(process.env.WP2423_SNAPSHOT_TABLES_REPORT, JSON.stringify(report, null, 2));
      assert.deepEqual(after.errors, {}, "no snapshot Tables read failed");
      assert.ok(after.reads > 0 && before.reads > 0);
      assert.ok(after.p95 < before.p95, "snapshot reads are faster than locking reads under load");
      assert.ok(
        after.roleChangeWaitMax < 500,
        "a role change never waits for snapshot Tables reads " + after.roleChangeWaitMax,
      );
    } finally {
      await pool.end().catch(() => undefined);
      await admin.end();
    }
  });
});
