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
import { createMerchantStoreConfigurationWithdrawal } from "../../../apps/api/dist/merchant-store-configuration-withdrawal.js";
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
import { seedSoleOperatorSetting, seedStepUp } from "../test-support/sole-operator-brand-gate.mjs";
import { createIdentityActor } from "../../bop/identity/src/index.ts";

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
        // A live server clock (the session's own clock is fixed at sign-in), and an Identity roster
        // double (pilot `currentActor`): an active workforce actor per reference, so the
        // sole-operator gate evaluates each Store member as an approval would (TEST-ONLY).
        people[name] = {
          ...session,
          actor,
          persistence: {
            ...session.persistence,
            now,
            currentActor: async (_tx, reference, authenticatedAt) =>
              createIdentityActor({
                actorType: "User",
                actorReference: reference,
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
      /** One hours-editor step (as the browser sends it), optionally approved alone. */
      const act = async (person, command, approvalMode) => {
        const composition = await hoursFor(person);
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
            ...(approvalMode === undefined ? {} : { approvalMode }),
          },
        });
      };
      const counts = async () =>
        (
          await admin.query(
            "SELECT (SELECT count(*) FROM rms_store.store_configuration_authoring_operation)::int authoring,(SELECT count(*) FROM rms_store.store_configuration_version)::int versions,(SELECT count(*) FROM rms_store.store_configuration_sole_operator_approval)::int marks,(SELECT count(*) FROM bop_publishing.publishing_mutation_record)::int publishing,(SELECT count(*) FROM platform_audit.audit_record)::int audits",
          )
        ).rows[0];
      const refusedUnchanged = async (attempt, check) => {
        const before = await counts();
        await assert.rejects(attempt(), check);
        assert.deepEqual(await counts(), before);
      };
      const isCode = (code) => (error) => error?.code === code || error?.message === code;
      const isSole = (code, reason) => (error) =>
        error?.name === "MerchantSoleOperatorGateError" &&
        error.code === code &&
        error.reason === reason;
      const secondOwnerApproval = () =>
        admin.query(
          "SELECT grant_id FROM bop_permission.permission_grant WHERE role_id=$1 AND lifecycle='Active' AND permission_id IN (SELECT permission_id FROM bop_permission.permission_definition WHERE action_code='store.service.approve')",
          ["01a7e1c0-0000-7000-8000-000000000004"],
        );
      const revokeSecondOwnerApproval = async () => {
        const revoked = await admin.query(
          "UPDATE bop_permission.permission_grant SET lifecycle='Revoked',version=version+1 WHERE role_id=$1 AND lifecycle='Active' AND permission_id IN (SELECT permission_id FROM bop_permission.permission_definition WHERE action_code='store.service.approve') RETURNING permission_id,effective_from,effective_until",
          ["01a7e1c0-0000-7000-8000-000000000004"],
        );
        assert.equal(revoked.rowCount, 1);
        return revoked.rows[0];
      };
      const restoreSecondOwnerApproval = async (revoked) => {
        await admin.query(
          "INSERT INTO bop_permission.permission_grant VALUES ($1,$2,$3,$4,$5,'Active',$6,$7,1,$6,$6)",
          [
            reference(),
            "01a7e1c0-0000-7000-8000-000000000004",
            revoked.permission_id,
            scope.brandReference,
            scope.storeReference,
            revoked.effective_from,
            revoked.effective_until,
          ],
        );
        assert.equal((await secondOwnerApproval()).rowCount, 1);
      };
      const sid = (n) => id(0x9000 + n);
      let settingVersion = 0;
      const soleOperator = (state) =>
        seedSoleOperatorSetting(admin, {
          id: sid,
          n: 0x100 + settingVersion * 0x10,
          tenantReference: scope.tenantReference,
          brandReference: scope.brandReference,
          actorReference: people.owner.actor,
          state,
          version: ++settingVersion,
        });
      let stepUps = 0;
      const verifyOwner = (ageMs = 0) =>
        seedStepUp(admin, {
          id: sid,
          n: 0x400 + 0x10 * stepUps++,
          brandReference: scope.brandReference,
          storeReference: scope.storeReference,
          actorReference: people.owner.actor,
          ageMs,
        });

      // --- WP-2423 v15: the Owner changes the installed configuration's hours (no Store setup
      // yet); only the Owner checks and sends their own change, and approves it alone only as an
      // in-effect, verified sole operator (DEC-SOLE-OPERATOR-APPROVAL 2026-10-16).
      {
        const ownerComposition = await hoursFor(people.owner);
        const view = await ownerComposition.read(people.owner.sessionCookie);
        const installedHours = view.current.weeklySchedule.map((day) => ({
          ...day,
          intervals: day.intervals.map((i) => ({ ...i, orderCutoffSeconds: 1200 })),
        }));
        const saved = await ownerComposition({
          sessionCookie: people.owner.sessionCookie,
          csrf: people.owner.csrf,
          command: {
            command: "SaveDraft",
            operationReference: reference(),
            auditReference: reference(),
            expectedVersion: view.expectedVersion,
            configuration: {
              ...view.current,
              configurationReference: reference(),
              configurationVersion: view.expectedVersion + 1,
              supersedesConfigurationReference: view.current.configurationReference,
              lifecycle: "Draft",
              weeklySchedule: installedHours,
              effectiveFrom: view.observedAt,
              effectiveUntil: null,
              reasonCode: "STORE_HOURS_UPDATE",
              approvedByReference: null,
              approvalEvidenceReference: null,
              publicationReference: null,
              liveGateEvidenceReference: null,
              createdAt: view.observedAt,
              updatedAt: view.observedAt,
            },
          },
        });
        assert.equal(saved.status, "Applied");
        // The Store Manager cannot check or send the Owner's change (named refusal, nothing
        // recorded); the Owner does.
        for (const command of ["Validate", "Submit"])
          await refusedUnchanged(
            () => act(people.manager, command),
            isCode("STORE_CONFIGURATION_NOT_YOUR_CHANGE"),
          );
        await act(people.owner, "Validate");
        await act(people.owner, "Submit");
        // The Owner's own approval: refused unless asked alone; sole operator off says so.
        let read = await (await hoursFor(people.owner)).read(people.owner.sessionCookie);
        assert.equal(read.latest.lifecycle, "PendingApproval");
        assert.equal(read.latestAuthorName, null);
        assert.equal(read.soleOperator.status, "NotSet");
        await refusedUnchanged(
          () => act(people.owner, "Approve"),
          isCode("STORE_CONFIGURATION_SELF_APPROVAL"),
        );
        await refusedUnchanged(
          () => act(people.owner, "Approve", "SoleOperator"),
          isSole("NotInEffect", "Off"),
        );
        // v15 (`8bd902e3` D3/D9): with no Store name kept for the Owner, the Store Manager sees
        // the Owner's Store role (administered name, owner-seeded TEST-ONLY; v15 "Owner"), never a
        // reference, and is not offered to decline it.
        await admin.query(
          "INSERT INTO bop_permission.role_administration_version (administration_reference,role_id,version,brand_id,store_id,role_code,display_name,description,role_type,lifecycle,source_policy_version,authored_by_reference,submitted_by_reference,approved_by_reference,decision_evidence_reference,reason_code,changed_at,data_classification) SELECT $1,role_id,1,brand_id,$2,role_code,'Owner','All Store permissions (TEST-ONLY)','System','Active',1,$3,$3,$4,$5,'STORE_OPENING',now(),'ConfigurationMetadata' FROM bop_permission.role WHERE role_id=$6",
          [
            reference(),
            scope.storeReference,
            people.secondOwner.actor,
            people.frontOfHouse.actor,
            reference(),
            "01a7e1b0-0000-7000-8000-000000000004",
          ],
        );
        const byRole = await (await hoursFor(people.manager)).read(people.manager.sessionCookie);
        assert.equal(byRole.latestAuthorName, "the Owner");
        assert.equal(byRole.viewerMayDecline, false);
        // The Store Manager sees whose change waits (by the name the Store keeps for the Owner,
        // owner-seeded TEST-ONLY), and gets no sole-operator view.
        await admin.query(
          "INSERT INTO bop_membership.member_profile_version (membership_id,version,brand_id,actor_id,display_name,operation_id,changed_by,changed_at,data_classification) VALUES ($1,1,$2,$3,'Test Owner',$4,$3,$5,'PersonalData')",
          [
            "01a7e1b0-0000-7000-8000-000000000001",
            scope.brandReference,
            people.owner.actor,
            reference(),
            now(),
          ],
        );
        const managerRead = await (
          await hoursFor(people.manager)
        ).read(people.manager.sessionCookie);
        assert.equal(managerRead.latestAuthorName, "Test Owner");
        assert.equal(managerRead.soleOperator, null);
        // On, but the second Owner also approves Store configuration.
        await soleOperator("On");
        read = await (await hoursFor(people.owner)).read(people.owner.sessionCookie);
        assert.equal(read.soleOperator.status, "OtherApprovers");
        await refusedUnchanged(
          () => act(people.owner, "Approve", "SoleOperator"),
          isSole("NotInEffect", "OtherApprovers"),
        );
        // The Owner is the only approver; verification missing or older than 15 minutes refused.
        const revoked = await revokeSecondOwnerApproval();
        await refusedUnchanged(
          () => act(people.owner, "Approve", "SoleOperator"),
          isSole("NeedsReverification", undefined),
        );
        await verifyOwner(20 * 60000);
        await refusedUnchanged(
          () => act(people.owner, "Approve", "SoleOperator"),
          isSole("NeedsReverification", undefined),
        );
        const verifiedAt = await verifyOwner();
        read = await (await hoursFor(people.owner)).read(people.owner.sessionCookie);
        assert.equal(read.soleOperator.status, "Effective");
        // Someone else's change is never approved "alone".
        await refusedUnchanged(
          () => act(people.secondOwner, "Approve", "SoleOperator"),
          (error) =>
            /STORE_CONFIGURATION_(COMMAND_INVALID|PERMISSION_DENIED)/u.test(
              String(error?.code ?? error?.message),
            ),
        );
        const approved = await act(people.owner, "Approve", "SoleOperator");
        assert.equal(approved.status, "Applied");
        await act(people.owner, "Publish");
        read = await (await hoursFor(people.owner)).read(people.owner.sessionCookie);
        assert.equal(read.current.configurationVersion, view.expectedVersion + 1);
        assert.equal(read.current.approvedByReference, people.owner.actor);
        assert.equal(read.current.authoredByReference, people.owner.actor);
        assert.equal(read.current.setupBasis, undefined);
        const mark = (
          await admin.query(
            "SELECT actor_id::text actor,approval_evidence_id::text evidence,actor_mfa_at FROM rms_store.store_configuration_sole_operator_approval WHERE configuration_id=$1",
            [read.current.configurationReference],
          )
        ).rows;
        assert.equal(mark.length, 1);
        assert.equal(mark[0].actor, people.owner.actor);
        assert.equal(mark[0].evidence, read.current.approvalEvidenceReference);
        assert.equal(mark[0].actor_mfa_at.toISOString(), verifiedAt);
        const approvalAudit = (
          await admin.query(
            "SELECT reason_code,after_summary_json FROM platform_audit.audit_record WHERE target_id=$1 AND action_code='STORE_CONFIGURATION_CHANGED' AND reason_code LIKE 'STORE_HOURS_CHANGE%' ORDER BY occurred_at",
            [read.current.configurationReference],
          )
        ).rows.map((row) => [row.reason_code, row.after_summary_json]);
        assert.deepEqual(approvalAudit.slice(-2), [
          ["STORE_HOURS_CHANGE_SOLE_OPERATOR", { approvalMode: "SoleOperator" }],
          ["STORE_HOURS_CHANGE", {}],
        ]);
        // The Store runs on it (the publication proof accepts the Owner's approval with its mark).
        const running = await transactions.run((tx) =>
          readPublishedStoreConfiguration(operating, tx, now(), async () => true),
        );
        assert.equal(
          running.configuration.configurationReference,
          read.current.configurationReference,
        );
        // Back to two people for the rest of this journey.
        await soleOperator("Off");
        await restoreSecondOwnerApproval(revoked);
      }
      // The database refuses a Store Manager's check of the Owner's change, whatever the caller.
      await assert.rejects(
        admin.query(
          "INSERT INTO rms_store.store_configuration_authoring_operation SELECT * FROM jsonb_populate_record(NULL::rms_store.store_configuration_authoring_operation,(SELECT to_jsonb(a)||jsonb_build_object('operation_id',$1::text,'sequence_number',(SELECT max(sequence_number)+1 FROM rms_store.store_configuration_authoring_operation),'audit_reference',$2::text,'actor_reference',$3::text,'command_type','Validate','lifecycle','Draft') FROM rms_store.store_configuration_authoring_operation a WHERE command_type='Validate' ORDER BY sequence_number DESC LIMIT 1))",
          [reference(), reference(), people.manager.actor],
        ),
        /only the person who made a store configuration change checks or sends it/u,
      );
      const installedNow = (
        await admin.query(
          "SELECT configuration_json FROM rms_store.store_configuration_publication_content WHERE store_id=$1 ORDER BY (configuration_json->>'configurationVersion')::int DESC LIMIT 1",
          [scope.storeReference],
        )
      ).rows[0].configuration_json;

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
          ].map((field) => [field, configured(installedNow[field])]),
        ),
        // From now: after the Owner's own hours change published above.
        effectiveFrom: configured(now()),
        effectiveUntil: configured(null),
      };
      let revision1 = await setupSave(setupContent, null, installedNow.configurationReference);

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
      // --- WP-2423 v15 (`8bd902e3` D2): a configuration created from Store setup is withdrawn
      // while the published configuration is still the installed (V1) kind. The hours editor's
      // path follows the PUBLISHED configuration: an ordinary hours change (the hours-only setup
      // revision is refused for a V1 published configuration), which builds on the published
      // hours, not the withdrawn change. The Store Manager and the Owner both save, send and get
      // their changes published (the Owner alone as sole operator); v15 recovers without data fix.
      {
        await publishStep(people.owner, "Materialize", {
          setupSelector: {
            setupDraftReference: revision1.setupDraftReference,
            sourceRevision: revision1.revision,
            sourceSnapshotDigest: digest(revision1),
          },
          reasonCode: "STORE_SETUP_PUBLICATION",
        });
        let read = await (await hoursFor(people.owner)).read(people.owner.sessionCookie);
        const created = read.latest;
        assert.notEqual(created.setupBasis, undefined);
        assert.equal(read.current.setupBasis, undefined);
        const withdrawn = await createMerchantStoreConfigurationWithdrawal({
          persistence: people.owner.persistence,
          authentication: people.owner.authentication,
        })({
          sessionCookie: people.owner.sessionCookie,
          csrf: people.owner.csrf,
          command: {
            configurationReference: created.configurationReference,
            configurationVersion: created.configurationVersion,
            auditReference: reference(),
          },
        });
        assert.deepEqual(withdrawn, { status: "Applied", kind: "Withdrawn" });
        /** The browser's ordinary hours save: from the published hours (the latest was withdrawn),
         * superseding the latest recorded change. */
        const ordinaryHours = async (person, cutoff) => {
          const composition = await hoursFor(person);
          const view = await composition.read(person.sessionCookie);
          assert.notEqual(view.latestWithdrawal ?? null, null);
          const base = view.current;
          assert.equal(base.setupBasis, undefined);
          return composition({
            sessionCookie: person.sessionCookie,
            csrf: person.csrf,
            command: {
              command: "SaveDraft",
              operationReference: reference(),
              auditReference: reference(),
              expectedVersion: view.expectedVersion,
              configuration: {
                ...base,
                configurationReference: reference(),
                configurationVersion: view.expectedVersion + 1,
                supersedesConfigurationReference: view.latest.configurationReference,
                lifecycle: "Draft",
                weeklySchedule: base.weeklySchedule.map((day) => ({
                  ...day,
                  intervals: day.intervals.map((i) => ({ ...i, orderCutoffSeconds: cutoff })),
                })),
                effectiveFrom: view.observedAt,
                effectiveUntil: null,
                reasonCode: "STORE_HOURS_UPDATE",
                approvedByReference: null,
                approvalEvidenceReference: null,
                publicationReference: null,
                liveGateEvidenceReference: null,
                createdAt: view.observedAt,
                updatedAt: view.observedAt,
              },
            },
          });
        };
        // The hours-only setup revision the editor used to send (v15: 409 "Source changed") is
        // refused for a V1 published configuration and writes nothing.
        const stuck = await (await hoursFor(people.manager)).read(people.manager.sessionCookie);
        await refusedUnchanged(
          () =>
            hoursFor(people.manager).then((composition) =>
              composition.hoursDraft({
                sessionCookie: people.manager.sessionCookie,
                csrf: people.manager.csrf,
                command: {
                  expectedSetup: {
                    setupDraftReference: created.setupBasis.setupDraftReference,
                    sourceRevision: created.setupBasis.sourceRevision,
                    sourceSnapshotDigest: created.setupBasis.sourceSnapshotDigest,
                  },
                  setupOperationReference: reference(),
                  operationReference: reference(),
                  auditReference: reference(),
                  configurationReference: reference(),
                  expectedVersion: stuck.expectedVersion,
                  weeklySchedule: stuck.current.weeklySchedule,
                  exceptions: stuck.current.exceptions,
                  effectiveFrom: stuck.observedAt,
                },
              }),
            ),
          isCode("STORE_CONFIGURATION_LIFECYCLE_CONFLICT"),
        );
        // The Store Manager's ordinary change: saved, checked and sent; the Owner approves and
        // publishes it (two people).
        assert.equal((await ordinaryHours(people.manager, 600)).status, "Applied");
        read = await (await hoursFor(people.manager)).read(people.manager.sessionCookie);
        assert.equal(read.latest.supersedesConfigurationReference, created.configurationReference);
        assert.equal(read.latest.setupBasis, undefined);
        assert.equal(read.latestWithdrawal, null);
        await act(people.manager, "Validate");
        await act(people.manager, "Submit");
        // v15 D3/D9: the Owner, reading the Store Manager's change, may decline it; the Store
        // Manager, reading the Owner's change below, may not.
        read = await (await hoursFor(people.owner)).read(people.owner.sessionCookie);
        assert.equal(read.viewerMayDecline, true);
        await act(people.owner, "Approve");
        await act(people.owner, "Publish");
        read = await (await hoursFor(people.owner)).read(people.owner.sessionCookie);
        assert.equal(read.current.authoredByReference, people.manager.actor);
        assert.equal(read.current.weeklySchedule[0].intervals[0].orderCutoffSeconds, 600);
        // The Owner's own ordinary change, approved alone as sole operator and published.
        const ownerWithdrawn = await (async () => {
          // Another withdrawn change from Store setup first (the v15 shape again).
          await publishStep(people.owner, "Materialize", {
            setupSelector: {
              setupDraftReference: revision1.setupDraftReference,
              sourceRevision: revision1.revision,
              sourceSnapshotDigest: digest(revision1),
            },
            reasonCode: "STORE_SETUP_PUBLICATION",
          }).then(
            () => assert.fail("the setup was saved on an older configuration"),
            (error) => assert.match(String(error?.code ?? error?.message), /OUTDATED|CONFLICT/u),
          );
          return null;
        })();
        assert.equal(ownerWithdrawn, null);
        // Recreate the v15 shape on the current published V1 configuration: the Owner saves the
        // setup again (it builds on the latest configuration), creates and withdraws it.
        const latestNow = read.current;
        revision1 = await setupSave(
          { ...setupContent, effectiveFrom: configured(now()) },
          revision1,
          latestNow.configurationReference,
        );
        await publishStep(people.owner, "Materialize", {
          setupSelector: {
            setupDraftReference: revision1.setupDraftReference,
            sourceRevision: revision1.revision,
            sourceSnapshotDigest: digest(revision1),
          },
          reasonCode: "STORE_SETUP_PUBLICATION",
        });
        const createdAgain = (await (await hoursFor(people.owner)).read(people.owner.sessionCookie))
          .latest;
        assert.notEqual(createdAgain.setupBasis, undefined);
        await createMerchantStoreConfigurationWithdrawal({
          persistence: people.owner.persistence,
          authentication: people.owner.authentication,
        })({
          sessionCookie: people.owner.sessionCookie,
          csrf: people.owner.csrf,
          command: {
            configurationReference: createdAgain.configurationReference,
            configurationVersion: createdAgain.configurationVersion,
            auditReference: reference(),
          },
        });
        assert.equal((await ordinaryHours(people.owner, 300)).status, "Applied");
        // The Store Manager sees the Owner's open change by the Owner's Store name, and is not
        // offered to decline it.
        read = await (await hoursFor(people.manager)).read(people.manager.sessionCookie);
        assert.equal(read.latestAuthorName, "Test Owner");
        assert.equal(read.viewerMayDecline, false);
        await act(people.owner, "Validate");
        await act(people.owner, "Submit");
        await soleOperator("On");
        const revoked = await revokeSecondOwnerApproval();
        await verifyOwner();
        read = await (await hoursFor(people.owner)).read(people.owner.sessionCookie);
        assert.equal(read.soleOperator.status, "Effective");
        assert.equal((await act(people.owner, "Approve", "SoleOperator")).status, "Applied");
        await act(people.owner, "Publish");
        read = await (await hoursFor(people.owner)).read(people.owner.sessionCookie);
        assert.equal(read.current.authoredByReference, people.owner.actor);
        assert.equal(read.current.approvedByReference, people.owner.actor);
        assert.equal(read.current.weeklySchedule[0].intervals[0].orderCutoffSeconds, 300);
        const running = await transactions.run((tx) =>
          readPublishedStoreConfiguration(operating, tx, now(), async () => true),
        );
        assert.equal(
          running.configuration.configurationReference,
          read.current.configurationReference,
        );
        await soleOperator("Off");
        await restoreSecondOwnerApproval(revoked);
        // The setup is saved again on the configuration now published, for the journey below.
        revision1 = await setupSave(
          { ...setupContent, effectiveFrom: configured(now()) },
          revision1,
          read.current.configurationReference,
        );
      }
      await publishStep(people.owner, "Materialize", {
        setupSelector: {
          setupDraftReference: revision1.setupDraftReference,
          sourceRevision: revision1.revision,
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
      assert.equal(view.current.setupBasis.sourceRevision, revision1.revision);
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
      assert.equal(revisions.rows.length, revision1.revision + 1);
      const revision2 = revisions.rows[revision1.revision];
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
      assert.equal(afterSave.latest.setupBasis.sourceRevision, revision1.revision + 1);
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
        revision1.revision + 1,
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

      // --- WP-2423 v15: the Owner's own hours change on the configuration from Store setup (an
      // hours-only Store setup revision): the Store Manager cannot check or send it; the Owner
      // approves it alone as an in-effect, verified sole operator and publishes it.
      const ownerHoursCommand = {
        expectedSetup: {
          setupDraftReference: final.current.setupBasis.setupDraftReference,
          sourceRevision: final.current.setupBasis.sourceRevision,
          sourceSnapshotDigest: final.current.setupBasis.sourceSnapshotDigest,
        },
        setupOperationReference: reference(),
        operationReference: reference(),
        auditReference: reference(),
        configurationReference: reference(),
        expectedVersion: final.expectedVersion,
        weeklySchedule: newHours.map((day) => ({
          ...day,
          intervals: day.intervals.map((i) => ({ ...i, endLocalTime: "21:00:00" })),
        })),
        exceptions: newExceptions,
        effectiveFrom: final.observedAt,
      };
      assert.equal((await saveHours(people.owner, ownerHoursCommand)).status, "Applied");
      for (const command of ["Validate", "Submit"])
        await refusedUnchanged(
          () => act(people.manager, command),
          isCode("STORE_CONFIGURATION_NOT_YOUR_CHANGE"),
        );
      await act(people.owner, "Validate");
      await act(people.owner, "Submit");
      await refusedUnchanged(
        () => act(people.owner, "Approve"),
        isCode("STORE_CONFIGURATION_SELF_APPROVAL"),
      );
      await soleOperator("On");
      const revokedAgain = await revokeSecondOwnerApproval();
      await verifyOwner();
      const ownerApproved = await act(people.owner, "Approve", "SoleOperator");
      assert.equal(ownerApproved.status, "Applied");
      await act(people.owner, "Publish");
      const afterOwn = await (await hoursFor(people.owner)).read(people.owner.sessionCookie);
      assert.equal(afterOwn.current.approvedByReference, people.owner.actor);
      assert.equal(afterOwn.current.authoredByReference, people.owner.actor);
      assert.notEqual(afterOwn.current.setupBasis, undefined);
      assert.deepEqual(afterOwn.current.weeklySchedule, ownerHoursCommand.weeklySchedule);
      assert.equal(
        (
          await admin.query(
            "SELECT count(*)::int n FROM rms_store.store_configuration_sole_operator_approval WHERE configuration_id=$1",
            [afterOwn.current.configurationReference],
          )
        ).rows[0].n,
        1,
      );
      const runningOwn = await transactions.run((tx) =>
        readPublishedStoreConfiguration(operating, tx, now(), async () => true),
      );
      assert.equal(
        runningOwn.configuration.configurationReference,
        afterOwn.current.configurationReference,
      );
      await soleOperator("Off");
      await restoreSecondOwnerApproval(revokedAgain);

      // --- v15 (`8bd902e3` D2), published from Store setup: a withdrawn hours-only change does
      // not block the next hours change; the browser continues from the latest setup revision (it
      // changed nothing but hours) and the new change replaces its hours.
      {
        const withdrawFor = (person, latest) =>
          createMerchantStoreConfigurationWithdrawal({
            persistence: person.persistence,
            authentication: person.authentication,
          })({
            sessionCookie: person.sessionCookie,
            csrf: person.csrf,
            command: {
              configurationReference: latest.configurationReference,
              configurationVersion: latest.configurationVersion,
              auditReference: reference(),
            },
          });
        const hoursOn = (v, closing) => ({
          expectedSetup: {
            setupDraftReference: (v.latest ?? v.current).setupBasis.setupDraftReference,
            sourceRevision: (v.latest ?? v.current).setupBasis.sourceRevision,
            sourceSnapshotDigest: (v.latest ?? v.current).setupBasis.sourceSnapshotDigest,
          },
          setupOperationReference: reference(),
          operationReference: reference(),
          auditReference: reference(),
          configurationReference: reference(),
          expectedVersion: v.expectedVersion,
          weeklySchedule: newHours.map((day) => ({
            ...day,
            intervals: day.intervals.map((i) => ({ ...i, endLocalTime: closing })),
          })),
          exceptions: newExceptions,
          effectiveFrom: v.observedAt,
        });
        let v = await managerHours.read(people.manager.sessionCookie);
        assert.equal((await saveHours(people.manager, hoursOn(v, "19:00:00"))).status, "Applied");
        v = await managerHours.read(people.manager.sessionCookie);
        const first = v.latest;
        assert.deepEqual(await withdrawFor(people.manager, first), {
          status: "Applied",
          kind: "Withdrawn",
        });
        v = await managerHours.read(people.manager.sessionCookie);
        assert.equal(v.latestWithdrawal.kind, "Withdrawn");
        assert.equal((await saveHours(people.manager, hoursOn(v, "18:00:00"))).status, "Applied");
        v = await managerHours.read(people.manager.sessionCookie);
        assert.equal(v.latestWithdrawal, null);
        assert.equal(v.latest.supersedesConfigurationReference, first.configurationReference);
        assert.equal(v.latest.weeklySchedule[0].intervals[0].endLocalTime, "18:00:00");
        for (const field of ["taxConfigurationReference", "addressReference", "receiptReference"])
          assert.equal(v.latest[field], v.current[field], field);
        assert.equal((await withdrawFor(people.manager, v.latest)).status, "Applied");
      }
      const latestRevision = (
        await admin.query(
          "SELECT revision,snapshot_json FROM rms_store.store_setup_draft_revision WHERE store_id=$1 ORDER BY revision DESC LIMIT 1",
          [scope.storeReference],
        )
      ).rows[0];

      // --- Store setup changes the Owner has not published block an hours change.
      const revision3 = await setupSave(
        { ...latestRevision.snapshot_json.content, contactReference: configured(id(0x300)) },
        latestRevision.snapshot_json,
        afterOwn.current.configurationReference,
      );
      assert.equal(revision3.revision, Number(latestRevision.revision) + 1);
      const blockedView = await managerHours.read(people.manager.sessionCookie);
      await assert.rejects(
        saveHours(people.manager, {
          ...hoursCommand,
          expectedSetup: {
            setupDraftReference: afterOwn.current.setupBasis.setupDraftReference,
            sourceRevision: afterOwn.current.setupBasis.sourceRevision,
            sourceSnapshotDigest: afterOwn.current.setupBasis.sourceSnapshotDigest,
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
      // v15 (`8bd902e3` D2): the Owner creates a configuration from that setup and withdraws it.
      // The withdrawn change carries Store setup changes beyond hours: an hours change neither
      // continues from it nor carries them (they stay the Owner's to finish in Store setup).
      {
        const recorded = (await managerHours.read(people.manager.sessionCookie)).latest;
        const revision4 = await setupSave(
          { ...revision3.content, effectiveFrom: configured(now()) },
          revision3,
          recorded.configurationReference,
        );
        await publishStep(people.owner, "Materialize", {
          setupSelector: {
            setupDraftReference: revision4.setupDraftReference,
            sourceRevision: revision4.revision,
            sourceSnapshotDigest: digest(revision4),
          },
          reasonCode: "STORE_SETUP_PUBLICATION",
        });
        const created = (await managerHours.read(people.manager.sessionCookie)).latest;
        assert.equal(created.setupBasis.sourceRevision, revision4.revision);
        const withdrawn = await createMerchantStoreConfigurationWithdrawal({
          persistence: people.owner.persistence,
          authentication: people.owner.authentication,
        })({
          sessionCookie: people.owner.sessionCookie,
          csrf: people.owner.csrf,
          command: {
            configurationReference: created.configurationReference,
            configurationVersion: created.configurationVersion,
            auditReference: reference(),
          },
        });
        assert.equal(withdrawn.status, "Applied");
        const v = await managerHours.read(people.manager.sessionCookie);
        await refusedUnchanged(
          () =>
            saveHours(people.manager, {
              ...hoursCommand,
              expectedSetup: {
                setupDraftReference: created.setupBasis.setupDraftReference,
                sourceRevision: created.setupBasis.sourceRevision,
                sourceSnapshotDigest: created.setupBasis.sourceSnapshotDigest,
              },
              setupOperationReference: reference(),
              operationReference: reference(),
              auditReference: reference(),
              configurationReference: reference(),
              expectedVersion: v.expectedVersion,
              effectiveFrom: v.observedAt,
            }),
          (error) => error?.code === "STORE_SETUP_OPERATION_UNPUBLISHED_CHANGES",
        );
      }

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
