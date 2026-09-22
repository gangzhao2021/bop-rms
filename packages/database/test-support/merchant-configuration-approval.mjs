import assert from "node:assert/strict";
import { createMerchantRuntime } from "../../../apps/api/src/merchant-runtime.ts";
import { createMerchantStoreScope } from "../../../apps/api/src/merchant-store-scope.ts";
import {
  createPostgresStoreConfigurationAdministration,
  createStoreConfigurationVersion,
} from "../../rms/store/src/index.ts";
import { appendAuditRecordInTransaction } from "../../bop/audit/src/index.ts";
import * as f from "../../bop/permission/src/tests/current-policy.fixture.ts";
/** Other author's pending draft is synthetic owner setup. Approver uses real
 * issued session/current policy and all actual review/Publishing/Store writers.
 */
export async function verifyMerchantConfigurationApproval({
  admin,
  role,
  options,
  cookie,
  csrf,
  commandOptions,
  previous,
  baseline,
}) {
  const draft = createStoreConfigurationVersion({
    ...previous,
    configurationReference: f.uuid("4030"),
    configurationVersion: 4,
    supersedesConfigurationReference: previous.configurationReference,
    authoredByReference: f.uuid("4031"),
  });
  const pending = createStoreConfigurationVersion({ ...draft, lifecycle: "PendingApproval" });
  let seedReference = 4500;
  const seedPending = async (seedDraft) =>
    options.transactions.run(async (tx) => {
      const scope = await createMerchantStoreScope(options)(tx, cookie, "store.service.read");
      const configured = commandOptions.configure(tx, scope);
      const setup = createPostgresStoreConfigurationAdministration({
        ...configured,
        brandReference: f.BRAND,
        storeReference: f.STORE,
        run: async (work) => work(tx),
        ports: () => ({
          ...configured.ports(tx),
          authorization: { authorize: async () => true },
          approval: { validate: async () => false },
          publishing: { validate: async () => false },
          liveGate: { validate: async () => false },
        }),
        materializePublication: async () => {
          throw new Error("Synthetic setup never publishes");
        },
      });
      const raw = {
        actorReference: seedDraft.authoredByReference,
        purposeCode: "STORE_CONFIGURATION",
        occurredAt: options.now(),
        configuration: seedDraft,
        operationReference: f.uuid(String(seedReference++)),
        auditReference: f.uuid(String(seedReference++)),
        expectedVersion: seedDraft.configurationVersion - 1,
      };
      await setup.saveDraft(raw);
      await setup.submit({
        ...raw,
        configuration: createStoreConfigurationVersion({
          ...seedDraft,
          lifecycle: "PendingApproval",
        }),
        operationReference: f.uuid(String(seedReference++)),
        auditReference: f.uuid(String(seedReference++)),
        expectedVersion: seedDraft.configurationVersion,
      });
    });
  await seedPending(draft);
  await admin.query(
    "GRANT SELECT,INSERT,UPDATE ON rms_store.store_configuration_review_snapshot TO " + role,
  );
  await admin.query("GRANT INSERT ON bop_publishing.publishing_mutation_record TO " + role);
  const permissions = [
    "store.service.approve",
    "publishing.draft.create",
    "publishing.review.submit",
    "publishing.review.approve",
  ];
  for (let i = 0; i < permissions.length; i++) {
    await admin.query(
      "INSERT INTO bop_permission.permission_definition VALUES ($1,$2,'Active',1,$3,$3)",
      [f.uuid(String(4200 + i * 2)), permissions[i], f.FROM],
    );
    if (i < 3)
      await admin.query(
        "INSERT INTO bop_permission.permission_grant VALUES ($1,$2,$3,$4,$5,'Active',$6,$7,1,$6,$6)",
        [
          f.uuid(String(4201 + i * 2)),
          f.STORE_ROLE,
          f.uuid(String(4200 + i * 2)),
          f.BRAND,
          f.STORE,
          f.FROM,
          f.UNTIL,
        ],
      );
  }
  let allocated = 4300;
  let publicationAuditFailure = false;
  let publicationAuditAttempts = 0;
  const configurationOptions = {
    actionPermissions: commandOptions.actionPermissions,
    configure: (tx, scope) => ({
      ...commandOptions.configure(tx, scope),
      nextReference: () => f.uuid(String(allocated++)),
      appendAudit: async (transaction, input) => {
        if (publicationAuditFailure && input.operation.configuration.lifecycle === "Published") {
          publicationAuditAttempts++;
          throw new Error("SYNTHETIC_PUBLICATION_AUDIT_FAILURE");
        }
        return commandOptions.configure(tx, scope).appendAudit(transaction, input);
      },
    }),
    review: {
      validate: async () => ({
        validUntil: f.UNTIL,
        checkCodes: ["SYNTHETIC_REFERENCE_VALIDATION"],
        liveGateEvidenceReference: baseline.liveGateEvidenceReference,
      }),
      snapshotAudit: async (tx, input) =>
        appendAuditRecordInTransaction(tx, {
          auditId: input.auditReference,
          brandId: f.BRAND,
          storeId: f.STORE,
          actor: { type: "User", reference: input.actorReference },
          actionCode: "STORE_CONFIGURATION_CHANGED",
          targetType: "StoreConfiguration",
          targetId: input.reviewedPublication.configurationReference,
          correlationId: input.lifecycleReference,
          reasonCode: "SYNTHETIC_REVIEW",
          occurredAt: input.recordedAt,
          sourceChannel: "MERCHANT_WEB",
          dataClassification: "Internal",
          retentionPolicyCode: "STORE_CONFIGURATION_AUDIT",
          retentionPolicyVersion: 1,
        }),
    },
  };
  const runtime = (exactOrigin, acceptedHost) =>
    createMerchantRuntime({
      persistence: options,
      exactOrigin,
      acceptedHost,
      serviceAudit: {
        reasonCode: "SYNTHETIC_SERVICE_CONTROL",
        retentionPolicyCode: "STORE_SERVICE_AUDIT",
        retentionPolicyVersion: 1,
      },
      configuration: configurationOptions,
    });
  const command = runtime("https://merchant.invalid", "merchant.invalid").storeConfiguration;
  const request = {
    sessionCookie: cookie,
    csrf,
    command: {
      command: "Approve",
      configuration: pending,
      operationReference: f.uuid("4041"),
      auditReference: f.uuid("4042"),
      expectedVersion: 4,
    },
  };
  await assert.rejects(command(request), { code: "PUBLISHING_PERMISSION_DENIED" });
  assert.equal(
    (
      await admin.query(
        "SELECT * FROM rms_store.store_configuration_review_snapshot WHERE brand_id=$1 AND store_id=$2 AND configuration_id=$3",
        [f.BRAND, f.STORE, draft.configurationReference],
      )
    ).rowCount,
    0,
  );
  assert.equal((await command.read(cookie)).latest.lifecycle, "PendingApproval");
  await admin.query(
    "INSERT INTO bop_permission.permission_grant VALUES ($1,$2,$3,$4,$5,'Active',$6,$7,1,$6,$6)",
    [f.uuid("4207"), f.STORE_ROLE, f.uuid("4206"), f.BRAND, f.STORE, f.FROM, f.UNTIL],
  );
  assert.deepEqual(await command(request), { status: "Applied", resultingVersion: 4 });
  const count = allocated;
  assert.deepEqual(await command(request), { status: "AlreadyApplied", resultingVersion: 4 });
  assert.equal(allocated, count);
  const state = await command.read(cookie);
  assert.equal(state.latest.lifecycle, "Approved");
  assert.equal(state.latest.authoredByReference, draft.authoredByReference);
  assert.equal(state.latest.approvedByReference, f.ACTOR);
  assert.equal(state.current.configurationReference, baseline.configurationReference);
  assert.equal(
    (
      await admin.query("SELECT * FROM platform_audit.audit_record WHERE audit_id=$1", [
        f.uuid("4042"),
      ])
    ).rowCount,
    1,
  );
  return Object.assign(command, {
    runtime,
    verifyPublication: async (publishThroughBrowser) => {
      const approved = (await command.read(cookie)).latest;
      assert.equal(approved.lifecycle, "Approved");
      for (const [number, permission] of [
        [4210, "store.service.publish"],
        [4212, "publishing.release.publish"],
      ]) {
        await admin.query(
          "INSERT INTO bop_permission.permission_definition VALUES ($1,$2,'Active',1,$3,$3)",
          [f.uuid(String(number)), permission, f.FROM],
        );
      }
      const grant = async (number) =>
        admin.query(
          "INSERT INTO bop_permission.permission_grant VALUES ($1,$2,$3,$4,$5,'Active',$6,$7,1,$6,$6)",
          [
            f.uuid(String(number + 1)),
            f.STORE_ROLE,
            f.uuid(String(number)),
            f.BRAND,
            f.STORE,
            f.FROM,
            f.UNTIL,
          ],
        );
      await grant(4210);
      await admin.query(
        "GRANT INSERT ON rms_store.store_configuration_version,rms_store.store_weekly_service_period,rms_store.store_service_exception,rms_store.store_service_exception_content,rms_store.store_service_exception_interval,rms_store.store_configuration_publication_content TO " +
          role,
      );
      let publish = {
        sessionCookie: cookie,
        csrf,
        command: {
          command: "Publish",
          configuration: approved,
          operationReference: f.uuid("4051"),
          auditReference: f.uuid("4052"),
          expectedVersion: approved.configurationVersion,
        },
      };
      await assert.rejects(command(publish), { code: "PUBLISHING_PERMISSION_DENIED" });
      await grant(4212);
      publicationAuditFailure = true;
      await assert.rejects(command(publish), {
        code: "STORE_CONFIGURATION_DEPENDENCY_UNAVAILABLE",
      });
      assert.equal(publicationAuditAttempts, 1);
      publicationAuditFailure = false;
      assert.equal((await command.read(cookie)).latest.lifecycle, "Approved");
      assert.equal(
        (
          await admin.query(
            "SELECT * FROM rms_store.store_configuration_version WHERE configuration_id=$1",
            [approved.configurationReference],
          )
        ).rowCount,
        0,
      );
      if (publishThroughBrowser) {
        publish = { ...publish, command: await publishThroughBrowser() };
      } else {
        assert.deepEqual(await command(publish), {
          status: "Applied",
          resultingVersion: approved.configurationVersion,
        });
      }
      const afterAllocation = allocated;
      assert.deepEqual(await command(publish), {
        status: "AlreadyApplied",
        resultingVersion: approved.configurationVersion,
      });
      assert.equal(allocated, afterAllocation);
      const published = await command.read(cookie);
      assert.equal(published.latest.lifecycle, "Published");
      assert.equal(published.current.configurationReference, approved.configurationReference);
      assert.equal(
        (
          await admin.query("SELECT * FROM platform_audit.audit_record WHERE audit_id=$1", [
            publish.command.auditReference,
          ])
        ).rowCount,
        1,
      );
    },
    prepareBrowserApproval: async () => {
      const latest = (await command.read(cookie)).latest;
      const browserDraft = createStoreConfigurationVersion({
        ...latest,
        configurationReference: f.uuid(String(seedReference++)),
        configurationVersion: latest.configurationVersion + 1,
        supersedesConfigurationReference: latest.configurationReference,
        lifecycle: "Draft",
        authoredByReference: draft.authoredByReference,
        approvedByReference: null,
        approvalEvidenceReference: null,
        publicationReference: null,
        liveGateEvidenceReference: null,
        createdAt: options.now(),
        updatedAt: options.now(),
      });
      await seedPending(browserDraft);
      return (await command.read(cookie)).latest;
    },
  });
}
