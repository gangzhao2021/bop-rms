import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import pg from "pg";
import {
  projectOperationsAlertBoard,
  projectOrderingEndingNotice,
} from "../../../apps/api/dist/merchant-operations-alerts.js";
import { readInternalQuoteTaxReadiness } from "../../../tooling/environment/pilot-configured-quote.mjs";
import { createPilotAlertBoardReader } from "../../../tooling/environment/pilot-ops-files.mjs";
import { createInternalSettlementDays } from "../../../tooling/environment/pilot-settlement-window.mjs";
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
  // A merchant whose only configuration is the TEST tool's first one: its Owner has not opened.
  const unopened = {
    name: "unopened",
    tenantReference: id(0xc021),
    brandReference: id(0xc022),
    storeReference: id(0xc023),
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
  await asOwner(unopened, () =>
    seedJourneyStorePublication({
      client: admin,
      scope: unopened,
      publishedAt: new Date(Date.now() - 3600_000).toISOString(),
      businessDayStart: "04:00:00",
      prefix: "01a9f200",
      validUntil: new Date(Date.now() + 86400_000).toISOString(),
      reasonCode: "INTERNAL_TEST_STORE_SETUP",
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
  const coverage = new Map();
  const loadStore = async (storeDirectory) => {
    loaded.push(path.relative(directory, storeDirectory));
    const of = [...stores, unopened].find((each) => each.name === path.basename(storeDirectory));
    assert.ok(of, "a Store's reads load from that Store's own directory");
    const installation = {
      database: "isolated",
      loadProfile: async () => ({
        environment: "InternalTest",
        database: "isolated",
        binding: resourcesOf(of).publicProfile.binding,
      }),
      loadDailySettlementCoverage: async () => coverage.get(of.name),
      // No Store here has a Workflow binding file in its directory: the real installation
      // (pilot-installation.mjs) refuses to load one that is not there.
      loadWorkflow: async () => {
        throw new Error("PILOT_INSTALLATION_UNAVAILABLE");
      },
      loadCancellationWorkflow: async () => {
        throw new Error("PILOT_INSTALLATION_UNAVAILABLE");
      },
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
  };
  const monitors = createStoreMonitors({
    runtimeDirectory: directory,
    log: async (entry) => logs.push(entry),
    report: (event, error, where) => reported.push({ event, error, ...where }),
    // This run steps through minutes by the instants it passes, however long each read takes.
    clock: () => 0,
    load: loadStore,
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
    const sqlStateOf = (error) => {
      for (let at = error; at !== undefined && at !== null; at = at.cause) {
        const found = at.diagnostic?.sqlState ?? at[Symbol.for("bop.database.failure")]?.sqlState;
        if (typeof found === "string") return found;
      }
      return null;
    };

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
    const { readBusinessSignals } =
      await import("../../../tooling/environment/pilot-ops-observe.mjs");
    const signalsOf = async (of, change = {}) => {
      const dependencies = await composeBusinessDependencies({
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
      });
      return readBusinessSignals({
        resources: resourcesOf(of),
        installation: {},
        now: Date.now(),
        dependencies: {
          ...dependencies,
          readQuoteTaxConfiguration: (current) =>
            readInternalQuoteTaxReadiness(current, async () => ({
              taxConfiguration: { configurationReference: id(0xc0ff) },
            })),
          ...change,
        },
      });
    };
    const signals = await signalsOf(first);
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
    // Refused, as by a grant a migration left out, it is no "none yet": it fails with the code, so
    // the monitor says the check could not run and keeps telling BOP there is no settlement.
    await admin.query(`REVOKE SELECT ON rms_store.store_configuration_version FROM ${api}`);
    const refusedDay = await closedDay(second).then(
      () => null,
      (error) => error,
    );
    await admin.query(`GRANT SELECT ON rms_store.store_configuration_version TO ${api}`);
    assert.notEqual(refusedDay, null, "a refused closed-day read is not 'no closed day'");
    assert.equal(sqlStateOf(refusedDay), "42501");
    assert.equal(await closedDay(second), true);

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

    // Before its Owner publishes, a merchant on the TEST tool's first configuration is not checked
    // for receipts, pricing, pickup times or held stock: the real gate, under the role, says not
    // opened. Run on a timeline of its own, well past the 5 minutes "Some checks could not run"
    // takes, beside the merchant with no configuration at all: without the gate those reads would
    // run on settings and business days not set up yet, and that row would rise at both.
    const openedOf = async (of) =>
      (
        await composeBusinessDependencies({
          directory: path.join(directory, "stores", of.name),
          installation: { database: "isolated", loadProfile: async () => null },
          store: true,
        })
      ).readOwnerPublishedSetup(resourcesOf(of));
    assert.equal(await openedOf(unopened), false);
    assert.equal(await openedOf(never), false);
    // DEC-STORE-FIRST-OPENING (WP-2423 item 14): only a publication made from Store setup opens a
    // Store. The second merchant's only configuration was installed for it, under an ordinary
    // reason code, so its Owner still has Store setup to answer, whatever that reason code says.
    assert.equal(await openedOf(second), false);
    assert.equal(await openedOf(first), true);
    const aside = await mkdtemp(path.join(tmpdir(), "store-monitors-unopened-"));
    try {
      await chmod(aside, 0o700);
      for (const name of ["unopened", "never"]) {
        await mkdir(path.join(aside, "stores", name), { recursive: true, mode: 0o700 });
        await writeFile(
          path.join(aside, "stores", name, "internal-test-profile.json"),
          JSON.stringify({ binding: { validUntil: "2027-11-26T02:26:31.000Z" } }),
        );
      }
      await writeFile(
        path.join(aside, "stores.json"),
        JSON.stringify({ schemaVersion: 1, stores: ["stores/unopened", "stores/never"] }),
      );
      const alone = createStoreMonitors({
        runtimeDirectory: aside,
        log: async (entry) => logs.push({ ...entry, aside: true }),
        report: (event, error, where) => reported.push({ event, error, ...where, aside: true }),
        clock: () => 0,
        load: loadStore,
      });
      for (let minute = 0; minute <= 7; minute += 1)
        await alone.run({
          now: T0 + minute * 60_000,
          probes,
          supervisor: healthy,
          maintenance: null,
          config: null,
        });
      const boardAside = async (name) =>
        JSON.parse(
          await readFile(path.join(aside, "stores", name, "ops", "alert-board.json"), "utf8"),
        );
      const quiet = await boardAside("unopened");
      // What the gate holds back: receipts, pricing, pickup times and held stock are neither read
      // nor raised.
      const gated = ["receipts", "quoteTax", "pickupCapacity", "heldStock"];
      assert.deepEqual(
        logs
          .filter((entry) => entry.aside === true && entry.event === "store_check_failed")
          .map((entry) => entry.check)
          .filter((check) => gated.includes(check)),
        [],
        "nothing read before its Owner has opened",
      );
      const readiness = [
        "receipts.template",
        "pricing.tax_configuration",
        "pickup.capacity_horizon",
        "orders.held_stock",
      ];
      assert.deepEqual(
        quiet.active.map((item) => item.key).filter((key) => readiness.includes(key)),
        [],
      );
      for (const source of [
        "the receipt template check",
        "the check that orders can be priced",
        "the check for pickup times",
        "the check for orders holding stock",
      ])
        assert.ok(!JSON.stringify(quiet.active).includes(source), source);
      // Past the 5 minutes "Some checks could not run" takes, neither new merchant is told so.
      for (const name of ["unopened", "never"])
        assert.deepEqual(
          (await boardAside(name)).active.map((item) => item.key),
          [],
          `${name}: nothing raised before its Owner has opened`,
        );
    } finally {
      await rm(aside, { recursive: true, force: true });
    }

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

    // The money reads refused one at a time: stuck updates must still say "do not take a second
    // payment" on the merchant's Home while the rest of the read cannot run. The second merchant's
    // first closed day is recorded here, so its settlement is really scanned under the grants.
    const keysOf = (board) => board.active.map((item) => item.key).sort();
    const closedDays = createInternalSettlementDays({
      resources: resourcesOf(second),
      active: async () => true,
    });
    coverage.set(second.name, { firstWindow: await closedDays.window() });
    await writeFile(
      path.join(directory, "stores", "second", "daily-settlement-coverage.json"),
      JSON.stringify({ schemaVersion: 1 }),
    );
    await run(T0 + 14 * 60_000);
    assert.equal(failedChecks("second", "settlement").length, 0);
    await asOwner(second, async () => {
      await deadLetter(second, second.storeReference);
    });
    await asOwner(first, async () => undefined);

    await admin.query(`REVOKE SELECT ON rms_payment.payment_reconciliation_run FROM ${api}`);
    for (const minute of [20, 25]) await run(T0 + minute * 60_000);
    await admin.query(`GRANT SELECT ON rms_payment.payment_reconciliation_run TO ${api}`);
    const noScan = await boardOf("second");
    assert.ok(keysOf(noScan).includes("payment.updates"), "stuck updates stay in view");
    assert.ok(keysOf(noScan).includes("reconciliation.differences"));
    assert.match(bySummary(noScan, "monitor.source"), /the day-end settlement check/u);
    assert.equal(failedChecks("second", "settlement").length, 1);
    const scan = reported.find(
      (item) => item.step === "settlement" && item.store === "stores/second",
    );
    assert.equal(sqlStateOf(scan.error), "42501");
    assert.ok(!JSON.stringify(noScan).includes("42501"));
    const merchantHome = projectOperationsAlertBoard(noScan, noScan.observedAt, {
      audience: "Merchant",
    });
    assert.ok(merchantHome.active.some((item) => item.key === "payment.updates"));
    assert.ok(merchantHome.active.every((item) => item.key !== "monitor.source"));
    // "Last checked" is when the scan was first refused (minute 20), not its raise at minute 25.
    assert.equal(merchantHome.checksIncompleteSince, new Date(T0 + 20 * 60_000).toISOString());

    await admin.query(`REVOKE SELECT ON rms_payment.payment_reconciliation_exception FROM ${api}`);
    for (const minute of [31, 32, 33, 34, 35, 36]) await run(T0 + minute * 60_000);
    await admin.query(`GRANT SELECT ON rms_payment.payment_reconciliation_exception TO ${api}`);
    const noDifferences = await boardOf("second");
    assert.ok(keysOf(noDifferences).includes("payment.updates"), "stuck updates stay in view");
    assert.ok(keysOf(noDifferences).includes("reconciliation.differences"), "what it said stays");
    assert.match(bySummary(noDifferences, "monitor.source"), /the check for payment differences/u);
    assert.equal(failedChecks("second", "reconciliation").length, 1);
    const differences = reported.find(
      (item) => item.step === "reconciliation" && item.store === "stores/second",
    );
    assert.equal(sqlStateOf(differences.error), "42501");

    // What any staff member's screen reads, from the real board and through the real reader: the
    // end of ordering in its last day, and nothing before it.
    let staffNow = T0 + 36 * 60_000;
    const staffRead = async () =>
      projectOrderingEndingNotice(
        await createPilotAlertBoardReader(path.join(directory, "stores", "second"))(),
        new Date(staffNow).toISOString(),
      );
    assert.deepEqual(await staffRead(), { endsAt: null, support: null });
    const profileOf = path.join(directory, "stores", "second", "internal-test-profile.json");
    const endingIn = async (hours, minute) => {
      const validUntil = new Date(T0 + minute * 60_000 + hours * 3600_000).toISOString();
      await writeFile(profileOf, JSON.stringify({ binding: { validUntil } }));
      await run(T0 + minute * 60_000);
      staffNow = T0 + minute * 60_000 + 30_000;
      return validUntil;
    };
    await endingIn(25, 40);
    assert.deepEqual(await staffRead(), { endsAt: null, support: null });
    const validEnd = await endingIn(23, 41);
    assert.deepEqual(await staffRead(), { endsAt: validEnd, support: null });
    // The monitor stops after that and BOP renews: an old board never tells staff ordering stopped.
    staffNow = Date.parse(validEnd) + 60_000;
    assert.deepEqual(await staffRead(), { endsAt: null, support: null });
  } finally {
    await pool.end().catch(() => undefined);
    await rm(directory, { recursive: true, force: true });
  }
}
