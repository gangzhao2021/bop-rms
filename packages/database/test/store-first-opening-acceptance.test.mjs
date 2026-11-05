import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { readFile } from "node:fs/promises";
import { request } from "node:http";
import { createRequire } from "node:module";
import { URL } from "node:url";
import pg from "pg";
import { it, vi } from "vitest";
import { storeRoleTemplateActions } from "../../bop/permission/src/index.ts";
import { createIdentityActor } from "../../bop/identity/src/index.ts";
import { changeStoreTipSetting } from "../../rms/payment/src/index.ts";
import { hasOwnerPublishedStoreSetup } from "../../rms/store/src/index.ts";
import { input as quoteInput } from "../../rms/pricing/src/tests/price-quote.fixture.ts";
import { createMerchantBffRouter } from "../../../apps/api/dist/merchant-bff.js";
import { createMerchantOpeningChecklist } from "../../../apps/api/dist/merchant-opening-checklist.js";
import { readStoreTipChoices } from "../../../apps/api/dist/merchant-store-features.js";
import { renderPilotAclSql } from "../../../tooling/environment/pilot-acl-render.mjs";
import { createInternalRefundWorkforceContext } from "../../../tooling/environment/pilot-refund-workforce.mjs";
import { createInternalStoreSetupBff } from "../../../tooling/environment/pilot-store-setup.mjs";
import {
  storeConfigurationContentHash,
  storeConfigurationSetupSnapshotReferences,
  storeConfigurationValidationCheckCodes,
} from "../../../tooling/environment/pilot-store-publication-codes.mjs";
import {
  createStoreOpeningDeps,
  loadOpeningFacts,
  openingConfirmationFromFacts,
  openingWaitsFromFacts,
  runStoreOpening,
} from "../../../apps/merchant-web/src/store-first-opening.ts";
import { seedJourneyStorePublication } from "../test-support/dine-in-journey-seed.mjs";
import { withIsolatedDatabase } from "../test-support/isolated-database.mjs";
import { seedMerchantAcceptanceSession } from "../test-support/merchant-acceptance-session.mjs";
import { seedSoleOperatorSetting, seedStepUp } from "../test-support/sole-operator-brand-gate.mjs";
import { seedTaxConfiguration } from "../test-support/tax-configuration-seed.mjs";

const { Client } = pg;
const require = createRequire(new URL("../../../apps/api/package.json", import.meta.url));
const express = require("express");
const hour = 3600000;
const id = (base, n) => base + "-0000-7000-8000-" + n.toString(16).padStart(12, "0");

/** A journal that lasts the test: the same contract as the browser's durable one. */
const memoryJournal = () => {
  let held = null;
  return {
    load: async () => held,
    reserve: async (cursor) => {
      held = cursor;
    },
    complete: async () => {
      held = null;
      return { historical: false };
    },
  };
};
const keyed = () => {
  const journals = new Map();
  return (key) => {
    const name = String(key);
    if (!journals.has(name)) journals.set(name, memoryJournal());
    return journals.get(name);
  };
};

const details = {
  names: { "en-CA": "First Noodle House - not production" },
  addressLines: ["1 King Street West", ""],
  locality: "Toronto",
  regionCode: "ON",
  postalCode: "M5H 1A1",
  phone: "(416) 555-0100",
  businessName: "First Noodle House Inc.",
  gstHstNumber: "",
  qstNumber: "",
  pstNumber: "",
};
/** Lunch and dinner past midnight, closed Mondays, dine-in only: nothing like the first config. */
const answers = {
  serviceModes: ["DineIn"],
  hours: {
    sameEveryDay: true,
    everyDay: [
      { start: "11:30", end: "14:30" },
      { start: "17:00", end: "00:00" },
    ],
    days: Array.from({ length: 7 }, (_, index) => ({
      open: index !== 0,
      periods: [{ start: "", end: "" }],
    })),
    lastOrdersMinutes: "30",
    preparationMinutes: "15",
  },
  offerTips: true,
};

/**
 * WP-2423 item 14 (DEC-STORE-FIRST-OPENING): the page's own run (the browser's exported functions,
 * real clients, real parsers) against the real Store setup, payment, receipt template and Store
 * configuration routes of the pilot composition, as a NOBYPASSRLS role holding exactly the rendered
 * pilot API grants, with the real v16 Owner template. Test-controlled and labelled: the installed
 * first configuration with its go-live check, the Store's tax configuration, the second factor and
 * the sole-operator setting (owner-seeded; their own commands have their own acceptance), and the
 * name, receipt, kitchen, tips and allergen clients, which keep their own acceptance tests.
 */
it("a first Store's Owner publishes with one action, alone or with a second Owner", async () => {
  vi.stubEnv("NODE_ENV", "development");
  await withIsolatedDatabase({ caseId: "wp2423_first_open" }, async (context) => {
    const admin = new Client(context.clientConfig);
    await admin.connect();
    const api = "wp2423_fo_" + context.runId,
      worker = "wp2423_fo_w_" + context.runId;
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
      const now = () => new Date().toISOString();
      const transactions = {
        async run(work) {
          const client = new Client(context.clientConfig);
          await client.connect();
          try {
            await client.query("BEGIN");
            await client.query("SET LOCAL ROLE " + api);
            await client.query("SET LOCAL statement_timeout = '20s'");
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

      /** One Brand and Store as the TEST tool leaves it, with its Owners on the real template. */
      const openedStore = async (base, owners) => {
        const scope = {
          tenantReference: id(base, 0x90),
          brandReference: id(base, 0x91),
          storeReference: id(base, 0x92),
        };
        let next = 0x1000;
        const reference = () => id(base, next++);
        // Each merchant under its own codes: the session seed only adds them when absent.
        const from = new Date(Date.now() - 3 * hour).toISOString();
        await admin.query(
          "INSERT INTO bop_tenant.brand VALUES ($1,$2,'First Opening Brand','en-CA','CAD','Active',1,$3,$3)",
          [scope.brandReference, "FIRST_OPENING_" + base.slice(4, 6).toUpperCase(), from],
        );
        await admin.query(
          "INSERT INTO bop_tenant.store VALUES ($1,$2,'MAIN','First Opening Store','America/Toronto','en-CA','CAD','Active',1,$3,$3)",
          [scope.storeReference, scope.brandReference, from],
        );
        await seedJourneyStorePublication({
          client: admin,
          scope,
          publishedAt: new Date(Date.now() - 2 * hour).toISOString(),
          businessDayStart: "04:00:00",
          prefix: base.slice(0, 6) + "a0",
        });
        const installed = (
          await admin.query(
            "SELECT configuration_json FROM rms_store.store_configuration_publication_content WHERE store_id=$1",
            [scope.storeReference],
          )
        ).rows[0].configuration_json;
        const people = {};
        for (const [index, name] of owners.entries()) {
          const actor = id(base, 0x100 + index);
          const session = await seedMerchantAcceptanceSession({
            admin,
            runner: transactions,
            scope,
            actor,
            at: now(),
            extraPermissions: storeRoleTemplateActions("owner").filter(
              (action) => !["merchant.access", "order.accept", "ordering.operate"].includes(action),
            ),
            referencePrefix: base.slice(0, 6) + "b" + index,
            sessionReferencePrefix: base.slice(0, 6) + "c" + index,
          });
          people[name] = {
            ...session,
            actor,
            persistence: {
              ...session.persistence,
              now,
              transactions,
              publication: {
                configurationType: "STORE_CONFIGURATION",
                purposeCode: "STORE_CONFIGURATION",
                requiredLiveGateRequirementCodes: ["SYNTHETIC_STORE_READY"],
                requiredValidationCheckCodes: storeConfigurationValidationCheckCodes,
              },
              currentActor: async (_tx, actorReference, authenticatedAt) =>
                createIdentityActor({
                  actorType: "User",
                  actorReference,
                  accountKind: "Workforce",
                  status: "Active",
                  authenticationMethod: "Oidc",
                  verificationLevel: "SingleFactor",
                  authenticatedAt,
                  recentMfaAt: null,
                }),
            },
          };
        }
        const operating = {
          ...scope,
          timeZone: "America/Toronto",
          configurationType: "STORE_CONFIGURATION",
          purposeCode: "STORE_CONFIGURATION",
          requiredLiveGateRequirementCodes: ["SYNTHETIC_STORE_READY"],
          requiredValidationCheckCodes: storeConfigurationValidationCheckCodes,
          setupSnapshotReferences: storeConfigurationSetupSnapshotReferences,
          hashContent: storeConfigurationContentHash,
          authorize: async () => true,
        };
        const resources = { operating, transactions, now, credentials: { reference } };
        /** Runs `work` with a server for this person, and clients that talk to it. */
        const listening = async (person, work) => {
          const bff = await createInternalStoreSetupBff(resources, {
            persistence: person.persistence,
            authentication: person.authentication,
            nextReference: reference,
          });
          const app = express();
          app.use(
            "/merchant",
            createMerchantBffRouter({
              service: person.authentication,
              exactOrigin: "https://merchant.invalid",
              acceptedHost: "merchant.invalid",
              ...bff,
              openingChecklist: createMerchantOpeningChecklist({
                persistence: person.persistence,
                authentication: person.authentication,
                approvalContext: (tx, active) =>
                  createInternalRefundWorkforceContext({
                    expected: {
                      tenantReference: active.selected.tenantReference,
                      brandReference: active.context.brand.brandReference,
                      storeReference: active.store.storeReference,
                    },
                    persistence: person.persistence,
                    sessionActorReference: String(active.actorReference),
                    sessionContext: async () => active.context,
                    current: async (t) => t === tx && (await active.allowed()),
                    permissions: ["organization.manage", "store.service.approve"],
                  }),
              }),
            }),
          );
          const server = app.listen(0, "127.0.0.1");
          await new Promise((resolve) => server.once("listening", resolve));
          const fetcher = (path, init = {}) =>
            new Promise((resolve, reject) => {
              const body = init.body === undefined ? null : Buffer.from(init.body);
              const headers = {
                ...Object.fromEntries(new globalThis.Headers(init.headers).entries()),
                host: "merchant.invalid",
                origin: "https://merchant.invalid",
                "sec-fetch-site": "same-origin",
                cookie: "__Host-bop-merchant=" + person.sessionCookie,
                ...(body === null ? {} : { "content-length": body.byteLength }),
              };
              const sent = request(
                {
                  host: "127.0.0.1",
                  port: server.address().port,
                  method: init.method ?? "GET",
                  path,
                  headers,
                },
                (response) => {
                  const chunks = [];
                  response.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
                  response.once("end", () =>
                    resolve(
                      new globalThis.Response(
                        response.statusCode === 204 ? null : Buffer.concat(chunks),
                        {
                          status: response.statusCode,
                          headers: Object.entries(response.headers).flatMap(([name, value]) =>
                            value === undefined
                              ? []
                              : [[name, Array.isArray(value) ? value.join(",") : String(value)]],
                          ),
                        },
                      ),
                    ),
                  );
                },
              );
              sent.setTimeout(30000, () => sent.destroy(new Error("OPENING_HTTP_TIMEOUT")));
              sent.once("error", reject);
              sent.end(body ?? undefined);
            });
          try {
            return await work(fetcher);
          } finally {
            server.closeAllConnections();
            await new Promise((resolve) => server.close(resolve));
          }
        };
        return { scope, base, people, installed, listening };
      };
      /** The Store's tax rates, as BOP support leaves them (TEST-ONLY, owner-seeded). */
      const seedTax = async ({ base, scope, installed, people }) => {
        const tax = quoteInput().taxConfiguration;
        await seedTaxConfiguration(
          admin,
          {
            ...tax,
            configurationReference: installed.taxConfigurationReference,
            versionReference: id(base, 0x200),
            brandReference: scope.brandReference,
            storeReference: scope.storeReference,
            effectivePeriod: {
              ...tax.effectivePeriod,
              timeZone: "America/Toronto",
              effectiveFrom: {
                ...tax.effectivePeriod.effectiveFrom,
                instant: new Date(Date.now() - 24 * hour).toISOString(),
              },
              effectiveUntil: null,
            },
            registrationEvidence: {
              ...tax.registrationEvidence,
              validUntil: new Date(Date.now() + 240 * hour).toISOString(),
            },
            professionalEvidence: {
              ...tax.professionalEvidence,
              validUntil: new Date(Date.now() + 240 * hour).toISOString(),
            },
            rules: tax.rules.map((rule) => ({ ...rule, ruleReference: id(base, 0x201) })),
            createdAt: new Date(Date.now() - 24 * hour).toISOString(),
          },
          Object.values(people)[0].actor,
        );
      };
      /** The clients this test does not take to a server: each has its own acceptance. */
      const standIns = (store) => ({
        profile: {
          load: async () => ({
            observedAt: now(),
            canChange: true,
            locales: ["en-CA"],
            current: store.profile,
            regionCodes: ["ON"],
          }),
          save: async (body) => {
            store.profile = {
              version: body.expectedVersion + 1,
              publishedAt: now(),
              defaultLocale: "en-CA",
              names: [
                { locale: "en-CA", storeDisplayName: body.details.storeDisplayNames["en-CA"] },
              ],
              address: {
                ...body.details.address,
                postalCode: body.details.address.postalCode.toUpperCase(),
                countryCode: "CA",
              },
              businessPhone: "+14165550100",
            };
            return store.profile;
          },
        },
        receipts: {
          load: async () => ({
            observedAt: now(),
            canChange: true,
            version: store.receiptVersion,
            recordedAt: store.receiptVersion > 0 ? now() : null,
            details: {
              gstHstNumber: null,
              qstNumber: null,
              pstNumber: null,
              privacyNoticeUrl: null,
            },
            gaps: { taxRegistrationMissing: true, privacyNoticeMissing: true },
            issuer: {
              businessName: store.receiptVersion > 0 ? details.businessName : null,
              suggestedBusinessName: "Brand",
            },
          }),
          save: async () => {
            store.receiptVersion += 1;
            return { version: store.receiptVersion, gaps: {} };
          },
        },
        kitchen: {
          load: async () => ({
            canChange: true,
            version: store.kitchenVersion,
            inEffectFrom: null,
            uncoveredDishes: [],
          }),
          apply: async () => {
            store.kitchenVersion += 1;
          },
        },
        features: {
          read: async () => ({
            tips: {
              version: 0,
              enabled: true,
              tierPercents: [10, 15, 18],
              changedAt: null,
              offInStoreSetup: false,
            },
          }),
          changeTips: async () => assert.fail("tips stay as they are"),
        },
        soleOperator: {
          read: async () => ({
            state: store.soleOperator,
            version: store.soleOperator === "On" ? 1 : 0,
            verifiedUntil: null,
          }),
          change: async (command) => {
            assert.equal(command.reasonCode, "OWNER_RUNS_STORE_ALONE");
            await seedSoleOperatorSetting(admin, {
              id: (n) => id(store.base, n),
              n: 0x300,
              tenantReference: store.scope.tenantReference,
              brandReference: store.scope.brandReference,
              actorReference: store.ownerActor,
              state: "On",
              version: 1,
            });
            store.soleOperator = "On";
          },
        },
        allergens: {
          load: async () => ({
            screenId: "CMP-ALLERGEN-REVIEW",
            sourceAsOf: now(),
            viewer: store.ownerActor,
            locale: "en-CA",
            permissions: { mayRead: true, mayDeclare: true, mayManageRegistry: true },
            registry: { entries: [] },
            registryProposal: null,
            soleOperator: null,
            registryTemplate: { template: "CA_PRIORITY_TEST", allergens: [] },
            sources: [],
            items: [],
          }),
        },
      });
      const depsFor = (person, opened, store, journals, fetcher) => ({
        ...createStoreOpeningDeps({
          scope: { ...opened.scope, actorReference: person.actor },
          csrf: person.csrf,
          signal: new globalThis.AbortController().signal,
          locale: "en-CA",
          fetcher,
          journals,
        }),
        ...standIns(store),
      });
      const journalsFor = () => ({
        setupJournal: memoryJournal(),
        referenceJournal: keyed(),
        paymentJournal: memoryJournal(),
        artifactJournal: keyed(),
        templateJournal: keyed(),
        submitJournal: keyed(),
        lifecycleJournal: keyed(),
        configurationJournal: memoryJournal(),
      });
      const counts = async (store) =>
        (
          await admin.query(
            `SELECT
              (SELECT count(*)::int FROM rms_store.store_setup_reference_version WHERE store_id=$1) "references",
              (SELECT count(*)::int FROM rms_payment.store_payment_configuration_version WHERE store_id=$1) payments,
              (SELECT count(*)::int FROM rms_device.digital_receipt_template_artifact_version WHERE store_id=$1) artifacts,
              (SELECT count(*)::int FROM rms_device.digital_receipt_template_draft_revision WHERE store_id=$1) templates,
              (SELECT count(*)::int FROM rms_store.store_setup_draft_revision WHERE store_id=$1) drafts,
              (SELECT count(*)::int FROM rms_store.store_configuration_version WHERE store_id=$1) configurations,
              (SELECT count(*)::int FROM bop_publishing.publishing_mutation_record WHERE store_id=$1) publishing,
              (SELECT count(*)::int FROM platform_audit.audit_record WHERE store_id=$1) audits`,
            [store],
          )
        ).rows[0];
      const setupPublished = ({ scope }) =>
        transactions.run((tx) => hasOwnerPublishedStoreSetup(tx, scope));

      // --- One Owner, on their own.
      {
        const opened = await openedStore("01a8f100", ["owner"]);
        const owner = opened.people.owner;
        const store = {
          base: opened.base,
          scope: opened.scope,
          ownerActor: owner.actor,
          profile: null,
          receiptVersion: 0,
          kitchenVersion: 0,
          soleOperator: "Off",
        };
        const journals = journalsFor();
        await opened.listening(owner, async (fetcher) => {
          const deps = depsFor(owner, opened, store, journals, fetcher);
          // The Store as the TEST tool leaves it: not published from Store setup, whatever made
          // its first configuration, and only the Owner's name on each approval.
          assert.equal(await setupPublished(opened), false);
          let facts = await loadOpeningFacts(deps);
          assert.deepEqual(facts.approvers, {
            receiptTemplate: [],
            storeSetup: [],
            allergenList: [],
          });
          assert.equal(facts.live.goLive, true);
          assert.equal(facts.live.storeTaxConfigurationReference, null);
          const opening = await (await fetcher("/merchant/store/opening-list")).json();
          assert.deepEqual(
            [opening.setupPublished, opening.taxRatesSet],
            [false, false],
            JSON.stringify(opening),
          );
          // No tax rates yet: what the Owner typed is saved and nothing else is written, so no
          // code and no approval is asked for what could not be published.
          const before = await counts(opened.scope.storeReference);
          const waiting = await runStoreOpening(deps, {
            details,
            answers,
            confirmed: null,
            approveAlone: false,
            approveOthers: false,
            approvers: facts.approvers,
          });
          assert.deepEqual(waiting, { kind: "DetailsSaved", missing: ["TaxRates"] });
          const saved = await counts(opened.scope.storeReference);
          assert.equal(saved.references, before.references + 2);
          assert.equal(saved.drafts, before.drafts + 1);
          assert.equal(saved.payments, before.payments);
          assert.equal(saved.templates, before.templates);
          assert.equal(saved.configurations, before.configurations);
          assert.equal(saved.publishing, before.publishing);
          // The Owner's press is what asked for this: their saved address is what BOP support reads.
          const address = (
            await admin.query(
              "SELECT snapshot_json->'content'->>'regionCode' region,snapshot_json->'content'->>'countryCode' country FROM rms_store.store_setup_reference_version WHERE store_id=$1 AND reference_kind='Address' ORDER BY revision DESC LIMIT 1",
              [opened.scope.storeReference],
            )
          ).rows[0];
          assert.deepEqual(address, { region: "ON", country: "CA" });

          await seedTax(opened);
          facts = await loadOpeningFacts(deps);
          assert.equal(typeof facts.live.storeTaxConfigurationReference, "string");
          const confirmed = openingConfirmationFromFacts(facts, details, answers);
          assert.notEqual(confirmed, null);
          let answered = answers,
            ticked = confirmed;
          const press = () =>
            runStoreOpening(deps, {
              details,
              answers: answered,
              confirmed: ticked,
              approveAlone: true,
              approveOthers: false,
              approvers: facts.approvers,
            });
          // No second factor yet: stopped at the first approval, with everything else kept.
          const stopped = await press();
          assert.deepEqual(
            [stopped.kind, stopped.step, stopped.code],
            ["Stopped", "ReceiptTemplate", "SoleOperatorNeedsVerification"],
            JSON.stringify(stopped),
          );
          // One code, asked for while the setting was off (the page's purpose): the approvals that
          // follow take the same verification, so the Owner is never asked twice.
          await seedStepUp(admin, {
            id: (n) => id(opened.base, n),
            n: 0x400,
            brandReference: opened.scope.brandReference,
            storeReference: opened.scope.storeReference,
            actorReference: owner.actor,
            purposeCode: "ORGANIZATION_SOLE_OPERATOR_SETTING",
          });
          // A stale tick: the Owner read other hours than the record says. No approval is sent.
          const stale = await runStoreOpening(deps, {
            details,
            answers,
            confirmed: { ...confirmed, businessDayStart: "05:00:00" },
            approveAlone: true,
            approveOthers: false,
            approvers: facts.approvers,
          });
          assert.equal(stale.kind, "ConfirmAgain", JSON.stringify(stale));
          assert.equal(await setupPublished(opened), false);
          assert.equal(
            (
              await admin.query(
                "SELECT count(*)::int n FROM rms_store.store_configuration_sole_operator_approval WHERE store_id=$1",
                [opened.scope.storeReference],
              )
            ).rows[0].n,
            0,
          );
          // The Owner corrects an answer while that change waits for approval: it is replaced by
          // one made from the corrected setup, and that is what they approve.
          answered = { ...answers, hours: { ...answers.hours, preparationMinutes: "20" } };
          ticked = openingConfirmationFromFacts(await loadOpeningFacts(deps), details, answered);
          const pressed = await press();
          assert.deepEqual(pressed, { kind: "Published", waits: [] });
          assert.equal(await setupPublished(opened), true);
          // What was answered is what runs: the hours and order types, tips on for them.
          const published = (await loadOpeningFacts(deps)).live.current;
          assert.deepEqual(published.enabledServiceModes, ["DineIn"]);
          assert.deepEqual(published.weeklySchedule[0].intervals, []);
          assert.deepEqual(
            published.weeklySchedule[1].intervals.map((interval) => [
              interval.startLocalTime,
              interval.endLocalTime,
              interval.endsNextDay,
              interval.serviceModes,
              interval.orderCutoffSeconds,
              interval.leadTimeSeconds,
            ]),
            [
              ["11:30:00", "14:30:00", false, ["DineIn"], 1800, 1200],
              ["17:00:00", "00:00:00", true, ["DineIn"], 1800, 1200],
            ],
          );
          assert.deepEqual(published.setupBasis.feeContexts, [
            { chargeType: "ServiceCharge", state: "Disabled" },
            { chargeType: "DeliveryFee", state: "Disabled" },
            {
              chargeType: "Tip",
              state: "Enabled",
              taxClassificationReference: null,
              orderTypes: ["DineIn"],
            },
          ]);
          // What guests' quotes and table checkout read: offered at the tiers. The Store features
          // switch turns them off at once, with no publish: a published Tip Off would override it.
          const tipChoices = () => transactions.run((tx) => readStoreTipChoices(tx, opened.scope));
          const tipSwitch = (expectedVersion, tipsEnabled) =>
            transactions.run((tx) =>
              changeStoreTipSetting(tx, opened.scope, {
                operationReference: id(opened.base, 0x410 + expectedVersion),
                expectedVersion,
                tipsEnabled,
                tierPercents: [10, 15, 18],
                actorReference: owner.actor,
                observedAt: new Date().toISOString(),
              }),
            );
          assert.deepEqual(await tipChoices(), { enabled: true, tierPercents: [10, 15, 18] });
          await tipSwitch(0, false);
          assert.equal((await tipChoices()).enabled, false);
          await tipSwitch(1, true);
          assert.equal((await tipChoices()).enabled, true);
          assert.equal(published.approvedByReference, owner.actor);
          assert.equal(published.authoredByReference, owner.actor);
          // Recorded as approved alone, once each: the configuration and the receipt template.
          const marks = async (table) =>
            (
              await admin.query("SELECT approval_mode FROM " + table + " WHERE store_id=$1", [
                opened.scope.storeReference,
              ])
            ).rows.map((row) => row.approval_mode);
          assert.deepEqual(await marks("rms_store.store_configuration_sole_operator_approval"), [
            "SoleOperator",
          ]);
          assert.deepEqual(
            await marks("rms_device.digital_receipt_template_sole_operator_approval"),
            ["SoleOperator"],
          );
          const audit = (
            await admin.query(
              "SELECT reason_code,after_summary_json FROM platform_audit.audit_record WHERE target_id=$1 AND action_code='STORE_CONFIGURATION_CHANGED' ORDER BY occurred_at",
              [published.configurationReference],
            )
          ).rows.map((row) => row.reason_code);
          assert.deepEqual(audit, [
            "STORE_SETUP_PUBLICATION",
            "STORE_SETUP_PUBLICATION",
            "STORE_SETUP_PUBLICATION_SOLE_OPERATOR",
            "STORE_SETUP_PUBLICATION",
          ]);
          // Everything once, even after the earlier stops; pressing again writes nothing.
          const finished = await counts(opened.scope.storeReference);
          assert.equal(finished.references, 2);
          assert.equal(finished.payments, 1);
          assert.equal(finished.artifacts, 2);
          assert.equal(finished.templates, 1);
          assert.deepEqual((await press()).kind, "Published");
          assert.deepEqual(await counts(opened.scope.storeReference), finished);
        });
      }

      // --- Two Owners: each approves what the other sent, in place, from server state.
      {
        const opened = await openedStore("01a8f200", ["first", "second"]);
        const { first, second } = opened.people;
        await seedTax(opened);
        const store = {
          base: opened.base,
          scope: opened.scope,
          ownerActor: first.actor,
          profile: null,
          receiptVersion: 0,
          kitchenVersion: 0,
          soleOperator: "Off",
        };
        const firstJournals = journalsFor(),
          secondJournals = journalsFor();
        const press = (person, journals, input) =>
          opened.listening(person, async (fetcher) => {
            const deps = depsFor(person, opened, store, journals, fetcher);
            const facts = await loadOpeningFacts(deps);
            return {
              facts,
              outcome: await runStoreOpening(deps, { ...input, approvers: facts.approvers }),
              after: openingWaitsFromFacts(await loadOpeningFacts(deps)),
            };
          });
        const sent = await press(first, firstJournals, {
          details,
          answers,
          confirmed: null,
          approveAlone: false,
          approveOthers: false,
        });
        // The second Owner is named before anything is sent, whatever the setting says.
        assert.equal(sent.facts.approvers.receiptTemplate.length, 1);
        assert.equal(sent.facts.approvers.storeSetup.length, 1);
        assert.deepEqual(sent.outcome.kind, "Waiting", JSON.stringify(sent.outcome));
        assert.deepEqual(
          sent.outcome.waits.map((wait) => wait.what),
          ["ReceiptTemplate"],
        );
        assert.equal(sent.outcome.waits[0].who.length, 1);
        assert.deepEqual(
          sent.after.forOthers.map((wait) => wait.what),
          ["ReceiptTemplate"],
        );
        const approved = await press(second, secondJournals, {
          details: null,
          answers: null,
          confirmed: null,
          approveAlone: false,
          approveOthers: true,
        });
        // On the second Owner's page it waited for them; their press approved and carried on.
        assert.deepEqual(approved.facts.approvers.storeSetup.length, 1);
        assert.deepEqual(openingWaitsFromFacts(approved.facts).forYou, ["ReceiptTemplate"]);
        assert.equal(approved.outcome.kind, "Waiting", JSON.stringify(approved.outcome));
        assert.deepEqual(
          approved.outcome.waits.map((wait) => wait.what),
          ["StoreSetup"],
        );
        assert.equal(await setupPublished(opened), false);
        const finished = await press(first, firstJournals, {
          details: null,
          answers: null,
          confirmed: null,
          approveAlone: false,
          approveOthers: true,
        });
        assert.deepEqual(finished.outcome, { kind: "Published", waits: [] });
        assert.equal(await setupPublished(opened), true);
        const published = await admin.query(
          "SELECT authored_by_reference::text author,approved_by_reference::text approver,enabled_service_modes modes FROM rms_store.store_configuration_version WHERE store_id=$1 AND lifecycle='Published' ORDER BY configuration_version DESC LIMIT 1",
          [opened.scope.storeReference],
        );
        // Still two people: the one who wrote it never approved it. Hours the first Owner answered.
        assert.deepEqual(
          [published.rows[0].author, published.rows[0].approver],
          [second.actor, first.actor],
        );
        assert.deepEqual(published.rows[0].modes, ["DineIn"]);
        assert.equal(
          (
            await admin.query(
              "SELECT count(*)::int n FROM rms_store.store_configuration_sole_operator_approval WHERE store_id=$1",
              [opened.scope.storeReference],
            )
          ).rows[0].n,
          0,
        );
      }
    } finally {
      await admin.end();
    }
  });
});
