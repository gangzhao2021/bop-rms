import assert from "node:assert/strict";
import { createMerchantProductPublicationCommand } from "../../../apps/api/src/merchant-product-publication-command.ts";
import { createPersistentMerchantBffService } from "../../../apps/api/src/persistent-merchant-bff.ts";
import { withProductPublicationHttp } from "../../../apps/api/test-support/product-publication-http.mjs";
import { createPublicationNativeHttpClient } from "./product-publication-client-http.mjs";
import {
  CatalogError,
  parseProductAggregate,
  deriveCatalogProductPublicationContentIdentity,
  productPublicationCheckCodes,
  productApprovalSourceFields,
  productEditorContentFields,
  productEditorContentReferenceChecks,
} from "../../rms/catalog/src/index.ts";
import { canonicalizeRfc8785, sha256Hex } from "../../bop/audit/src/index.ts";
import { currentProductPolicyFields } from "../../../apps/api/src/current-product-publication-policy.ts";

// Actual complete stored body/ordinary publication/native IAM/owning approval/policy/SQL.
// Validation12/topology/Phase/fields/reference holders and initial governance are synthetic.
export async function exerciseCompletePublicationHttp({
  admin,
  role,
  id,
  sessions,
  scope,
  policy,
  originalAggregate,
  at,
  from,
  until,
  state,
}) {
  assert.match(role, /^wp2421_approval_[a-f0-9]+$/);
  const hash = (v) => "sha256:" + sha256Hex(canonicalizeRfc8785(v));
  let permission = (
    await admin.query(
      "SELECT permission_id FROM bop_permission.permission_definition WHERE action_code='catalog.sku.read'",
    )
  ).rows[0]?.permission_id;
  if (!permission) {
    permission = id(106280);
    await admin.query(
      "INSERT INTO bop_permission.permission_definition VALUES($1,'catalog.sku.read','Active',1,$2,$2)",
      [permission, from],
    );
  }
  for (const [index, roleRef] of [id(101100), id(101200)].entries())
    await admin.query(
      "INSERT INTO bop_permission.permission_grant VALUES($1,$2,$3,$4,NULL,'Active',$5,$6,1,$5,$5)",
      [id(106281 + index), roleRef, permission, id(2), from, until],
    );
  const base = 106000,
    required = true,
    future = false,
    selectedPolicy = policy,
    targetAction = "Publish",
    grant = id(106282);

  let clock = at,
    mode = "normal",
    approvalAllowed = true,
    policyAllowed = true,
    tentative = false,
    approvalHolds = 0,
    policyHolds = 0,
    remainingCalls = 0,
    contentAllowed = true,
    referenceAllowed = true,
    contentHolds = 0,
    publishHolds = 0;
  const product = id(base + 5),
    version = id(base + 6);
  const aggregate = parseProductAggregate({
    ...originalAggregate,
    productReference: product,
    internalCode: "SYNTHETIC_CURRENT_APPROVAL_" + base,
    aggregateVersion: 1,
    createdAt: at,
    updatedAt: at,
    draft: {
      ...originalAggregate.draft,
      versionReference: version,
      createdAt: at,
      updatedAt: at,
      editorContent: {
        profile: "CatalogProductEditorContentV1",
        localizedShortDescriptions: { "en-CA": "Synthetic complete publication" },
        localizedDescriptions: {},
        preparationNotes: {},
        tagReferences: [],
        attributeValues: [],
        media: [],
        variantDimensions: [],
        variantCombinations: [],
        optionRules: [],
        allergenReferences: [],
        nutritionProfile: null,
      },
    },
  });
  await admin.query(
    "INSERT INTO rms_catalog.product(product_id,brand_id,internal_code,product_type,lifecycle,aggregate_version,created_at,created_by_actor_id,updated_at) VALUES($1,$2,$3,'PreparedFood','Active',1,$4,$5,$4)",
    [product, id(2), aggregate.internalCode, at, id(3)],
  );
  await admin.query(
    "INSERT INTO rms_catalog.product_version(product_version_id,product_id,brand_id,status,default_locale,localized_names_json,created_at,updated_at,editor_content_json) VALUES($1,$2,$3,'Draft','en-CA',$4,$5,$5,$6)",
    [version, product, id(2), aggregate.draft.localizedNames, at, aggregate.draft.editorContent],
  );
  const identity = deriveCatalogProductPublicationContentIdentity(aggregate),
    start = future ? new Date(Date.parse(at) + 600000).toISOString() : at;
  const command = (action, root, pub, op, extra = {}) => ({
    operationReference: id(base + op),
    productReference: product,
    versionReference: version,
    expectedProductAggregateVersion: root,
    expectedPublicationVersion: pub,
    action,
    contentDigest: identity.contentDigest,
    configurationDigest: identity.configurationDigest,
    scopeSet: [{ level: "Brand", reference: null, channelCodes: [], orderTypeCodes: [] }],
    effectivePeriod: {
      timeZone: "UTC",
      effectiveFrom: { instant: start, localDateTime: start.slice(0, -1), utcOffsetMinutes: 0 },
      effectiveUntil: null,
    },
    scheduleReference: null,
    replacementVersionReference: null,
    successorDraftVersionReference: null,
    occurredAt: at,
    reasonCode: "SYNTHETIC_CURRENT_APPROVAL",
    ...extra,
  });
  const sources = {
    async withHeldCurrentFacts(tx, input, work) {
      remainingCalls++;
      const c = input.command;
      const result = await work({
        now: clock,
        productAggregateVersion: c.expectedProductAggregateVersion,
        contentDigest: c.contentDigest,
        configurationDigest: c.configurationDigest,
        scopeDigest: hash(c.scopeSet),
        periodDigest: hash(c.effectivePeriod),
        validation: {
          evidenceReference: id(base + 18),
          productAggregateVersion: c.expectedProductAggregateVersion,
          contentDigest: c.contentDigest,
          configurationDigest: c.configurationDigest,
          scopeDigest: hash(c.scopeSet),
          periodDigest: hash(c.effectivePeriod),
          policyReference: mode === "missing-policy" ? id(999999) : selectedPolicy.policyReference,
          policyVersion: 1,
          approvalPolicy: required ? "Required" : "NotRequired",
          checks: productPublicationCheckCodes.map((code) => ({ code, outcome: "Pass" })),
          warningAcknowledgement: null,
          checkedAt: clock,
          validUntil: until,
        },
        approval: null,
        reviewReference: id(base + 19),
        replacement: null,
      });
      if (c.action === targetAction) {
        assert.equal(
          (
            await tx.query(
              "SELECT aggregate_version FROM rms_catalog.product WHERE product_id=$1",
              [product],
            )
          ).rows[0].aggregate_version,
          c.expectedProductAggregateVersion + 1,
        );
        tentative = true;
        if (mode === "late-grant")
          await tx.query(
            "UPDATE bop_permission.permission_grant SET lifecycle='Revoked',version=version+1 WHERE grant_id=$1",
            [grant],
          );
        if (mode === "late-field") contentAllowed = false;
        if (mode === "late-reference") referenceAllowed = false;
        if (mode === "late-nonvoid") contentAllowed = "nonvoid";

        if (mode === "late-expiry") clock = new Date(Date.parse(at) + 5000).toISOString();
      }
      return result;
    },
  };
  const approvalAuthority = {
    async holdUntilTransactionCompletes(_tx, input) {
      approvalHolds++;
      assert.equal(input.productReference, product);
      assert.equal(input.owningAction, "catalog.product.approval.read");
      assert.deepEqual(input.requiredFields, productApprovalSourceFields);
      if (!approvalAllowed) throw new CatalogError("CATALOG_PERMISSION_DENIED");
    },
  };
  const policyAuthority = {
    async holdUntilTransactionCompletes(_tx, input) {
      policyHolds++;
      assert.equal(input.policyReference, selectedPolicy.policyReference);
      assert.deepEqual(input.requiredFields, currentProductPolicyFields);
      if (!policyAllowed) throw new CatalogError("CATALOG_PERMISSION_DENIED");
    },
  };
  const contentAuthority = async (tx, input) => {
    contentHolds++;
    if (input.mode === "Publish") publishHolds++;
    assert.equal(input.tenantReference, id(1));
    assert.equal(input.brandReference, id(2));
    assert.equal(input.storeReference, scope.storeReference);
    assert.equal(input.productReference, product);
    assert.equal(input.command.productReference, product);
    assert.equal(input.operationReference, input.command.operationReference);
    assert.equal(input.actorReference, input.command.actorReference);
    assert.equal(input.purposeCode, "CATALOG_PRODUCT_VERSION_PUBLICATION");
    assert.equal(input.owningAction, "catalog.product.read");
    assert.deepEqual(input.requiredFields, productEditorContentFields);
    assert.deepEqual(
      input.requiredReferenceChecks,
      input.mode === "Read" ? [] : productEditorContentReferenceChecks,
    );
    assert.deepEqual(input.aggregate.draft.editorContent, aggregate.draft.editorContent);
    if (!contentAllowed || (input.mode === "Publish" && !referenceAllowed))
      throw new CatalogError("CATALOG_PERMISSION_DENIED");
    if (contentAllowed === "nonvoid") return {};
  };
  const make = (session, complete = true) => {
    const merchant = { ...session.persistence, now: () => clock };
    return createMerchantProductPublicationCommand({
      merchant,
      authentication: createPersistentMerchantBffService(merchant),
      auditReference: (operation) => id(parseInt(operation.slice(-12), 16) + 5000),
      authority: {
        async holdUntilTransactionCompletes(_tx, input) {
          assert.equal(input.requiredScope, "FullBrandScope");
        },
      },
      sources,
      ...(complete ? { editorContentAuthority: contentAuthority } : {}),
      approvalDecision: {
        maximumApprovalValiditySeconds: 12,
        reviewAuthority: {
          async holdUntilTransactionCompletes() {
            return undefined;
          },
        },
        policyAuthority,
      },
      currentApproval: { approvalAuthority, policyAuthority },
      currentScopePolicy: { authority: policyAuthority },
    });
  };
  const handlers = sessions.map((session) => make(session));
  await withProductPublicationHttp(make(sessions[0], false), sessions[0], scope, async (post) => {
    const before = await state();
    assert.equal((await post(command("Validate", 1, 0, 10))).status, 503);
    assert.deepEqual(await state(), before);
  });
  approvalAuthority.holdUntilTransactionCompletes = async () => {
    throw Error("SYNTHETIC_REBOUND_APPROVAL");
  };
  policyAuthority.holdUntilTransactionCompletes = async () => {
    throw Error("SYNTHETIC_REBOUND_POLICY");
  };
  await withProductPublicationHttp(handlers[0], sessions[0], scope, async (post) => {
    assert.equal((await post(command("Validate", 1, 0, 10))).status, 200);
    assert.equal((await post(command("SubmitReview", 2, 1, 11))).status, 200);
  });
  if (required)
    await withProductPublicationHttp(handlers[1], sessions[1], scope, async (post) => {
      assert.equal((await post(command("Approve", 3, 2, 12))).status, 200);
    });

  const body = command("Publish", 4, 3, 30, { successorDraftVersionReference: id(base + 51) });
  await withProductPublicationHttp(handlers[1], sessions[1], scope, async (post) => {
    for (const [probe, status] of [
      ["initial-field", 403],
      ["initial-reference", 403],
      ["late-field", 403],
      ["late-reference", 403],
      ["late-nonvoid", 503],
      ["late-grant", 403],
      ["late-expiry", 503],
    ]) {
      mode = probe;
      clock = at;
      tentative = false;
      contentAllowed = probe !== "initial-field";
      referenceAllowed = probe !== "initial-reference";
      const before = await state();
      assert.equal((await post(body)).status, status, probe);
      if (probe.startsWith("late-")) assert.equal(tentative, true, probe);
      assert.deepEqual(await state(), before, probe);
    }
    mode = "normal";
    clock = at;
    contentAllowed = referenceAllowed = true;
    const pending = createPublicationNativeHttpClient({
      post,
      command: body,
      scope,
      csrf: sessions[1].csrf,
    });
    const lost = await pending({ loseNextResponse: true });
    assert.equal(lost.nativeReply.status, 200);
    assert.equal(lost.error.code, "OutcomeUnknown");
    assert.ok(contentHolds > 0 && publishHolds > 0);
    const rows = (
      await admin.query(
        "SELECT product_version_id,status,editor_content_json FROM rms_catalog.product_version WHERE product_id=$1 ORDER BY status",
        [product],
      )
    ).rows;
    assert.equal(rows.length, 2);
    for (const row of rows)
      assert.deepEqual(row.editor_content_json, aggregate.draft.editorContent);
    assert.equal(rows.find((row) => row.status === "Draft").product_version_id, id(base + 51));
    const root = (
      await admin.query("SELECT aggregate_version FROM rms_catalog.product WHERE product_id=$1", [
        product,
      ])
    ).rows[0].aggregate_version;
    assert.equal(root, 5);
    await admin.query(
      "UPDATE bop_permission.permission_grant SET lifecycle='Revoked',version=version+1 WHERE grant_id=$1",
      [grant],
    );
    let before = await state();
    const denied = await pending();
    assert.equal(denied.nativeReply.status, 403);
    assert.equal(denied.error.code, "OutcomeUnknown");
    assert.deepEqual(await state(), before);
    await admin.query(
      "UPDATE bop_permission.permission_grant SET lifecycle='Active',version=version+1 WHERE grant_id=$1",
      [grant],
    );
    clock = new Date(Date.parse(at) + 60000).toISOString();
    referenceAllowed = approvalAllowed = policyAllowed = false;
    contentHolds = publishHolds = remainingCalls = approvalHolds = policyHolds = 0;
    before = await state();
    const replay = await pending();
    assert.equal(replay.receipt.status, "Replayed");
    assert.equal(replay.receipt.aggregateVersion, 5);
    assert.ok(contentHolds > 0);
    assert.equal(publishHolds + remainingCalls + approvalHolds + policyHolds, 0);
    assert.deepEqual(await state(), before);
  });
}
