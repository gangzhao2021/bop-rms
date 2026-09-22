import { createPublishedReceiptTemplateSource } from "../../../apps/api/src/published-receipt-template-source.ts";
import { exerciseReceiptTemplate } from "./receipt-template.mjs";
import { verifyMerchantConfigurationApproval } from "./merchant-configuration-approval.mjs";
import { verifyMerchantConfigurationHttp } from "./merchant-configuration-http.mjs";
import assert from "node:assert/strict";
import { createMerchantStoreConfiguration } from "../../../apps/api/src/merchant-store-configuration.ts";
import {
  createPostgresCurrentStorePublicationProof,
  createPostgresStoreReceiptConfigurationSource,
  createPostgresStoreBusinessDateSource,
  createPostgresStoreConfigurationAuthoringSource,
  createStoreConfigurationVersion,
} from "../../rms/store/src/index.ts";
import {
  appendAuditRecordInTransaction,
  canonicalizeRfc8785,
  sha256Hex,
} from "../../bop/audit/src/index.ts";
import * as f from "../../bop/permission/src/tests/current-policy.fixture.ts";

/** Real persisted session/policy/authoring/Audit. Reference checks are synthetic. */
export async function verifyMerchantConfigurationCommand({
  admin,
  role,
  options,
  service,
  cookie,
  csrf,
}) {
  const hashContent = (value) => "sha256:" + sha256Hex(canonicalizeRfc8785(value));
  const current = async (tx) => {
    let selected;
    const source = createPostgresStoreBusinessDateSource({
      brandReference: f.BRAND,
      storeReference: f.STORE,
      timeZone: "America/Toronto",
      authorize: async () => true,
      publicationProof: async (transaction, candidate, at) => {
        const proof = await createPostgresCurrentStorePublicationProof({
          ...options.publication,
          tenantReference: f.uuid("90"),
          brandReference: f.BRAND,
          storeReference: f.STORE,
          configurationReference: candidate.configurationReference,
          authorize: async () => true,
          hashContent,
        })(transaction, at);
        selected = proof.configuration;
        return proof;
      },
    });
    await source(tx, options.now());
    assert.ok(selected);
    return selected;
  };
  const baseline = await options.transactions.run(current);
  const receiptBinding = await options.transactions.run((tx) =>
    createPostgresStoreReceiptConfigurationSource({
      ...options.publication,
      tenantReference: f.uuid("90"),
      brandReference: f.BRAND,
      storeReference: f.STORE,
      timeZone: "America/Toronto",
      authorize: async () => true,
      hashContent,
    })(tx, options.now()),
  );
  assert.equal(receiptBinding.configurationReference, baseline.configurationReference);
  assert.equal(receiptBinding.templateReference, baseline.receiptReference);
  assert.equal(receiptBinding.locale, baseline.defaultLocale);
  assert.equal(receiptBinding.currencyCode, baseline.currencyCode);
  assert.equal(receiptBinding.contentDigest, hashContent(baseline));
  const templateFixture = await exerciseReceiptTemplate({
    admin,
    runner: options.transactions,
    role,
    scope: { brandReference: f.BRAND, storeReference: f.STORE },
    at: options.now(),
    templateReference: baseline.receiptReference,
    tenantReference: f.uuid("90"),
  });
  const templateSource = createPublishedReceiptTemplateSource({
    store: {
      ...options.publication,
      tenantReference: f.uuid("90"),
      brandReference: f.BRAND,
      storeReference: f.STORE,
      timeZone: "America/Toronto",
      authorize: async () => true,
      hashContent,
    },
    templatePublication: {
      ...templateFixture.publicationOptions,
      templateReference: templateFixture.templateReference,
    },
    authorize: async () => true,
  });
  const receiptRequest = {
    brandReference: f.BRAND,
    storeReference: f.STORE,
    orderReference: f.uuid("9000"),
    receiptReference: f.uuid("9001"),
    observedAt: options.now(),
    freshAfter: options.now(),
    currencyCode: baseline.currencyCode,
  };
  const selectedTemplate = await options.transactions.run((tx) =>
    templateSource(tx, receiptRequest),
  );
  assert.equal(selectedTemplate.template.version, "RECEIPT_V1");
  assert.equal(selectedTemplate.template.locale, baseline.defaultLocale);
  await assert.rejects(
    options.transactions.run((tx) =>
      templateSource(tx, { ...receiptRequest, currencyCode: "USD" }),
    ),
    { code: "DIGITAL_RECEIPT_DEPENDENCY_UNAVAILABLE" },
  );

  let readAllowed = true;
  const readAuthoring = createPostgresStoreConfigurationAuthoringSource({
    brandReference: f.BRAND,
    storeReference: f.STORE,
    authorize: async () => readAllowed,
  });
  await admin.query(
    "GRANT SELECT,UPDATE ON rms_store.store_configuration_authoring_operation TO " + role,
  );
  assert.equal(await options.transactions.run((tx) => readAuthoring(tx, options.now())), null);

  let auditFailure = false;
  const commandOptions = {
    persistence: options,
    authentication: service,
    actionPermissions: {
      saveDraft: "store.service.save-draft",
      validate: "store.service.validate",
      submit: "store.service.submit",
      approve: "store.service.approve",
      publish: "store.service.publish",
    },
    configure: (_tx, scope) => ({
      publication: {
        ...options.publication,
        tenantReference: scope.selected.tenantReference,
        publishingFamilyReference: f.uuid("1070"),
        hashContent,
        authorize: scope.allowed,
      },
      ports: () => ({
        authorization: { authorize: scope.allowed },
        references: {
          hashIntent: (text) => "sha256:" + sha256Hex(text),
          equals: (a, b) => a === b,
          validateControlledReferences: async () => true,
          validateBrandBaseCompatibility: async () => true,
        },
      }),
      approvalSnapshot: async () => null,
      publishedBaseline: current,
      businessDayStartSource: "StoreOverride",
      nextReference: () => {
        throw new Error("No publication in draft scenario");
      },
      appendAudit: async (tx, input) => {
        await appendAuditRecordInTransaction(tx, {
          auditId: input.audit.auditReference,
          brandId: f.BRAND,
          storeId: f.STORE,
          actor: { type: "User", reference: input.audit.actorReference },
          actionCode: "STORE_CONFIGURATION_CHANGED",
          targetType: "StoreConfiguration",
          targetId: input.operation.configuration.configurationReference,
          correlationId: input.operation.operationReference,
          reasonCode: "SYNTHETIC_CONFIGURATION",
          occurredAt: input.audit.occurredAt,
          sourceChannel: "MERCHANT_WEB",
          dataClassification: "Internal",
          retentionPolicyCode: "STORE_CONFIGURATION_AUDIT",
          retentionPolicyVersion: 1,
        });
        if (auditFailure) throw new Error("Synthetic Audit failure");
      },
    }),
  };
  const command = createMerchantStoreConfiguration(commandOptions);
  const draft = createStoreConfigurationVersion({
    ...baseline,
    configurationReference: f.uuid("4010"),
    configurationVersion: 2,
    supersedesConfigurationReference: baseline.configurationReference,
    lifecycle: "Draft",
    authoredByReference: f.ACTOR,
    approvedByReference: null,
    approvalEvidenceReference: null,
    publicationReference: null,
    liveGateEvidenceReference: null,
    updatedAt: options.now(),
  });
  const input = {
    sessionCookie: cookie,
    csrf,
    command: {
      command: "SaveDraft",
      operationReference: f.uuid("4011"),
      auditReference: f.uuid("4012"),
      expectedVersion: 1,
      configuration: draft,
    },
  };
  await admin.query(
    "INSERT INTO bop_permission.permission_definition VALUES ($1,'store.service.save-draft','Active',1,$2,$2)",
    [f.uuid("4000"), f.FROM],
  );
  await assert.rejects(command(input), /STORE_CONFIGURATION_PERMISSION_DENIED/u);
  await admin.query(
    "INSERT INTO bop_permission.permission_grant VALUES ($1,$2,$3,$4,$5,'Active',$6,$7,1,$6,$6)",
    [f.uuid("4001"), f.STORE_ROLE, f.uuid("4000"), f.BRAND, f.STORE, f.FROM, f.UNTIL],
  );
  await admin.query(
    "GRANT SELECT,INSERT,UPDATE ON rms_store.store_configuration_authoring_operation TO " + role,
  );

  for (const [code, n] of [
    ["store.service.validate", 4004],
    ["store.service.submit", 4006],
  ]) {
    await admin.query(
      "INSERT INTO bop_permission.permission_definition VALUES ($1,$2,'Active',1,$3,$3)",
      [f.uuid(String(n)), code, f.FROM],
    );
    await admin.query(
      "INSERT INTO bop_permission.permission_grant VALUES ($1,$2,$3,$4,$5,'Active',$6,$7,1,$6,$6)",
      [f.uuid(String(n + 1)), f.STORE_ROLE, f.uuid(String(n)), f.BRAND, f.STORE, f.FROM, f.UNTIL],
    );
  }
  await assert.rejects(command({ ...input, csrf: "invalid" }));
  await assert.rejects(
    command({ ...input, command: { ...input.command, actorReference: f.ACTOR } }),
    /STORE_CONFIGURATION_COMMAND_INVALID/u,
  );
  await assert.rejects(
    command({
      ...input,
      command: { ...input.command, configuration: { ...draft, storeReference: f.uuid("610") } },
    }),
    /STORE_CONFIGURATION_COMMAND_INVALID/u,
  );
  auditFailure = true;
  await assert.rejects(command(input), { code: "STORE_CONFIGURATION_DEPENDENCY_UNAVAILABLE" });
  assert.equal(
    (
      await admin.query(
        "SELECT * FROM rms_store.store_configuration_authoring_operation WHERE operation_id=$1",
        [f.uuid("4011")],
      )
    ).rowCount,
    0,
  );
  assert.equal(
    (
      await admin.query("SELECT * FROM platform_audit.audit_record WHERE audit_id=$1", [
        f.uuid("4012"),
      ])
    ).rowCount,
    0,
  );
  auditFailure = false;
  assert.deepEqual(await command(input), { status: "Applied", resultingVersion: 2 });
  assert.deepEqual(await command(input), { status: "AlreadyApplied", resultingVersion: 2 });
  const persisted = await admin.query(
    "SELECT actor_reference,purpose_code,configuration_json FROM rms_store.store_configuration_authoring_operation WHERE operation_id=$1",
    [f.uuid("4011")],
  );
  assert.equal(persisted.rows[0].actor_reference, f.ACTOR);
  assert.equal(persisted.rows[0].purpose_code, "STORE_CONFIGURATION");
  assert.deepEqual(persisted.rows[0].configuration_json, draft);
  await assert.rejects(
    command({
      ...input,
      command: { ...input.command, configuration: { ...draft, reasonCode: "CHANGED" } },
    }),
    { code: "STORE_CONFIGURATION_IDEMPOTENCY_CONFLICT" },
  );
  const httpConfiguration = createStoreConfigurationVersion({
    ...draft,
    configurationReference: f.uuid("4020"),
    configurationVersion: 3,
    supersedesConfigurationReference: draft.configurationReference,
  });
  await verifyMerchantConfigurationHttp({
    service,
    command,
    input: {
      ...input,
      command: {
        ...input.command,
        operationReference: f.uuid("4021"),
        auditReference: f.uuid("4022"),
        expectedVersion: 2,
        configuration: httpConfiguration,
      },
    },
    assertPersisted: async () => {
      const rows = await admin.query(
        "SELECT actor_reference,configuration_json FROM rms_store.store_configuration_authoring_operation WHERE operation_id=$1",
        [f.uuid("4021")],
      );
      assert.equal(rows.rowCount, 1);
      assert.equal(rows.rows[0].actor_reference, f.ACTOR);
      assert.deepEqual(rows.rows[0].configuration_json, httpConfiguration);
      assert.equal(
        (
          await admin.query("SELECT * FROM platform_audit.audit_record WHERE audit_id=$1", [
            f.uuid("4022"),
          ])
        ).rowCount,
        1,
      );
    },
  });
  assert.deepEqual(
    await options.transactions.run((tx) => readAuthoring(tx, options.now())),
    httpConfiguration,
  );
  readAllowed = false;
  await assert.rejects(options.transactions.run((tx) => readAuthoring(tx, options.now())));
  readAllowed = true;
  await assert.rejects(options.transactions.run((tx) => readAuthoring(tx, f.FROM)));
  const other = createPostgresStoreConfigurationAuthoringSource({
    brandReference: f.BRAND,
    storeReference: f.uuid("610"),
    authorize: async () => true,
  });
  assert.equal(await options.transactions.run((tx) => other(tx, options.now())), null);
  return verifyMerchantConfigurationApproval({
    admin,
    role,
    options,
    cookie,
    csrf,
    commandOptions,
    previous: httpConfiguration,
    baseline,
  });
}
