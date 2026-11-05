import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import pg from "pg";
import { projectOperationsAlertBoard } from "../../../apps/api/dist/merchant-operations-alerts.js";
import { readInternalQuoteTaxReadiness } from "../../../tooling/environment/pilot-configured-quote.mjs";
import { createPilotAlertBoardReader } from "../../../tooling/environment/pilot-ops-files.mjs";
import { createStoreMonitors } from "../../../tooling/environment/pilot-ops-stores.mjs";
import { composeBusinessDependencies } from "../../../tooling/environment/pilot-ops.mjs";
import { withTransactionConflictWait } from "../../../tooling/environment/pilot-transaction-conflict-wait.mjs";
import { createTenantTransactionRunner } from "../src/transaction-runner.ts";
import { seedJourneyStorePublication } from "./dine-in-journey-seed.mjs";

/**
 * DEC-PILOT-ALERTS-BACKUP correction 2, on a real database: the one monitor writes each served
 * Store its own board, every read running as the restricted role holding the rendered pilot API
 * grants, in that Store's scope. The first merchant's Store is published through the real Store
 * setup; the second merchant's is another Tenant, Brand and Store on the same database.
 */
export async function exercisePilotStoreMonitors(context) {
  const { admin, clientConfig, scope, store, api, operating, id } = context;
  const first = {
    name: "first",
    tenantReference: scope.tenantReference,
    brandReference: scope.brandReference,
    storeReference: store,
  };
  const second = {
    name: "second",
    tenantReference: id(0xc001),
    brandReference: id(0xc002),
    storeReference: id(0xc003),
  };
  const never = {
    name: "never",
    tenantReference: id(0xc011),
    brandReference: id(0xc012),
    storeReference: id(0xc013),
  };
  const asOwner = async (of, work) => {
    await admin.query(
      "SELECT set_config('bop.tenant_id',$1,false),set_config('bop.brand_id',$2,false),set_config('bop.store_id',$3,false)",
      [of.tenantReference, of.brandReference, of.storeReference],
    );
    await work();
  };
  // Three days old: the second merchant has closed business days and no settlement coverage.
  await asOwner(second, () =>
    seedJourneyStorePublication({
      client: admin,
      scope: second,
      publishedAt: new Date(Date.now() - 3 * 86400_000).toISOString(),
      businessDayStart: "04:00:00",
      prefix: "01a9f100",
      validUntil: new Date(Date.now() + 86400_000).toISOString(),
    }),
  );
  let reference = 0xc100;
  const deadLetter = (of, storeReference) =>
    admin.query(
      `INSERT INTO platform_eventing.dead_letter_item (dead_letter_id,brand_id,store_id,delivery_path,
         event_id,failure_class,safe_code,attempt_count,policy_name,policy_version,status,opened_at)
       VALUES ($1,$2,$3,'outbox',$4,'exhausted','TRANSPORT_REJECTED',8,'eventing_default',1,'open',$5)`,
      [
        id(reference++),
        of.brandReference,
        storeReference,
        id(reference++),
        new Date(Date.now() - 10 * 60_000).toISOString(),
      ],
    );
  // The first merchant: two stuck updates (one of the Store, one of the whole Brand). The second:
  // one stuck update and an open payment difference. Neither may show at the other.
  await asOwner(first, async () => {
    await deadLetter(first, first.storeReference);
  });
  await asOwner({ ...first, storeReference: "" }, async () => {
    await deadLetter(first, null);
  });
  await asOwner(second, async () => {
    await deadLetter(second, second.storeReference);
    await admin.query(
      "INSERT INTO rms_payment.payment_reconciliation_exception (reconciliation_exception_id,brand_id,store_id,candidate_id,reason,severity,status,opened_at) VALUES ($1,$2,$3,$4,'AmountMismatch','Error','Open',$5)",
      [
        id(reference++),
        second.brandReference,
        second.storeReference,
        id(reference++),
        new Date(Date.now() - 2 * 3600_000).toISOString(),
      ],
    );
  });
  await asOwner(first, async () => undefined);

  const directory = await mkdtemp(path.join(tmpdir(), "store-monitors-"));
  await chmod(directory, 0o700);
  const validUntil = new Date(Date.now() + 86400_000).toISOString();
  const stores = [first, second, never];
  for (const each of stores) {
    await mkdir(path.join(directory, "stores", each.name), { recursive: true, mode: 0o700 });
    await writeFile(
      path.join(directory, "stores", each.name, "internal-test-profile.json"),
      JSON.stringify({ binding: { validUntil: "2027-11-26T02:26:31.000Z" } }),
    );
  }
  await writeFile(
    path.join(directory, "stores.json"),
    JSON.stringify({ schemaVersion: 1, stores: stores.map((each) => `stores/${each.name}`) }),
  );
  // As the monitor's own pool (pilot-connections.mjs).
  const pool = new pg.Pool({
    ...clientConfig,
    max: 2,
    connectionTimeoutMillis: 2000,
    query_timeout: 5000,
  });
  const asApi = (runner) => ({
    run: (work) =>
      runner.run(async (tx) => {
        await tx.query(`SET LOCAL ROLE ${api}`, []);
        return work(tx);
      }),
  });
  const resourcesOf = (of) => ({
    scope: { brandReference: of.brandReference, storeReference: of.storeReference },
    // What a served Store's own runtime directory says it is, valid for this run.
    publicProfile: {
      binding: {
        tenantReference: of.tenantReference,
        brandReference: of.brandReference,
        storeReference: of.storeReference,
        validUntil,
      },
    },
    operating: {
      ...operating,
      tenantReference: of.tenantReference,
      brandReference: of.brandReference,
      storeReference: of.storeReference,
    },
    now: () => new Date().toISOString(),
    // As createBackgroundPilotResources: a conflicted transaction is rerun whole.
    transactions: withTransactionConflictWait(
      asApi(
        createTenantTransactionRunner(pool, {
          brandId: of.brandReference,
          storeId: of.storeReference,
        }),
      ),
    ),
    database: {
      transactions: (runnerScope) => asApi(createTenantTransactionRunner(pool, runnerScope)),
    },
    close: async () => undefined,
  });
  const logs = [];
  const reported = [];
  const loaded = [];
  const monitors = createStoreMonitors({
    runtimeDirectory: directory,
    log: async (entry) => logs.push(entry),
    report: (event, error, where) => reported.push({ event, error, ...where }),
    // This run steps through minutes by the instants it passes, however long each read takes.
    clock: () => 0,
    load: async (storeDirectory) => {
      loaded.push(path.relative(directory, storeDirectory));
      const of = stores.find((each) => each.name === path.basename(storeDirectory));
      assert.ok(of, "a Store's reads load from that Store's own directory");
      const installation = {
        database: "isolated",
        loadProfile: async () => ({
          environment: "InternalTest",
          database: "isolated",
          binding: resourcesOf(of).publicProfile.binding,
        }),
      };
      const dependencies = await composeBusinessDependencies({
        directory: storeDirectory,
        installation,
        store: true,
      });
      return {
        resources: resourcesOf(of),
        installation,
        dependencies: {
          ...dependencies,
          // The owner read of the published tax configuration, with the pilot's file policy stood
          // in for: that file only carries test evidence, which this read never looks at.
          readQuoteTaxConfiguration: (current) =>
            readInternalQuoteTaxReadiness(current, async () => ({
              taxConfiguration: { configurationReference: id(0xc0ff) },
            })),
        },
      };
    },
  });
  const healthy = { maintenance: false, reportAgeMs: 1000, attention: [] };
  const probes = { api: { ok: true }, customer: { ok: true }, merchant: { ok: true } };
  const boardOf = async (name) =>
    JSON.parse(
      await readFile(path.join(directory, "stores", name, "ops", "alert-board.json"), "utf8"),
    );
  const run = (now) =>
    monitors.run({ now, probes, supervisor: healthy, maintenance: null, config: null });
  try {
    const T0 = Date.now();
    await run(T0);
    assert.deepEqual(loaded.sort(), ["stores/first", "stores/never", "stores/second"]);
    const bySummary = (board, key) => board.active.find((item) => item.key === key)?.summary;

    // Each Store's own money facts, and nobody else's.
    const firstBoard = await boardOf("first");
    assert.match(bySummary(firstBoard, "payment.updates"), /^2 updates /u);
    assert.equal(bySummary(firstBoard, "reconciliation.differences"), undefined);
    const secondBoard = await boardOf("second");
    assert.match(bySummary(secondBoard, "payment.updates"), /^1 update /u);
    assert.match(bySummary(secondBoard, "reconciliation.differences"), /^1 difference /u);
    assert.equal(bySummary(secondBoard, "settlement.exceptions"), undefined);
    // A merchant with no published configuration at all says nothing false about receipts or
    // pricing; only what could not be read is held back from "all good" later.
    const neverBoard = await boardOf("never");
    assert.deepEqual(neverBoard.active, []);

    // Every read really ran under the rendered grants: a refused one reads as unreadable, and
    // "Some checks could not run" follows. The second merchant's configuration is real.
    const signals = await (async () => {
      const { readBusinessSignals } =
        await import("../../../tooling/environment/pilot-ops-observe.mjs");
      const dependencies = await composeBusinessDependencies({
        directory: path.join(directory, "stores", "first"),
        installation: {
          database: "isolated",
          loadProfile: async () => ({
            environment: "InternalTest",
            database: "isolated",
            binding: resourcesOf(first).publicProfile.binding,
          }),
        },
        store: true,
      });
      return readBusinessSignals({
        resources: resourcesOf(first),
        installation: {},
        now: Date.now(),
        dependencies: {
          ...dependencies,
          readQuoteTaxConfiguration: (current) =>
            readInternalQuoteTaxReadiness(current, async () => ({
              taxConfiguration: { configurationReference: id(0xc0ff) },
            })),
        },
      });
    })();
    for (const field of ["receiptTemplate", "quoteTax", "heldStock", "pickupCapacity"])
      assert.notEqual(signals[field], "unreadable", field);
    assert.equal(signals.settlementCovered, false);
    assert.equal(signals.settlementExceptions, null);
    // Its published tax configuration is not the file policy's: a real answer, from a real read.
    assert.deepEqual(signals.quoteTax, { ready: false, reason: "TaxConfigurationMismatch" });

    // The closed-day read under the role: the three-day-old Store has one, the one with no
    // configuration has none.
    const closedDay = async (of) =>
      (
        await composeBusinessDependencies({
          directory: path.join(directory, "stores", of.name),
          installation: {
            database: "isolated",
            loadProfile: async () => ({
              environment: "InternalTest",
              database: "isolated",
              binding: resourcesOf(of).publicProfile.binding,
            }),
          },
          store: true,
        })
      ).readClosedBusinessDay(resourcesOf(of));
    assert.equal(await closedDay(second), true);
    assert.equal(await closedDay(never), false);

    // What the merchant's Home reads: its own board through the real reader and projection.
    const home = projectOperationsAlertBoard(
      await createPilotAlertBoardReader(path.join(directory, "stores", "second"))(),
      new Date(T0).toISOString(),
      { audience: "Merchant" },
    );
    assert.equal(home.audience, "Merchant");
    assert.equal(home.monitor, "Reporting");
    assert.equal(home.lastSuccessfulBackupAt, null);
    assert.ok(home.active.some((item) => item.key === "payment.updates"));
    assert.ok(home.active.every((item) => !item.key.startsWith("settlement.not")));

    // A stuck update resolved at one merchant leaves that board only. Another read a minute later.
    await asOwner(second, async () => {
      await admin.query(
        "UPDATE platform_eventing.dead_letter_item SET status='resolved',resolution_kind='retry_completed',resolved_at=now(),version=version+1 WHERE store_id=$1",
        [second.storeReference],
      );
    });
    await asOwner(first, async () => undefined);
    await run(T0 + 60_000);
    await run(T0 + 120_000);
    await run(T0 + 180_000);
    assert.equal(bySummary(await boardOf("second"), "payment.updates"), undefined);
    assert.match(bySummary(await boardOf("first"), "payment.updates"), /^2 updates /u);

    // A refused read is unreadable, never all good, and the raised alert stays on the board.
    await admin.query(`REVOKE SELECT ON platform_eventing.dead_letter_item FROM ${api}`);
    for (const minute of [4, 5, 6, 7, 8, 9, 10]) await run(T0 + minute * 60_000);
    const refused = await boardOf("first");
    assert.match(bySummary(refused, "payment.updates"), /^2 updates /u);
    assert.match(bySummary(refused, "monitor.source"), /payment and settlement status/u);
    await admin.query(`GRANT SELECT ON platform_eventing.dead_letter_item TO ${api}`);
    assert.ok(logs.some((entry) => entry.event === "store_monitor_failed"));

    // One check's read refused, as by a grant a migration left out: the merchant is told nothing,
    // so BOP can find which check it was and the real code.
    const sqlStateOf = (error) => {
      for (let at = error; at !== undefined && at !== null; at = at.cause) {
        const found = at.diagnostic?.sqlState ?? at[Symbol.for("bop.database.failure")]?.sqlState;
        if (typeof found === "string") return found;
      }
      return null;
    };
    await admin.query(`REVOKE SELECT ON rms_inventory.stock_reservation_version FROM ${api}`);
    await run(T0 + 11 * 60_000);
    await run(T0 + 12 * 60_000);
    await admin.query(`GRANT SELECT ON rms_inventory.stock_reservation_version TO ${api}`);
    const failedChecks = (store, check) =>
      logs.filter(
        (entry) =>
          entry.event === "store_check_failed" && entry.store === store && entry.check === check,
      );
    assert.equal(failedChecks("first", "heldStock").length, 1);
    const held = reported.find(
      (item) => item.step === "heldStock" && item.store === "stores/first",
    );
    assert.equal(held.event, "PILOT_OPS_STORE_READ_UNAVAILABLE");
    assert.equal(sqlStateOf(held.error), "42501");
    // Nothing of that reaches what anyone reads: the board has the catalog's words only.
    assert.ok(!JSON.stringify(await boardOf("first")).includes("42501"));

    // The published settings refused: the receipt and pricing checks are just as findable.
    await admin.query(`REVOKE SELECT ON bop_publishing.publishing_mutation_record FROM ${api}`);
    await run(T0 + 13 * 60_000);
    await admin.query(`GRANT SELECT ON bop_publishing.publishing_mutation_record TO ${api}`);
    for (const check of ["receipts", "quoteTax"]) {
      assert.equal(failedChecks("first", check).length, 1, check);
      const answer = reported.find((item) => item.step === check && item.store === "stores/first");
      assert.equal(sqlStateOf(answer.error), "42501", check);
    }
  } finally {
    await pool.end().catch(() => undefined);
    await rm(directory, { recursive: true, force: true });
  }
}
