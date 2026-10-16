import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { readFile } from "node:fs/promises";
import { request } from "node:http";
import { createRequire } from "node:module";
import { URL } from "node:url";
import pg from "pg";
import { canonicalizeRfc8785, sha256Hex } from "../../bop/audit/src/index.ts";
import { createIdentityActor } from "../../bop/identity/src/index.ts";
import { createEffectivePeriod } from "../../bop/effective-period/src/index.ts";
import {
  createTaxConfigurationSnapshot,
  createCurrencyMetadataSnapshot,
} from "../../rms/pricing/src/index.ts";
import { parseStoreConfigurationOrdinaryCommand } from "../../rms/store/src/index.ts";
import { createMerchantBffRouter } from "../../../apps/api/dist/merchant-bff.js";
import { renderPilotAclSql } from "../../../tooling/environment/pilot-acl-render.mjs";
import { createInternalStoreSetupBff } from "../../../tooling/environment/pilot-store-setup.mjs";
import {
  createInternalStoreConfigurationOrdinary,
  readPublishedStoreConfiguration,
} from "../../../tooling/environment/pilot-store-publication.mjs";
import {
  storeConfigurationContentHash,
  storeConfigurationSetupSnapshotReferences,
  storeConfigurationValidationCheckCodes,
} from "../../../tooling/environment/pilot-store-publication-codes.mjs";
import { seedJourneyStorePublication } from "./dine-in-journey-seed.mjs";
import { seedMerchantAcceptanceSession } from "./merchant-acceptance-session.mjs";
import { seedTaxConfiguration } from "./tax-configuration-seed.mjs";
import { seedSoleOperatorHistory, seedStepUp } from "./sole-operator-brand-gate.mjs";
import { digitalReceiptRequiredFields } from "../../rms/printing-device/src/index.ts";
import { prepareReceiptTemplatePublication } from "./receipt-template-publication.mjs";

const require = createRequire(new URL("../../../apps/api/package.json", import.meta.url));
const express = require("express");
const hash = (value) => "sha256:" + sha256Hex(canonicalizeRfc8785(value));

/**
 * WP-2423 DEC-STORE-SETUP-PUBLICATION: the Owner publishes a saved Store setup draft as the
 * Store's configuration through the pilot composition (Store setup step 8), as a restricted
 * NOBYPASSRLS role holding exactly the rendered pilot API grants. The Store starts like v15: an
 * installed (V1) configuration with its Publishing release and approved synthetic go-live check.
 * The saved setup's address, contact, payment and receipt settings were made through the actual
 * Store setup BFF by the calling harness; the installed configuration, the go-live check and the
 * Store's tax configuration are owner-seeded TEST-ONLY facts.
 */
export async function exercisePilotStoreSetupPublication(input) {
  const { admin, clientConfig, runId, session, manager, scope, id, savedSetup } = input;
  const seedRunner = input.transactions;
  const store = scope.storeReference,
    owner = scope.actorReference,
    second = id(9);
  const api = "wp2423_ssp_" + runId,
    worker = "wp2423_ssp_w_" + runId;
  for (const name of [api, worker])
    await admin.query(
      "CREATE ROLE " + name + " NOLOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE",
    );
  try {
    const root = new URL("../../../docs/spec/", import.meta.url);
    const matrices = await Promise.all(
      ["pilot-acl-matrix.json", "pilot-acl-additions.json"].map(async (file) =>
        JSON.parse(await readFile(new URL(file, root), "utf8")),
      ),
    );
    await admin.query(renderPilotAclSql(matrices, { api, worker }));
    let allocated = 0x9a000;
    const next = () => id(allocated++);
    const now = () => new Date().toISOString();
    // Both people hold Owner access: the Store configuration actions the Owner template derives
    // (organization.store.update/publish -> store.service.*); the harness granted the rest.
    const grantFrom = new Date(Date.now() - 60000).toISOString(),
      grantUntil = new Date(Date.now() + 3600000).toISOString();
    for (const action of [
      "store.service.read",
      "store.service.save-draft",
      "store.service.validate",
      "store.service.submit",
      "store.service.approve",
      "store.service.publish",
    ]) {
      let permission = (
        await admin.query(
          "SELECT permission_id FROM bop_permission.permission_definition WHERE action_code=$1",
          [action],
        )
      ).rows[0]?.permission_id;
      if (!permission) {
        permission = next();
        await admin.query(
          "INSERT INTO bop_permission.permission_definition VALUES($1,$2,'Active',1,$3,$3)",
          [permission, action, grantFrom],
        );
      }
      for (const rolePrefix of ["01902431", "01902433"])
        await admin.query(
          "INSERT INTO bop_permission.permission_grant VALUES($1,$2,$3,$4,$5,'Active',$6,$7,1,$6,$6)",
          [
            next(),
            rolePrefix + "-0000-7000-8000-000000000004",
            permission,
            scope.brandReference,
            store,
            grantFrom,
            grantUntil,
          ],
        );
    }
    const transactions = {
      async run(work) {
        const client = new pg.Client({
          ...clientConfig,
          connectionTimeoutMillis: 10000,
          query_timeout: 15000,
        });
        await client.connect();
        try {
          await client.query("BEGIN ISOLATION LEVEL READ COMMITTED");
          await client.query("SET LOCAL ROLE " + api);
          await client.query(
            "SELECT set_config('bop.tenant_id',$1,true),set_config('bop.brand_id',$2,true),set_config('bop.store_id',$3,true)",
            [scope.tenantReference, scope.brandReference, store],
          );
          const result = await work({ query: (sql, values = []) => client.query(sql, values) });
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

    // The Store as installed: a published V1 configuration (no recorded authoring), its release
    // and the approved synthetic go-live check (TEST-ONLY), one hour ago.
    const installedAt = new Date(Date.now() - 3600000).toISOString();
    const prefix = "01a9e000";
    await seedJourneyStorePublication({
      client: admin,
      scope,
      publishedAt: installedAt,
      businessDayStart: "04:00:00",
      prefix,
    });
    const installed = (n) => prefix + "-0000-7000-8000-" + n.toString(16).padStart(12, "0");
    const operating = Object.freeze({
      tenantReference: scope.tenantReference,
      brandReference: scope.brandReference,
      storeReference: store,
      configurationType: "STORE_CONFIGURATION",
      purposeCode: "STORE_CONFIGURATION",
      requiredLiveGateRequirementCodes: Object.freeze(["SYNTHETIC_STORE_READY"]),
      requiredValidationCheckCodes: storeConfigurationValidationCheckCodes,
      setupSnapshotReferences: storeConfigurationSetupSnapshotReferences,
      authorize: async () => true,
      hashContent: storeConfigurationContentHash,
      timeZone: "America/Toronto",
    });
    const resources = { operating, transactions, now, credentials: { reference: next } };
    // Identity roster double (pilot `currentActor`): an active workforce actor per reference, so
    // the sole-operator gate evaluates each Store member as an approval would (TEST-ONLY).
    const currentActor = async (_tx, reference, authenticatedAt) =>
      createIdentityActor({
        actorType: "User",
        actorReference: reference,
        accountKind: "Workforce",
        status: "Active",
        authenticationMethod: "Oidc",
        verificationLevel: "SingleFactor",
        authenticatedAt,
        recentMfaAt: null,
      });
    const persistenceFor = (reader) => ({
      ...reader.persistence,
      currentActor,
      transactions,
      now,
      publication: {
        configurationType: "STORE_CONFIGURATION",
        purposeCode: "STORE_CONFIGURATION",
        requiredLiveGateRequirementCodes: ["SYNTHETIC_STORE_READY"],
        requiredValidationCheckCodes: storeConfigurationValidationCheckCodes,
      },
    });
    const counts = async () =>
      (
        await admin.query(
          "SELECT (SELECT count(*) FROM rms_store.store_configuration_authoring_operation)::int authoring,(SELECT count(*) FROM rms_store.store_configuration_version)::int versions,(SELECT count(*) FROM bop_publishing.publishing_mutation_record)::int publishing,(SELECT count(*) FROM platform_audit.audit_record)::int audits",
        )
      ).rows[0];

    const listen = async (reader, work) => {
      const bff = await createInternalStoreSetupBff(resources, {
        persistence: persistenceFor(reader),
        authentication: reader.authentication,
        nextReference: next,
      });
      const app = express();
      app.use(
        "/merchant",
        createMerchantBffRouter({
          service: reader.authentication,
          exactOrigin: "https://merchant.invalid",
          acceptedHost: "merchant.invalid",
          ...bff,
        }),
      );
      const server = app.listen(0, "127.0.0.1");
      await new Promise((resolve) => server.once("listening", resolve));
      const actorReference =
        reader === session ? owner : reader === manager ? second : reader.actor;
      const selected = { ...scope, actorReference };
      const send = (path, body) =>
        new Promise((resolve, reject) => {
          const bytes = body === undefined ? null : JSON.stringify(body);
          const req = request(
            {
              host: "127.0.0.1",
              port: server.address().port,
              method: bytes === null ? "GET" : "POST",
              path: "/merchant/" + path,
              headers: {
                host: "merchant.invalid",
                origin: "https://merchant.invalid",
                "sec-fetch-site": "same-origin",
                cookie: "__Host-bop-merchant=" + reader.sessionCookie,
                "x-bop-store-setup-scope": Buffer.from(canonicalizeRfc8785(selected)).toString(
                  "base64url",
                ),
                ...(bytes === null
                  ? {}
                  : {
                      "x-bop-csrf": reader.csrf,
                      "content-type": "application/json",
                      "content-length": Buffer.byteLength(bytes),
                    }),
              },
            },
            (response) => {
              const chunks = [];
              response.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
              response.once("end", () =>
                resolve({
                  status: response.statusCode,
                  body: JSON.parse(Buffer.concat(chunks).toString("utf8")),
                }),
              );
            },
          );
          req.setTimeout(20000, () => req.destroy(new Error("PILOT_PUBLICATION_HTTP_TIMEOUT")));
          req.once("error", reject);
          req.end(bytes ?? undefined);
        });
      try {
        return await work(send, selected);
      } finally {
        server.closeAllConnections();
        await new Promise((resolve) => server.close(resolve));
      }
    };
    const workspaceOf = (send) =>
      send("store-configuration/ordinary?expectedStoreReference=" + store);
    const command = (selected, action, head, extra = {}) =>
      parseStoreConfigurationOrdinaryCommand({
        profile: "StoreConfigurationOrdinaryCommandV1",
        ...selected,
        operationReference: next(),
        action,
        expectedHead: head,
        ...extra,
      });

    // The Owner completes the saved setup: Store setup's own steps plus the settings carried from
    // the live Store (tax, Brand settings, holidays, start). Before any authoring record exists,
    // the save builds on the installed configuration.
    const weeklySchedule = Array.from({ length: 7 }, (_, index) => ({
      isoWeekday: index + 1,
      intervals:
        index < 5
          ? [
              {
                startLocalTime: "08:00:00",
                endLocalTime: "20:00:00",
                endsNextDay: false,
                serviceModes: ["DineIn", "Pickup"],
                orderCutoffSeconds: 600,
                leadTimeSeconds: 900,
              },
            ]
          : [],
    }));
    const taxReference = next();
    // WP-2423 v15: the receipt template the Store issues receipts with today, as the installer
    // published it (TEST-ONLY seed, v15 shape: Publishing history by one installer actor, the
    // version row, no authored submission). The setup keeps it ("Keep the receipt template in
    // use today") instead of needing a new template approved by a second person.
    const storeLocale = (
      await admin.query("SELECT locale FROM bop_tenant.store WHERE store_id=$1", [store])
    ).rows[0].locale;
    const receiptAt = new Date(Date.now() - 3600000).toISOString();
    const liveReceipt = {
      templateReference: next(),
      versionReference: next(),
      versionNumber: 1,
      versionCode: "RECEIPT_V1",
      brandReference: scope.brandReference,
      storeReference: store,
      locale: storeLocale,
      dataContractVersion: 1,
      renderEngineVersion: 1,
      outputProfile: "AccessibleDigitalReceipt",
      layoutDefinitionReference: next(),
      complianceRuleReference: next(),
      requiredFields: [...digitalReceiptRequiredFields],
      publicationReference: next(),
      publishedAt: receiptAt,
      effectiveFrom: receiptAt,
      effectiveUntil: null,
    };
    const receiptInstaller = await prepareReceiptTemplatePublication({
      admin,
      role: worker,
      scope: { brandReference: scope.brandReference, storeReference: store },
      version: liveReceipt,
      digest: hash(liveReceipt),
      tenantReference: scope.tenantReference,
    });
    await receiptInstaller.publish();
    await admin.query(
      "INSERT INTO rms_device.digital_receipt_template_version(version_id,brand_id,store_id,template_id,version_number,version_code,operation_id,audit_id,publication_id,publication_digest,published_at,version_json,data_classification) VALUES($1,$2,$3,$4,1,'RECEIPT_V1',$5,$6,$7,$8,$9,$10::jsonb,'Confidential')",
      [
        liveReceipt.versionReference,
        scope.brandReference,
        store,
        liveReceipt.templateReference,
        next(),
        next(),
        liveReceipt.publicationReference,
        hash(liveReceipt),
        receiptAt,
        JSON.stringify(liveReceipt),
      ],
    );
    let setup;
    await listen(session, async (send, selected) => {
      // The Owner checks the template in use today (the step 5 published read) and keeps it.
      const kept = await send(
        "store-setup/receipt-template-published?storeReference=" +
          store +
          "&templateReference=" +
          liveReceipt.templateReference +
          "&locale=" +
          storeLocale,
      );
      assert.equal(kept.status, 200, JSON.stringify(kept.body));
      assert.deepEqual(kept.body.currentVersion, liveReceipt);
      const current = await send("store-setup?storeReference=" + store);
      assert.equal(current.status, 200, JSON.stringify(current.body));
      const head = current.body.setup.snapshot;
      assert.equal(head.revision, savedSetup.revision);
      const configured = (value) => ({ state: "Configured", value });
      const content = {
        ...head.content,
        source: configured("StoreOverride"),
        receiptReference: configured(liveReceipt.templateReference),
        brandBaseVersionReference: configured(installed(4)),
        timeZone: configured("America/Toronto"),
        businessDayStartLocalTime: configured("04:00:00"),
        taxConfigurationReference: configured(taxReference),
        capacityConfigurationReference: configured(null),
        enabledServiceModes: configured(["DineIn", "Pickup"]),
        weeklySchedule: configured(weeklySchedule),
        exceptions: configured([]),
        effectiveFrom: configured(now()),
        effectiveUntil: configured(null),
        feeContexts: configured(
          ["ServiceCharge", "DeliveryFee", "Tip"].map((chargeType) => ({
            chargeType,
            state: "Disabled",
          })),
        ),
      };
      const saved = await send("store-setup", {
        command: "SaveDraft",
        operationReference: next(),
        expectedSetupReference: head.setupDraftReference,
        expectedRevision: head.revision,
        content,
      });
      assert.equal(saved.status, 200, JSON.stringify(saved.body));
      setup = saved.body.snapshot;
      assert.equal(setup.baseConfigurationReference, installed(1));

      // Nothing recorded yet: the live Store is the installed configuration.
      let workspace = await workspaceOf(send);
      assert.equal(workspace.status, 200, JSON.stringify(workspace.body));
      assert.equal(workspace.body.latest, null);
      assert.equal(workspace.body.current.configurationReference, installed(1));
      assert.equal(Object.hasOwn(workspace.body, "publicationChecks"), false);

      const materialized = await send("store-configuration/ordinary-command", {
        command: command(selected, "Materialize", workspace.body.expectedHead, {
          setupSelector: {
            setupDraftReference: setup.setupDraftReference,
            sourceRevision: setup.revision,
            sourceSnapshotDigest: hash(setup),
          },
          reasonCode: "STORE_SETUP_MATERIALIZATION",
        }),
      });
      assert.equal(materialized.status, 200, JSON.stringify(materialized.body));
      assert.equal(materialized.body.outcome, "Committed");

      // The Store has no tax configuration in force yet: the check says so and sending is refused.
      workspace = await workspaceOf(send);
      assert.equal(workspace.status, 200, JSON.stringify(workspace.body));
      const draft = workspace.body.latest;
      assert.equal(draft.lifecycle, "Draft");
      assert.equal(draft.setupBasis.sourceRevision, setup.revision);
      assert.equal(draft.supersedesConfigurationReference, installed(1));
      const outcomes = (body) =>
        Object.fromEntries(body.publicationChecks.checks.map((c) => [c.code, c.outcome]));
      // v15 D1: no tax configuration in force yet: the workspace says none.
      assert.equal(workspace.body.storeTaxConfigurationReference, null);
      assert.deepEqual(outcomes(workspace.body), {
        Tax: "Fail",
        BrandSettings: "Pass",
        TimeZone: "Pass",
        BusinessDayStart: "Pass",
        Hours: "Pass",
        EffectiveDate: "Pass",
        Fees: "Pass",
        GoLive: "Pass",
      });
      const beforeRefusal = await counts();
      const refused = await send("store-configuration/ordinary-command", {
        command: command(selected, "Submit", workspace.body.expectedHead),
      });
      assert.equal(refused.status, 409, JSON.stringify(refused.body));
      assert.deepEqual(await counts(), beforeRefusal);
    });

    // TEST-ONLY tax configuration in force for the Store (owner-seeded Pricing facts).
    const at = now(),
      until = new Date(Date.parse(at) + 86400000).toISOString();
    const offsetName = new Intl.DateTimeFormat("en-CA", {
      timeZone: "America/Toronto",
      timeZoneName: "shortOffset",
    })
      .formatToParts(new Date(installedAt))
      .find((part) => part.type === "timeZoneName")?.value;
    const offsetMinutes = -Number(offsetName.slice(4)) * 60;
    const local = new Date(Date.parse(installedAt) + offsetMinutes * 60000)
      .toISOString()
      .slice(0, -1);
    const taxVersion = next(),
      taxDigest = hash({ profile: "TEST_ONLY_TAX", configurationReference: taxReference });
    await seedTaxConfiguration(
      admin,
      createTaxConfigurationSnapshot({
        configurationReference: taxReference,
        versionReference: taxVersion,
        brandReference: scope.brandReference,
        storeReference: store,
        stableCode: "TEST_ONLY_TAX",
        aggregateVersion: 1,
        versionNumber: 1,
        snapshotDigest: taxDigest,
        lifecycle: "Published",
        jurisdictionCode: "CA-ON",
        currencyMetadata: createCurrencyMetadataSnapshot({
          currencyCode: "CAD",
          minorUnitExponent: 2,
          metadataVersion: 1,
          metadataVersionReference: next(),
          metadataDigest: hash({ currency: "CAD", testOnly: true }),
        }),
        effectivePeriod: createEffectivePeriod({
          timeZone: "America/Toronto",
          effectiveFrom: {
            instant: installedAt,
            localDateTime: local,
            utcOffsetMinutes: offsetMinutes,
          },
          effectiveUntil: null,
        }),
        registrationEvidence: {
          applicabilityReference: next(),
          operatingEntityTaxReference: next(),
          jurisdictionProfileReference: next(),
          status: "Verified",
          validUntil: until,
        },
        professionalEvidence: {
          evidenceReference: next(),
          snapshotReference: taxVersion,
          snapshotDigest: taxDigest,
          professionalReviewReference: next(),
          fixtureSuiteReference: next(),
          fixtureSuiteDigest: hash({ testOnly: "fixture" }),
          result: "Pass",
          reviewedAt: installedAt,
          validUntil: until,
        },
        rules: [
          {
            ruleReference: next(),
            taxClassificationReference: next(),
            orderType: "Pickup",
            chargeType: "Sellable",
            taxComponentCode: "SYNTHETIC_TAX",
            treatment: "Taxable",
            rate: "0.13",
            priceInclusion: "Exclusive",
            roundingMode: "HalfUp",
            calculationOrder: 1,
            compoundOnPriorTax: false,
            exceptionEvidenceReference: null,
            receiptPresentationCode: "SYNTHETIC_TAX_LINE",
          },
        ],
        createdAt: installedAt,
      }),
      owner,
    );

    // Every check passes; the Owner sends it for approval and cannot approve their own change.
    let pending;
    await listen(session, async (send, selected) => {
      let workspace = await workspaceOf(send);
      assert.equal(workspace.status, 200, JSON.stringify(workspace.body));
      assert(workspace.body.publicationChecks.checks.every((c) => c.outcome === "Pass"));
      // WP-2423 v15 (`8bd902e3` D1): the installed configuration names the installer's tax
      // reference; the Store's tax configuration in force is its Pricing record (the one quotes
      // use). The workspace names it, so "Use the live Store's settings" carries it and the
      // "Tax" check compares like with like.
      assert.equal(workspace.body.storeTaxConfigurationReference, taxReference);
      assert.notEqual(workspace.body.current.taxConfigurationReference, taxReference);
      const submitted = await send("store-configuration/ordinary-command", {
        command: command(selected, "Submit", workspace.body.expectedHead),
      });
      assert.equal(submitted.status, 200, JSON.stringify(submitted.body));
      assert.equal(submitted.body.outcome, "Committed");
      workspace = await workspaceOf(send);
      assert.equal(workspace.body.latest.lifecycle, "PendingApproval");
      pending = workspace.body;
      const before = await counts();
      const own = await send("store-configuration/ordinary-command", {
        command: command(selected, "Approve", workspace.body.expectedHead),
      });
      assert.notEqual(own.status, 200, "the author cannot approve their own configuration");
      assert.deepEqual(await counts(), before);
    });
    // A Store person without Owner access cannot read or act on Store configuration publication.
    const staff = await seedMerchantAcceptanceSession({
      admin,
      runner: seedRunner,
      scope,
      actor: id(0x9f00),
      at: now(),
      referencePrefix: "01a9f000",
      sessionReferencePrefix: "01a9f001",
    });
    staff.actor = id(0x9f00);
    await listen(staff, async (send) => {
      const before = await counts();
      assert.equal((await workspaceOf(send)).status, 403);
      assert.deepEqual(await counts(), before);
    });
    // Another person with Owner access approves; the Owner publishes.
    await listen(manager, async (send, selected) => {
      const workspace = await workspaceOf(send);
      assert.equal(workspace.status, 200, JSON.stringify(workspace.body));
      assert.deepEqual(workspace.body.latest, pending.latest);
      const approved = await send("store-configuration/ordinary-command", {
        command: command(selected, "Approve", workspace.body.expectedHead),
      });
      assert.equal(approved.status, 200, JSON.stringify(approved.body));
      assert.equal(approved.body.outcome, "Committed");
    });
    let published;
    await listen(session, async (send, selected) => {
      let workspace = await workspaceOf(send);
      assert.equal(workspace.body.latest.lifecycle, "Approved");
      assert.equal(workspace.body.latest.approvedByReference, second);
      const result = await send("store-configuration/ordinary-command", {
        command: command(selected, "Publish", workspace.body.expectedHead),
      });
      assert.equal(result.status, 200, JSON.stringify(result.body));
      assert.equal(result.body.outcome, "Committed");
      workspace = await workspaceOf(send);
      published = workspace.body.current;
      assert.equal(published.lifecycle, "Published");
      assert.equal(published.configurationReference, workspace.body.latest.configurationReference);
      assert.equal(published.setupBasis.sourceRevision, setup.revision);
      assert.equal(published.supersedesConfigurationReference, installed(1));
      // The Store keeps issuing receipts with the template it used before.
      assert.equal(published.receiptReference, liveReceipt.templateReference);
      assert.equal(Object.hasOwn(workspace.body, "publicationChecks"), false);
    });

    // The Store now runs on it: the operating reads (the same options the pilot runtime uses)
    // verify the V2 publication, its setup provenance and its go-live check.
    const live = await transactions.run((tx) =>
      readPublishedStoreConfiguration(operating, tx, now(), async () => true),
    );
    assert.equal(live.configuration.configurationReference, published.configurationReference);
    assert.deepEqual(live.configuration.weeklySchedule, weeklySchedule);
    assert.equal(live.contentDigest, storeConfigurationContentHash(live.configuration));
    // A restart composes publication again from the configuration that came from setup.
    await createInternalStoreConfigurationOrdinary(resources, {
      persistence: persistenceFor(session),
      authentication: session.authentication,
    });

    // Append-only versions and audit with each actor.
    const versions = (
      await admin.query(
        "SELECT configuration_id::text id,lifecycle FROM rms_store.store_configuration_version WHERE store_id=$1 ORDER BY configuration_version",
        [store],
      )
    ).rows;
    assert.deepEqual(
      versions.map((v) => v.id),
      [installed(1), published.configurationReference],
    );
    const audits = (
      await admin.query(
        "SELECT actor_reference::text actor,reason_code FROM platform_audit.audit_record WHERE target_id=$1 AND action_code='STORE_CONFIGURATION_CHANGED' ORDER BY occurred_at",
        [published.configurationReference],
      )
    ).rows;
    assert.deepEqual(
      audits.map((a) => [a.actor, a.reason_code]),
      [
        [owner, "STORE_SETUP_PUBLICATION"],
        [owner, "STORE_SETUP_PUBLICATION"],
        [second, "STORE_SETUP_PUBLICATION"],
        [owner, "STORE_SETUP_PUBLICATION"],
      ],
    );
    await assert.rejects(
      admin.query(
        "UPDATE rms_store.store_configuration_version SET reason_code='X' WHERE configuration_id=$1",
        [published.configurationReference],
      ),
    );

    // Another Store sees none of it through the pilot role.
    const otherStore = id(0x9e01);
    const isolated = await (async () => {
      const client = new pg.Client(clientConfig);
      await client.connect();
      try {
        await client.query("BEGIN");
        await client.query("SET LOCAL ROLE " + api);
        await client.query(
          "SELECT set_config('bop.tenant_id',$1,true),set_config('bop.brand_id',$2,true),set_config('bop.store_id',$3,true)",
          [scope.tenantReference, scope.brandReference, otherStore],
        );
        const rows = (
          await client.query(
            "SELECT count(*)::int n FROM rms_store.store_configuration_publication_content WHERE store_id=$1",
            [store],
          )
        ).rows[0].n;
        await client.query("ROLLBACK");
        return rows;
      } finally {
        await client.end();
      }
    })();
    assert.equal(isolated, 0);

    // WP-2423 DEC-SOLE-OPERATOR-APPROVAL (Owner decision 2026-10-16): the Owner approves and
    // publishes their own configuration alone only while sole operator is in effect for them
    // (the Brand setting is on and nobody else at the Store holds Store configuration approval),
    // with a second factor at most 15 minutes old; recorded as sole operator with audit.
    const soleCounts = async () => ({
      ...(await counts()),
      marks: (
        await admin.query(
          "SELECT count(*)::int n FROM rms_store.store_configuration_sole_operator_approval",
        )
      ).rows[0].n,
    });
    const ownApproval = (send, selected, head, mode = "SoleOperator") =>
      send("store-configuration/ordinary-command", {
        command: command(selected, "Approve", head),
        ...(mode === null ? {} : { approvalMode: mode }),
      });
    const refusedUnchanged = async (attempt, status, error) => {
      const before = await soleCounts();
      const reply = await attempt();
      assert.equal(reply.status, status, JSON.stringify(reply.body));
      if (error !== undefined) assert.deepEqual(reply.body, { error });
      assert.deepEqual(await soleCounts(), before);
    };
    let ownHead;
    await listen(session, async (send, selected) => {
      // A later closing time, saved on the published configuration, created and sent.
      const current = await send("store-setup?storeReference=" + store);
      assert.equal(current.status, 200, JSON.stringify(current.body));
      const head = current.body.setup.snapshot;
      const later = weeklySchedule.map((day) => ({
        ...day,
        intervals: day.intervals.map((i) => ({ ...i, endLocalTime: "21:00:00" })),
      }));
      const saved = await send("store-setup", {
        command: "SaveDraft",
        operationReference: next(),
        expectedSetupReference: head.setupDraftReference,
        expectedRevision: head.revision,
        content: {
          ...head.content,
          weeklySchedule: { state: "Configured", value: later },
          effectiveFrom: { state: "Configured", value: now() },
        },
      });
      assert.equal(saved.status, 200, JSON.stringify(saved.body));
      const revised = saved.body.snapshot;
      assert.equal(revised.baseConfigurationReference, published.configurationReference);
      let workspace = await workspaceOf(send);
      const created = await send("store-configuration/ordinary-command", {
        command: command(selected, "Materialize", workspace.body.expectedHead, {
          setupSelector: {
            setupDraftReference: revised.setupDraftReference,
            sourceRevision: revised.revision,
            sourceSnapshotDigest: hash(revised),
          },
          reasonCode: "STORE_SETUP_MATERIALIZATION",
        }),
      });
      assert.equal(created.status, 200, JSON.stringify(created.body));
      workspace = await workspaceOf(send);
      assert(workspace.body.publicationChecks.checks.every((c) => c.outcome === "Pass"));
      // No sole-operator view before it is sent for approval.
      assert.equal(Object.hasOwn(workspace.body, "soleOperator"), false);
      const sent = await send("store-configuration/ordinary-command", {
        command: command(selected, "Submit", workspace.body.expectedHead),
      });
      assert.equal(sent.status, 200, JSON.stringify(sent.body));
      workspace = await workspaceOf(send);
      assert.equal(workspace.body.latest.lifecycle, "PendingApproval");
      assert.equal(workspace.body.latest.authoredByReference, owner);
      // Setting off: the Owner is told another person must approve; asking alone is refused and
      // says sole operator is off (WP-2423 v15: so the Owner knows to turn it on).
      assert.equal(workspace.body.soleOperator.status, "NotSet");
      ownHead = workspace.body.expectedHead;
      await refusedUnchanged(() => ownApproval(send, selected, ownHead), 403, "sole_operator_off");
      await refusedUnchanged(() => ownApproval(send, selected, ownHead, null), 503);
      await refusedUnchanged(() => ownApproval(send, selected, ownHead, "Independent"), 400);
    });
    // The second Owner reads no sole-operator view for a configuration they neither made nor sent.
    await listen(manager, async (send) => {
      const workspace = await workspaceOf(send);
      assert.equal(workspace.status, 200, JSON.stringify(workspace.body));
      assert.equal(Object.hasOwn(workspace.body, "soleOperator"), false);
    });
    // Setting on (owner-seeded Organization fact), but the second Owner still holds approval.
    const sid = (n) => id(0x9c000 + n);
    // WP-2423 v15 defect (2026-10-16): with the setting history past version 10 and the latest
    // version Off, sole operator is off (a text sort read version 9 "On" as the latest).
    const history = {
      id: sid,
      n: 0x100,
      tenantReference: scope.tenantReference,
      brandReference: scope.brandReference,
      actorReference: owner,
    };
    assert.equal(
      await seedSoleOperatorHistory(admin, { ...history, atLeast: 11, latest: "Off" }),
      12,
    );
    await listen(session, async (send, selected) => {
      const workspace = await workspaceOf(send);
      assert.equal(workspace.body.soleOperator.status, "NotSet");
      await refusedUnchanged(() => ownApproval(send, selected, ownHead), 403, "sole_operator_off");
    });
    await seedSoleOperatorHistory(admin, { ...history, atLeast: 13, latest: "On" });
    await listen(session, async (send, selected) => {
      const workspace = await workspaceOf(send);
      assert.equal(workspace.body.soleOperator.status, "OtherApprovers");
      assert.equal(workspace.body.soleOperator.otherApprovers.length, 1);
      await refusedUnchanged(
        () => ownApproval(send, selected, ownHead),
        403,
        "sole_operator_not_in_effect",
      );
    });
    // The second Owner's Store configuration approval is withdrawn (owner-seeded Permission fact):
    // the Owner is now the only holder.
    const withdrawn = await admin.query(
      "UPDATE bop_permission.permission_grant SET lifecycle='Revoked',version=version+1 WHERE role_id=$1 AND store_id=$2 AND lifecycle='Active' AND permission_id IN (SELECT permission_id FROM bop_permission.permission_definition WHERE action_code='store.service.approve')",
      ["01902433-0000-7000-8000-000000000004", store],
    );
    assert.equal(withdrawn.rowCount, 1);
    let soleApproved, soleStepUpAt;
    await listen(session, async (send, selected) => {
      let workspace = await workspaceOf(send);
      assert.deepEqual(workspace.body.soleOperator, {
        status: "Effective",
        otherApprovers: [],
        verifiedUntil: null,
      });
      // In effect but not verified, or verified more than 15 minutes ago: refused.
      await refusedUnchanged(
        () => ownApproval(send, selected, ownHead),
        403,
        "sole_operator_needs_verification",
      );
      await seedStepUp(admin, {
        id: sid,
        n: 10,
        brandReference: scope.brandReference,
        storeReference: store,
        actorReference: owner,
        ageMs: 20 * 60000,
      });
      await refusedUnchanged(
        () => ownApproval(send, selected, ownHead),
        403,
        "sole_operator_needs_verification",
      );
      soleStepUpAt = await seedStepUp(admin, {
        id: sid,
        n: 20,
        brandReference: scope.brandReference,
        storeReference: store,
        actorReference: owner,
      });
      workspace = await workspaceOf(send);
      assert.equal(
        workspace.body.soleOperator.verifiedUntil,
        new Date(Date.parse(soleStepUpAt) + 15 * 60000).toISOString(),
      );
      // Not asked as sole operator: still refused (never implied).
      await refusedUnchanged(() => ownApproval(send, selected, ownHead, null), 503);
      const approved = await ownApproval(send, selected, ownHead);
      assert.equal(approved.status, 200, JSON.stringify(approved.body));
      assert.equal(approved.body.outcome, "Committed");
      workspace = await workspaceOf(send);
      soleApproved = workspace.body.latest;
      assert.equal(soleApproved.lifecycle, "Approved");
      assert.equal(soleApproved.approvedByReference, owner);
      assert.equal(soleApproved.authoredByReference, owner);
      assert.equal(Object.hasOwn(workspace.body, "soleOperator"), false);
      const result = await send("store-configuration/ordinary-command", {
        command: command(selected, "Publish", workspace.body.expectedHead),
      });
      assert.equal(result.status, 200, JSON.stringify(result.body));
      workspace = await workspaceOf(send);
      assert.equal(
        workspace.body.current.configurationReference,
        soleApproved.configurationReference,
      );
      assert.equal(workspace.body.current.approvedByReference, owner);
    });
    // Recorded as sole operator: the mark, the audit, the published version and the Publishing
    // review history; the Store runs on it (current and as-published proofs).
    const marks = (
      await admin.query(
        "SELECT configuration_id::text configuration,actor_id::text actor,approval_mode,approval_evidence_id::text evidence,actor_mfa_at,approved_at FROM rms_store.store_configuration_sole_operator_approval",
      )
    ).rows;
    assert.equal(marks.length, 1);
    assert.equal(marks[0].configuration, soleApproved.configurationReference);
    assert.equal(marks[0].actor, owner);
    assert.equal(marks[0].approval_mode, "SoleOperator");
    assert.equal(marks[0].evidence, soleApproved.approvalEvidenceReference);
    assert.equal(marks[0].actor_mfa_at.toISOString(), soleStepUpAt);
    const soleAudits = (
      await admin.query(
        "SELECT actor_reference::text actor,reason_code,after_summary_json FROM platform_audit.audit_record WHERE target_id=$1 AND action_code='STORE_CONFIGURATION_CHANGED' ORDER BY occurred_at",
        [soleApproved.configurationReference],
      )
    ).rows;
    assert.deepEqual(
      soleAudits.map((a) => [a.actor, a.reason_code]),
      [
        [owner, "STORE_SETUP_PUBLICATION"],
        [owner, "STORE_SETUP_PUBLICATION"],
        [owner, "STORE_SETUP_PUBLICATION_SOLE_OPERATOR"],
        [owner, "STORE_SETUP_PUBLICATION"],
      ],
    );
    assert.deepEqual(soleAudits[2].after_summary_json, { approvalMode: "SoleOperator" });
    const version = (
      await admin.query(
        "SELECT authored_by_reference::text authored,approved_by_reference::text approved FROM rms_store.store_configuration_version WHERE configuration_id=$1",
        [soleApproved.configurationReference],
      )
    ).rows[0];
    assert.deepEqual(version, { authored: owner, approved: owner });
    const reviewActors = (
      await admin.query(
        "SELECT operation_code,actor_id::text actor FROM bop_publishing.publishing_mutation_record WHERE lifecycle_id=$1 ORDER BY lifecycle_version",
        [soleApproved.configurationReference],
      )
    ).rows;
    assert.deepEqual(
      reviewActors.map((r) => r.actor),
      [owner, owner, owner, owner],
    );
    const running = await transactions.run((tx) =>
      readPublishedStoreConfiguration(operating, tx, now(), async () => true),
    );
    assert.equal(running.configuration.configurationReference, soleApproved.configurationReference);
    const asPublished = await transactions.run((tx) =>
      readPublishedStoreConfiguration(operating, tx, now(), async () => true, "AsPublished"),
    );
    assert.equal(
      asPublished.configuration.configurationReference,
      soleApproved.configurationReference,
    );
    await createInternalStoreConfigurationOrdinary(resources, {
      persistence: persistenceFor(session),
      authentication: session.authentication,
    });
    await assert.rejects(
      admin.query(
        "UPDATE rms_store.store_configuration_sole_operator_approval SET approval_mode='SoleOperator'",
      ),
    );
    // Another Store is unaffected: it sees no mark, and its own history still refuses an approver
    // who is the author without a sole-operator approval of its own (database checks).
    const otherScoped = async (work) => {
      const client = new pg.Client(clientConfig);
      await client.connect();
      try {
        await client.query("BEGIN");
        await client.query("SET LOCAL ROLE " + api);
        await client.query(
          "SELECT set_config('bop.tenant_id',$1,true),set_config('bop.brand_id',$2,true),set_config('bop.store_id',$3,true)",
          [scope.tenantReference, scope.brandReference, otherStore],
        );
        return await work(client);
      } finally {
        await client.query("ROLLBACK").catch(() => undefined);
        await client.end();
      }
    };
    assert.equal(
      await otherScoped(
        async (client) =>
          (
            await client.query(
              "SELECT count(*)::int n FROM rms_store.store_configuration_sole_operator_approval",
            )
          ).rows[0].n,
      ),
      0,
    );
    await assert.rejects(
      admin.query(
        "INSERT INTO rms_store.store_configuration_version SELECT * FROM jsonb_populate_record(NULL::rms_store.store_configuration_version,(SELECT to_jsonb(v)||jsonb_build_object('configuration_id',$2::text,'store_id',$3::text,'configuration_version',1,'supersedes_configuration_reference',NULL) FROM rms_store.store_configuration_version v WHERE configuration_id=$1))",
        [soleApproved.configurationReference, id(0x9e10), otherStore],
      ),
      /store configuration approval needs another person/u,
    );
    await assert.rejects(
      admin.query(
        "INSERT INTO rms_store.store_configuration_authoring_operation SELECT * FROM jsonb_populate_record(NULL::rms_store.store_configuration_authoring_operation,(SELECT to_jsonb(a)||jsonb_build_object('operation_id',$2::text,'store_id',$3::text,'audit_reference',$4::text,'configuration_json',a.configuration_json||jsonb_build_object('storeReference',$3::text)) FROM rms_store.store_configuration_authoring_operation a WHERE configuration_id=$1 AND command_type='Approve'))",
        [soleApproved.configurationReference, id(0x9e11), otherStore, id(0x9e12)],
      ),
      /store configuration approval needs another person/u,
    );
    // A mark that no self-approval committed with is refused at COMMIT.
    const orphan = new pg.Client(clientConfig);
    await orphan.connect();
    try {
      await orphan.query("BEGIN");
      await orphan.query(
        "INSERT INTO rms_store.store_configuration_sole_operator_approval SELECT brand_id,$1::text::platform_helpers.uuid_v7,configuration_id,$2::text::platform_helpers.uuid_v7,approval_evidence_id,approval_mode,actor_id,actor_mfa_at,approved_at,$3::text::platform_helpers.uuid_v7,data_classification FROM rms_store.store_configuration_sole_operator_approval",
        [otherStore, id(0x9e13), id(0x9e14)],
      );
      await assert.rejects(orphan.query("COMMIT"), /must mark a self-approval/u);
    } finally {
      await orphan.query("ROLLBACK").catch(() => undefined);
      await orphan.end();
    }

    // WP-2423 (v15 live check of 48093a71, D2/D3): an unfinished saved setup is answered plainly
    // (it was a 503 "result unknown"); an open change is never replaced by another person's new
    // change; it is withdrawn by its author or declined by an approver (append-only, audited).
    const withdrawals = async () =>
      (
        await admin.query(
          "SELECT configuration_id::text configuration,withdrawal_kind kind,actor_id::text actor,withdrawn_lifecycle lifecycle,reason_code reason FROM rms_store.store_configuration_withdrawal ORDER BY withdrawn_at",
        )
      ).rows;
    const saveSetup = async (send, change) => {
      const current = await send("store-setup?storeReference=" + store);
      assert.equal(current.status, 200, JSON.stringify(current.body));
      const head = current.body.setup.snapshot;
      const saved = await send("store-setup", {
        command: "SaveDraft",
        operationReference: next(),
        expectedSetupReference: head.setupDraftReference,
        expectedRevision: head.revision,
        content: {
          ...head.content,
          effectiveFrom: { state: "Configured", value: now() },
          ...change,
        },
      });
      assert.equal(saved.status, 200, JSON.stringify(saved.body));
      return saved.body.snapshot;
    };
    const materialize = (send, selected, head, saved) =>
      send("store-configuration/ordinary-command", {
        command: command(selected, "Materialize", head, {
          setupSelector: {
            setupDraftReference: saved.setupDraftReference,
            sourceRevision: saved.revision,
            sourceSnapshotDigest: hash(saved),
          },
          reasonCode: "STORE_SETUP_MATERIALIZATION",
        }),
      });
    const withdraw = (send, latest, auditReference = next(), declineReason) =>
      send("store-configuration/withdrawal", {
        configurationReference: latest.configurationReference,
        configurationVersion: latest.configurationVersion,
        auditReference,
        ...(declineReason === undefined ? {} : { declineReason }),
      });
    let ownOpen;
    await listen(session, async (send, selected) => {
      // D2: an unfinished saved setup is refused with its reason; nothing is recorded.
      const unfinished = await saveSetup(send, {
        capacityConfigurationReference: { state: "Unconfigured" },
      });
      let workspace = await workspaceOf(send);
      await refusedUnchanged(
        () => materialize(send, selected, workspace.body.expectedHead, unfinished),
        409,
        "store_setup_incomplete",
      );
      const finished = await saveSetup(send, {
        capacityConfigurationReference: { state: "Configured", value: null },
      });
      const created = await materialize(send, selected, workspace.body.expectedHead, finished);
      assert.equal(created.status, 200, JSON.stringify(created.body));
      workspace = await workspaceOf(send);
      const sent = await send("store-configuration/ordinary-command", {
        command: command(selected, "Submit", workspace.body.expectedHead),
      });
      assert.equal(sent.status, 200, JSON.stringify(sent.body));
      workspace = await workspaceOf(send);
      ownOpen = workspace.body.latest;
      assert.equal(ownOpen.lifecycle, "PendingApproval");
      assert.equal(Object.hasOwn(workspace.body, "latestWithdrawal"), false);
    });
    // D3: the second Owner cannot replace the Owner's open change, nor decline it without
    // Store configuration approval (withdrawn above).
    await listen(manager, async (send, selected) => {
      const workspace = await workspaceOf(send);
      const setupNow = (await send("store-setup?storeReference=" + store)).body.setup.snapshot;
      await refusedUnchanged(
        () => materialize(send, selected, workspace.body.expectedHead, setupNow),
        409,
        "open_change_by_another",
      );
      const before = await soleCounts();
      assert.equal((await withdraw(send, ownOpen)).status, 403);
      assert.deepEqual(await soleCounts(), before);
      assert.deepEqual(await withdrawals(), []);
    });
    // The Owner withdraws their own open change: it takes no further step; a retry returns it.
    await listen(session, async (send, selected) => {
      const auditReference = next();
      const withdrawn = await withdraw(send, ownOpen, auditReference);
      assert.equal(withdrawn.status, 200, JSON.stringify(withdrawn.body));
      // 08cb8e8b: the answer says whether Store setup's hours went back to the published hours
      // (not here: this change carried more than hours).
      assert.deepEqual(withdrawn.body, {
        status: "Applied",
        kind: "Withdrawn",
        setupHoursRestored: false,
      });
      const again = await withdraw(send, ownOpen, auditReference);
      assert.deepEqual(again.body, {
        status: "AlreadyApplied",
        kind: "Withdrawn",
        setupHoursRestored: false,
      });
      const workspace = await workspaceOf(send);
      assert.equal(workspace.body.latestWithdrawal.kind, "Withdrawn");
      assert.equal(workspace.body.latestWithdrawal.byYou, true);
      assert.equal(Object.hasOwn(workspace.body, "publicationChecks"), false);
      assert.equal(Object.hasOwn(workspace.body, "soleOperator"), false);
      await refusedUnchanged(
        () => ownApproval(send, selected, workspace.body.expectedHead),
        409,
        "store_configuration_withdrawn",
      );
    });
    assert.deepEqual(await withdrawals(), [
      {
        configuration: ownOpen.configurationReference,
        kind: "Withdrawn",
        actor: owner,
        lifecycle: "PendingApproval",
        reason: "STORE_CONFIGURATION_WITHDRAWN",
      },
    ]);
    // The second Owner's change builds on the withdrawn one; the Owner cannot replace it but
    // declines it (Store configuration approval), then creates their own.
    let managerOpen;
    await listen(manager, async (send, selected) => {
      let workspace = await workspaceOf(send);
      // The setup was saved on the configuration before the withdrawn one: refused plainly until
      // it is saved again (it then builds on the latest configuration).
      const stale = (await send("store-setup?storeReference=" + store)).body.setup.snapshot;
      await refusedUnchanged(
        () => materialize(send, selected, workspace.body.expectedHead, stale),
        409,
        "store_setup_outdated",
      );
      const rebased = await saveSetup(send, {});
      assert.equal(rebased.baseConfigurationReference, ownOpen.configurationReference);
      const created = await materialize(send, selected, workspace.body.expectedHead, rebased);
      assert.equal(created.status, 200, JSON.stringify(created.body));
      workspace = await workspaceOf(send);
      managerOpen = workspace.body.latest;
      assert.equal(managerOpen.authoredByReference, second);
      assert.equal(managerOpen.supersedesConfigurationReference, ownOpen.configurationReference);
    });
    await listen(session, async (send, selected) => {
      let workspace = await workspaceOf(send);
      const setupNow = (await send("store-setup?storeReference=" + store)).body.setup.snapshot;
      await refusedUnchanged(
        () => materialize(send, selected, workspace.body.expectedHead, setupNow),
        409,
        "open_change_by_another",
      );
      // WP-2423 v15: a reason is offered only when declining someone else's change, from a fixed
      // list (refused when unknown, and when withdrawing one's own).
      await refusedUnchanged(
        () => withdraw(send, managerOpen, next(), "Because"),
        400,
        "store_configuration_withdrawal_invalid",
      );
      const declined = await withdraw(send, managerOpen, next(), "NotRight");
      assert.deepEqual(declined.body, {
        status: "Applied",
        kind: "Declined",
        setupHoursRestored: false,
      });
      workspace = await workspaceOf(send);
      assert.deepEqual(
        {
          kind: workspace.body.latestWithdrawal.kind,
          byYou: workspace.body.latestWithdrawal.byYou,
        },
        { kind: "Declined", byYou: true },
      );
      const rebased = await saveSetup(send, {});
      const created = await materialize(send, selected, workspace.body.expectedHead, rebased);
      assert.equal(created.status, 200, JSON.stringify(created.body));
    });
    assert.deepEqual(
      (await withdrawals()).map((w) => [w.configuration, w.kind, w.actor, w.lifecycle, w.reason]),
      [
        [
          ownOpen.configurationReference,
          "Withdrawn",
          owner,
          "PendingApproval",
          "STORE_CONFIGURATION_WITHDRAWN",
        ],
        [
          managerOpen.configurationReference,
          "Declined",
          owner,
          "Draft",
          "STORE_CONFIGURATION_DECLINED_NOT_RIGHT",
        ],
      ],
    );
    const withdrawalAudits = (
      await admin.query(
        "SELECT target_id::text target,reason_code,after_summary_json FROM platform_audit.audit_record WHERE action_code='STORE_CONFIGURATION_CHANGED' AND reason_code IN ('STORE_CONFIGURATION_WITHDRAWN','STORE_CONFIGURATION_DECLINED') ORDER BY occurred_at",
      )
    ).rows;
    assert.deepEqual(
      withdrawalAudits.map((a) => [a.target, a.reason_code, a.after_summary_json]),
      [
        [
          ownOpen.configurationReference,
          "STORE_CONFIGURATION_WITHDRAWN",
          { withdrawal: "Withdrawn" },
        ],
        [
          managerOpen.configurationReference,
          "STORE_CONFIGURATION_DECLINED",
          { withdrawal: "Declined", declineReason: "NotRight" },
        ],
      ],
    );
    // The database refuses the same, whatever the caller: a further step of a withdrawn change,
    // a new change over another person's open change, and editing a withdrawal.
    const scopedAdmin = async (work) => {
      const client = new pg.Client(clientConfig);
      await client.connect();
      try {
        await client.query("BEGIN");
        await client.query(
          "SELECT set_config('bop.brand_id',$1,true),set_config('bop.store_id',$2,true)",
          [scope.brandReference, store],
        );
        return await work(client);
      } finally {
        await client.query("ROLLBACK").catch(() => undefined);
        await client.end();
      }
    };
    await assert.rejects(
      scopedAdmin((client) =>
        client.query(
          "INSERT INTO rms_store.store_configuration_authoring_operation SELECT * FROM jsonb_populate_record(NULL::rms_store.store_configuration_authoring_operation,(SELECT to_jsonb(a)||jsonb_build_object('operation_id',$2::text,'sequence_number',(SELECT max(sequence_number)+1 FROM rms_store.store_configuration_authoring_operation),'audit_reference',$3::text) FROM rms_store.store_configuration_authoring_operation a WHERE configuration_id=$1 AND command_type='Submit'))",
          [ownOpen.configurationReference, id(0x9e20), id(0x9e21)],
        ),
      ),
      /store configuration was withdrawn/u,
    );
    await assert.rejects(
      scopedAdmin((client) =>
        client.query(
          "INSERT INTO rms_store.store_configuration_authoring_operation SELECT * FROM jsonb_populate_record(NULL::rms_store.store_configuration_authoring_operation,(SELECT to_jsonb(a)||jsonb_build_object('operation_id',$1::text,'sequence_number',a.sequence_number+1,'configuration_id',$1::text,'configuration_version',a.configuration_version+1,'expected_version',a.configuration_version,'audit_reference',$2::text,'actor_reference',$3::text,'configuration_json',a.configuration_json||jsonb_build_object('configurationReference',$1::text,'configurationVersion',a.configuration_version+1,'authoredByReference',$3::text)) FROM rms_store.store_configuration_authoring_operation a ORDER BY sequence_number DESC LIMIT 1))",
          [id(0x9e22), id(0x9e23), second],
        ),
      ),
      /another person's store configuration change is still open/u,
    );
    await assert.rejects(
      admin.query("UPDATE rms_store.store_configuration_withdrawal SET reason_code='X'"),
    );
    // WP-2423: further Store configuration journeys on this published Store (same roles).
    if (typeof input.afterPublication === "function")
      await input.afterPublication({
        ...input,
        api,
        store,
        owner,
        second,
        next,
        now,
        transactions,
        operating,
        resources,
        listen,
        command,
        workspaceOf,
        saveSetup,
        materialize,
        liveReceipt,
        receiptInstaller,
        storeLocale,
      });
    return { published, soleApproved };
  } finally {
    for (const name of [api, worker]) {
      await admin.query("DROP OWNED BY " + name).catch(() => undefined);
      await admin.query("DROP ROLE IF EXISTS " + name).catch(() => undefined);
    }
  }
}
