import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { URL } from "node:url";
import pg from "pg";
import { it, vi } from "vitest";
import { canonicalizeRfc8785, sha256Hex } from "../../bop/audit/src/index.ts";
import { storeRoleTemplateActions } from "../../bop/permission/src/index.ts";
import {
  createPostgresPublishedStoreOperatingStatusReader,
  createPostgresStoreSetupDraftStore,
  parseStoreSetupSaveCommand,
} from "../../rms/store/src/index.ts";
import { input as quoteInput } from "../../rms/pricing/src/tests/price-quote.fixture.ts";
import { createMerchantStoreConfigurationOrdinary } from "../../../apps/api/dist/merchant-store-configuration-ordinary.js";
import { appendAuditRecordInTransaction } from "../../bop/audit/src/index.ts";
import { renderPilotAclSql } from "../../../tooling/environment/pilot-acl-render.mjs";
import { createInternalStoreConfiguration } from "../../../tooling/environment/pilot-store-configuration.mjs";
import {
  createStoreConfigurationV2Ports,
  readPublishedStoreConfiguration,
  storeConfigurationPublicationPermissions,
} from "../../../tooling/environment/pilot-store-publication.mjs";
import {
  storeConfigurationContentHash,
  storeConfigurationSetupSnapshotReferences,
  storeConfigurationValidationCheckCodes,
} from "../../../tooling/environment/pilot-store-publication-codes.mjs";
import { withIsolatedDatabase } from "../test-support/isolated-database.mjs";
import { seedMerchantAcceptanceSession } from "../test-support/merchant-acceptance-session.mjs";
import { seedJourneyStorePublication } from "../test-support/dine-in-journey-seed.mjs";
import { seedTaxConfiguration } from "../test-support/tax-configuration-seed.mjs";

const { Client } = pg;
const id = (n) => "01a7e100-0000-7000-8000-" + n.toString(16).padStart(12, "0");
const digest = (value) => "sha256:" + sha256Hex(canonicalizeRfc8785(value));
const configured = (value) => ({ state: "Configured", value });
const day = 86400000;

/**
 * WP-2423 Q4 + DEC-STORE-SETUP-PUBLICATION: store hours once the Owner has published the Store's
 * configuration from Store setup. Everything runs as a restricted NOBYPASSRLS role holding exactly
 * the rendered pilot API grants (pilot ACL matrix + additions), with the real v16 Store role
 * templates (Owner, Store Manager, Front of House), encrypted sessions and current permission
 * policy. Test-controlled (labelled) seed only: the installed V1 configuration and its go-live
 * check, the Store's tax configuration, the Owner's Store setup revisions, and the reference check
 * of the first publication from Store setup (the synthetic address, contact, payment and receipt
 * references have no owner records here). The hours change itself, its review and publication use
 * the pilot compositions unchanged.
 */
it("WP-2423 Q4: a Store Manager changes hours on a configuration from Store setup; the Owner publishes", async () => {
  await withIsolatedDatabase({ caseId: "wp2423_hours_setup" }, async (context) => {
    const admin = new Client(context.clientConfig);
    await admin.connect();
    const api = "wp2423_hs_" + context.runId,
      worker = "wp2423_hs_w_" + context.runId;
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
      const scope = { tenantReference: id(3), brandReference: id(1), storeReference: id(2) };
      const now = () => new Date().toISOString();
      let next = 0x1000;
      const reference = () => id(next++);

      // --- Seed (test-controlled): installed configuration, go-live check and tax in force.
      const publishedAt = new Date(Date.now() - 2 * 3600000).toISOString();
      await seedJourneyStorePublication({
        client: admin,
        scope,
        publishedAt,
        businessDayStart: "04:00:00",
        prefix: "01a7e1a0",
      });
      const installed = (
        await admin.query(
          "SELECT configuration_json FROM rms_store.store_configuration_publication_content WHERE store_id=$1",
          [scope.storeReference],
        )
      ).rows[0].configuration_json;
      const tax = quoteInput().taxConfiguration;
      await seedTaxConfiguration(
        admin,
        {
          ...tax,
          configurationReference: installed.taxConfigurationReference,
          versionReference: id(0x200),
          brandReference: scope.brandReference,
          storeReference: scope.storeReference,
          effectivePeriod: {
            ...tax.effectivePeriod,
            timeZone: "America/Toronto",
            effectiveFrom: {
              ...tax.effectivePeriod.effectiveFrom,
              instant: new Date(Date.now() - day).toISOString(),
            },
            effectiveUntil: null,
          },
          registrationEvidence: {
            ...tax.registrationEvidence,
            validUntil: new Date(Date.now() + 30 * day).toISOString(),
          },
          professionalEvidence: {
            ...tax.professionalEvidence,
            validUntil: new Date(Date.now() + 30 * day).toISOString(),
          },
          rules: tax.rules.map((rule) => ({ ...rule, ruleReference: id(0x201) })),
          createdAt: new Date(Date.now() - day).toISOString(),
        },
        id(10),
      );

      // --- People: two Owners, a Store Manager and Front of House on the real v16 templates.
      const people = {};
      for (const [name, actor, prefix, sessionPrefix, template] of [
        ["owner", id(10), "01a7e1b0", "01a7e1b1", "owner"],
        ["secondOwner", id(12), "01a7e1c0", "01a7e1c1", "owner"],
        ["manager", id(11), "01a7e1d0", "01a7e1d1", "store-manager"],
        ["frontOfHouse", id(13), "01a7e1e0", "01a7e1e1", "front-of-house"],
      ]) {
        const session = await seedMerchantAcceptanceSession({
          admin,
          runner: transactions,
          scope,
          actor,
          at: now(),
          extraPermissions: storeRoleTemplateActions(template).filter(
            (action) => !["merchant.access", "order.accept", "ordering.operate"].includes(action),
          ),
          referencePrefix: prefix,
          sessionReferencePrefix: sessionPrefix,
        });
        // A live server clock (the session's own clock is fixed at sign-in).
        people[name] = {
          ...session,
          actor,
          persistence: { ...session.persistence, now },
        };
      }
      const manager = storeRoleTemplateActions("store-manager");
      for (const action of ["publishing.draft.create", "publishing.review.submit"])
        assert.ok(manager.includes(action), "v16 Store Manager: " + action);
      assert.ok(!manager.includes("store.service.approve"));

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
      const resources = {
        operating,
        transactions,
        now,
        credentials: { reference },
      };
      /** The pilot's Q4 composition for one signed-in person (as at a pilot restart). */
      const hoursFor = (person) =>
        createInternalStoreConfiguration(resources, {
          persistence: person.persistence,
          service: person.authentication,
        });
      // The installed configuration: the hours editor starts as before.
      assert.equal(
        (await (await hoursFor(people.owner)).read(people.owner.sessionCookie)).current.setupBasis,
        undefined,
      );

      // --- Seed (test-controlled): the Owner's Store setup revision 1, based on the installed one.
      const setupSave = async (content, expected, base) => {
        const tx = { query: (sql, values) => admin.query(sql, [...values]) };
        const t0 = now();
        const guards = [];
        await admin.query("BEGIN");
        try {
          const store = createPostgresStoreSetupDraftStore({
            ...scope,
            actorReference: people.owner.actor,
            transaction: tx,
            clock: { now },
            originalObservedAt: t0,
            originalValidUntil: new Date(Date.parse(t0) + 5000).toISOString(),
            registerBeforeCommit: (_tx, guard, final) => {
              guards.push([guard, final]);
            },
            authority: {
              holdUntilTransactionCompletes: async (_tx, packet) => ({
                validUntil: packet.validUntil,
              }),
            },
            references: { ...storeConfigurationSetupSnapshotReferences, nextReference: reference },
            appendAudit: async () => undefined,
            withCurrentSaveScope: async (_tx, _packet, work) =>
              work({
                ...scope,
                actorReference: people.owner.actor,
                defaultLocale: "en-CA",
                currencyCode: "CAD",
                baseConfigurationReference: base,
              }),
          });
          const receipt = await store.save(
            parseStoreSetupSaveCommand({
              profile: "StoreSetupSaveV2",
              ...scope,
              actorReference: people.owner.actor,
              operationReference: reference(),
              expectedSetupReference: expected?.setupDraftReference ?? null,
              expectedRevision: expected?.revision ?? 0,
              purposeCode: "STORE_SETUP_DRAFT",
              content,
            }),
          );
          for (const [guard] of guards) await guard();
          for (const [, final] of guards) final();
          store.assertFinalized(tx);
          await admin.query("COMMIT");
          return receipt.snapshot;
        } catch (error) {
          await admin.query("ROLLBACK");
          throw error;
        }
      };
      const setupContent = {
        feeContexts: configured(
          ["ServiceCharge", "DeliveryFee", "Tip"].map((chargeType) => ({
            chargeType,
            state: "Disabled",
          })),
        ),
        ...Object.fromEntries(
          [
            "source",
            "brandBaseVersionReference",
            "timeZone",
            "businessDayStartLocalTime",
            "addressReference",
            "contactReference",
            "receiptReference",
            "taxConfigurationReference",
            "paymentConfigurationReference",
            "capacityConfigurationReference",
            "enabledServiceModes",
            "weeklySchedule",
            "exceptions",
          ].map((field) => [field, configured(installed[field])]),
        ),
        effectiveFrom: configured(new Date(Date.now() - 3600000).toISOString()),
        effectiveUntil: configured(null),
      };
      const revision1 = await setupSave(setupContent, null, installed.configurationReference);

      // --- The Owner publishes revision 1 through the ordinary Store setup publication (another
      // Owner approves). Test-controlled: the saved references are accepted as they are.
      const runs = new WeakMap();
      const ordinary = (person) =>
        createMerchantStoreConfigurationOrdinary({
          persistence: person.persistence,
          authentication: person.authentication,
          actionPermissions: storeConfigurationPublicationPermissions,
          nextReference: reference,
          v2: createStoreConfigurationV2Ports(resources, (tx) => runs.get(tx)),
          configure: (tx, scopeOfRun) => {
            const authorize = async (transaction, at) =>
              (await scopeOfRun.allowed()) && (await operating.authorize(transaction, at));
            let published;
            const read = async (actual) =>
              (published ??= await readPublishedStoreConfiguration(
                operating,
                actual,
                now(),
                authorize,
              ));
            runs.set(tx, { authorize, references: async () => true, published: () => read(tx) });
            return {
              publication: {
                tenantReference: scope.tenantReference,
                publishingFamilyReference: "01a7e1a0-0000-7000-8000-000000000046",
                configurationType: operating.configurationType,
                purposeCode: operating.purposeCode,
                requiredLiveGateRequirementCodes: operating.requiredLiveGateRequirementCodes,
                requiredValidationCheckCodes: storeConfigurationValidationCheckCodes,
                setupSnapshotReferences: storeConfigurationSetupSnapshotReferences,
                hashContent: storeConfigurationContentHash,
                authorize,
              },
              businessDayStartSource: "StoreOverride",
              nextReference: reference,
              publishedBaseline: async (actual) => (await read(actual)).configuration,
              ports: () => ({
                authorization: { authorize: async () => scopeOfRun.allowed() },
                references: {
                  hashIntent: (text) => "sha256:" + sha256Hex(text),
                  equals: (left, right) => left === right,
                  validateControlledReferences: async () => true,
                  validateBrandBaseCompatibility: async () => true,
                },
              }),
              appendAudit: async (actual, input) =>
                appendAuditRecordInTransaction(actual, {
                  auditId: input.audit.auditReference,
                  brandId: scope.brandReference,
                  storeId: scope.storeReference,
                  actor: { type: "User", reference: input.audit.actorReference },
                  actionCode: "STORE_CONFIGURATION_CHANGED",
                  targetType: "StoreConfiguration",
                  targetId: input.operation.configuration.configurationReference,
                  correlationId: input.operation.operationReference,
                  reasonCode: "STORE_SETUP_PUBLICATION",
                  occurredAt: input.audit.occurredAt,
                  sourceChannel: "MERCHANT_WEB",
                  dataClassification: "Internal",
                  retentionPolicyCode: "AUDIT_DEFAULT",
                  retentionPolicyVersion: 1,
                }),
            };
          },
        });
      const publishStep = async (person, action, extra = {}) => {
        const expectedScope = { ...scope, actorReference: person.actor };
        const workspace = await ordinary(person).read({
          sessionCookie: person.sessionCookie,
          expectedStoreReference: scope.storeReference,
          expectedScope,
        });
        return ordinary(person).write({
          sessionCookie: person.sessionCookie,
          csrf: person.csrf,
          expectedScope,
          command: {
            profile: "StoreConfigurationOrdinaryCommandV1",
            ...expectedScope,
            operationReference: reference(),
            action,
            expectedHead: workspace.expectedHead,
            ...extra,
          },
        });
      };
      await publishStep(people.owner, "Materialize", {
        setupSelector: {
          setupDraftReference: revision1.setupDraftReference,
          sourceRevision: 1,
          sourceSnapshotDigest: digest(revision1),
        },
        reasonCode: "STORE_SETUP_PUBLICATION",
      });
      await publishStep(people.owner, "Validate");
      await publishStep(people.owner, "Submit");
      await publishStep(people.secondOwner, "Approve");
      await publishStep(people.secondOwner, "Publish");

      // --- Restart: the hours editor starts on a configuration from Store setup and reads it.
      // Before WP-2423 Q4 this refused to start (PILOT_STORE_CONFIGURATION_SETUP_BASIS_UNSUPPORTED).
      const managerHours = await hoursFor(people.manager);
      const view = await managerHours.read(people.manager.sessionCookie);
      assert.equal(view.current.setupBasis.sourceRevision, 1);
      assert.equal(view.current.lifecycle, "Published");
      const publishedX = view.current;

      // --- The Store Manager saves an hours draft.
      const newHours = Array.from({ length: 7 }, (_, index) => ({
        isoWeekday: index + 1,
        intervals: [
          {
            startLocalTime: "10:00:00",
            endLocalTime: "20:00:00",
            endsNextDay: false,
            serviceModes: ["Pickup"],
            orderCutoffSeconds: 900,
            leadTimeSeconds: 600,
          },
        ],
      }));
      const newExceptions = [{ localDate: "2026-12-25", kind: "Holiday", intervals: [] }];
      const hoursCommand = {
        expectedSetup: {
          setupDraftReference: publishedX.setupBasis.setupDraftReference,
          sourceRevision: publishedX.setupBasis.sourceRevision,
          sourceSnapshotDigest: publishedX.setupBasis.sourceSnapshotDigest,
        },
        setupOperationReference: reference(),
        operationReference: reference(),
        auditReference: reference(),
        configurationReference: reference(),
        expectedVersion: view.expectedVersion,
        weeklySchedule: newHours,
        exceptions: newExceptions,
        effectiveFrom: view.observedAt,
      };
      const saveHours = (person, command) =>
        person === people.manager
          ? managerHours.hoursDraft({
              sessionCookie: person.sessionCookie,
              csrf: person.csrf,
              command,
            })
          : hoursFor(person).then((composition) =>
              composition.hoursDraft({
                sessionCookie: person.sessionCookie,
                csrf: person.csrf,
                command,
              }),
            );
      const saved = await saveHours(people.manager, hoursCommand);
      assert.deepEqual(saved, { status: "Applied", resultingVersion: view.expectedVersion + 1 });
      const revisions = await admin.query(
        "SELECT revision,actor_id,snapshot_json,snapshot_digest FROM rms_store.store_setup_draft_revision WHERE store_id=$1 ORDER BY revision",
        [scope.storeReference],
      );
      assert.equal(revisions.rows.length, 2);
      const revision2 = revisions.rows[1];
      assert.equal(revision2.actor_id, people.manager.actor);
      assert.deepEqual(revision2.snapshot_json.content.weeklySchedule, configured(newHours));
      assert.equal(
        revision2.snapshot_json.baseConfigurationReference,
        publishedX.configurationReference,
      );
      for (const field of [
        "timeZone",
        "taxConfigurationReference",
        "feeContexts",
        "addressReference",
      ])
        assert.deepEqual(revision2.snapshot_json.content[field], revision1.content[field], field);
      const afterSave = await managerHours.read(people.manager.sessionCookie);
      assert.equal(afterSave.latest.lifecycle, "Draft");
      assert.equal(afterSave.latest.authoredByReference, people.manager.actor);
      assert.equal(
        afterSave.latest.supersedesConfigurationReference,
        publishedX.configurationReference,
      );
      assert.equal(afterSave.latest.setupBasis.sourceRevision, 2);
      assert.equal(afterSave.latest.setupBasis.sourceSnapshotDigest, revision2.snapshot_digest);
      assert.deepEqual(afterSave.latest.weeklySchedule, newHours);
      const audits = await admin.query(
        "SELECT action_code,actor_reference FROM platform_audit.audit_record WHERE correlation_id IN ($1,$2)",
        [hoursCommand.setupOperationReference, hoursCommand.operationReference],
      );
      assert.deepEqual(audits.rows.map((row) => row.action_code).sort(), [
        "STORE_CONFIGURATION_CHANGED",
        "STORE_SETUP_DRAFT_SAVED",
      ]);

      // A retried request returns the recorded result without writing again.
      assert.deepEqual(await saveHours(people.manager, hoursCommand), {
        status: "AlreadyApplied",
        resultingVersion: view.expectedVersion + 1,
      });
      assert.equal(
        (
          await admin.query(
            "SELECT count(*)::int n FROM rms_store.store_setup_draft_revision WHERE store_id=$1",
            [scope.storeReference],
          )
        ).rows[0].n,
        2,
      );

      // Front of House cannot change hours.
      await assert.rejects(
        saveHours(people.frontOfHouse, {
          ...hoursCommand,
          setupOperationReference: reference(),
          operationReference: reference(),
          auditReference: reference(),
          configurationReference: reference(),
        }),
        (error) =>
          [
            "STORE_CONFIGURATION_PERMISSION_DENIED",
            "STORE_SETUP_OPERATION_PERMISSION_DENIED",
          ].includes(error?.code ?? error?.message),
      );

      // --- Validate and submit (Store Manager), approve and publish (Owner).
      const step = async (person, composition, command) => {
        const current = await composition.read(person.sessionCookie);
        const latest = current.latest;
        return composition({
          sessionCookie: person.sessionCookie,
          csrf: person.csrf,
          command: {
            command,
            operationReference: reference(),
            auditReference: reference(),
            expectedVersion: current.expectedVersion,
            configuration: {
              ...latest,
              lifecycle:
                command === "Submit" || command === "Approve"
                  ? "PendingApproval"
                  : command === "Publish"
                    ? "Approved"
                    : "Draft",
              updatedAt: command === "Publish" ? latest.updatedAt : current.observedAt,
            },
          },
        });
      };
      await step(people.manager, managerHours, "Validate");
      await step(people.manager, managerHours, "Submit");
      assert.equal(
        (await managerHours.read(people.manager.sessionCookie)).latest.lifecycle,
        "PendingApproval",
      );
      // The Store Manager cannot approve (its own change, and no approval permission); nor can
      // Front of House. Both answer 403 at the route (plain refusals, nothing recorded).
      await assert.rejects(step(people.manager, managerHours, "Approve"), (error) =>
        /^STORE_CONFIGURATION_(COMMAND_INVALID|PERMISSION_DENIED)$/u.test(String(error?.message)),
      );
      await assert.rejects(
        hoursFor(people.frontOfHouse).then((composition) =>
          step(people.frontOfHouse, composition, "Approve"),
        ),
        (error) => String(error?.message).includes("PERMISSION_DENIED"),
      );
      assert.equal(
        (await managerHours.read(people.manager.sessionCookie)).latest.lifecycle,
        "PendingApproval",
      );
      const ownerHours = await hoursFor(people.owner);
      await step(people.owner, ownerHours, "Approve");
      await step(people.owner, ownerHours, "Publish");

      // --- Customers get the new hours; Store setup shows them as its latest revision.
      const final = await ownerHours.read(people.owner.sessionCookie);
      assert.equal(final.current.lifecycle, "Published");
      assert.deepEqual(final.current.weeklySchedule, newHours);
      assert.deepEqual(final.current.exceptions, newExceptions);
      assert.equal(final.current.approvedByReference, people.owner.actor);
      const proof = await transactions.run((tx) =>
        readPublishedStoreConfiguration(operating, tx, now(), async () => true),
      );
      assert.deepEqual(proof.configuration.weeklySchedule, newHours);
      const status = await transactions.run((tx) =>
        createPostgresPublishedStoreOperatingStatusReader(operating)(tx, now()),
      );
      assert.equal(status.businessDate.storeReference, scope.storeReference);
      assert.match(JSON.stringify(status), /"10:00:00"/u);
      const head = (
        await admin.query(
          "SELECT revision,snapshot_digest FROM rms_store.store_setup_draft_revision WHERE store_id=$1 ORDER BY revision DESC LIMIT 1",
          [scope.storeReference],
        )
      ).rows[0];
      assert.equal(final.current.setupBasis.sourceRevision, Number(head.revision));
      assert.equal(final.current.setupBasis.sourceSnapshotDigest, head.snapshot_digest);

      // --- Store setup changes the Owner has not published block an hours change.
      const revision3 = await setupSave(
        { ...revision2.snapshot_json.content, contactReference: configured(id(0x300)) },
        revision2.snapshot_json,
        final.current.configurationReference,
      );
      assert.equal(revision3.revision, 3);
      const blockedView = await managerHours.read(people.manager.sessionCookie);
      await assert.rejects(
        saveHours(people.manager, {
          ...hoursCommand,
          expectedSetup: {
            setupDraftReference: final.current.setupBasis.setupDraftReference,
            sourceRevision: final.current.setupBasis.sourceRevision,
            sourceSnapshotDigest: final.current.setupBasis.sourceSnapshotDigest,
          },
          setupOperationReference: reference(),
          operationReference: reference(),
          auditReference: reference(),
          configurationReference: reference(),
          expectedVersion: blockedView.expectedVersion,
          effectiveFrom: blockedView.observedAt,
        }),
        (error) => error?.code === "STORE_SETUP_OPERATION_UNPUBLISHED_CHANGES",
      );

      // --- Another Store sees none of it (row-level security under the API role).
      const otherStore = id(0x400);
      await admin.query(
        "INSERT INTO bop_tenant.store VALUES ($1,$2,'SYNTHETIC_OTHER_STORE','Synthetic Other Store','America/Toronto','en-CA','CAD','Active',1,$3,$3)",
        [otherStore, scope.brandReference, now()],
      );
      const visible = await transactions.run(async (tx) => {
        await tx.query(
          "SELECT set_config('bop.tenant_id',$1,true),set_config('bop.brand_id',$2,true),set_config('bop.store_id',$3,true)",
          [scope.tenantReference, scope.brandReference, otherStore],
        );
        const counts = [];
        for (const table of [
          "store_setup_draft_revision",
          "store_setup_draft_operation",
          "store_configuration_authoring_operation",
        ])
          counts.push(
            (await tx.query("SELECT count(*)::int n FROM rms_store." + table, [])).rows[0].n,
          );
        return counts;
      });
      assert.deepEqual(visible, [0, 0, 0]);
    } finally {
      vi.unstubAllEnvs();
      await admin.end();
    }
  });
});
