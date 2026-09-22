import { prepareReceiptTemplatePublication } from "./receipt-template-publication.mjs";
import assert from "node:assert/strict";
import { canonicalizeRfc8785, sha256Hex } from "../../bop/audit/src/index.ts";
import {
  createPostgresDigitalReceiptTemplateStore,
  digitalReceiptRequiredFields,
} from "../../rms/printing-device/src/index.ts";
/** Actual Publishing/template persistence; approver and artifact validation facts are synthetic. */
export async function exerciseReceiptTemplate({
  admin,
  runner,
  role,
  scope,
  at,
  templateReference,
  tenantReference,
}) {
  const id = (n) => "0190ed12-0000-7000-8000-" + n.toString(16).padStart(12, "0");
  const version = {
    templateReference: templateReference ?? id(1),
    versionReference: id(2),
    versionNumber: 1,
    versionCode: "RECEIPT_V1",
    ...scope,
    locale: "en-CA",
    dataContractVersion: 1,
    renderEngineVersion: 1,
    outputProfile: "AccessibleDigitalReceipt",
    layoutDefinitionReference: id(3),
    complianceRuleReference: id(4),
    requiredFields: [...digitalReceiptRequiredFields],
    publicationReference: id(5),
    publishedAt: at,
    effectiveFrom: at,
    effectiveUntil: null,
  };
  const publicationDigest = "sha256:" + sha256Hex(canonicalizeRfc8785(version));
  const publication = await prepareReceiptTemplatePublication({
    admin,
    role,
    scope,
    version,
    digest: publicationDigest,
    tenantReference,
  });
  let allowed = true;
  const store = createPostgresDigitalReceiptTemplateStore({
    ...scope,
    authorize: async () => allowed,
    validatePublication: async (tx, candidate, digest) => {
      const proof = await publication.proof(tx, candidate, at);
      return proof !== null && proof.contentDigest === digest;
    },
    isCurrentPublication: async (tx, candidate, observedAt) =>
      (await publication.proof(tx, candidate, observedAt)) !== null,
  });
  await admin.query("GRANT USAGE ON SCHEMA rms_device TO " + role);
  await admin.query(
    "GRANT SELECT,INSERT ON rms_device.digital_receipt_template_version TO " + role,
  );
  const input = {
    version,
    operationReference: id(6),
    publicationDigest,
    audit: {
      auditId: id(7),
      brandId: scope.brandReference,
      storeId: scope.storeReference,
      actor: { type: "System" },
      actionCode: "RECEIPT_TEMPLATE_PUBLISH",
      targetType: "DigitalReceiptTemplate",
      targetId: version.versionReference,
      reasonCode: "SYNTHETIC_TEMPLATE_PUBLICATION",
      correlationId: id(6),
      occurredAt: at,
      sourceChannel: "MERCHANT_WEB",
      dataClassification: "Confidential",
      retentionPolicyCode: "AUDIT_DEFAULT",
      retentionPolicyVersion: 1,
    },
  };
  await assert.rejects(
    runner.run((tx) => store.appendPublished(tx, input)),
    { code: "RECEIPT_TEMPLATE_UNAVAILABLE" },
  );
  await publication.publish();
  await runner.run(async (tx) => {
    await assert.rejects(
      store.appendPublished(
        {
          query: (sql, values) => {
            if (sql.startsWith("INSERT INTO platform_audit.audit_record"))
              throw new Error("synthetic template Audit failpoint");
            return tx.query(sql, values);
          },
        },
        input,
      ),
      { code: "RECEIPT_TEMPLATE_UNAVAILABLE" },
    );
  });
  const count = () =>
    admin.query(
      "SELECT count(*)::int AS n FROM rms_device.digital_receipt_template_version WHERE brand_id=$1 AND store_id=$2",
      [scope.brandReference, scope.storeReference],
    );
  assert.equal(
    (await count()).rows[0].n,
    0,
    "caught Audit failure must roll back template insertion",
  );
  const results = await Promise.all([
    runner.run((tx) => store.appendPublished(tx, input)),
    runner.run((tx) => store.appendPublished(tx, input)),
  ]);
  assert.deepEqual(results.map((result) => result.status).sort(), ["Created", "Existing"]);
  assert.equal((await count()).rows[0].n, 1);
  await runner.run(async (tx) => {
    await tx.query("SELECT set_config('bop.brand_id',$1,true),set_config('bop.store_id',$2,true)", [
      id(98),
      id(99),
    ]);
    const hidden = await tx.query(
      "SELECT version_id FROM rms_device.digital_receipt_template_version WHERE version_id=$1",
      [version.versionReference],
    );
    assert.equal(hidden.rows.length, 0, "foreign scope must not read a retained template");
  });
  await assert.rejects(
    admin.query(
      "UPDATE rms_device.digital_receipt_template_version SET version_code=version_code WHERE version_id=$1",
      [version.versionReference],
    ),
    { code: "55000" },
  );
  assert.equal(
    (
      await admin.query(
        "DELETE FROM rms_device.digital_receipt_template_version WHERE version_id=$1",
        [version.versionReference],
      )
    ).rowCount,
    0,
  );
  assert.equal((await count()).rows[0].n, 1, "published version survives attempted history edits");

  const request = {
    templateReference: version.templateReference,
    locale: version.locale,
    observedAt: at,
  };
  assert.deepEqual(await runner.run((tx) => store.resolve(tx, request)), version);
  await runner.run(async (tx) => {
    await tx.query("SAVEPOINT archived_template_publication", []);
    try {
      await publication.archive(tx);
      await assert.rejects(store.resolve(tx, request), { code: "RECEIPT_TEMPLATE_UNAVAILABLE" });
    } finally {
      await tx.query("ROLLBACK TO SAVEPOINT archived_template_publication", []);
      await tx.query("RELEASE SAVEPOINT archived_template_publication", []);
    }
  });
  allowed = false;
  await assert.rejects(
    runner.run((tx) => store.resolve(tx, request)),
    { code: "RECEIPT_TEMPLATE_PERMISSION_DENIED" },
  );
  allowed = true;
  return Object.assign(
    async (tx) => {
      const current = await store.resolve(tx, request);
      return {
        template: { ...scope, locale: current.locale, version: current.versionCode },
        evidenceReference: current.versionReference,
        evidenceDigest: "sha256:" + sha256Hex(canonicalizeRfc8785(current)),
      };
    },
    { publicationOptions: publication.proofOptions, templateReference: version.templateReference },
  );
}
