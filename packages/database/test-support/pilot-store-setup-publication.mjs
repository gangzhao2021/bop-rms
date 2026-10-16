import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { readFile } from "node:fs/promises";
import { request } from "node:http";
import { createRequire } from "node:module";
import { URL } from "node:url";
import pg from "pg";
import { canonicalizeRfc8785, sha256Hex } from "../../bop/audit/src/index.ts";
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
    const persistenceFor = (reader) => ({
      ...reader.persistence,
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
    let setup;
    await listen(session, async (send, selected) => {
      const current = await send("store-setup?storeReference=" + store);
      assert.equal(current.status, 200, JSON.stringify(current.body));
      const head = current.body.setup.snapshot;
      assert.equal(head.revision, savedSetup.revision);
      const configured = (value) => ({ state: "Configured", value });
      const content = {
        ...head.content,
        source: configured("StoreOverride"),
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
    return { published };
  } finally {
    for (const name of [api, worker]) {
      await admin.query("DROP OWNED BY " + name).catch(() => undefined);
      await admin.query("DROP ROLE IF EXISTS " + name).catch(() => undefined);
    }
  }
}
