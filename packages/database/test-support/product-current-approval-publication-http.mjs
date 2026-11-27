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
} from "../../rms/catalog/src/index.ts";
import { canonicalizeRfc8785, sha256Hex } from "../../bop/audit/src/index.ts";
import { publishingProductPublicationPolicyDigest } from "../../bop/publishing/src/index.ts";
import { currentProductPolicyFields } from "../../../apps/api/src/current-product-publication-policy.ts";

// Actual owning decision/original receipt/current policy/native IAM/BFF HTTP/CAS/SQL.
// Initial legacy content/full validation12/topology/Phase/write and independent source fields/governance are synthetic.
export async function exerciseCurrentApprovalPublicationHttp({
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
  publish,
  state,
}) {
  assert.match(role, /^wp2421_approval_[a-f0-9]+$/);
  const hash = (v) => "sha256:" + sha256Hex(canonicalizeRfc8785(v));
  let permission = (
    await admin.query(
      "SELECT permission_id FROM bop_permission.permission_definition WHERE action_code='catalog.product.approval.read'",
    )
  ).rows[0]?.permission_id;
  if (!permission) {
    permission = id(103280);
    await admin.query(
      "INSERT INTO bop_permission.permission_definition VALUES($1,'catalog.product.approval.read','Active',1,$2,$2)",
      [permission, from],
    );
  }
  const grant = id(103281);
  await admin.query(
    "INSERT INTO bop_permission.permission_grant VALUES($1,$2,$3,$4,NULL,'Active',$5,$6,1,$5,$5)",
    [grant, id(101200), permission, id(2), from, until],
  );
  const noRequired = {
    ...policy,
    familyReference: id(105900),
    policyReference: id(105919),
    approvalPolicy: "NotRequired",
  };
  await publish({
    base: 105930,
    type: "PRODUCT_PUBLICATION_POLICY",
    snapshot: noRequired.policyReference,
    digest: publishingProductPublicationPolicyDigest(noRequired),
    family: noRequired.familyReference,
    releaseId: id(105920),
    approvalId: id(105921),
    body: noRequired,
  });
  async function runCase(base, required, future) {
    let clock = at,
      mode = "normal",
      approvalAllowed = true,
      policyAllowed = true,
      tentative = false,
      approvalHolds = 0,
      policyHolds = 0,
      remainingCalls = 0;
    const product = id(base + 5),
      version = id(base + 6),
      selectedPolicy = required ? policy : noRequired;
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
      },
    });
    await admin.query(
      "INSERT INTO rms_catalog.product(product_id,brand_id,internal_code,product_type,lifecycle,aggregate_version,created_at,created_by_actor_id,updated_at) VALUES($1,$2,$3,'PreparedFood','Active',1,$4,$5,$4)",
      [product, id(2), aggregate.internalCode, at, id(3)],
    );
    await admin.query(
      "INSERT INTO rms_catalog.product_version(product_version_id,product_id,brand_id,status,default_locale,localized_names_json,created_at,updated_at) VALUES($1,$2,$3,'Draft','en-CA',$4,$5,$5)",
      [version, product, id(2), aggregate.draft.localizedNames, at],
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
    const targetAction = future ? "SchedulePublish" : "Publish";
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
            policyReference:
              mode === "missing-policy" ? id(999999) : selectedPolicy.policyReference,
            policyVersion: 1,
            approvalPolicy: required ? "Required" : "NotRequired",
            checks: productPublicationCheckCodes.map((code) => ({
              code,
              outcome:
                mode === "initial-warning-override" && code === "MediaReady" ? "Warning" : "Pass",
            })),
            warningAcknowledgement:
              mode === "initial-warning-override"
                ? {
                    actorReference: c.actorReference,
                    reasonCode: "SYNTHETIC_WARNING",
                    warningCodes: ["MediaReady"],
                  }
                : null,
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
          if (mode === "late-approval") approvalAllowed = false;
          if (mode === "late-policy") policyAllowed = false;
          if (mode === "late-expiry") clock = new Date(Date.parse(at) + 2000).toISOString();
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
    const handlers = sessions.map((session) => {
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
        approvalDecision: {
          maximumApprovalValiditySeconds: 2,
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
    const root = required ? 4 : 3,
      pub = required ? 3 : 2;
    const body = command(
      targetAction,
      root,
      pub,
      30,
      future
        ? { scheduleReference: id(base + 50) }
        : { successorDraftVersionReference: id(base + 51) },
    );
    const counts = async () =>
      (
        await admin.query(
          "SELECT (SELECT aggregate_version FROM rms_catalog.product WHERE product_id=$1) root,(SELECT count(*)::int FROM rms_catalog.product_operation_record WHERE product_id=$1) operations,(SELECT count(*)::int FROM rms_catalog.product_operation_snapshot WHERE product_id=$1) snapshots,(SELECT count(*)::int FROM rms_catalog.product_source_commit WHERE product_id=$1) commits,(SELECT count(*)::int FROM rms_catalog.product_approval_receipt WHERE product_id=$1) receipts,(SELECT count(*)::int FROM platform_audit.audit_record WHERE target_id=$1) audit,(SELECT count(*)::int FROM platform_eventing.outbox_event WHERE aggregate_id=$1) outbox",
          [product],
        )
      ).rows[0];
    await withProductPublicationHttp(handlers[1], sessions[1], scope, async (post) => {
      let before;
      mode = "initial-warning-override";
      clock = at;
      tentative = false;
      before = await state();
      assert.equal((await post(body)).status, 503);
      assert.equal(tentative, false);
      assert.deepEqual(await state(), before);
      mode = "normal";
      if (required) {
        approvalAllowed = false;
        before = await state();
        assert.equal((await post(body)).status, 403);
        assert.deepEqual(await state(), before);
        approvalAllowed = true;
        policyAllowed = false;
        before = await state();
        assert.equal((await post(body)).status, 403);
        assert.deepEqual(await state(), before);
        policyAllowed = true;
        mode = "missing-policy";
        before = await state();
        assert.equal((await post(body)).status, 503);
        assert.deepEqual(await state(), before);
        mode = "normal";
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
          ["late-approval", 403],
          ["late-policy", 403],
          ["late-expiry", 503],
        ]) {
          mode = probe;
          clock = at;
          approvalAllowed = policyAllowed = true;
          tentative = false;
          before = await state();
          assert.equal((await post(body)).status, status, probe);
          assert.equal(tentative, true);
          assert.deepEqual(await state(), before);
        }
      } else {
        // Actual NotRequired policy requires no permission to read a nonexistent approval.
        await admin.query(
          "UPDATE bop_permission.permission_grant SET lifecycle='Revoked',version=version+1 WHERE grant_id=$1",
          [grant],
        );
      }
      mode = "normal";
      clock = at;
      approvalAllowed = policyAllowed = true;
      approvalHolds = policyHolds = remainingCalls = 0;
      const initial = await counts(),
        pending = createPublicationNativeHttpClient({
          post,
          command: body,
          scope,
          csrf: sessions[1].csrf,
        });
      const lost = await pending({ loseNextResponse: true });
      assert.equal(lost.nativeReply.status, 200);
      assert.equal(lost.error.code, "OutcomeUnknown");
      assert.equal(required ? approvalHolds > 0 : approvalHolds === 0, true);
      assert.ok(policyHolds > 0);
      const after = await counts();
      assert.equal(after.root, root + 1);
      for (const key of ["operations", "snapshots", "commits", "audit", "outbox"])
        assert.equal(after[key], initial[key] + 1);
      assert.equal(after.receipts, initial.receipts);
      assert.equal(after.receipts, required ? 1 : 0);
      if (required) {
        const receipt = (
          await admin.query(
            "SELECT snapshot_json FROM rms_catalog.product_approval_receipt WHERE operation_id=$1",
            [id(base + 12)],
          )
        ).rows[0].snapshot_json;
        assert.equal(receipt.approval.validUntil, new Date(Date.parse(at) + 2000).toISOString());
        assert.equal(receipt.approval.evidenceReference, id(base + 12));
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
      }
      clock = new Date(Date.parse(at) + 60000).toISOString();
      approvalAllowed = policyAllowed = false;
      approvalHolds = policyHolds = remainingCalls = 0;
      before = await state();
      const replay = await pending();
      assert.equal(replay.receipt.status, "Replayed");
      assert.equal(replay.receipt.aggregateVersion, root + 1);
      assert.equal(approvalHolds + policyHolds + remainingCalls, 0);
      assert.deepEqual(await state(), before);
      if (future) {
        // Original approval is still valid at controlled at; rejection is changed timing, not expired evidence.
        clock = at;
        approvalAllowed = policyAllowed = true;
        const changedStart = new Date(Date.parse(start) + 60000).toISOString();
        const changed = command("ReschedulePublish", root + 1, pub + 1, 31, {
          scheduleReference: id(base + 50),
          effectivePeriod: {
            timeZone: "UTC",
            effectiveFrom: {
              instant: changedStart,
              localDateTime: changedStart.slice(0, -1),
              utcOffsetMinutes: 0,
            },
            effectiveUntil: null,
          },
        });
        before = await state();
        assert.equal((await post(changed)).status, 503);
        assert.deepEqual(await state(), before);
        clock = new Date(Date.parse(at) + 60000).toISOString();
        approvalAllowed = policyAllowed = false;
        approvalHolds = policyHolds = 0;
        assert.equal(
          (
            await post(
              command("CancelScheduledPublish", root + 1, pub + 1, 32, {
                scheduleReference: id(base + 50),
              }),
            )
          ).status,
          200,
        );
        assert.equal(approvalHolds + policyHolds, 0);
        assert.equal((await counts()).root, root + 2);
      }
    });
    if (!required)
      await admin.query(
        "UPDATE bop_permission.permission_grant SET lifecycle='Active',version=version+1 WHERE grant_id=$1",
        [grant],
      );
  }
  await runCase(103000, true, false);
  await runCase(104000, true, true);
  await runCase(105000, false, false);
}
