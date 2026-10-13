import assert from "node:assert/strict";
import pg from "pg";
import { it } from "vitest";
import {
  createPostgresPublishingMutationStore,
  createPublishingLifecycleRecord,
  createPublishingScope,
  createPublishingValidationEvidence,
} from "../../bop/publishing/src/index.ts";
import { recordMenuSoleOperatorApproval } from "../../rms/catalog/src/index.ts";
import { createMenuReviewApprovalSource } from "../../../apps/api/src/menu-review-approval-source.ts";
import {
  MerchantSoleOperatorGateError,
  requireMerchantBrandSoleOperator,
} from "../../../apps/api/src/merchant-sole-operator.ts";
import { withIsolatedDatabase } from "../test-support/isolated-database.mjs";
import {
  createPilotApiRole,
  dbNow,
  seedBrand,
  seedBrandMember,
  seedBrandRole,
  seedSoleOperatorSetting,
  seedStepUp,
} from "../test-support/sole-operator-brand-gate.mjs";

const { Client } = pg;
const id = (n) => "01909a1e-0000-7000-8000-" + n.toString(16).padStart(12, "0");

/**
 * WP-2423 Q19 step 2 (DEC-SOLE-OPERATOR-APPROVAL): menu review approval. The person who submitted a
 * menu version for review cannot approve it (server rule, previously only hidden in the browser),
 * except alone as an in-effect, re-verified sole operator, explicitly asked; that approval is
 * marked SoleOperator. A second holder of menu approval ends the waiver at once and approves
 * independently. Real Publishing lifecycle rows, Organization/Membership/Permission/Identity
 * owners, under the restricted pilot API role.
 */
it("menu review: submitter ≠ approver on the server; the sole operator approves alone", async () => {
  await withIsolatedDatabase({ caseId: "wp2423_so_menu" }, async (context) => {
    const admin = new Client(context.clientConfig);
    await admin.connect();
    const tenantReference = id(1),
      brandReference = id(2),
      storeReference = id(3),
      owner = id(4),
      noah = id(5);
    try {
      const role = await createPilotApiRole(admin, context, "wp2423_som");
      const start = Date.parse(await dbNow(admin));
      const from = new Date(start - 3 * 3600_000).toISOString();
      const enrolledAt = new Date(start - 2 * 3600_000).toISOString();
      await seedBrand(admin, { brandReference, policyReference: id(300), from });
      const approverRole = await seedBrandRole(admin, {
        id,
        brandReference,
        roleId: id(310),
        code: "menu_manager",
        actions: ["catalog.menu.approve", "publishing.review.approve"],
        from,
      });
      await seedBrandMember(admin, {
        id,
        base: 400,
        brandReference,
        storeReference,
        actorReference: owner,
        name: "Sam",
        roles: [approverRole],
        from,
        enrolledAt,
      });
      const run = async (work) => {
        await admin.query("BEGIN");
        try {
          await admin.query("SET LOCAL ROLE " + role);
          await admin.query(
            "SELECT set_config('bop.brand_id',$1,true),set_config('bop.store_id','',true)",
            [brandReference],
          );
          const value = await work({
            query: (sql, values) => admin.query(sql, values === undefined ? [] : [...values]),
          });
          await admin.query("COMMIT");
          return value;
        } catch (error) {
          await admin.query("ROLLBACK");
          throw error;
        }
      };
      const scope = createPublishingScope({ kind: "Brand", brandReference, storeReference: null });
      const publishing = createPostgresPublishingMutationStore(
        { run: (work) => run(work) },
        tenantReference,
        scope,
      );
      const digest = "sha256:" + "c".repeat(64);
      // A menu version submitted for review by `submitter` (Publishing lifecycle rows).
      let n = 1000;
      const submit = async (submitter) => {
        const lifecycle = id(++n),
          menu = id(++n),
          version = id(++n);
        const at = new Date(Date.parse(await dbNow(admin)) - 60_000).toISOString();
        const draft = createPublishingLifecycleRecord({
          lifecycleId: lifecycle,
          familyReference: menu,
          configurationType: "MENU",
          purposeCode: "CUSTOMER_ORDERING",
          snapshotReference: version,
          snapshotDigest: digest,
          scope,
          version: 1,
          state: "Draft",
          validationEvidenceReference: null,
          approvalEvidenceReference: null,
          createdAt: at,
          changedAt: at,
        });
        const validation = createPublishingValidationEvidence({
          evidenceReference: id(++n),
          snapshotReference: version,
          snapshotDigest: digest,
          scope,
          result: "Pass",
          checkedAt: at,
          validUntil: new Date(Date.parse(at) + 3600_000).toISOString(),
          checkCodes: ["SYNTHETIC_MENU_VALIDATION"],
        });
        const commit = async (operation, current, next, extra) =>
          publishing.commit({
            operation,
            current,
            next,
            expectedVersion: current?.version ?? 1,
            idempotencyKey: id(++n),
            release: null,
            supersededReleaseId: null,
            rollbackTargetReleaseId: null,
            validationEvidence: null,
            approvalEvidence: null,
            audit: {
              auditId: id(++n),
              brandId: brandReference,
              actor: { type: "User", reference: submitter },
              actionCode:
                operation === "CreateDraft"
                  ? "PUBLISHING_DRAFT_CREATED"
                  : "PUBLISHING_REVIEW_SUBMITTED",
              targetType: "PublishingLifecycle",
              targetId: lifecycle,
              reasonCode: "SYNTHETIC_TEST",
              correlationId: id(n - 1),
              occurredAt: at,
              sourceChannel: "MERCHANT_WEB",
              dataClassification: "Confidential",
              retentionPolicyCode: "PUBLISHING_LIFECYCLE_AUDIT",
              retentionPolicyVersion: 1,
            },
            ...extra,
          });
        await commit("CreateDraft", null, draft, {});
        await commit(
          "SubmitReview",
          draft,
          {
            ...draft,
            version: 2,
            state: "InReview",
            validationEvidenceReference: validation.evidenceReference,
          },
          { validationEvidence: validation },
        );
        return { lifecycle, menu, version };
      };
      const references = new Map();
      const approval = createMenuReviewApprovalSource({
        tenantReference,
        brandReference,
        reference: (purpose, operation) => {
          const key = purpose + operation;
          if (!references.has(key)) references.set(key, id(0x9000 + references.size));
          return references.get(key);
        },
        validUntil: ({ validationValidUntil }) => validationValidUntil,
        authorize: async () => true,
      });
      const gate = (tx, actor, at) =>
        requireMerchantBrandSoleOperator(tx, {
          tenantReference,
          brandReference,
          storeReference,
          actorReference: actor,
          permissionCode: "catalog.menu.approve",
          observedAt: at,
          allowed: async () => true,
        });
      /** Approve as `actor`; `sole` asks for the sole-operator path and marks it. */
      const approve = async (submitted, actor, sole) => {
        const operation = id(++n);
        return run(async (tx) => {
          const at = await dbNow(admin);
          let mfaAt = null;
          const next = await approval.approve(tx, {
            actorReference: actor,
            menuReference: submitted.menu,
            menuVersionReference: submitted.version,
            lifecycleReference: submitted.lifecycle,
            snapshotDigest: digest,
            operationReference: operation,
            expectedVersion: 2,
            observedAt: at,
            ...(sole
              ? {
                  soleOperator: async () => {
                    mfaAt = (await gate(tx, actor, at)).actorMfaAt;
                    await tx.query(
                      "SELECT set_config('bop.brand_id',$1,true),set_config('bop.store_id','',true)",
                      [brandReference],
                    );
                  },
                }
              : {}),
          });
          if (sole)
            await recordMenuSoleOperatorApproval(tx, {
              brandReference,
              approvalEvidenceReference: references.get("Approval" + operation),
              operationReference: operation,
              menuReference: submitted.menu,
              menuVersionReference: submitted.version,
              lifecycleReference: submitted.lifecycle,
              actorReference: actor,
              actorMfaAt: mfaAt,
              approvedAt: at,
              auditReference: references.get("Audit" + operation),
            });
          return next;
        });
      };
      const marks = async () =>
        (
          await admin.query(
            "SELECT menu_version_id::text version,actor_id::text actor,approval_mode FROM rms_catalog.menu_sole_operator_approval ORDER BY approved_at",
          )
        ).rows;
      const refused = (code) => (error) => {
        assert.equal(error.code, code);
        return true;
      };

      // ── 1. Two-person rule on the server: the submitter cannot approve their own submission.
      const first = await submit(owner);
      await assert.rejects(
        approve(first, owner, false),
        refused("CATALOG_INDEPENDENT_APPROVAL_REQUIRED"),
      );
      // Asking for the sole-operator path: not set → named refusal; nothing recorded.
      await assert.rejects(approve(first, owner, true), (error) => {
        assert.ok(error instanceof MerchantSoleOperatorGateError);
        assert.equal(error.code, "NotInEffect");
        return true;
      });

      // ── 2. On and in effect, but the second factor is two hours old: verify again.
      await seedSoleOperatorSetting(admin, {
        id,
        n: 500,
        tenantReference,
        brandReference,
        actorReference: owner,
        state: "On",
        version: 1,
      });
      await assert.rejects(approve(first, owner, true), refused("NeedsReverification"));
      await assert.rejects(
        approve(first, owner, false),
        refused("CATALOG_INDEPENDENT_APPROVAL_REQUIRED"),
      );
      assert.deepEqual(await marks(), []);

      // ── 3. Re-verified: the submitter approves alone; the approval is marked SoleOperator.
      await seedStepUp(admin, {
        id,
        n: 520,
        brandReference,
        storeReference,
        actorReference: owner,
      });
      const approved = await approve(first, owner, true);
      assert.equal(approved.state, "Approved");
      assert.deepEqual(await marks(), [
        { version: first.version, actor: owner, approval_mode: "SoleOperator" },
      ]);
      const publishingActor = (
        await admin.query(
          "SELECT actor_id::text actor FROM bop_publishing.publishing_mutation_record WHERE lifecycle_id=$1 AND operation_code='Approve'",
          [first.lifecycle],
        )
      ).rows;
      assert.deepEqual(publishingActor, [{ actor: owner }]);

      // ── 4. Noah gains menu approval: the waiver lapses at once; Noah approves independently.
      await seedBrandMember(admin, {
        id,
        base: 600,
        brandReference,
        storeReference,
        actorReference: noah,
        name: "Noah",
        roles: [approverRole],
        from,
        enrolledAt,
      });
      const second = await submit(owner);
      await assert.rejects(approve(second, owner, true), refused("NotInEffect"));
      // The sole-operator path is never used for someone else's submission.
      await assert.rejects(approve(second, noah, true), refused("CATALOG_INPUT_INVALID"));
      assert.equal((await approve(second, noah, false)).state, "Approved");
      assert.equal((await marks()).length, 1);

      // ── 5. The mark is append-only and refuses a second factor older than 15 minutes.
      await assert.rejects(
        admin.query("UPDATE rms_catalog.menu_sole_operator_approval SET actor_id=$1", [noah]),
        /append-only menu sole operator approval/u,
      );
      await assert.rejects(
        admin.query("DELETE FROM rms_catalog.menu_sole_operator_approval"),
        /append-only menu sole operator approval/u,
      );
      await assert.rejects(
        admin.query(
          "INSERT INTO rms_catalog.menu_sole_operator_approval VALUES ($1,$2,$3,$4,$5,$6,'SoleOperator',$7,now()-interval '16 minutes',date_trunc('milliseconds',now()),$8)",
          [
            brandReference,
            id(901),
            id(902),
            second.menu,
            second.version,
            second.lifecycle,
            owner,
            id(903),
          ],
        ),
        /menu_sole_operator_approval_recent_mfa/u,
      );
    } finally {
      await admin.end();
    }
  });
});
