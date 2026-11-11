import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { URL } from "node:url";
import pg from "pg";
import { it, vi } from "vitest";
import { createPersistentMerchantSettlement } from "../../../apps/api/src/persistent-merchant-settlement.ts";
import { createPersistentMerchantStoreReports } from "../../../apps/api/src/persistent-merchant-store-reports.ts";
import { createPilotMerchantSettlement } from "../../../tooling/environment/pilot-merchant-settlement.mjs";
import { createInternalSettlementDays } from "../../../tooling/environment/pilot-settlement-window.mjs";
import { storeConfigurationProofHashing } from "../../../apps/api/src/merchant-store-configuration-proof-hash.ts";
import { renderPilotAclSql } from "../../../tooling/environment/pilot-acl-render.mjs";
import { storeRoleTemplateActions } from "../../bop/permission/src/index.ts";
import {
  createPostgresAsPublishedStorePublicationProof,
  createPostgresStoreBusinessDateConfigurationSource,
  readStoreFirstConfigurationGoverningFrom,
} from "../../rms/store/src/index.ts";
import { withIsolatedDatabase } from "../test-support/isolated-database.mjs";
import { seedMerchantAcceptanceSession } from "../test-support/merchant-acceptance-session.mjs";
import { seedJourneyStorePublication } from "../test-support/dine-in-journey-seed.mjs";
import { exercisePilotStoreSetupPublication } from "../test-support/pilot-store-setup-publication.mjs";
import { exerciseStoreSetupRuntimeHttp } from "../test-support/store-setup-runtime-http.mjs";

const { Client } = pg;
const id = (n) => "01a7e000-0000-7000-8000-" + n.toString(16).padStart(12, "0");
const sha = "sha256:" + "b".repeat(64);
const minutes = (n) => n * 60_000;
const hours = (n) => minutes(n * 60);
const provider = id(20);
const dateOf = (instant) =>
  new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Toronto",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date(instant));
const shift = (date, days) =>
  new Date(Date.parse(date + "T12:00:00.000Z") + days * 86_400_000).toISOString().slice(0, 10);

/**
 * WP-2423 M160 (v15 2026-11-06, simulation blocker): Fireside Hotpot was set up at 20:51 on its
 * first business day. The owner's Reports worked for today only (yesterday, last 7 days, this
 * month and last month answered 503) and every Settlement answered 503, so Home always said
 * "Could not read: Settlement". The Store's first business day could not be read (its noon anchor
 * and its 04:00 start were before its first configuration), and a dated Settlement of any merchant
 * other than the installation's own Store took its first day from the installation's coverage
 * file, which refused it.
 *
 * Run as a restricted NOBYPASSRLS role holding exactly the rendered pilot API grants. The Store
 * configuration, staff sessions and card-machine payments are owner-seeded TEST-ONLY facts.
 */
it("reads the Store's first business day in reports and settlement, says where records begin and refuses a payment before them", async () => {
  await withIsolatedDatabase({ caseId: "wp2423_first_day" }, async (context) => {
    const admin = new Client(context.clientConfig);
    await admin.connect();
    const api = "wp2423_fd_" + context.runId,
      worker = "wp2423_fd_w_" + context.runId;
    vi.stubEnv("NODE_ENV", "development");
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
      const transactions = {
        async run(work) {
          const client = new Client(context.clientConfig);
          await client.connect();
          try {
            await client.query("BEGIN");
            await client.query("SET LOCAL ROLE " + api);
            await client.query("SET LOCAL statement_timeout = '20s'");
            await client.query("SET LOCAL lock_timeout = '5s'");
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
        },
      };
      const scope = { brandReference: id(1), storeReference: id(2) };
      const ownerScope = { tenantReference: id(3), ...scope };
      const now = () => new Date().toISOString();
      const base = Date.parse(
        (
          await admin.query("SELECT date_trunc('milliseconds',clock_timestamp()) AS at")
        ).rows[0].at.toISOString(),
      );
      const session = await seedMerchantAcceptanceSession({
        admin,
        runner: transactions,
        scope: ownerScope,
        actor: id(10),
        at: now(),
        extraPermissions: [
          "reporting.sales.read",
          "reporting.sales.export",
          "payment.settlement.read",
        ],
      });
      // Today's business day began three hours ago; the Store was set up nine hours into
      // yesterday's (fifteen hours ago), like Fireside Hotpot at 20:51 on 11-04.
      const startedAt = base - hours(3);
      const dayStart =
        new Intl.DateTimeFormat("en-GB", {
          timeZone: "America/Toronto",
          hourCycle: "h23",
          hour: "2-digit",
          minute: "2-digit",
        }).format(new Date(startedAt)) + ":00";
      const today = dateOf(startedAt);
      const first = shift(today, -1);
      const opening = new Date(base - hours(15)).toISOString();
      await seedJourneyStorePublication({
        client: admin,
        scope: ownerScope,
        publishedAt: opening,
        businessDayStart: dayStart,
        prefix: "01a7e100",
      });

      // Card-machine payments at the counter: one with a tip on the first day, one today.
      const pay = async (
        n,
        { total, tip, takenAt, recordedAt = takenAt, reason = "AtCounter" },
      ) => {
        // The preparation the counter's "Send order" step records (Ordering evidence shape).
        const preparation = {
          preparationReference: id(n + 11),
          orderReference: id(n + 1),
          orderBatchReference: id(n + 2),
          submissionReference: id(n + 3),
          sourceCartReference: id(n + 12),
          sourceCartVersion: 1,
          brandReference: scope.brandReference,
          storeReference: scope.storeReference,
          guestSessionReference: id(n + 13),
          quoteReference: id(n + 14),
          capacityAllocationReference: id(n + 15),
          readiness: "PaymentPending",
          transactionBoundary: "OrderSubmissionPaymentPreparation",
          orderAllocation: { amountMinor: String(total - tip), currencyCode: "CAD" },
          tip: { amountMinor: String(tip), currencyCode: "CAD" },
          total: { amountMinor: String(total), currencyCode: "CAD" },
          committedAt: takenAt,
          capacityExpiresAt: new Date(Date.parse(takenAt) + minutes(30)).toISOString(),
          sourceDigest: sha,
        };
        await admin.query(
          `INSERT INTO rms_payment.card_machine_payment VALUES
           ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,'CAD','Test',NULL,$17,$18,$19,$20,$21,$22)`,
          [
            ownerScope.tenantReference,
            scope.brandReference,
            scope.storeReference,
            id(n + 4),
            id(n + 5),
            id(n + 6),
            id(n + 7),
            id(n + 8),
            sha,
            id(n + 1),
            id(n + 2),
            id(n + 3),
            JSON.stringify(preparation),
            total - tip,
            tip,
            total,
            reason,
            takenAt,
            recordedAt,
            id(10),
            id(n + 9),
            id(n + 10),
          ],
        );
      };
      await pay(100, { total: 2150, tip: 150, takenAt: new Date(base - hours(14)).toISOString() });
      await pay(200, { total: 1000, tip: 0, takenAt: new Date(base - hours(1)).toISOString() });

      const persistence = {
        ...session.persistence,
        transactions,
        now,
        publication: {
          configurationType: "STORE_CONFIGURATION",
          purposeCode: "STORE_CONFIGURATION",
          requiredLiveGateRequirementCodes: ["SYNTHETIC_STORE_READY"],
        },
      };
      const resolveConfiguration = async () => ({
        providerAccountReference: provider,
        environment: "Test",
      });
      const reports = createPersistentMerchantStoreReports({ persistence, resolveConfiguration });
      const settlement = createPersistentMerchantSettlement({
        persistence,
        resolveConfiguration,
        settlementRunReference: async () => null,
      });
      const cookie = session.sessionCookie;
      const cardMachine = (view) => view.byChannel.find((entry) => entry.channel === "CardMachine");

      // The first business day alone: its whole nominal day, marked with when the Store opened.
      const firstDay = await reports.read({ sessionCookie: cookie, from: first, to: first });
      assert.equal(firstDay.from, first);
      assert.equal(firstDay.requestedFrom, first);
      assert.equal(firstDay.recordsBeginOn, null);
      assert.equal(firstDay.days.length, 1);
      assert.equal(firstDay.days[0].status, "Closed");
      assert.equal(firstDay.days[0].opensAt, opening);
      assert.equal(
        firstDay.days[0].endsAt,
        new Date(startedAt - (startedAt % 60_000)).toISOString(),
      );
      assert.equal(cardMachine(firstDay).collectedMinor, "2150");
      assert.equal(firstDay.summary.tipsMinor, "150");

      // The settlement of the same day agrees to the cent, whether asked by date or as the last
      // closed day (what Home and Orders read).
      const expectedCard = {
        taken: { count: 1, amountMinor: "2150", currencyCode: "CAD" },
        tipMinor: "150",
        recordedAfterOutageCount: 0,
        refunded: { count: 0, amountMinor: "0", currencyCode: "CAD" },
        // WP-2423 M163: nothing charged back on the machine after a refund made by mistake.
        takenBack: { count: 0, amountMinor: "0", currencyCode: "CAD" },
      };
      for (const businessDate of [first, null]) {
        const day = await settlement({ sessionCookie: cookie, businessDate });
        assert.equal(day.businessDate, first);
        assert.equal(day.window.status, "Closed");
        assert.equal(day.window.startsAt, firstDay.days[0].startsAt);
        assert.deepEqual(day.cardMachine, expectedCard);
      }
      // Today still reads as the open day.
      const open = await settlement({ sessionCookie: cookie, businessDate: today });
      assert.equal(open.window.status, "Open");
      assert.equal(open.cardMachine.taken.amountMinor, "1000");

      // A month asked from before the Store: the range starts at the first day and says so;
      // the totals are the covered days'.
      const asked = shift(today, -30);
      const month = await reports.read({ sessionCookie: cookie, from: asked, to: today });
      assert.equal(month.from, first);
      assert.equal(month.to, today);
      assert.equal(month.requestedFrom, asked);
      assert.equal(month.recordsBeginOn, first);
      assert.deepEqual(
        month.days.map((day) => [day.businessDate, day.status, day.opensAt]),
        [
          [first, "Closed", opening],
          [today, "Open", null],
        ],
      );
      assert.equal(cardMachine(month).collectedMinor, "3150");
      assert.equal(month.summary.tipsMinor, "150");
      // Its CSV keeps the column header first and names where records begin after the figures.
      const file = await reports.export({
        sessionCookie: cookie,
        from: asked,
        to: today,
        report: "summary",
      });
      assert.equal(file.fileName, `summary-${first}-to-${today}.csv`);
      const lines = file.body.slice(1).trimEnd().split("\r\n");
      assert.ok(lines[0].startsWith("business_date,day_status,"));
      assert.deepEqual(lines.slice(-2), ["", "Records begin," + first]);

      // A period wholly before the Store is an answer naming its first day, not an outage.
      await assert.rejects(
        reports.read({ sessionCookie: cookie, from: shift(today, -40), to: shift(today, -10) }),
        (error) =>
          error.code === "MERCHANT_STORE_REPORTS_NOT_COVERED" && error.firstBusinessDate === first,
      );
      await assert.rejects(
        settlement({ sessionCookie: cookie, businessDate: shift(first, -1) }),
        (error) =>
          error.code === "MERCHANT_SETTLEMENT_NOT_COVERED" && error.firstBusinessDate === first,
      );

      // The pilot's own settlement composition: a Store that is not the installation's
      // daily-settlement coverage scope reads its dated day (v15: refused), and the coverage
      // Store's days before the coverage file's first window read with the reconciliation "not
      // checked yet" instead of "nothing to settle" (its earliest settlement date is now its own
      // first business day).
      const pilotSettlement = (coverageScope) =>
        createPilotMerchantSettlement({
          persistence,
          selected: ownerScope,
          refundConfiguration: async () => ({
            providerAccountReference: provider,
            environment: "Test",
            roleMapping: {},
          }),
          // Ignored since M160; kept so this case reads the same before and after the fix.
          loadDailySettlementCoverage: async () => ({
            scope: coverageScope,
            firstWindow: { businessDate: today },
          }),
        });
      const installationStore = {
        tenantReference: id(3),
        brandReference: id(1),
        storeReference: id(0x900),
      };
      for (const coverageScope of [installationStore, ownerScope]) {
        const day = await pilotSettlement(coverageScope)({
          sessionCookie: cookie,
          businessDate: first,
        });
        assert.equal(day.businessDate, first);
        assert.deepEqual(day.cardMachine, expectedCard);
        assert.equal(day.reconciliation?.settlement ?? null, null);
        assert.equal(day.reconciliation?.operational.runCount ?? 0, 0);
      }

      // The installation's daily-settlement worker reads the same first day (it reconciles it once
      // the Store is in its coverage), and still finds no window before the Store's records.
      const workerDays = createInternalSettlementDays({
        resources: {
          scope,
          transactions,
          now,
          operating: {
            ...persistence.publication,
            ...ownerScope,
            ...storeConfigurationProofHashing,
            timeZone: "America/Toronto",
            authorize: async () => true,
          },
        },
        active: async () => true,
      });
      const workerDay = await workerDays.window();
      assert.equal(workerDay.businessDate, first);
      assert.equal(workerDay.startsAt, firstDay.days[0].startsAt);
      assert.equal(workerDay.opensAt, opening);
      await assert.rejects(workerDays.window({ endingAt: workerDay.startsAt }));

      // Staff without the reports or settlement permission are still refused before any read.
      const cashier = await seedMerchantAcceptanceSession({
        admin,
        runner: transactions,
        scope: ownerScope,
        actor: id(601),
        at: now(),
        extraPermissions: storeRoleTemplateActions("front-of-house").filter(
          (action) => !["merchant.access", "order.accept", "ordering.operate"].includes(action),
        ),
        referencePrefix: "01a7e201",
        sessionReferencePrefix: "01a7e301",
      });
      const cashierPersistence = { ...persistence, ...cashier.persistence, transactions, now };
      await assert.rejects(
        createPersistentMerchantStoreReports({
          persistence: { ...cashierPersistence, publication: persistence.publication },
          resolveConfiguration,
        }).read({ sessionCookie: cashier.sessionCookie, from: first, to: first }),
        /DENIED/u,
      );
      await assert.rejects(
        createPersistentMerchantSettlement({
          persistence: { ...cashierPersistence, publication: persistence.publication },
          resolveConfiguration,
          settlementRunReference: async () => null,
        })({ sessionCookie: cashier.sessionCookie, businessDate: first }),
        /MERCHANT_SETTLEMENT_DENIED/u,
      );

      // A payment entered after an outage with a time before the first day would be in no day:
      // reports and settlement refuse loudly instead of leaving it out (no sales suppression).
      // Staff entry refuses such a time, so only a record made outside the product gets here:
      // seeded as the owner with triggers off (TEST-ONLY), first a table paid in cash after an
      // outage (v15: every Fireside Hotpot payment is a table settlement), then a counter one.
      const tableSettlement = id(0x700);
      await admin.query("SET session_replication_role = replica");
      await admin.query(
        `INSERT INTO rms_payment.dining_table_settlement (settlement_id,tenant_id,brand_id,store_id,
         operation_id,intent_digest,dining_session_id,order_id,method,rounds_minor,tip_minor,
         rounding_minor,total_minor,tendered_minor,change_minor,currency_code,payment_environment,
         slip_reference,recording_reason,taken_at,recorded_at,actor_id,audit_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'Cash',2000,0,0,2000,2000,0,'CAD','Test',NULL,
         'RecordedAfterOutage',$9,$10,$11,$12)`,
        [
          tableSettlement,
          ownerScope.tenantReference,
          scope.brandReference,
          scope.storeReference,
          id(0x701),
          sha,
          id(0x702),
          id(0x703),
          new Date(startedAt - hours(25)).toISOString(),
          new Date(base).toISOString(),
          id(10),
          id(0x704),
        ],
      );
      await admin.query("SET session_replication_role = origin");
      await assert.rejects(
        reports.read({ sessionCookie: cookie, from: asked, to: today }),
        /MERCHANT_PAYMENT_BEFORE_STORE_RECORDS/u,
      );
      await assert.rejects(
        settlement({ sessionCookie: cookie, businessDate: first }),
        /MERCHANT_PAYMENT_BEFORE_STORE_RECORDS/u,
      );
      await admin.query("SET session_replication_role = replica");
      await admin.query("DELETE FROM rms_payment.dining_table_settlement WHERE settlement_id=$1", [
        tableSettlement,
      ]);
      await admin.query("SET session_replication_role = origin");
      assert.equal(
        (await settlement({ sessionCookie: cookie, businessDate: first })).businessDate,
        first,
      );
      await pay(300, {
        total: 900,
        tip: 0,
        takenAt: new Date(startedAt - hours(25)).toISOString(),
        recordedAt: new Date(base).toISOString(),
        reason: "RecordedAfterOutage",
      });
      await assert.rejects(
        reports.read({ sessionCookie: cookie, from: asked, to: today }),
        /MERCHANT_PAYMENT_BEFORE_STORE_RECORDS/u,
      );
      await assert.rejects(
        settlement({ sessionCookie: cookie, businessDate: null }),
        /MERCHANT_PAYMENT_BEFORE_STORE_RECORDS/u,
      );

      // The first configuration keeps the Store's first day when it is given an end (a version in
      // force for a while still governed from its first instant), so the days it had sales on
      // never read as before the records. Rewritten as the owner with triggers off (TEST-ONLY):
      // versions are append-only in the product.
      const governing = () =>
        transactions.run((tx) => readStoreFirstConfigurationGoverningFrom(tx, scope));
      const setUntil = async (until) => {
        await admin.query("SET session_replication_role = replica");
        await admin.query(
          "UPDATE rms_store.store_configuration_version SET effective_until=$3 WHERE brand_id=$1 AND store_id=$2",
          [scope.brandReference, scope.storeReference, until],
        );
        await admin.query("SET session_replication_role = origin");
      };
      await setUntil(new Date(Date.parse(opening) + hours(1)).toISOString());
      assert.equal(await governing(), opening);
      await setUntil(null);
      assert.equal(await governing(), opening);
    } finally {
      await admin.query("SET session_replication_role = origin").catch(() => undefined);
      await admin.query("RESET ROLE").catch(() => undefined);
      for (const name of [api, worker])
        await admin
          .query("DROP OWNED BY " + name + " CASCADE")
          .then(() => admin.query("DROP ROLE " + name))
          .catch(() => undefined);
      await admin.end();
    }
  });
});

/**
 * WP-2423 M160: the instant a Store's records begin is computed by the configuration source's own
 * rule (effective, and its Store publication recorded, created and updated). For a configuration
 * published through the real Store setup path, the source accepts it at exactly that instant
 * (its Publishing release was created by then) and not a millisecond before.
 */
it("a configuration published through Store setup governs from the instant the first-day rule computes", async () => {
  vi.stubEnv("NODE_ENV", "development");
  let checked = false;
  await withIsolatedDatabase({ caseId: "wp2423_first_day_pub" }, (context) =>
    exerciseStoreSetupRuntimeHttp({
      ...context,
      afterSetup: (input) =>
        exercisePilotStoreSetupPublication({
          ...input,
          afterPublication: async ({ admin, scope, store, transactions, operating }) => {
            const read = createPostgresStoreBusinessDateConfigurationSource({
              brandReference: scope.brandReference,
              storeReference: store,
              timeZone: operating.timeZone,
              authorize: async () => true,
              publicationProof: async (tx, candidate, at) => {
                const proof = await createPostgresAsPublishedStorePublicationProof({
                  ...operating,
                  configurationReference: candidate.configurationReference,
                })(tx, at);
                return {
                  contentDigest: proof.contentDigest,
                  businessDayStartSource: proof.businessDayStartSource,
                };
              },
            });
            const versions = (
              await admin.query(
                "SELECT v.configuration_id::text AS id,date_trunc('milliseconds',t)+CASE WHEN t>date_trunc('milliseconds',t) THEN interval '1 millisecond' ELSE interval '0' END AS governs FROM (SELECT v.configuration_id,greatest(v.effective_from,v.created_at,v.updated_at,c.recorded_at) AS t,v.configuration_version FROM rms_store.store_configuration_version v JOIN rms_store.store_configuration_publication_content c USING (brand_id,store_id,configuration_id) WHERE v.brand_id=$1 AND v.store_id=$2 AND v.lifecycle='Published') v ORDER BY v.configuration_version",
                [scope.brandReference, store],
              )
            ).rows;
            assert.ok(versions.length >= 2, "the installed and the published configuration");
            const published = versions.at(-1);
            const at = published.governs.toISOString();
            await transactions.run(async (tx) => {
              assert.equal((await read(tx, at)).configurationReference, published.id);
              const before = await read(tx, new Date(Date.parse(at) - 1).toISOString()).catch(
                () => null,
              );
              assert.notEqual(before?.configurationReference ?? null, published.id);
              // The Store's records begin with its first (installed) configuration, readable there.
              const opening = await readStoreFirstConfigurationGoverningFrom(tx, {
                brandReference: scope.brandReference,
                storeReference: store,
              });
              assert.equal(opening, versions[0].governs.toISOString());
              assert.equal((await read(tx, opening)).configurationReference, versions[0].id);
            });
            checked = true;
          },
        }),
    }),
  );
  assert.equal(checked, true, "the publication hook ran");
});
