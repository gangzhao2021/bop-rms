import assert from "node:assert/strict";
import { createMerchantProductPublicationCommand } from "../../../apps/api/src/merchant-product-publication-command.ts";
import { createPersistentMerchantBffService } from "../../../apps/api/src/persistent-merchant-bff.ts";
import { withProductPublicationHttp } from "../../../apps/api/test-support/product-publication-http.mjs";
import { createPublicationNativeHttpClient } from "./product-publication-client-http.mjs";
import { CatalogError, productPublicationCheckCodes } from "../../rms/catalog/src/index.ts";
import { canonicalizeRfc8785, sha256Hex } from "../../bop/audit/src/index.ts";
import { currentProductPolicyFields } from "../../../apps/api/src/current-product-publication-policy.ts";

// Actual current Publishing policy/native IAM/BFF HTTP/SQL/journal.
// Remaining validation/topology/current approval qualification/full fields/Phase/write policy remain synthetic.
export async function exerciseCurrentScopePolicyHttp({
  admin,
  role,
  id,
  sessions,
  scope,
  product,
  at,
  from,
  until,
  policy,
  command,
  state,
  counts,
}) {
  assert.match(role, /^wp2421_approval_[a-f0-9]+$/);
  const hash = (value) => "sha256:" + sha256Hex(canonicalizeRfc8785(value));
  let clock = at,
    mode = "normal",
    allowed = true,
    holds = 0,
    tentative = false;
  let permission = (
    await admin.query(
      "SELECT permission_id FROM bop_permission.permission_definition WHERE action_code='catalog.product.publish'",
    )
  ).rows[0]?.permission_id;
  if (!permission) {
    permission = id(101280);
    await admin.query(
      "INSERT INTO bop_permission.permission_definition VALUES($1,'catalog.product.publish','Active',1,$2,$2)",
      [permission, from],
    );
  }
  const grant = id(101281);
  await admin.query(
    "INSERT INTO bop_permission.permission_grant VALUES($1,$2,$3,$4,NULL,'Active',$5,$6,1,$5,$5)",
    [grant, id(101200), permission, id(2), from, until],
  );
  const originalApproval = (
    await admin.query(
      "SELECT snapshot_json FROM rms_catalog.product_approval_receipt WHERE operation_id=$1",
      [id(101012)],
    )
  ).rows[0].snapshot_json.approval;
  const body = { ...command("Publish", 4, 3, 101030), successorDraftVersionReference: id(101031) };
  const configuration = {
    authority: {
      async holdUntilTransactionCompletes(_tx, input) {
        holds++;
        assert.deepEqual(input.requiredFields, currentProductPolicyFields);
        assert.equal(input.policyReference, policy.policyReference);
        assert.equal(input.actorReference, id(4));
        assert.equal(input.purposeCode, "CATALOG_PRODUCT_VERSION_PUBLICATION");
        if (!allowed) throw new CatalogError("CATALOG_PERMISSION_DENIED");
      },
    },
  };
  const sources = {
    async withHeldCurrentFacts(tx, input, work) {
      const c = input.command;
      const value = await work({
        now: clock,
        productAggregateVersion: c.expectedProductAggregateVersion,
        contentDigest: c.contentDigest,
        configurationDigest: c.configurationDigest,
        scopeDigest: hash(c.scopeSet),
        periodDigest: hash(c.effectivePeriod),
        validation: {
          evidenceReference: id(101032),
          productAggregateVersion: c.expectedProductAggregateVersion,
          contentDigest: c.contentDigest,
          configurationDigest: c.configurationDigest,
          scopeDigest: hash(c.scopeSet),
          periodDigest: hash(c.effectivePeriod),
          policyReference: policy.policyReference,
          policyVersion: 1,
          approvalPolicy: "Required",
          checks: productPublicationCheckCodes.map((code) => ({ code, outcome: "Pass" })),
          warningAcknowledgement: null,
          checkedAt: clock,
          validUntil: until,
        },
        approval: originalApproval,
        reviewReference: id(101019),
        replacement: null,
      });
      assert.equal(
        (
          await tx.query("SELECT aggregate_version FROM rms_catalog.product WHERE product_id=$1", [
            product,
          ])
        ).rows[0].aggregate_version,
        5,
      );
      tentative = true;
      if (mode === "late-grant")
        await tx.query(
          "UPDATE bop_permission.permission_grant SET lifecycle='Revoked',version=version+1 WHERE grant_id=$1",
          [grant],
        );
      if (mode === "late-policy") allowed = false;
      if (mode === "late-expiry") clock = new Date(Date.parse(at) + 5000).toISOString();
      return value;
    },
  };
  const merchant = { ...sessions[1].persistence, now: () => clock };
  const handler = createMerchantProductPublicationCommand({
    merchant,
    authentication: createPersistentMerchantBffService(merchant),
    auditReference: (operation) => id(parseInt(operation.slice(-12), 16) + 5000),
    authority: {
      async holdUntilTransactionCompletes(_tx, input) {
        assert.equal(input.requiredScope, "FullBrandScope");
      },
    },
    sources,
    currentScopePolicy: configuration,
  });
  configuration.authority.holdUntilTransactionCompletes = async () => {
    throw Error("SYNTHETIC_REBOUND_POLICY");
  };
  await withProductPublicationHttp(handler, sessions[1], scope, async (post) => {
    allowed = false;
    let before = await state();
    assert.equal((await post(body)).status, 403);
    assert.deepEqual(await state(), before);
    allowed = true;
    await admin.query(
      "UPDATE bop_permission.permission_grant SET lifecycle='Revoked',version=version+1 WHERE grant_id=$1",
      [grant],
    );
    before = await state();
    assert.equal((await post(body)).status, 403);
    assert.deepEqual(await state(), before);
    await admin.query(
      "UPDATE bop_permission.permission_grant SET lifecycle='Active',version=version+1 WHERE grant_id=$1",
      [grant],
    );
    for (const [probe, status] of [
      ["late-grant", 403],
      ["late-policy", 403],
      ["late-expiry", 503],
    ]) {
      mode = probe;
      clock = at;
      allowed = true;
      tentative = false;
      before = await state();
      assert.equal((await post(body)).status, status, probe);
      assert.equal(tentative, true);
      assert.deepEqual(await state(), before);
    }
    mode = "normal";
    clock = at;
    allowed = true;
    const initial = await counts();
    const pending = createPublicationNativeHttpClient({
      post,
      command: body,
      scope,
      csrf: sessions[1].csrf,
    });
    const lost = await pending({ loseNextResponse: true });
    assert.equal(lost.nativeReply.status, 200);
    assert.equal(lost.error.code, "OutcomeUnknown");
    const after = await counts();
    assert.equal(after.root, 5);
    for (const key of ["operations", "snapshots", "commits", "audit", "outbox"])
      assert.equal(after[key], initial[key] + 1);
    assert.equal(after.receipts, initial.receipts);
    const journal = (
      await admin.query(
        "SELECT snapshot_json FROM rms_catalog.product_scope_journal WHERE operation_id=$1",
        [body.operationReference],
      )
    ).rows[0].snapshot_json;
    assert.equal(journal.policyEvidenceReference, id(101920));
    assert.equal(journal.incoming.actorKind, "User");
    assert.equal(journal.incoming.policyReference, policy.policyReference);
    assert.equal(journal.plan.overlaps.length, 0);
    await admin.query(
      "UPDATE bop_permission.permission_grant SET lifecycle='Revoked',version=version+1 WHERE grant_id=$1",
      [grant],
    );
    before = await state();
    const denied = await pending();
    assert.equal(denied.nativeReply.status, 403);
    assert.equal(denied.error.code, "OutcomeUnknown");
    assert.deepEqual(await state(), before);
    await admin.query(
      "UPDATE bop_permission.permission_grant SET lifecycle='Active',version=version+1 WHERE grant_id=$1",
      [grant],
    );
    clock = new Date(Date.parse(at) + 60000).toISOString();
    allowed = false;
    holds = 0;
    before = await state();
    const replay = await pending();
    assert.equal(replay.receipt.status, "Replayed");
    assert.equal(replay.receipt.aggregateVersion, 5);
    assert.equal(holds, 0);
    assert.deepEqual(await state(), before);
  });
}
