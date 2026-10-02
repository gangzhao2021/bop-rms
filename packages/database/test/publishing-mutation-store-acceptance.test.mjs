import {
  createCurrentOptionSetDraftApprovalSource,
  currentOptionSetApprovalFields,
} from "../../../apps/api/src/current-option-set-draft-approval.ts";
import { optionContentReviewValidationCodes } from "../../rms/catalog/src/index.ts";
import { createCurrentOptionSetDraftPolicySource } from "../../../apps/api/src/current-option-set-draft-policy.ts";
import {
  createPostgresFullOptionSetDraftStore,
  parseCatalogOptionSetEditorContent,
} from "../../rms/catalog/src/index.ts";
import {
  createCurrentOptionSetPublicationPolicySource,
  currentOptionSetPolicyFields,
} from "../../../apps/api/src/current-option-set-publication-policy.ts";
import {
  publishingOptionSetPublicationPolicyDigest,
  optionSetPolicyScopeLevels,
} from "../../bop/publishing/src/index.ts";
import { createMerchantProductEditorPolicyContentAuthority } from "../../../apps/api/src/merchant-product-editor-policy-content-authority.ts";
import { remainingProductEditorVariantReferenceChecks } from "../../../apps/api/src/merchant-product-editor-variant-content-authority.ts";
import { createCurrentProductCandidateContentPolicySource } from "../../../apps/api/src/current-product-candidate-content-policy.ts";
import { createCurrentProductHeldContentPolicySource } from "../../../apps/api/src/current-product-held-content-policy.ts";
import {
  applyCatalogProductContentPolicyValidation,
  parseProductPublicationValidation,
  productPublicationCheckCodes,
} from "../../rms/catalog/src/index.ts";
import {
  createPostgresProductValidationCandidateSource,
  createPostgresProductCreationStore,
  createPostgresProductDraftStore,
  parseProductAggregate,
  productValidationCandidateFields,
  productEditorContentFields,
  CatalogError,
} from "../../rms/catalog/src/index.ts";
import { createCurrentProductContentPolicySource } from "../../../apps/api/src/current-product-content-policy.ts";
import { deriveCatalogProductPublicationContentIdentity } from "../../rms/catalog/src/index.ts";
import { canonicalizeRfc8785, sha256Hex } from "../../bop/audit/src/index.ts";
import {
  publishingProductPublicationPolicyDigest,
  productPolicyScopeLevels,
} from "../../bop/publishing/src/index.ts";
import { createCurrentProductPublicationPolicySource } from "../../../apps/api/src/current-product-publication-policy.ts";
import assert from "node:assert/strict";
import pg from "pg";
import { it } from "vitest";
import { createPostgresPublishingMutationStore } from "../../bop/publishing/src/index.ts";
import {
  createPostgresTenantBrandConfigurationContentSource,
  tenantBrandConfigurationContentDigest,
  tenantBrandConfigurationRequiredFields,
} from "../../bop/tenant/src/index.ts";
import { createCurrentBrandConfigurationContentSource } from "../../../apps/api/src/current-brand-configuration-content.ts";
import { withIsolatedDatabase } from "../test-support/isolated-database.mjs";
const { Client } = pg;
const id = (n) => "01909998-0000-7000-8000-" + n.toString(16).padStart(12, "0");
const at = "2026-09-11T10:00:00.000Z",
  until = "2026-09-11T11:00:00.000Z";
it("commits Publishing and Audit atomically and matches original review evidence and replay", async () => {
  await withIsolatedDatabase({ caseId: "wp2402_pub_store" }, async (context) => {
    const admin = new Client(context.clientConfig);
    await admin.connect();
    const role = "wp2402_pub_" + context.runId;
    let created = false;
    try {
      await admin.query("CREATE ROLE " + role + " NOLOGIN NOSUPERUSER NOBYPASSRLS");
      created = true;
      await admin.query(
        "GRANT USAGE ON SCHEMA bop_publishing,platform_audit,platform_helpers TO " + role,
      );
      await admin.query(
        "GRANT SELECT,INSERT,UPDATE ON bop_publishing.publishing_mutation_record TO " + role,
      );
      await admin.query("GRANT SELECT,INSERT ON platform_audit.audit_record TO " + role);
      await admin.query("GRANT SELECT,INSERT,UPDATE ON platform_audit.audit_chain_head TO " + role);
      await admin.query(
        "GRANT EXECUTE ON FUNCTION platform_helpers.current_brand_id(),platform_helpers.current_store_id() TO " +
          role,
      );
      await admin.query("GRANT USAGE ON TYPE platform_helpers.uuid_v7 TO " + role);
      await admin.query("GRANT EXECUTE ON FUNCTION platform_helpers.is_uuid_v7(uuid) TO " + role);
      const scope = { kind: "Store", brandReference: id(2), storeReference: id(3) };
      function runner(options = {}) {
        return {
          async run(work) {
            const client = new Client(context.clientConfig);
            await client.connect();
            let committed = false;
            try {
              await client.query("BEGIN");
              await client.query("SET LOCAL ROLE " + role);
              const result = await work({
                query: async (sql, values) => {
                  if (options.failAudit && sql.startsWith("UPDATE platform_audit.audit_chain_head"))
                    throw new Error("synthetic Audit failure");
                  const result = await client.query(sql, [...values]);
                  // Synthetic transport corruption of actual SQL rows, never a database mutation.
                  if (
                    options.corruptIntentAt &&
                    sql.startsWith("SELECT mutation_json,intent_hash") &&
                    sql.includes(options.corruptIntentAt)
                  )
                    return {
                      rows: result.rows.map((row) => ({
                        ...row,
                        intent_hash: "sha256:" + "0".repeat(64),
                      })),
                    };
                  return result;
                },
              });
              await client.query("COMMIT");
              committed = true;
              if (options.loseAck) throw new Error("synthetic response loss");
              return result;
            } catch (error) {
              if (!committed) await client.query("ROLLBACK");
              throw error;
            } finally {
              await client.end();
            }
          },
        };
      }
      const base = {
        lifecycleId: id(5),
        familyReference: id(4),
        configurationType: "WORKFLOW_CONFIGURATION",
        purposeCode: "ORDER_FULFILLMENT",
        snapshotReference: id(6),
        snapshotDigest: "sha256:" + "a".repeat(64),
        scope,
        version: 1,
        state: "Draft",
        validationEvidenceReference: null,
        approvalEvidenceReference: null,
        createdAt: at,
        changedAt: at,
      };
      function mutation(operation, current, next, n, extra = {}) {
        return {
          operation,
          expectedVersion: current?.version ?? 1,
          idempotencyKey: id(n),
          current,
          next,
          release: null,
          supersededReleaseId: null,
          rollbackTargetReleaseId: null,
          validationEvidence: null,
          approvalEvidence: null,
          audit: {
            auditId: id(n + 1),
            brandId: id(2),
            storeId: id(3),
            actor: { type: "User", reference: id(7) },
            actionCode: {
              CreateDraft: "PUBLISHING_DRAFT_CREATED",
              SubmitReview: "PUBLISHING_REVIEW_SUBMITTED",
              Approve: "PUBLISHING_REVIEW_APPROVED",
              Publish: "PUBLISHING_RELEASE_PUBLISHED",
              Archive: "PUBLISHING_RELEASE_ARCHIVED",
              Rollback: "PUBLISHING_RELEASE_ROLLED_BACK",
            }[operation],
            targetType: "PublishingLifecycle",
            targetId: next.lifecycleId,
            reasonCode: "SYNTHETIC_TEST",
            correlationId: id(n),
            occurredAt: at,
            sourceChannel: "MERCHANT_WEB",
            dataClassification: "Confidential",
            retentionPolicyCode: "PUBLISHING_LIFECYCLE_AUDIT",
            retentionPolicyVersion: 1,
          },
          ...extra,
        };
      }
      const store = createPostgresPublishingMutationStore(runner(), id(1), scope);
      const first = mutation("CreateDraft", null, base, 10);
      const recovery = {
        operationReference: first.idempotencyKey,
        familyReference: base.familyReference,
        lifecycleReference: base.lifecycleId,
        configurationType: base.configurationType,
        purposeCode: base.purposeCode,
        observedAt: at,
      };
      assert.equal(await store.resolveOperation(recovery), null);
      await assert.rejects(
        createPostgresPublishingMutationStore(runner({ loseAck: true }), id(1), scope).commit(
          first,
        ),
      );
      assert.equal(
        (
          await admin.query(
            "SELECT count(*)::int AS n FROM bop_publishing.publishing_mutation_record",
          )
        ).rows[0].n,
        1,
        "response loss must occur after the original row committed",
      );
      assert.deepEqual(await store.resolveOperation(recovery), first);
      for (const patch of [
        { familyReference: id(999) },
        { lifecycleReference: id(999) },
        { configurationType: "OTHER_CONFIGURATION" },
        { purposeCode: "OTHER_PURPOSE" },
        { observedAt: "2026-09-11T09:59:59.999Z" },
      ])
        await assert.rejects(store.resolveOperation({ ...recovery, ...patch }), {
          code: "PUBLISHING_INPUT_INVALID",
        });
      assert.equal(
        await store.resolveOperation({ ...recovery, operationReference: id(999) }),
        null,
      );
      assert.equal(
        await createPostgresPublishingMutationStore(runner(), id(99), scope).resolveOperation(
          recovery,
        ),
        null,
      );
      assert.equal(
        await createPostgresPublishingMutationStore(runner(), id(1), {
          ...scope,
          storeReference: id(99),
        }).resolveOperation(recovery),
        null,
      );
      const replay = await store.commit({ ...first, audit: { ...first.audit, auditId: id(99) } });
      assert.equal(replay.auditReference, id(11));
      await assert.rejects(
        store.commit({
          ...first,
          audit: { ...first.audit, actor: { type: "User", reference: id(98) } },
        }),
      );
      const validation = {
        evidenceReference: id(20),
        snapshotReference: id(6),
        snapshotDigest: base.snapshotDigest,
        scope,
        result: "Pass",
        checkedAt: at,
        validUntil: until,
        checkCodes: ["SCHEMA_VALID"],
      };
      const review = {
        ...base,
        version: 2,
        state: "InReview",
        validationEvidenceReference: id(20),
      };
      const submit = mutation("SubmitReview", base, review, 30, { validationEvidence: validation });
      await assert.rejects(
        createPostgresPublishingMutationStore(runner({ failAudit: true }), id(1), scope).commit(
          submit,
        ),
      );
      assert.equal(
        (
          await admin.query(
            "SELECT count(*)::int AS n FROM bop_publishing.publishing_mutation_record",
          )
        ).rows[0].n,
        1,
      );
      assert.equal(
        (await admin.query("SELECT count(*)::int AS n FROM platform_audit.audit_record")).rows[0].n,
        1,
      );
      await store.commit(submit);
      const approval = {
        evidenceReference: id(21),
        reviewLifecycleId: id(5),
        reviewVersion: 2,
        snapshotReference: id(6),
        snapshotDigest: base.snapshotDigest,
        scope,
        decision: "Accepted",
        approvedActorReference: id(7),
        approvedAt: at,
        validUntil: until,
      };
      const approved = {
        ...review,
        version: 3,
        state: "Approved",
        approvalEvidenceReference: id(21),
      };
      await store.commit(mutation("Approve", review, approved, 40, { approvalEvidence: approval }));
      const published = { ...approved, version: 4, state: "Published" };
      const release = {
        releaseId: id(22),
        familyReference: id(4),
        configurationType: base.configurationType,
        purposeCode: base.purposeCode,
        snapshotReference: id(6),
        snapshotDigest: base.snapshotDigest,
        scope,
        sequence: 1,
        sourceLifecycleId: id(5),
        kind: "Publish",
        previousReleaseId: null,
        createdAt: at,
      };
      const publish = mutation("Publish", approved, published, 50, {
        validationEvidence: validation,
        approvalEvidence: approval,
        release,
      });
      await assert.rejects(
        store.commit({
          ...publish,
          validationEvidence: { ...validation, checkCodes: ["CHANGED_CHECK"] },
        }),
      );
      await store.commit(publish);
      const query = {
        familyReference: id(4),
        configurationType: base.configurationType,
        purposeCode: base.purposeCode,
        observedAt: at,
      };
      assert.equal((await store.resolveCurrentRelease(query)).release.releaseId, id(22));
      const referenceQuery = {
        publicationReference: release.releaseId,
        configurationType: query.configurationType,
        purposeCode: query.purposeCode,
        observedAt: query.observedAt,
      };
      const referenced = await store.resolveCurrentReleaseForReference(referenceQuery);
      assert.equal(referenced.recorded.release.releaseId, id(22));
      assert.equal(referenced.current.release.releaseId, id(22));
      assert.equal(referenced.recorded.approvalEvidence.evidenceReference, id(21));
      for (const corruptIntentAt of [
        "release_id=$4",
        "ORDER BY release_sequence",
        "ORDER BY lifecycle_version",
      ])
        await assert.rejects(
          createPostgresPublishingMutationStore(
            runner({ corruptIntentAt }),
            id(1),
            scope,
          ).resolveCurrentReleaseForReference(referenceQuery),
        );
      for (const patch of [
        { publicationReference: id(999) },
        { publicationReference: base.lifecycleId },
        { configurationType: "OTHER_CONFIGURATION" },
        { purposeCode: "OTHER_PURPOSE" },
        { observedAt: "2026-09-11T09:59:59.999Z" },
      ])
        await assert.rejects(
          store.resolveCurrentReleaseForReference({ ...referenceQuery, ...patch }),
        );
      for (const [tenant, candidateScope] of [
        [id(99), scope],
        [id(1), { ...scope, brandReference: id(99) }],
        [id(1), { ...scope, storeReference: id(99) }],
        [id(1), { kind: "Brand", brandReference: scope.brandReference, storeReference: null }],
      ])
        await assert.rejects(
          createPostgresPublishingMutationStore(
            runner(),
            tenant,
            candidateScope,
          ).resolveCurrentReleaseForReference(referenceQuery),
        );
      await runner().run(async (tx) => {
        const bound = createPostgresPublishingMutationStore(
          { run: async (work) => work(tx) },
          id(1),
          scope,
        );
        await bound.resolveCurrentReleaseForReference(referenceQuery);
        await admin.query("BEGIN");
        try {
          await assert.rejects(
            admin.query(
              "LOCK TABLE bop_publishing.publishing_mutation_record IN ROW EXCLUSIVE MODE NOWAIT",
            ),
            { code: "55P03" },
          );
        } finally {
          await admin.query("ROLLBACK");
        }
      });
      await assert.rejects(store.resolveCurrentRelease({ ...query, purposeCode: "OTHER_PURPOSE" }));
      // Approval's publish-time window is not an invented runtime release expiration.
      assert.equal(
        (await store.resolveCurrentRelease({ ...query, observedAt: "2026-09-11T12:00:00.000Z" }))
          .release.releaseId,
        id(22),
      );
      async function prepare(n, snapshotReference, snapshotDigest) {
        const draft = { ...base, lifecycleId: id(n), snapshotReference, snapshotDigest };
        const validation = {
          ...publish.validationEvidence,
          evidenceReference: id(n + 10),
          snapshotReference,
          snapshotDigest,
        };
        const review = {
          ...draft,
          state: "InReview",
          version: 2,
          validationEvidenceReference: id(n + 10),
        };
        const approval = {
          ...publish.approvalEvidence,
          evidenceReference: id(n + 11),
          reviewLifecycleId: id(n),
          snapshotReference,
          snapshotDigest,
        };
        const approved = {
          ...review,
          state: "Approved",
          version: 3,
          approvalEvidenceReference: id(n + 11),
        };
        await store.commit(mutation("CreateDraft", null, draft, n + 1));
        await store.commit(
          mutation("SubmitReview", draft, review, n + 3, { validationEvidence: validation }),
        );
        await store.commit(
          mutation("Approve", review, approved, n + 5, { approvalEvidence: approval }),
        );
        return { approved, validation, approval };
      }
      const candidates = [];
      for (const n of [200, 300]) {
        const prepared = await prepare(n, id(n + 12), "sha256:" + "c".repeat(64));
        const next = { ...prepared.approved, state: "Published", version: 4 };
        candidates.push(
          mutation("Publish", prepared.approved, next, n + 7, {
            validationEvidence: prepared.validation,
            approvalEvidence: prepared.approval,
            supersededReleaseId: id(22),
            release: {
              ...release,
              releaseId: id(n + 20),
              sourceLifecycleId: id(n),
              snapshotReference: next.snapshotReference,
              snapshotDigest: next.snapshotDigest,
              sequence: 2,
              previousReleaseId: id(22),
            },
          }),
        );
      }
      const race = await Promise.allSettled(candidates.map((candidate) => store.commit(candidate)));
      assert.equal(race.filter((r) => r.status === "fulfilled").length, 1);
      const winner = candidates[race.findIndex((r) => r.status === "fulfilled")];
      assert.equal(
        (await store.resolveCurrentRelease(query)).release.releaseId,
        winner.release.releaseId,
      );
      await assert.rejects(store.resolveCurrentReleaseForReference(referenceQuery));
      assert.equal(
        (
          await store.resolveCurrentReleaseForReference({
            ...referenceQuery,
            publicationReference: winner.release.releaseId,
          })
        ).current.release.releaseId,
        winner.release.releaseId,
      );
      const prepared = await prepare(400, id(6), base.snapshotDigest);
      const rollbackAt = "2026-09-11T10:05:00.000Z";
      const rolledNext = {
        ...prepared.approved,
        state: "Published",
        version: 4,
        changedAt: rollbackAt,
      };
      const rollback = mutation("Rollback", prepared.approved, rolledNext, 407, {
        validationEvidence: prepared.validation,
        approvalEvidence: prepared.approval,
        supersededReleaseId: winner.release.releaseId,
        rollbackTargetReleaseId: id(22),
        release: {
          ...release,
          kind: "Rollback",
          releaseId: id(420),
          sourceLifecycleId: id(400),
          sequence: 3,
          previousReleaseId: winner.release.releaseId,
          createdAt: rollbackAt,
        },
      });
      rollback.audit = { ...rollback.audit, occurredAt: rollbackAt };
      await assert.rejects(
        store.commit({ ...rollback, rollbackTargetReleaseId: winner.release.releaseId }),
      );
      await store.commit(rollback);
      assert.equal(
        (await store.resolveCurrentRelease({ ...query, observedAt: rollbackAt })).release.releaseId,
        id(420),
      );
      const restored = await store.resolveCurrentReleaseForReference({
        ...referenceQuery,
        observedAt: rollbackAt,
      });
      assert.equal(restored.recorded.release.releaseId, id(22));
      assert.equal(restored.recorded.approvalEvidence.evidenceReference, id(21));
      assert.equal(restored.current.release.releaseId, id(420));
      assert.equal(restored.current.approvalEvidence.evidenceReference, id(411));
      await assert.rejects(store.resolveCurrentReleaseForReference(referenceQuery));
      await assert.rejects(
        store.resolveCurrentReleaseForReference({
          ...referenceQuery,
          publicationReference: winner.release.releaseId,
          observedAt: rollbackAt,
        }),
      );
      const archived = { ...rolledNext, state: "Archived", version: 5 };
      const archive = mutation("Archive", rolledNext, archived, 430);
      archive.audit = { ...archive.audit, occurredAt: rollbackAt };
      await store.commit(archive);
      await assert.rejects(store.resolveCurrentRelease({ ...query, observedAt: rollbackAt }));
      await assert.rejects(
        store.resolveCurrentReleaseForReference({
          ...referenceQuery,
          observedAt: rollbackAt,
        }),
      );
      assert.deepEqual(
        await store.resolveOperation({ ...recovery, observedAt: rollbackAt }),
        first,
      );

      const foreign = createPostgresPublishingMutationStore(runner(), id(90), scope);
      await assert.rejects(
        foreign.commit(
          mutation("Archive", published, { ...published, version: 5, state: "Archived" }, 60),
        ),
      );
      assert.equal(
        (
          await admin.query(
            "SELECT count(*)::int AS n FROM bop_publishing.publishing_mutation_record",
          )
        ).rows[0].n,
        16,
      );
      assert.equal(
        (await admin.query("SELECT count(*)::int AS n FROM platform_audit.audit_record")).rows[0].n,
        16,
      );

      // Milestone56: independent recorded approval from actual owning Brand history.
      const brandScope56 = { kind: "Brand", brandReference: id(2), storeReference: null },
        owner56 = createPostgresPublishingMutationStore(runner(), id(1), brandScope56),
        codes56 = [
          "CURRENT_REFERENCES",
          "RULE_SATISFIABILITY",
          "SCOPE_TOPOLOGY",
          "PUBLISHING_POLICY",
          "INDEPENDENT_APPROVAL",
        ],
        vUntil56 = "2026-09-11T10:20:00.000Z",
        aUntil56 = "2026-09-11T10:30:00.000Z";
      function brandAudit56(audit) {
        const v = { ...audit };
        delete v.storeId;
        return v;
      }
      async function approved56(seed, actor) {
        const draft = {
            ...base,
            lifecycleId: id(seed),
            familyReference: id(seed + 1),
            snapshotReference: id(seed + 2),
            scope: brandScope56,
            configurationType: "CATALOG_OPTION_SET",
            purposeCode: "CATALOG_OPTION_SET_PUBLICATION",
          },
          review = {
            ...draft,
            version: 2,
            state: "InReview",
            validationEvidenceReference: id(seed + 3),
          },
          approved = {
            ...review,
            version: 3,
            state: "Approved",
            approvalEvidenceReference: id(seed + 4),
          },
          validation = {
            evidenceReference: id(seed + 3),
            snapshotReference: draft.snapshotReference,
            snapshotDigest: draft.snapshotDigest,
            scope: brandScope56,
            result: "Pass",
            checkedAt: at,
            validUntil: vUntil56,
            checkCodes: codes56,
          },
          approval = {
            evidenceReference: id(seed + 4),
            reviewLifecycleId: draft.lifecycleId,
            reviewVersion: 2,
            snapshotReference: draft.snapshotReference,
            snapshotDigest: draft.snapshotDigest,
            scope: brandScope56,
            decision: "Accepted",
            approvedActorReference: actor,
            approvedAt: at,
            validUntil: aUntil56,
          };
        for (const [op, cur, next, n, extra] of [
          ["CreateDraft", null, draft, seed + 10, {}],
          ["SubmitReview", draft, review, seed + 20, { validationEvidence: validation }],
          ["Approve", review, approved, seed + 30, { approvalEvidence: approval }],
        ]) {
          const m = mutation(op, cur, next, n, extra);
          await owner56.commit({
            ...m,
            audit: {
              ...brandAudit56(m.audit),
              actor: { type: "User", reference: op === "Approve" ? actor : id(7) },
            },
          });
        }
        return {
          draft,
          approved,
          validation,
          approval,
          request: {
            familyReference: draft.familyReference,
            lifecycleReference: draft.lifecycleId,
            configurationType: draft.configurationType,
            purposeCode: draft.purposeCode,
            snapshotReference: draft.snapshotReference,
            snapshotDigest: draft.snapshotDigest,
            requiredCheckCodes: codes56,
            observedAt: at,
          },
        };
      }
      async function state56() {
        const result = [];
        for (const table of [
          "bop_publishing.publishing_mutation_record",
          "platform_audit.audit_record",
          "platform_audit.audit_chain_head",
        ]) {
          result.push(
            (
              await admin.query(
                "SELECT COALESCE(jsonb_agg(to_jsonb(t) ORDER BY to_jsonb(t)::text),'[]'::jsonb) value FROM " +
                  table +
                  " t",
              )
            ).rows[0].value,
          );
        }
        return result;
      }
      const fixture56 = await approved56(9000, id(8)),
        self56 = await approved56(9100, id(7)),
        before56 = await state56(),
        proof56 = await owner56.resolveCurrentIndependentApproval(fixture56.request);
      assert.equal(proof56.requestedByActorReference, id(7));
      assert.equal(proof56.approvedByActorReference, id(8));
      assert.equal(proof56.recordedIndependence, "Verified");
      assert.equal(proof56.validUntil, vUntil56);
      assert.equal(proof56.currentValidation, "NotEvaluated");
      assert.equal(proof56.referenceEligibility, "NotEvaluated");
      assert.deepEqual(proof56.validationCheckCodes, [...codes56].sort());
      assert.ok(Object.isFrozen(proof56));
      assert.deepEqual(await state56(), before56, "current approval read writes no history");
      assert.equal(
        (await owner56.resolveCurrentApproval(self56.request)).approvalEvidence
          .approvedActorReference,
        id(7),
      );
      await assert.rejects(owner56.resolveCurrentIndependentApproval(self56.request));
      for (const patch of [
        { snapshotReference: id(999) },
        { snapshotDigest: "sha256:" + "b".repeat(64) },
        { requiredCheckCodes: ["SCHEMA_VALID"] },
        { observedAt: vUntil56 },
        { observedAt: aUntil56 },
      ])
        await assert.rejects(
          owner56.resolveCurrentIndependentApproval({ ...fixture56.request, ...patch }),
        );
      assert.equal(
        (
          await owner56.resolveCurrentIndependentApproval({
            ...fixture56.request,
            observedAt: "2026-09-11T10:19:59.999Z",
          })
        ).validUntil,
        vUntil56,
      );
      await assert.rejects(
        createPostgresPublishingMutationStore(
          runner(),
          id(99),
          brandScope56,
        ).resolveCurrentIndependentApproval(fixture56.request),
      );
      await assert.rejects(
        createPostgresPublishingMutationStore(
          runner(),
          id(1),
          scope,
        ).resolveCurrentIndependentApproval(fixture56.request),
      );
      await assert.rejects(
        createPostgresPublishingMutationStore(
          runner({ corruptIntentAt: "lifecycle_version IN" }),
          id(1),
          brandScope56,
        ).resolveCurrentIndependentApproval(fixture56.request),
      );
      const rollbackState56 = await state56(),
        caller56 = new Client(context.clientConfig);
      await caller56.connect();
      let reached56 = false;
      try {
        await caller56.query("BEGIN");
        await caller56.query("SET LOCAL ROLE " + role);
        const tx56 = { query: (sql, values) => caller56.query(sql, [...values]) },
          held56 = createPostgresPublishingMutationStore(
            { run: (work) => work(tx56) },
            id(1),
            brandScope56,
          );
        await held56.resolveCurrentIndependentApproval(fixture56.request);
        const next56 = { ...fixture56.approved, version: 4, state: "Published" },
          release56 = {
            releaseId: id(9200),
            familyReference: next56.familyReference,
            configurationType: next56.configurationType,
            purposeCode: next56.purposeCode,
            snapshotReference: next56.snapshotReference,
            snapshotDigest: next56.snapshotDigest,
            scope: brandScope56,
            sequence: 1,
            sourceLifecycleId: next56.lifecycleId,
            kind: "Publish",
            previousReleaseId: null,
            createdAt: at,
          },
          change56 = mutation("Publish", fixture56.approved, next56, 9210, {
            validationEvidence: fixture56.validation,
            approvalEvidence: fixture56.approval,
            release: release56,
          });
        await held56.commit({ ...change56, audit: brandAudit56(change56.audit) });
        assert.equal(
          (
            await caller56.query(
              "SELECT lifecycle_version FROM bop_publishing.publishing_mutation_record WHERE tenant_id=$1 AND brand_id=$2 AND lifecycle_id=$3 ORDER BY lifecycle_version DESC LIMIT 1",
              [id(1), id(2), fixture56.draft.lifecycleId],
            )
          ).rows[0].lifecycle_version,
          "4",
        );
        reached56 = true;
        await assert.rejects(held56.resolveCurrentIndependentApproval(fixture56.request));
      } finally {
        await caller56.query("ROLLBACK");
        await caller56.end();
      }
      assert.ok(reached56, "actual owning head advance reached before final refusal");
      assert.deepEqual(
        await state56(),
        rollbackState56,
        "late refusal outer rollback restores Publishing/Audit chain exactly",
      );
    } finally {
      if (created) {
        await admin.query("DROP OWNED BY " + role);
        await admin.query("DROP ROLE " + role);
      }
      await admin.end();
    }
  });
});

it("binds actual Tenant metadata to the current Publishing head in one held transaction", async () => {
  await withIsolatedDatabase({ caseId: "wp2421_brand_content" }, async (context) => {
    const admin = new Client(context.clientConfig);
    const editor = new Client(context.clientConfig);
    await admin.connect();
    await editor.connect();
    const role = "wp2421_brand_content_" + context.runId;
    let created = false,
      now = at,
      allowed = true,
      commits = 0;
    try {
      await admin.query("CREATE ROLE " + role + " NOLOGIN NOSUPERUSER NOBYPASSRLS");
      created = true;
      await admin.query(
        "GRANT USAGE ON SCHEMA bop_tenant,bop_publishing,platform_audit,platform_helpers TO " +
          role,
      );
      await admin.query("GRANT SELECT,UPDATE(version) ON bop_tenant.brand TO " + role);
      await admin.query("GRANT SELECT ON bop_tenant.brand_configuration_version TO " + role);
      await admin.query(
        "GRANT SELECT,INSERT,UPDATE ON bop_publishing.publishing_mutation_record TO " + role,
      );
      await admin.query("GRANT SELECT,INSERT ON platform_audit.audit_record TO " + role);
      await admin.query("GRANT SELECT,INSERT,UPDATE ON platform_audit.audit_chain_head TO " + role);
      await admin.query(
        "GRANT EXECUTE ON FUNCTION platform_helpers.current_brand_id(),platform_helpers.current_store_id(),platform_helpers.is_uuid_v7(uuid) TO " +
          role,
      );
      await admin.query("GRANT USAGE ON TYPE platform_helpers.uuid_v7 TO " + role);
      await admin.query(
        "INSERT INTO bop_tenant.brand VALUES($1,'SOURCE','Synthetic source Brand','en-CA','CAD','Active',1,$2,$2)",
        [id(2), at],
      );
      const runner = {
        async run(work) {
          const client = new Client(context.clientConfig);
          await client.connect();
          try {
            await client.query("BEGIN");
            await client.query("SET LOCAL ROLE " + role);
            const result = await work({ query: (sql, values) => client.query(sql, [...values]) });
            await client.query("COMMIT");
            commits++;
            return result;
          } catch (error) {
            await client.query("ROLLBACK");
            throw error;
          } finally {
            await client.end();
          }
        },
      };
      const scope = { kind: "Brand", brandReference: id(2), storeReference: null };
      const publisher = createPostgresPublishingMutationStore(runner, id(1), scope);
      const configuration = (n, version, previous) => ({
        configurationVersionReference: id(n),
        brandReference: id(2),
        configurationVersion: version,
        lifecycle: "Published",
        defaultLocale: "en-CA",
        supportedLocales: ["en-CA", "fr-CA"],
        mediaThemeReference: null,
        catalogSourceReference: id(12),
        platformTemplateReference: id(13),
        overrideAllowedFieldCodes: ["DISPLAY.THEME"],
        hardRequirementFieldCodes: ["SECURITY.REAUTH"],
        effectiveFrom: at,
        effectiveUntil: "2026-09-11T10:00:20.000Z",
        supersedesVersionReference: previous,
        reasonCode: "SYNTHETIC_CONFIGURATION",
        authoredByReference: id(20),
        approvedByReference: id(21),
        approvalEvidenceReference: id(n + 1),
        publicationReference: id(n + 2),
        createdAt: at,
        updatedAt: at,
        dataClassification: "ConfigurationMetadata",
      });
      async function publish(c, n, previous = null, rollbackTarget = null, policyContent = null) {
        const occurredAt = rollbackTarget
          ? "2026-09-11T10:00:10.000Z"
          : previous
            ? "2026-09-11T10:00:05.000Z"
            : at;
        const draft = {
          lifecycleId: id(n),
          familyReference: policyContent?.familyReference ?? id(4),
          configurationType: policyContent ? "PRODUCT_PUBLICATION_POLICY" : "BRAND_CONFIGURATION",
          purposeCode: policyContent ? "PRODUCT_PUBLICATION_POLICY" : "BRAND_CONFIGURATION",
          snapshotReference: c.configurationVersionReference,
          snapshotDigest: policyContent
            ? publishingProductPublicationPolicyDigest(policyContent)
            : tenantBrandConfigurationContentDigest(c),
          scope,
          version: 1,
          state: "Draft",
          validationEvidenceReference: null,
          approvalEvidenceReference: null,
          createdAt: occurredAt,
          changedAt: occurredAt,
        };
        const mutation = (operation, current, next, offset, extra = {}) => ({
          operation,
          expectedVersion: current?.version ?? 1,
          idempotencyKey: id(n + offset),
          current,
          next,
          release: null,
          supersededReleaseId: null,
          rollbackTargetReleaseId: null,
          validationEvidence: null,
          approvalEvidence: null,
          audit: {
            auditId: id(n + offset + 1),
            brandId: id(2),
            actor: {
              type: "User",
              reference:
                operation === "CreateDraft" || operation === "SubmitReview" ? id(20) : id(21),
            },
            actionCode: {
              CreateDraft: "PUBLISHING_DRAFT_CREATED",
              SubmitReview: "PUBLISHING_REVIEW_SUBMITTED",
              Approve: "PUBLISHING_REVIEW_APPROVED",
              Publish: "PUBLISHING_RELEASE_PUBLISHED",
              Rollback: "PUBLISHING_RELEASE_ROLLED_BACK",
              Archive: "PUBLISHING_RELEASE_ARCHIVED",
            }[operation],
            targetType: "PublishingLifecycle",
            targetId: next.lifecycleId,
            reasonCode: "SYNTHETIC_TEST",
            correlationId: id(n + offset),
            occurredAt,
            sourceChannel: "MERCHANT_WEB",
            dataClassification: "Confidential",
            retentionPolicyCode: "PUBLISHING_LIFECYCLE_AUDIT",
            retentionPolicyVersion: 1,
          },
          ...extra,
        });
        const validation = {
          evidenceReference: id(n + 10),
          snapshotReference: draft.snapshotReference,
          snapshotDigest: draft.snapshotDigest,
          scope,
          result: "Pass",
          checkedAt: occurredAt,
          validUntil: until,
          checkCodes: ["SCHEMA_VALID"],
        };
        const review = {
          ...draft,
          version: 2,
          state: "InReview",
          validationEvidenceReference: validation.evidenceReference,
        };
        const approval = {
          evidenceReference: rollbackTarget ? id(n + 11) : c.approvalEvidenceReference,
          reviewLifecycleId: draft.lifecycleId,
          reviewVersion: 2,
          snapshotReference: draft.snapshotReference,
          snapshotDigest: draft.snapshotDigest,
          scope,
          decision: "Accepted",
          approvedActorReference: id(21),
          approvedAt: occurredAt,
          validUntil: until,
        };
        const approved = {
          ...review,
          version: 3,
          state: "Approved",
          approvalEvidenceReference: approval.evidenceReference,
        };
        const next = { ...approved, version: 4, state: "Published" };
        const release = {
          releaseId: rollbackTarget ? id(n + 12) : c.publicationReference,
          familyReference: draft.familyReference,
          configurationType: draft.configurationType,
          purposeCode: draft.purposeCode,
          snapshotReference: draft.snapshotReference,
          snapshotDigest: draft.snapshotDigest,
          scope,
          sequence: previous ? previous.sequence + 1 : 1,
          sourceLifecycleId: draft.lifecycleId,
          kind: rollbackTarget ? "Rollback" : "Publish",
          previousReleaseId: previous?.releaseId ?? null,
          createdAt: occurredAt,
        };
        await publisher.commit(
          mutation(
            "CreateDraft",
            null,
            draft,
            1,
            policyContent ? { productPolicyContent: policyContent } : {},
          ),
        );
        await publisher.commit(
          mutation("SubmitReview", draft, review, 3, { validationEvidence: validation }),
        );
        await publisher.commit(
          mutation("Approve", review, approved, 5, { approvalEvidence: approval }),
        );
        await publisher.commit(
          mutation(release.kind, approved, next, 7, {
            validationEvidence: validation,
            approvalEvidence: approval,
            release,
            supersededReleaseId: previous?.releaseId ?? null,
            rollbackTargetReleaseId: rollbackTarget,
          }),
        );
        return { release, next, mutation };
      }
      async function record(c) {
        // Immutable metadata seed only: actual ordinary Tenant configuration writer is still absent.
        await admin.query(
          `INSERT INTO bop_tenant.brand_configuration_version(
          configuration_version_id,brand_id,configuration_version,lifecycle,default_locale,supported_locales,
          media_theme_reference,catalog_source_reference,platform_template_reference,override_allowed_field_codes,
          hard_requirement_field_codes,effective_from,effective_until,supersedes_version_reference,reason_code,
          authored_by_reference,approved_by_reference,approval_evidence_reference,publication_reference,created_at,updated_at,data_classification)
          VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22)`,
          [
            c.configurationVersionReference,
            c.brandReference,
            c.configurationVersion,
            c.lifecycle,
            c.defaultLocale,
            c.supportedLocales,
            c.mediaThemeReference,
            c.catalogSourceReference,
            c.platformTemplateReference,
            c.overrideAllowedFieldCodes,
            c.hardRequirementFieldCodes,
            c.effectiveFrom,
            c.effectiveUntil,
            c.supersedesVersionReference,
            c.reasonCode,
            c.authoredByReference,
            c.approvedByReference,
            c.approvalEvidenceReference,
            c.publicationReference,
            c.createdAt,
            c.updatedAt,
            c.dataClassification,
          ],
        );
      }
      const first = configuration(600, 1, null);
      const initial = await publish(first, 1000);
      await record(first);
      const request = (c = first, patch = {}) => ({
        tenantReference: id(1),
        brandReference: id(2),
        actorReference: id(20),
        purposeCode: "CATALOG_PRODUCT_CONTENT",
        configurationVersionReference: c.configurationVersionReference,
        expectedBrandVersion: 1,
        originalIntentDigest: "sha256:" + "e".repeat(64),
        observedAt: now,
        validUntil: "2026-09-11T10:00:30.000Z",
        ...patch,
      });
      const recordedSource = createPostgresTenantBrandConfigurationContentSource({
        brandReference: id(2),
        clock: () => now,
        transactions: runner,
        // Current Actor/field holder is explicitly synthetic; owning SQL/Publishing barriers are actual.
        authority: {
          withCurrentContentRead: async (_request, fields, work) => {
            assert.deepEqual(fields, tenantBrandConfigurationRequiredFields);
            if (!allowed) throw new Error("synthetic authority denied");
            return work();
          },
          isCurrent: async (_tx, r, fields) =>
            allowed &&
            r.tenantReference === id(1) &&
            r.actorReference === id(20) &&
            fields.length === tenantBrandConfigurationRequiredFields.length,
        },
      });
      const content = createCurrentBrandConfigurationContentSource(recordedSource);
      const read = (r = request(), work = async (value) => value) =>
        content.withCurrentContent(r, work);
      const beforeRead = commits;
      const observed = await read(request(), async (value) => {
        await editor.query("BEGIN");
        try {
          await assert.rejects(
            editor.query(
              "SELECT brand_id FROM bop_tenant.brand WHERE brand_id=$1 FOR UPDATE NOWAIT",
              [id(2)],
            ),
            { code: "55P03" },
          );
        } finally {
          await editor.query("ROLLBACK");
        }
        await editor.query("BEGIN");
        try {
          await assert.rejects(
            editor.query(
              "LOCK TABLE bop_publishing.publishing_mutation_record IN ROW EXCLUSIVE MODE NOWAIT",
            ),
            { code: "55P03" },
          );
        } finally {
          await editor.query("ROLLBACK");
        }
        return value;
      });
      assert.equal(commits - beforeRead, 1, "one outer UoW, no nested source commit");
      assert.equal(observed.defaultLocale, "en-CA");
      assert.deepEqual(observed.supportedLocales, ["en-CA", "fr-CA"]);
      assert.equal(observed.contentDigest, tenantBrandConfigurationContentDigest(first));
      assert.equal(observed.currentPublicationReference, first.publicationReference);
      assert.equal(
        observed.validUntil,
        first.effectiveUntil,
        "metadata expiry narrows observation validity",
      );
      assert.equal(observed.eligibility, "NotEvaluated");
      assert.equal(Object.hasOwn(observed, "authoredByReference"), false);
      assert.equal(Object.hasOwn(observed, "approvedByReference"), false);
      // Actual two-owner content-policy acquisition; Catalog candidate and current Actor holders remain synthetic.
      const body = {
        profile: "PublishingProductPublicationPolicyV1",
        tenantReference: id(1),
        brandReference: id(2),
        familyReference: id(2300),
        policyReference: id(2301),
        policyVersion: 1,
        scopeOrder: productPolicyScopeLevels,
        approvalPolicy: "Required",
        warningOverrideAllowed: false,
        requiredLocales: ["en-CA", "fr-CA"],
        mediaRequirement: "Required",
        effectiveFrom: at,
        effectiveUntil: "2026-09-11T10:00:25.000Z",
      };
      const policyRelease = await publish(
        {
          configurationVersionReference: body.policyReference,
          approvalEvidenceReference: id(2600),
          publicationReference: id(2601),
        },
        2400,
        null,
        null,
        body,
      );
      const currentPolicy = createCurrentProductPublicationPolicySource({
        tenantReference: id(1),
        brandReference: id(2),
        actorReference: id(20),
        actorKind: "User",
        clock: { now: () => now },
        authority: {
          async holdUntilTransactionCompletes() {
            if (!allowed) throw new Error("synthetic current policy authority denied");
          },
        },
      });
      const currentAssessment = createCurrentProductContentPolicySource({
        brandSource: content,
        policySource: currentPolicy,
        clock: { now: () => now },
      });
      const candidate = {
        productReference: id(2700),
        brandReference: id(2),
        internalCode: "CONTENT_POLICY",
        productType: "PreparedFood",
        lifecycle: "Draft",
        aggregateVersion: 1,
        createdAt: at,
        createdByActorReference: id(20),
        updatedAt: at,
        draft: {
          versionReference: id(2701),
          baseVersionReference: null,
          status: "Draft",
          defaultLocale: "en-CA",
          localizedNames: { "en-CA": "Synthetic policy candidate" },
          taxClassificationReference: null,
          skus: [],
          optionBindings: [],
          createdAt: at,
          updatedAt: at,
          editorContent: {
            profile: "CatalogProductEditorContentV1",
            localizedShortDescriptions: {},
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
      };
      const assessmentInput = (aggregate = candidate) => {
        const identity = deriveCatalogProductPublicationContentIdentity(aggregate);
        return {
          aggregate,
          binding: {
            tenantReference: id(1),
            productReference: aggregate.productReference,
            versionReference: aggregate.draft.versionReference,
            expectedAggregateVersion: aggregate.aggregateVersion,
            contentDigest: identity.contentDigest,
            configurationDigest: identity.configurationDigest,
            originalIntentDigest: request().originalIntentDigest,
            observedAt: now,
            validUntil: "2026-09-11T10:00:30.000Z",
          },
          brandRequest: request(),
          policyRequest: {
            policyReference: body.policyReference,
            policyVersion: 1,
            observedAt: now,
          },
        };
      };
      let expireAtBrandFinalAuthority = false,
        shortLeaseConsumerCompleted = false;
      const shortBindingExpiry = "2026-09-11T10:00:10.000Z";
      const outerSource = (tx, repeatBrand = false) => {
        const heldBrand = createCurrentBrandConfigurationContentSource(
          createPostgresTenantBrandConfigurationContentSource({
            brandReference: id(2),
            clock: () => now,
            transactions: { run: (work) => work(tx) },
            authority: {
              withCurrentContentRead: async (_request, _fields, work) => {
                if (!allowed) throw new Error("synthetic denied");
                const result = await work();
                if (expireAtBrandFinalAuthority && shortLeaseConsumerCompleted)
                  now = shortBindingExpiry;
                return result;
              },
              isCurrent: async () => allowed,
            },
          }),
        );
        return createCurrentProductContentPolicySource({
          brandSource: repeatBrand
            ? {
                async withCurrentContent(request, work) {
                  return heldBrand.withCurrentContent(request, async (value, sourceTx) => {
                    const completed = await work(value, sourceTx);
                    try {
                      return await work(value, sourceTx);
                    } catch {
                      return completed;
                    }
                  });
                },
              }
            : heldBrand,
          policySource: currentPolicy,
          clock: { now: () => now },
        });
      };
      const assess = (aggregate = candidate, work = async (value) => value) =>
        runner.run((tx) =>
          outerSource(tx).withCurrentAssessment(tx, assessmentInput(aggregate), work),
        );
      const beforeAssessment = commits;
      const policyObserved = await assess();
      assert.equal(commits - beforeAssessment, 1, "both actual current owners share outer COMMIT");
      assert.equal(policyObserved.validUntil, first.effectiveUntil);
      assert.equal(policyObserved.decision, "HardError");
      assert.equal(
        policyObserved.checks.find((c) => c.code === "RequiredProductNames").outcome,
        "HardError",
      );
      assert.equal(
        policyObserved.checks.find((c) => c.code === "RequiredMediaPresence").outcome,
        "HardError",
      );
      assert.equal(policyObserved.publishValidation, "Incomplete");
      assert.equal(policyObserved.warningOverrideAllowed, false);
      assert.equal(policyObserved.mediaReadiness, "NotEvaluated");
      // Actual Product candidate joins the two current owners; authorization holders
      // and Tenant final Published metadata authoring remain controlled synthetic background.
      await admin.query("GRANT USAGE ON SCHEMA rms_catalog,platform_eventing TO " + role);
      await admin.query(
        "GRANT SELECT,INSERT,UPDATE ON rms_catalog.product,rms_catalog.product_version,rms_catalog.sku,rms_catalog.product_option_binding,rms_catalog.product_option_binding_option,rms_catalog.product_option_binding_sku_scope,rms_catalog.product_option_binding_channel,rms_catalog.product_version_category_assignment,rms_catalog.product_source_head TO " +
          role,
      );
      await admin.query(
        "GRANT SELECT,INSERT ON rms_catalog.product_operation_record,rms_catalog.product_operation_snapshot,rms_catalog.product_source_commit,platform_eventing.outbox_event TO " +
          role,
      );
      await admin.query(
        "GRANT DELETE ON rms_catalog.sku,rms_catalog.product_option_binding,rms_catalog.product_option_binding_option,rms_catalog.product_option_binding_sku_scope,rms_catalog.product_option_binding_channel TO " +
          role,
      );
      const storedCandidate = parseProductAggregate(candidate);
      const candidateAudit = (operation) => ({
        auditId: id(operation + 1),
        brandId: id(2),
        actor: { type: "User", reference: id(20) },
        actionCode: operation === 2900 ? "CATALOG_PRODUCT_CREATE" : "CATALOG_PRODUCT_REPLACEDRAFT",
        targetType: "CatalogProduct",
        targetId: storedCandidate.productReference,
        correlationId: id(operation),
        occurredAt: at,
        reasonCode: "SYNTHETIC_CANDIDATE",
        sourceChannel: "MERCHANT_WEB",
        dataClassification: "Confidential",
        retentionPolicyCode: "CATALOG_CONFIGURATION",
        retentionPolicyVersion: 1,
      });
      const candidateEditorAuthority = {
        async holdUntilTransactionCompletes() {
          if (!allowed) throw new CatalogError("CATALOG_PERMISSION_DENIED");
        },
      };
      await createPostgresProductCreationStore({
        brandReference: id(2),
        transactions: runner,
        authorize: async () => allowed,
        editorContentAuthority: candidateEditorAuthority,
      }).create({
        record: {
          action: "Create",
          operationReference: id(2900),
          operationIntentHash: sha256Hex("synthetic actual candidate create"),
          aggregate: storedCandidate,
        },
        audit: candidateAudit(2900),
      });
      let candidateAllowed = true,
        expireAtCandidateFinalAuthority = false,
        candidateConsumerCompleted = false;
      const actualCommand = {
        purposeCode: "CATALOG_PRODUCT_VERSION_PUBLICATION",
        tenantReference: id(1),
        brandReference: id(2),
        actorReference: id(20),
        actorKind: "User",
        operationReference: id(2902),
        productReference: storedCandidate.productReference,
        versionReference: storedCandidate.draft.versionReference,
        expectedProductAggregateVersion: 1,
        expectedPublicationVersion: 0,
        action: "Validate",
        contentDigest:
          deriveCatalogProductPublicationContentIdentity(storedCandidate).contentDigest,
        configurationDigest:
          deriveCatalogProductPublicationContentIdentity(storedCandidate).configurationDigest,
        scopeSet: [{ level: "Brand", reference: null, channelCodes: [], orderTypeCodes: [] }],
        effectivePeriod: {
          timeZone: "UTC",
          effectiveFrom: { instant: at, localDateTime: at.slice(0, 23), utcOffsetMinutes: 0 },
          effectiveUntil: null,
        },
        scheduleReference: null,
        replacementVersionReference: null,
        successorDraftVersionReference: null,
        occurredAt: at,
        reasonCode: "SYNTHETIC_VALIDATE",
      };
      const actualInput = {
        command: actualCommand,
        configurationVersionReference: first.configurationVersionReference,
        expectedBrandVersion: 1,
        policyReference: body.policyReference,
        policyVersion: 1,
      };
      let reverseAtCandidateFinalAuthority = false;
      const actualCandidateSource = (tx) =>
        createPostgresProductValidationCandidateSource({
          tenantReference: id(1),
          brandReference: id(2),
          actorReference: id(20),
          transactions: { run: (work) => work(tx) },
          clock: { now: () => now },
          authority: {
            async holdUntilTransactionCompletes(actual, input) {
              assert.equal(actual, tx);
              assert.equal(input.actorReference, id(20));
              assert.equal(input.tenantReference, id(1));
              assert.deepEqual(input.requiredFields, productValidationCandidateFields);
              if (!candidateAllowed) throw new CatalogError("CATALOG_PERMISSION_DENIED");
              if (expireAtCandidateFinalAuthority && candidateConsumerCompleted)
                now = first.effectiveUntil;
              if (reverseAtCandidateFinalAuthority && candidateConsumerCompleted)
                now = new Date(Date.parse(at) + 500).toISOString();
            },
          },
        });
      const actualComposition = (tx, rebound = false) => {
        const options = {
          candidateSource: actualCandidateSource(tx),
          policySource: currentPolicy,
          clock: { now: () => now },
          brandSource: createCurrentBrandConfigurationContentSource(
            createPostgresTenantBrandConfigurationContentSource({
              brandReference: id(2),
              clock: () => now,
              transactions: { run: (work) => work(tx) },
              authority: {
                withCurrentContentRead: async (_request, _fields, work) => {
                  if (!allowed) throw Error("synthetic denied");
                  return work();
                },
                isCurrent: async () => allowed,
              },
            }),
          ),
        };
        const source = createCurrentProductCandidateContentPolicySource(options);
        if (rebound) {
          const unavailable = async () => {
            throw Error("synthetic rebound must not be used");
          };
          options.candidateSource = {
            ...options.candidateSource,
            context: { ...options.candidateSource.context, actorReference: id(999) },
            withCurrentCandidate: unavailable,
          };
          options.brandSource = { withCurrentContent: unavailable };
          options.policySource = {
            ...options.policySource,
            context: { ...options.policySource.context, brandReference: id(999) },
            withCurrentPolicy: unavailable,
          };
          options.clock.now = () => first.effectiveUntil;
        }
        return source;
      };
      const beforeActual = commits;
      const actualObserved = await runner.run((tx) =>
        actualComposition(tx, true).withCurrentAssessment(
          tx,
          actualInput,
          async (value, publication) => {
            assert.equal(publication, policyRelease.release.releaseId);
            assert.equal(
              value.originalIntentDigest,
              "sha256:" + sha256Hex(canonicalizeRfc8785(actualCommand)),
            );
            await editor.query("BEGIN");
            try {
              assert.equal(
                (
                  await editor.query(
                    "SELECT pg_try_advisory_xact_lock(hashtextextended($1,0)) acquired",
                    ["CatalogProductSource:" + id(2)],
                  )
                ).rows[0].acquired,
                false,
              );
            } finally {
              await editor.query("ROLLBACK");
            }
            await editor.query("BEGIN");
            try {
              await assert.rejects(
                editor.query(
                  "SELECT brand_id FROM bop_tenant.brand WHERE brand_id=$1 FOR UPDATE NOWAIT",
                  [id(2)],
                ),
                { code: "55P03" },
              );
            } finally {
              await editor.query("ROLLBACK");
            }
            await editor.query("BEGIN");
            try {
              await assert.rejects(
                editor.query(
                  "LOCK TABLE bop_publishing.publishing_mutation_record IN ROW EXCLUSIVE MODE NOWAIT",
                ),
                { code: "55P03" },
              );
            } finally {
              await editor.query("ROLLBACK");
            }
            return value;
          },
        ),
      );
      assert.equal(commits - beforeActual, 1, "Catalog/Tenant/Publishing share one outer COMMIT");
      assert.equal(actualObserved.decision, "HardError");
      assert.equal(actualObserved.publishValidation, "Incomplete");
      assert.equal(actualObserved.mediaReadiness, "NotEvaluated");
      assert.equal(actualObserved.validUntil, first.effectiveUntil);
      const candidateCounts = async () =>
        (
          await admin.query(
            "SELECT (SELECT aggregate_version FROM rms_catalog.product WHERE product_id=$1) root,(SELECT count(*)::integer FROM rms_catalog.product_operation_record WHERE product_id=$1) operations,(SELECT count(*)::integer FROM rms_catalog.product_source_commit WHERE product_id=$1) receipts,(SELECT count(*)::integer FROM rms_catalog.product_operation_snapshot WHERE product_id=$1) snapshots,(SELECT max(source_revision)::text FROM rms_catalog.product_source_head) sourceHead,(SELECT max(next_sequence)::text FROM platform_audit.audit_chain_head) auditChain,(SELECT count(*)::integer FROM platform_audit.audit_record WHERE target_id=$1) audit,(SELECT count(*)::integer FROM platform_eventing.outbox_event WHERE aggregate_id=$1) outbox",
            [storedCandidate.productReference],
          )
        ).rows[0];
      const actualBeforeWrite = await candidateCounts();
      // Milestone124: one real Candidate owner and one already-held Policy owner;
      // exact Tenant metadata/current Publishing head is acquired by the new stage.
      // Remaining twelve-check placeholders/current field holders are synthetic.
      const heldContentValidation = (tx, work) => {
        let candidateCallbacks = 0,
          policyCallbacks = 0;
        const held = createCurrentProductHeldContentPolicySource(
          {
            configurationVersionReference: first.configurationVersionReference,
            expectedBrandVersion: 1,
            brandAuthority: {
              async withCurrentContentRead(request, fields, read) {
                assert.equal(request.purposeCode, "CATALOG_PRODUCT_CONTENT");
                assert.equal(request.actorReference, id(20));
                assert.equal(
                  request.originalIntentDigest,
                  "sha256:" + sha256Hex(canonicalizeRfc8785(actualCommand)),
                );
                assert.ok(fields.includes("supportedLocales"));
                if (!allowed) throw Error("synthetic current Brand field denial");
                return read();
              },
              isCurrent: async () => allowed,
            },
          },
          { now: () => now },
        );
        return actualCandidateSource(tx).withCurrentCandidate(
          actualCommand,
          async (candidate, actual) => {
            assert.equal(actual, tx);
            assert.equal(++candidateCallbacks, 1);
            return currentPolicy.withCurrentPolicy(
              tx,
              {
                policyReference: body.policyReference,
                policyVersion: 1,
                observedAt: now,
              },
              async (policy) => {
                assert.equal(++policyCallbacks, 1);
                return held.withHeldAssessment(
                  tx,
                  actualCommand,
                  candidate,
                  policy,
                  async (assessment) => {
                    const validation = applyCatalogProductContentPolicyValidation(
                      actualCommand,
                      parseProductPublicationValidation({
                        evidenceReference: id(2990),
                        productAggregateVersion: 1,
                        contentDigest: actualCommand.contentDigest,
                        configurationDigest: actualCommand.configurationDigest,
                        scopeDigest:
                          "sha256:" + sha256Hex(canonicalizeRfc8785(actualCommand.scopeSet)),
                        periodDigest:
                          "sha256:" + sha256Hex(canonicalizeRfc8785(actualCommand.effectivePeriod)),
                        policyReference: body.policyReference,
                        policyVersion: 1,
                        approvalPolicy: "Required",
                        checks: productPublicationCheckCodes.map((code) => ({
                          code,
                          outcome: "Pass",
                        })),
                        warningAcknowledgement: null,
                        checkedAt: now,
                        validUntil: new Date(Date.parse(now) + 30000).toISOString(),
                      }),
                      assessment,
                      now,
                    );
                    assert.equal(
                      validation.checks.find((c) => c.code === "DefaultLocaleName").outcome,
                      "HardError",
                    );
                    assert.equal(
                      validation.checks.find((c) => c.code === "MediaReady").outcome,
                      "HardError",
                    );
                    assert.equal(
                      validation.checks.find((c) => c.code === "HardErrorsCleared").outcome,
                      "HardError",
                    );
                    assert.equal(validation.validUntil, first.effectiveUntil);
                    assert.equal(assessment.mediaReadiness, "NotEvaluated");
                    return work(validation);
                  },
                );
              },
            );
          },
        );
      };
      const beforeHeld = commits;
      await runner.run((tx) => heldContentValidation(tx, async (validation) => validation));
      assert.equal(
        commits - beforeHeld,
        1,
        "held Candidate, Policy and Brand use one outer COMMIT",
      );
      const tentativeWrite = (tx) =>
        createPostgresProductDraftStore({
          brandReference: id(2),
          transactions: { run: (work) => work(tx) },
          authorize: async () => allowed,
          editorContentAuthority: candidateEditorAuthority,
        }).commit({
          record: {
            action: "ReplaceDraft",
            operationReference: id(2910),
            operationIntentHash: sha256Hex("synthetic three owner rollback"),
            aggregate: parseProductAggregate({
              ...storedCandidate,
              aggregateVersion: 2,
              draft: { ...storedCandidate.draft, localizedNames: { "en-CA": "Rollback only" } },
            }),
          },
          expectedAggregateVersion: 1,
          audit: candidateAudit(2910),
        });
      for (const late of [
        () => {
          allowed = false;
        },
        () => {
          now = first.effectiveUntil;
        },
      ]) {
        now = at;
        allowed = true;
        await assert.rejects(
          runner.run((tx) =>
            heldContentValidation(tx, async () => {
              await tentativeWrite(tx);
              assert.equal(
                (
                  await tx.query(
                    "SELECT aggregate_version::text root FROM rms_catalog.product WHERE product_id=$1",
                    [storedCandidate.productReference],
                  )
                ).rows[0].root,
                "2",
              );
              assert.equal(
                String((await candidateCounts()).root),
                "1",
                "tentative owning write is uncommitted",
              );
              late();
              return null;
            }),
          ),
        );
        now = at;
        allowed = true;
        assert.deepEqual(
          await candidateCounts(),
          actualBeforeWrite,
          "late held content-policy refusal rolls back root/history/Audit/Outbox",
        );
      }
      for (const late of [
        () => {
          candidateAllowed = false;
        },
        () => {
          allowed = false;
        },
        () => {
          now = first.effectiveUntil;
        },
      ]) {
        const beforeLateCommit = commits;
        let completedWrites = 0,
          consumerFailure;
        await assert.rejects(
          runner.run((tx) =>
            actualComposition(tx).withCurrentAssessment(tx, actualInput, async () => {
              try {
                const written = await tentativeWrite(tx);
                assert.equal(written.aggregate.aggregateVersion, 2);
                completedWrites++;
                late();
              } catch (error) {
                consumerFailure = error;
                throw error;
              }
            }),
          ),
        );
        if (consumerFailure) throw consumerFailure;
        assert.equal(completedWrites, 1);
        candidateAllowed = true;
        allowed = true;
        now = at;
        assert.equal(commits, beforeLateCommit);
        assert.deepEqual(await candidateCounts(), actualBeforeWrite);
      }
      // Both instants are within all actual source leases; only the original monotonic guard rejects.
      reverseAtCandidateFinalAuthority = true;
      let reverseWrites = 0;
      const beforeReverseCommit = commits;
      await assert.rejects(
        runner.run((tx) =>
          actualComposition(tx).withCurrentAssessment(tx, actualInput, async () => {
            const written = await tentativeWrite(tx);
            assert.equal(written.aggregate.aggregateVersion, 2);
            reverseWrites++;
            now = new Date(Date.parse(at) + 1000).toISOString();
            candidateConsumerCompleted = true;
          }),
        ),
        { code: "CATALOG_DEPENDENCY_UNAVAILABLE" },
      );
      assert.equal(reverseWrites, 1);
      assert.equal(commits, beforeReverseCommit);
      assert.deepEqual(await candidateCounts(), actualBeforeWrite);
      reverseAtCandidateFinalAuthority = false;
      candidateConsumerCompleted = false;
      now = at;
      // Assert inside the outer UoW: even the pre-repair unexpected success
      // cannot commit a tentative write in this controlled reproduction.
      expireAtCandidateFinalAuthority = true;
      let finalCandidateWrites = 0,
        finalConsumerFailure;
      const beforeFinalCandidate = commits;
      await runner
        .run(async (tx) => {
          await assert.rejects(
            actualComposition(tx).withCurrentAssessment(tx, actualInput, async () => {
              try {
                const written = await tentativeWrite(tx);
                assert.equal(written.aggregate.aggregateVersion, 2);
              } catch (error) {
                finalConsumerFailure = error;
                throw error;
              }
              finalCandidateWrites++;
              candidateConsumerCompleted = true;
            }),
            { code: "CATALOG_DEPENDENCY_UNAVAILABLE" },
          );
          if (finalConsumerFailure) throw finalConsumerFailure;
          throw new Error("SYNTHETIC_EXPECTED_OUTER_ROLLBACK");
        })
        .catch((error) => {
          if (finalConsumerFailure) throw finalConsumerFailure;
          assert.equal(error.message, "SYNTHETIC_EXPECTED_OUTER_ROLLBACK");
        });
      assert.equal(finalCandidateWrites, 1);
      assert.equal(commits, beforeFinalCandidate);
      assert.deepEqual(await candidateCounts(), actualBeforeWrite);
      expireAtCandidateFinalAuthority = false;
      candidateConsumerCompleted = false;
      now = at;
      for (const failure of ["FinalBrandExpiry", "RepeatedBrandCallback"]) {
        let completedWrites = 0,
          consumerFailure;
        const beforeCommit = commits;
        expireAtBrandFinalAuthority = failure === "FinalBrandExpiry";
        const current = assessmentInput(storedCandidate);
        const request = {
          ...current,
          binding: { ...current.binding, validUntil: shortBindingExpiry },
        };
        await runner
          .run(async (tx) => {
            await assert.rejects(
              outerSource(tx, failure === "RepeatedBrandCallback").withCurrentAssessment(
                tx,
                request,
                async () => {
                  try {
                    const written = await tentativeWrite(tx);
                    assert.equal(written.aggregate.aggregateVersion, 2);
                    completedWrites++;
                    shortLeaseConsumerCompleted = true;
                  } catch (error) {
                    consumerFailure = error;
                    throw error;
                  }
                },
              ),
              { code: "CATALOG_DEPENDENCY_UNAVAILABLE" },
            );
            if (consumerFailure) throw consumerFailure;
            throw new Error("SYNTHETIC_EXPECTED_OUTER_ROLLBACK");
          })
          .catch((error) => {
            if (consumerFailure) throw consumerFailure;
            assert.equal(error.message, "SYNTHETIC_EXPECTED_OUTER_ROLLBACK");
          });
        assert.equal(completedWrites, 1);
        assert.equal(commits, beforeCommit);
        assert.deepEqual(await candidateCounts(), actualBeforeWrite);
        expireAtBrandFinalAuthority = false;
        shortLeaseConsumerCompleted = false;
        now = at;
      }
      await assert.rejects(
        runner.run((tx) =>
          actualComposition(tx).withCurrentAssessment(
            tx,
            {
              ...actualInput,
              command: { ...actualCommand, contentDigest: "sha256:" + "a".repeat(64) },
            },
            async () => assert.fail("stale body callback"),
          ),
        ),
      );
      await assert.rejects(
        runner.run((tx) =>
          createCurrentProductCandidateContentPolicySource({
            candidateSource: actualCandidateSource(tx),
            brandSource: content,
            policySource: currentPolicy,
            clock: { now: () => now },
          }).withCurrentAssessment(tx, actualInput, async () =>
            assert.fail("nested current source callback"),
          ),
        ),
      );
      const configuredCandidate = {
        ...candidate,
        draft: {
          ...candidate.draft,
          localizedNames: { ...candidate.draft.localizedNames, "fr-CA": "Synthetic translation" },
          editorContent: {
            ...candidate.draft.editorContent,
            media: [
              {
                mediaReference: id(2710),
                assetReference: id(2711),
                assetVersionReference: id(2712),
                role: "Primary",
                altText: { "en-CA": "Synthetic asset" },
                sortOrder: 0,
                cropReference: null,
                focusReference: null,
              },
            ],
          },
        },
      };
      const constrained = await assess(configuredCandidate, async (value, publicationReference) => {
        assert.equal(publicationReference, policyRelease.release.releaseId);
        await editor.query("BEGIN");
        await assert.rejects(
          editor.query(
            "SELECT brand_id FROM bop_tenant.brand WHERE brand_id=$1 FOR UPDATE NOWAIT",
            [id(2)],
          ),
          { code: "55P03" },
        );
        await editor.query("ROLLBACK");
        await editor.query("BEGIN");
        await assert.rejects(
          editor.query(
            "LOCK TABLE bop_publishing.publishing_mutation_record IN ROW EXCLUSIVE MODE NOWAIT",
          ),
          { code: "55P03" },
        );
        await editor.query("ROLLBACK");
        return value;
      });
      assert.equal(constrained.decision, "PassForAssessedRules");
      assert.equal(constrained.eligibility, "NotEvaluated");
      assert.equal(constrained.publishValidation, "Incomplete");
      const unsupported = {
        ...configuredCandidate,
        draft: {
          ...configuredCandidate.draft,
          editorContent: {
            ...configuredCandidate.draft.editorContent,
            preparationNotes: { "de-DE": "Synthetic unsupported locale" },
          },
        },
      };
      assert.equal(
        (await assess(unsupported)).checks.find((c) => c.code === "SupportedLocales").outcome,
        "HardError",
      );
      // Actual Draft policy prerequisite; all complete fields, remaining five
      // checks and the other reference holders are controlled synthetic inputs.
      let draftPolicyMode = "normal",
        draftPolicyHolds = 0,
        draftRemainingHolds = 0;
      const draftPolicyUntil = new Date(Date.parse(at) + 5000).toISOString();
      const draftPolicy = (pins = {}) =>
        createMerchantProductEditorPolicyContentAuthority({
          tenantReference: id(1),
          brandReference: id(2),
          actorReference: id(20),
          configurationVersionReference: first.configurationVersionReference,
          expectedBrandVersion: 1,
          policyReference: body.policyReference,
          policyVersion: 1,
          ...pins,
          clock: { now: () => now },
          brandAuthority: {
            async withCurrentContentRead(r, fields, work) {
              assert.equal(r.tenantReference, id(1));
              assert.equal(r.actorReference, id(20));
              assert.deepEqual(fields, tenantBrandConfigurationRequiredFields);
              return work();
            },
            async isCurrent() {
              return allowed;
            },
          },
          policyAuthority: {
            async holdUntilTransactionCompletes(tx, r) {
              draftPolicyHolds++;
              assert.equal(r.actorReference, id(20));
              assert.equal(r.policyReference, body.policyReference);
              assert.equal(r.purposeCode, "CATALOG_PRODUCT_VERSION_PUBLICATION");
              assert.equal(r.tenantReference, id(1));
              if (draftPolicyMode === "late-policy")
                throw new CatalogError("CATALOG_PERMISSION_DENIED");
            },
          },
          async remainingAuthority(_tx, input) {
            draftRemainingHolds++;
            assert.deepEqual(input.requiredFields, productEditorContentFields);
            assert.deepEqual(
              input.requiredReferenceChecks,
              input.mode === "Read" ? [] : remainingProductEditorVariantReferenceChecks,
            );
            assert.equal(input.validUntil, draftPolicyUntil);
            if (draftPolicyMode === "late-fields")
              throw new CatalogError("CATALOG_PERMISSION_DENIED");
          },
        });
      const draftPolicyInput = (aggregate, mode = "DraftWrite") => ({
        tenantReference: id(1),
        brandReference: id(2),
        actorReference: id(20),
        storeReference: id(21),
        sessionReference: id(22),
        productReference: aggregate.productReference,
        operationReference: id(2990),
        permission: "catalog.manage",
        owningAction: "catalog.product.manage",
        purposeCode: "CATALOG_PRODUCT_DRAFT_REPLACE",
        observedAt: at,
        validUntil: draftPolicyUntil,
        aggregate,
        mode,
        requiredFields: productEditorContentFields,
        requiredReferenceChecks:
          mode === "Read" ? [] : remainingProductEditorVariantReferenceChecks,
      });
      const policyCountsBefore = await candidateCounts();
      await runner.run((tx) => draftPolicy()(tx, draftPolicyInput(configuredCandidate)));
      assert(draftPolicyHolds > 0);
      assert(draftRemainingHolds > 0);
      assert.deepEqual(await candidateCounts(), policyCountsBefore);
      for (const aggregate of [candidate, unsupported]) {
        const holdsBefore = draftRemainingHolds;
        await assert.rejects(
          runner.run((tx) => draftPolicy()(tx, draftPolicyInput(aggregate))),
          { code: "CATALOG_LIFECYCLE_CONFLICT" },
        );
        assert.equal(draftRemainingHolds, holdsBefore);
        assert.deepEqual(await candidateCounts(), policyCountsBefore);
      }
      for (const pins of [{ expectedBrandVersion: 2 }, { policyVersion: 2 }]) {
        await assert.rejects(
          runner.run((tx) => draftPolicy(pins)(tx, draftPolicyInput(configuredCandidate))),
          { code: "CATALOG_DEPENDENCY_UNAVAILABLE" },
        );
        assert.deepEqual(await candidateCounts(), policyCountsBefore);
      }
      for (const late of ["late-fields", "late-policy", "late-expiry", "controlled-complete"]) {
        draftPolicyMode = "normal";
        now = at;
        const beforeCommits = commits;
        let observedRoot = 0,
          completedWrites = 0;
        await assert.rejects(
          runner.run(async (tx) => {
            const hold = draftPolicy();
            const ownerAuthority = {
              holdUntilTransactionCompletes: (actualTx, input) => {
                assert.equal(actualTx, tx);
                assert.deepEqual(input.requiredFields, productEditorContentFields);
                // Other owning reference checks remain synthetic in this fixture.
                return hold(actualTx, draftPolicyInput(input.aggregate, input.mode));
              },
            };
            const written = await createPostgresProductDraftStore({
              brandReference: id(2),
              transactions: { run: (work) => work(tx) },
              authorize: async () => allowed,
              editorContentAuthority: ownerAuthority,
            }).commit({
              record: {
                action: "ReplaceDraft",
                operationReference: id(2990),
                operationIntentHash: sha256Hex("synthetic held Draft policy write"),
                aggregate: parseProductAggregate({ ...configuredCandidate, aggregateVersion: 2 }),
              },
              expectedAggregateVersion: 1,
              audit: candidateAudit(2990),
            });
            completedWrites++;
            observedRoot = (
              await tx.query(
                "SELECT aggregate_version FROM rms_catalog.product WHERE product_id=$1",
                [candidate.productReference],
              )
            ).rows[0].aggregate_version;
            assert.equal(observedRoot, 2);
            assert.equal(written.aggregate.aggregateVersion, 2);
            draftPolicyMode = late === "controlled-complete" ? "normal" : late;
            if (late === "late-expiry") now = draftPolicyUntil;
            await hold(tx, draftPolicyInput(written.aggregate));
            // Successful policy/write observation is rolled back deliberately so
            // every old scenario retains its original immutable fixture history.
            throw new Error("SYNTHETIC_POLICY_WRITE_PROBE_ROLLBACK");
          }),
          late === "controlled-complete"
            ? { message: "SYNTHETIC_POLICY_WRITE_PROBE_ROLLBACK" }
            : {
                code:
                  late === "late-fields"
                    ? "CATALOG_PERMISSION_DENIED"
                    : "CATALOG_DEPENDENCY_UNAVAILABLE",
              },
        );
        assert.equal(completedWrites, 1);
        assert.equal(observedRoot, 2);
        assert.equal(commits, beforeCommits);
        assert.deepEqual(await candidateCounts(), policyCountsBefore);
      }
      now = at;
      draftPolicyMode = "late-policy";
      const historyHoldsBeforeRead = draftPolicyHolds;
      await runner.run((tx) => draftPolicy()(tx, draftPolicyInput(storedCandidate, "Read")));
      assert.equal(draftPolicyHolds, historyHoldsBeforeRead);
      assert.deepEqual(await candidateCounts(), policyCountsBefore);
      draftPolicyMode = "normal";

      let ran = false;
      await assert.rejects(
        runner.run((tx) =>
          currentAssessment.withCurrentAssessment(tx, assessmentInput(), async () => {
            ran = true;
          }),
        ),
      );
      assert.equal(
        ran,
        false,
        "separate source transaction is never accepted as held outer acquisition",
      );
      const beforeRevocation = commits;
      await assert.rejects(
        assess(configuredCandidate, async () => {
          allowed = false;
        }),
      );
      assert.equal(commits, beforeRevocation, "late authority refuses outer commit");
      allowed = true;
      const beforeExpiration = commits;
      await assert.rejects(
        assess(configuredCandidate, async () => {
          now = first.effectiveUntil;
        }),
      );
      assert.equal(commits, beforeExpiration, "earliest source expiry remains exclusive");
      now = at;
      // Synthetic result-copy corruption: actual owning rows and history remain unchanged.
      for (const patch of [
        { defaultLocale: "fr-CA" },
        { approvalEvidenceReference: id(99) },
        { approvedByReference: id(99) },
      ]) {
        const tampered = createCurrentBrandConfigurationContentSource({
          withRecordedConfiguration: (r, work) =>
            recordedSource.withRecordedConfiguration(r, (source, tx) => {
              const configuration = { ...source.configuration, ...patch };
              return work(
                {
                  ...source,
                  configuration,
                  contentDigest: tenantBrandConfigurationContentDigest(configuration),
                },
                tx,
              );
            }),
        });
        await assert.rejects(
          tampered.withCurrentContent(request(), async () => "must not project"),
        );
      }
      for (const patch of [
        { expectedBrandVersion: 2 },
        { tenantReference: id(99) },
        { actorReference: id(99) },
        { brandReference: id(99) },
        { configurationVersionReference: id(99) },
      ])
        await assert.rejects(read(request(first, patch)));
      allowed = false;
      await assert.rejects(read());
      allowed = true;
      const beforeLate = commits;
      await assert.rejects(
        read(request(), async () => {
          allowed = false;
          return "must not commit";
        }),
      );
      assert.equal(commits, beforeLate);
      allowed = true;
      now = "2026-09-11T10:00:20.000Z";
      await assert.rejects(read(), "effectiveUntil is exclusive");
      now = "2026-09-11T09:59:59.999Z";
      await assert.rejects(
        read(request(first, { observedAt: at })),
        "future observation is unavailable",
      );
      now = at;
      await assert.rejects(
        read(request(), async () => {
          now = "2026-09-11T10:00:30.000Z";
        }),
      );
      now = at;
      const second = {
        ...configuration(700, 2, first.configurationVersionReference),
        updatedAt: "2026-09-11T10:00:05.000Z",
      };
      const replaced = await publish(second, 1100, initial.release);
      await record(second);
      now = "2026-09-11T10:00:05.000Z";
      await assert.rejects(read());
      assert.equal(
        (await read(request(second))).configurationVersionReference,
        second.configurationVersionReference,
      );
      const earlyMetadata = createCurrentBrandConfigurationContentSource({
        withRecordedConfiguration: (r, work) =>
          recordedSource.withRecordedConfiguration(r, (source, tx) =>
            work({ ...source, configuration: { ...source.configuration, updatedAt: at } }, tx),
          ),
      });
      await assert.rejects(
        earlyMetadata.withCurrentContent(request(second), async () => "must not project"),
      );
      const restored = await publish(first, 1200, replaced.release, initial.release.releaseId);
      now = "2026-09-11T10:00:10.000Z";
      const afterRollback = await read();
      assert.equal(afterRollback.originalPublicationReference, initial.release.releaseId);
      assert.equal(afterRollback.currentPublicationReference, restored.release.releaseId);
      await assert.rejects(read(request(second)));
      await publisher.commit(
        restored.mutation(
          "Archive",
          restored.next,
          { ...restored.next, state: "Archived", version: 5 },
          30,
        ),
      );
      await assert.rejects(read());
      await admin.query(
        "UPDATE bop_tenant.brand SET lifecycle='Archived',version=2,updated_at=$1 WHERE brand_id=$2",
        [at, id(2)],
      );
      await assert.rejects(read());
    } finally {
      if (created) {
        await admin.query("DROP OWNED BY " + role);
        await admin.query("DROP ROLE " + role);
      }
      await editor.end();
      await admin.end();
    }
  });
});

it("persists typed Product policy content and resolves actual current governance under one held source fence", async () => {
  await withIsolatedDatabase({ caseId: "wp2421_policy" }, async (context) => {
    const admin = new Client(context.clientConfig),
      client = new Client(context.clientConfig);
    await Promise.all([admin.connect(), client.connect()]);
    const role = "wp2421_policy_" + context.runId;
    let created = false,
      authorized = true,
      clock = at;
    const scope = { kind: "Brand", brandReference: id(2), storeReference: null };
    const transaction = async (work) => {
      await client.query("BEGIN");
      try {
        await client.query("SET LOCAL ROLE " + role);
        const result = await work(client);
        await client.query("COMMIT");
        return result;
      } catch (e) {
        await client.query("ROLLBACK");
        throw e;
      }
    };
    const publisher = createPostgresPublishingMutationStore({ run: transaction }, id(1), scope);
    const content = (reference, version) => ({
      profile: "PublishingProductPublicationPolicyV1",
      tenantReference: id(1),
      brandReference: id(2),
      familyReference: id(4),
      policyReference: id(reference),
      policyVersion: version,
      scopeOrder: productPolicyScopeLevels,
      approvalPolicy: "NotRequired",
      warningOverrideAllowed: false,
      requiredLocales: ["en-CA"],
      mediaRequirement: "Required",
      effectiveFrom: at,
      effectiveUntil: "2026-09-11T10:00:20.000Z",
    });
    const mutation = (operation, current, next, n, extra = {}) => ({
      operation,
      expectedVersion: current?.version ?? 1,
      idempotencyKey: id(n),
      current,
      next,
      release: null,
      supersededReleaseId: null,
      rollbackTargetReleaseId: null,
      validationEvidence: null,
      approvalEvidence: null,
      audit: {
        auditId: id(n + 1),
        brandId: id(2),
        actor: {
          type: "User",
          reference: operation === "CreateDraft" || operation === "SubmitReview" ? id(20) : id(21),
        },
        actionCode: {
          CreateDraft: "PUBLISHING_DRAFT_CREATED",
          SubmitReview: "PUBLISHING_REVIEW_SUBMITTED",
          Approve: "PUBLISHING_REVIEW_APPROVED",
          Publish: "PUBLISHING_RELEASE_PUBLISHED",
          Rollback: "PUBLISHING_RELEASE_ROLLED_BACK",
          Archive: "PUBLISHING_RELEASE_ARCHIVED",
        }[operation],
        targetType: "PublishingLifecycle",
        targetId: next.lifecycleId,
        reasonCode: "SYNTHETIC_TEST",
        correlationId: id(n),
        occurredAt: clock,
        sourceChannel: "MERCHANT_WEB",
        dataClassification: "Confidential",
        retentionPolicyCode: "PUBLISHING_LIFECYCLE_AUDIT",
        retentionPolicyVersion: 1,
      },
      ...extra,
    });
    async function publish(body, n, previous = null, rollback = null) {
      const draft = {
        lifecycleId: id(n),
        familyReference: id(4),
        configurationType: "PRODUCT_PUBLICATION_POLICY",
        purposeCode: "PRODUCT_PUBLICATION_POLICY",
        snapshotReference: body.policyReference,
        snapshotDigest: publishingProductPublicationPolicyDigest(body),
        scope,
        version: 1,
        state: "Draft",
        validationEvidenceReference: null,
        approvalEvidenceReference: null,
        createdAt: clock,
        changedAt: clock,
      };
      const start = mutation(
        "CreateDraft",
        null,
        draft,
        n + 1,
        rollback ? {} : { productPolicyContent: body },
      );
      await publisher.commit(start);
      assert.deepEqual(await publisher.commit(start), { auditReference: id(n + 2) });
      await assert.rejects(
        publisher.resolveCurrentProductPublicationPolicy({
          policyReference: body.policyReference,
          policyVersion: body.policyVersion,
          observedAt: clock,
        }),
      );
      const validation = {
        evidenceReference: id(n + 11),
        snapshotReference: body.policyReference,
        snapshotDigest: draft.snapshotDigest,
        scope,
        result: "Pass",
        checkedAt: clock,
        validUntil: until,
        checkCodes: ["PRODUCT_POLICY_STRUCTURE"],
      };
      const review = {
        ...draft,
        version: 2,
        state: "InReview",
        validationEvidenceReference: validation.evidenceReference,
      };
      await publisher.commit(
        mutation("SubmitReview", draft, review, n + 3, { validationEvidence: validation }),
      );
      const approval = {
        evidenceReference: id(n + 12),
        reviewLifecycleId: draft.lifecycleId,
        reviewVersion: 2,
        snapshotReference: body.policyReference,
        snapshotDigest: draft.snapshotDigest,
        scope,
        decision: "Accepted",
        approvedActorReference: id(21),
        approvedAt: clock,
        validUntil: until,
      };
      const approved = {
        ...review,
        version: 3,
        state: "Approved",
        approvalEvidenceReference: approval.evidenceReference,
      };
      await publisher.commit(
        mutation("Approve", review, approved, n + 5, { approvalEvidence: approval }),
      );
      const release = {
        releaseId: id(n + 13),
        familyReference: id(4),
        configurationType: draft.configurationType,
        purposeCode: draft.purposeCode,
        snapshotReference: body.policyReference,
        snapshotDigest: draft.snapshotDigest,
        scope,
        sequence: (previous?.sequence ?? 0) + 1,
        sourceLifecycleId: draft.lifecycleId,
        kind: rollback ? "Rollback" : "Publish",
        previousReleaseId: previous?.releaseId ?? null,
        createdAt: clock,
      };
      const published = { ...approved, version: 4, state: "Published" };
      await publisher.commit(
        mutation(rollback ? "Rollback" : "Publish", approved, published, n + 7, {
          release,
          supersededReleaseId: previous?.releaseId ?? null,
          rollbackTargetReleaseId: rollback?.releaseId ?? null,
          validationEvidence: validation,
          approvalEvidence: approval,
        }),
      );
      return { body, draft, start, release, published };
    }
    try {
      await admin.query("CREATE ROLE " + role + " NOLOGIN NOSUPERUSER NOBYPASSRLS");
      created = true;
      await admin.query(
        "GRANT USAGE ON SCHEMA bop_publishing,platform_audit,platform_helpers TO " + role,
      );
      await admin.query(
        "GRANT SELECT,INSERT,UPDATE ON bop_publishing.publishing_mutation_record TO " + role,
      );
      await admin.query("GRANT SELECT,INSERT,UPDATE ON platform_audit.audit_chain_head TO " + role);
      await admin.query(
        "GRANT EXECUTE ON FUNCTION platform_helpers.current_brand_id(),platform_helpers.current_store_id(),platform_helpers.is_uuid_v7(uuid) TO " +
          role,
      );
      await admin.query("GRANT USAGE ON TYPE platform_helpers.uuid_v7 TO " + role);
      await admin.query("GRANT SELECT,INSERT ON platform_audit.audit_record TO " + role);
      const a = await publish(content(60, 1), 100);
      await assert.rejects(
        transaction(async (tx) => {
          await tx.query(
            "SELECT set_config('bop.tenant_id',$1,true),set_config('bop.brand_id',$2,true),set_config('bop.store_id','',true)",
            [id(1), id(2)],
          );
          return tx.query(
            "UPDATE bop_publishing.publishing_mutation_record SET changed_at=changed_at",
          );
        }),
        (e) => e.code === "55000",
      );
      const current = await publisher.resolveCurrentProductPublicationPolicy({
        policyReference: id(60),
        policyVersion: 1,
        observedAt: clock,
      });
      assert.deepEqual(current.content, a.body);
      assert.equal(current.current.release.releaseId, a.release.releaseId);
      const count = async () =>
        (
          await admin.query(
            "SELECT (SELECT count(*)::int FROM bop_publishing.publishing_mutation_record) mutations,(SELECT count(*)::int FROM platform_audit.audit_record) audit",
          )
        ).rows[0];
      const baseline = await count();
      await assert.rejects(
        publisher.commit({
          ...a.start,
          productPolicyContent: { ...a.body, mediaRequirement: "Optional" },
        }),
      );
      assert.deepEqual(await count(), baseline);
      const collision = { ...a.body, mediaRequirement: "Optional" };
      await assert.rejects(
        publisher.commit(
          mutation(
            "CreateDraft",
            null,
            {
              ...a.draft,
              lifecycleId: id(170),
              snapshotDigest: publishingProductPublicationPolicyDigest(collision),
            },
            171,
            { productPolicyContent: collision },
          ),
        ),
      );
      assert.deepEqual(await count(), baseline);
      await assert.rejects(
        publisher.resolveCurrentProductPublicationPolicy({
          policyReference: id(60),
          policyVersion: 2,
          observedAt: clock,
        }),
      );
      await assert.rejects(
        createPostgresPublishingMutationStore(
          { run: transaction },
          id(9),
          scope,
        ).resolveCurrentProductPublicationPolicy({
          policyReference: id(60),
          policyVersion: 1,
          observedAt: clock,
        }),
      );
      // Synthetic Catalog publication envelope; actual policy body/governance SQL.
      const publication = () => {
        const v = {
          tenantReference: id(1),
          brandReference: id(2),
          productReference: id(500),
          versionReference: id(501),
          publicationVersion: 3,
          productAggregateVersion: 6,
          state: "Published",
          contentDigest: "sha256:" + "a".repeat(64),
          configurationDigest: "sha256:" + "b".repeat(64),
          scopeSet: [{ level: "Brand", reference: null, channelCodes: [], orderTypeCodes: [] }],
          scopeDigest: "sha256:" + "c".repeat(64),
          effectivePeriod: {
            timeZone: "UTC",
            effectiveFrom: { instant: at, localDateTime: at.slice(0, 23), utcOffsetMinutes: 0 },
            effectiveUntil: null,
          },
          periodDigest: "sha256:" + "d".repeat(64),
          validationEvidenceReference: id(502),
          validationDecision: "Pass",
          policyReference: id(60),
          policyVersion: 1,
          approvalPolicy: "NotRequired",
          reviewReference: id(503),
          reviewVersion: 1,
          submittedByActorReference: id(20),
          approvalEvidenceReference: null,
          scheduleReference: null,
          scheduleVersion: 0,
          publishedAt: clock,
          supersededAt: null,
          supersededByVersionReference: null,
          successorDraftVersionReference: id(504),
          operationReference: id(505),
          intentDigest: "sha256:" + "e".repeat(64),
          actorReference: id(20),
          actorKind: "User",
          occurredAt: clock,
          reasonCode: "SYNTHETIC_TEST",
        };
        return {
          ...v,
          scopeDigest: "sha256:" + sha256Hex(canonicalizeRfc8785(v.scopeSet)),
          periodDigest: "sha256:" + sha256Hex(canonicalizeRfc8785(v.effectivePeriod)),
        };
      };
      const source = createCurrentProductPublicationPolicySource({
        tenantReference: id(1),
        brandReference: id(2),
        actorReference: id(20),
        actorKind: "User",
        clock: { now: () => clock },
        authority: {
          async holdUntilTransactionCompletes(_tx, q) {
            assert.equal(q.purposeCode, "CATALOG_PRODUCT_VERSION_PUBLICATION");
            if (!authorized) throw new Error("synthetic revoked authority");
          },
        },
      });
      const projection = await transaction((tx) =>
        source.withHeldScopePolicy(
          tx,
          { publication: publication(), observedAt: clock },
          async (p) => {
            await admin.query("BEGIN");
            await assert.rejects(
              admin.query(
                "LOCK TABLE bop_publishing.publishing_mutation_record IN ROW EXCLUSIVE MODE NOWAIT",
              ),
              (e) => e.code === "55P03",
            );
            await admin.query("ROLLBACK");
            return p;
          },
        ),
      );
      assert.equal(projection.policyEvidenceReference, a.release.releaseId);
      assert.equal(projection.validUntil, a.body.effectiveUntil);
      assert.deepEqual(projection.scopeOrder, a.body.scopeOrder);
      let callback = false;
      await assert.rejects(
        transaction((tx) =>
          source.withHeldScopePolicy(
            tx,
            { publication: publication(), observedAt: clock },
            async () => {
              callback = true;
              authorized = false;
              return "bad";
            },
          ),
        ),
      );
      assert.equal(callback, true);
      authorized = true;
      clock = "2026-09-11T10:00:05.000Z";
      const b = await publish(content(61, 2), 200, a.release);
      await assert.rejects(
        publisher.resolveCurrentProductPublicationPolicy({
          policyReference: id(60),
          policyVersion: 1,
          observedAt: clock,
        }),
      );
      assert.equal(
        (
          await publisher.resolveCurrentProductPublicationPolicy({
            policyReference: id(61),
            policyVersion: 2,
            observedAt: clock,
          })
        ).current.release.releaseId,
        b.release.releaseId,
      );
      clock = "2026-09-11T10:00:10.000Z";
      const restored = await publish(a.body, 300, b.release, a.release);
      assert.equal(
        (
          await publisher.resolveCurrentProductPublicationPolicy({
            policyReference: id(60),
            policyVersion: 1,
            observedAt: clock,
          })
        ).current.release.releaseId,
        restored.release.releaseId,
      );
      await publisher.commit(
        mutation(
          "Archive",
          restored.published,
          { ...restored.published, version: 5, state: "Archived", changedAt: clock },
          320,
        ),
      );
      await assert.rejects(
        publisher.resolveCurrentProductPublicationPolicy({
          policyReference: id(60),
          policyVersion: 1,
          observedAt: clock,
        }),
      );
      await assert.rejects(
        publisher.resolveCurrentProductPublicationPolicy({
          policyReference: id(60),
          policyVersion: 1,
          observedAt: "2026-09-11T10:00:20.000Z",
        }),
      );
    } finally {
      await client.end();
      if (created) {
        await admin.query("DROP OWNED BY " + role);
        await admin.query("DROP ROLE " + role);
      }
      await admin.end();
    }
  });
});

it("persists typed Option policy content and resolves actual current governance under one held source fence", async () => {
  await withIsolatedDatabase({ caseId: "wp2421_optpolicy" }, async (context) => {
    const admin = new Client(context.clientConfig),
      client = new Client(context.clientConfig);
    await Promise.all([admin.connect(), client.connect()]);
    const role = "wp2421_optpolicy_" + context.runId;
    let created = false,
      clock = at;
    const scope = { kind: "Brand", brandReference: id(2), storeReference: null };
    const transaction = async (work) => {
      await client.query("BEGIN");
      try {
        await client.query("SET LOCAL ROLE " + role);
        const result = await work(client);
        await client.query("COMMIT");
        return result;
      } catch (e) {
        await client.query("ROLLBACK");
        throw e;
      }
    };
    const publisher = createPostgresPublishingMutationStore({ run: transaction }, id(1), scope);
    const content = (reference, version) => ({
      profile: "PublishingOptionSetPublicationPolicyV1",
      tenantReference: id(1),
      brandReference: id(2),
      familyReference: id(4),
      policyReference: id(reference),
      policyVersion: version,
      scopeOrder: optionSetPolicyScopeLevels,
      approvalPolicy: "NotRequired",
      warningOverrideAllowed: false,
      requiredLocales: ["en-CA"],
      mediaRequirement: "Required",
      effectiveFrom: at,
      effectiveUntil: "2026-09-11T10:00:20.000Z",
    });
    const mutation = (operation, current, next, n, extra = {}) => ({
      operation,
      expectedVersion: current?.version ?? 1,
      idempotencyKey: id(n),
      current,
      next,
      release: null,
      supersededReleaseId: null,
      rollbackTargetReleaseId: null,
      validationEvidence: null,
      approvalEvidence: null,
      audit: {
        auditId: id(n + 1),
        brandId: id(2),
        actor: {
          type: "User",
          reference: operation === "CreateDraft" || operation === "SubmitReview" ? id(20) : id(21),
        },
        actionCode: {
          CreateDraft: "PUBLISHING_DRAFT_CREATED",
          SubmitReview: "PUBLISHING_REVIEW_SUBMITTED",
          Approve: "PUBLISHING_REVIEW_APPROVED",
          Publish: "PUBLISHING_RELEASE_PUBLISHED",
          Rollback: "PUBLISHING_RELEASE_ROLLED_BACK",
          Archive: "PUBLISHING_RELEASE_ARCHIVED",
        }[operation],
        targetType: "PublishingLifecycle",
        targetId: next.lifecycleId,
        reasonCode: "SYNTHETIC_TEST",
        correlationId: id(n),
        occurredAt: clock,
        sourceChannel: "MERCHANT_WEB",
        dataClassification: "Confidential",
        retentionPolicyCode: "PUBLISHING_LIFECYCLE_AUDIT",
        retentionPolicyVersion: 1,
      },
      ...extra,
    });
    async function publish(body, n, previous = null, rollback = null) {
      const draft = {
        lifecycleId: id(n),
        familyReference: id(4),
        configurationType: "OPTION_SET_PUBLICATION_POLICY",
        purposeCode: "OPTION_SET_PUBLICATION_POLICY",
        snapshotReference: body.policyReference,
        snapshotDigest: publishingOptionSetPublicationPolicyDigest(body),
        scope,
        version: 1,
        state: "Draft",
        validationEvidenceReference: null,
        approvalEvidenceReference: null,
        createdAt: clock,
        changedAt: clock,
      };
      const start = mutation(
        "CreateDraft",
        null,
        draft,
        n + 1,
        rollback ? {} : { optionSetPolicyContent: body },
      );
      await publisher.commit(start);
      assert.deepEqual(await publisher.commit(start), { auditReference: id(n + 2) });
      await assert.rejects(
        publisher.resolveCurrentOptionSetPublicationPolicy({
          policyReference: body.policyReference,
          policyVersion: body.policyVersion,
          observedAt: clock,
        }),
      );
      const validation = {
        evidenceReference: id(n + 11),
        snapshotReference: body.policyReference,
        snapshotDigest: draft.snapshotDigest,
        scope,
        result: "Pass",
        checkedAt: clock,
        validUntil: until,
        checkCodes: ["OPTION_POLICY_STRUCTURE"],
      };
      const review = {
        ...draft,
        version: 2,
        state: "InReview",
        validationEvidenceReference: validation.evidenceReference,
      };
      await publisher.commit(
        mutation("SubmitReview", draft, review, n + 3, { validationEvidence: validation }),
      );
      const approval = {
        evidenceReference: id(n + 12),
        reviewLifecycleId: draft.lifecycleId,
        reviewVersion: 2,
        snapshotReference: body.policyReference,
        snapshotDigest: draft.snapshotDigest,
        scope,
        decision: "Accepted",
        approvedActorReference: id(21),
        approvedAt: clock,
        validUntil: until,
      };
      const approved = {
        ...review,
        version: 3,
        state: "Approved",
        approvalEvidenceReference: approval.evidenceReference,
      };
      const beforeApproval = (
        await admin.query(
          "SELECT (SELECT count(*)::int FROM bop_publishing.publishing_mutation_record) mutations,(SELECT count(*)::int FROM platform_audit.audit_record) audit",
        )
      ).rows[0];
      const selfApproval = mutation("Approve", review, approved, n + 5, {
        approvalEvidence: { ...approval, approvedActorReference: id(20) },
      });
      selfApproval.audit.actor.reference = id(20);
      await assert.rejects(publisher.commit(selfApproval));
      assert.deepEqual(
        (
          await admin.query(
            "SELECT (SELECT count(*)::int FROM bop_publishing.publishing_mutation_record) mutations,(SELECT count(*)::int FROM platform_audit.audit_record) audit",
          )
        ).rows[0],
        beforeApproval,
      );
      await publisher.commit(
        mutation("Approve", review, approved, n + 5, { approvalEvidence: approval }),
      );
      const release = {
        releaseId: id(n + 13),
        familyReference: id(4),
        configurationType: draft.configurationType,
        purposeCode: draft.purposeCode,
        snapshotReference: body.policyReference,
        snapshotDigest: draft.snapshotDigest,
        scope,
        sequence: (previous?.sequence ?? 0) + 1,
        sourceLifecycleId: draft.lifecycleId,
        kind: rollback ? "Rollback" : "Publish",
        previousReleaseId: previous?.releaseId ?? null,
        createdAt: clock,
      };
      const published = { ...approved, version: 4, state: "Published" };
      await publisher.commit(
        mutation(rollback ? "Rollback" : "Publish", approved, published, n + 7, {
          release,
          supersededReleaseId: previous?.releaseId ?? null,
          rollbackTargetReleaseId: rollback?.releaseId ?? null,
          validationEvidence: validation,
          approvalEvidence: approval,
        }),
      );
      return { body, draft, start, release, published };
    }
    try {
      await admin.query("CREATE ROLE " + role + " NOLOGIN NOSUPERUSER NOBYPASSRLS");
      created = true;
      await admin.query(
        "GRANT USAGE ON SCHEMA bop_publishing,platform_audit,platform_helpers TO " + role,
      );
      await admin.query(
        "GRANT SELECT,INSERT,UPDATE ON bop_publishing.publishing_mutation_record TO " + role,
      );
      await admin.query("GRANT SELECT,INSERT,UPDATE ON platform_audit.audit_chain_head TO " + role);
      await admin.query(
        "GRANT EXECUTE ON FUNCTION platform_helpers.current_brand_id(),platform_helpers.current_store_id(),platform_helpers.is_uuid_v7(uuid) TO " +
          role,
      );
      await admin.query("GRANT USAGE ON TYPE platform_helpers.uuid_v7 TO " + role);
      await admin.query("GRANT SELECT,INSERT ON platform_audit.audit_record TO " + role);
      const a = await publish(content(60, 1), 100);
      await assert.rejects(
        transaction(async (tx) => {
          await tx.query(
            "SELECT set_config('bop.tenant_id',$1,true),set_config('bop.brand_id',$2,true),set_config('bop.store_id','',true)",
            [id(1), id(2)],
          );
          return tx.query(
            "UPDATE bop_publishing.publishing_mutation_record SET changed_at=changed_at",
          );
        }),
        (e) => e.code === "55000",
      );
      const current = await publisher.resolveCurrentOptionSetPublicationPolicy({
        policyReference: id(60),
        policyVersion: 1,
        observedAt: clock,
      });
      assert.deepEqual(current.content, a.body);
      assert.equal(current.current.release.releaseId, a.release.releaseId);
      const count = async () =>
        (
          await admin.query(
            "SELECT (SELECT count(*)::int FROM bop_publishing.publishing_mutation_record) mutations,(SELECT count(*)::int FROM platform_audit.audit_record) audit",
          )
        ).rows[0];
      const baseline = await count();
      await assert.rejects(
        transaction(async (tx) => {
          const held = createPostgresPublishingMutationStore(
            { run: (work) => work(tx) },
            id(1),
            scope,
          );
          await held.resolveCurrentOptionSetPublicationPolicy({
            policyReference: id(60),
            policyVersion: 1,
            observedAt: clock,
          });
          assert.equal(
            (
              await tx.query(
                "SELECT count(*)::int AS held FROM pg_locks WHERE pid=pg_backend_pid() AND relation='bop_publishing.publishing_mutation_record'::regclass AND mode='ShareLock' AND granted",
              )
            ).rows[0].held,
            1,
          );
          await held.commit(
            mutation(
              "Archive",
              a.published,
              { ...a.published, version: 5, state: "Archived", changedAt: clock },
              175,
            ),
          );
          await assert.rejects(
            held.resolveCurrentOptionSetPublicationPolicy({
              policyReference: id(60),
              policyVersion: 1,
              observedAt: clock,
            }),
          );
          throw new Error("SYNTHETIC_OUTER_REFUSAL");
        }),
        /SYNTHETIC_OUTER_REFUSAL/,
      );
      assert.deepEqual(await count(), baseline);
      assert.equal(
        (
          await publisher.resolveCurrentOptionSetPublicationPolicy({
            policyReference: id(60),
            policyVersion: 1,
            observedAt: clock,
          })
        ).current.release.releaseId,
        a.release.releaseId,
      );
      // Real owning Option policy in a held caller transaction. Actor/Set fields
      // remain synthetic authority controls, never current Option qualification.
      let allowed = true,
        holds = 0,
        actualTx = null;
      const makeSource = () =>
        createCurrentOptionSetPublicationPolicySource({
          tenantReference: id(1),
          brandReference: id(2),
          actorReference: id(20),
          actorKind: "User",
          clock: { now: () => clock },
          authority: {
            async holdUntilTransactionCompletes(tx, q) {
              assert.equal(tx, actualTx);
              assert.equal(q.tenantReference, id(1));
              assert.equal(q.brandReference, id(2));
              assert.equal(q.actorReference, id(20));
              assert.equal(q.actorKind, "User");
              assert.equal(q.permission, "catalog.manage");
              assert.equal(q.action, "catalog.option_set.publish");
              assert.equal(q.purposeCode, "CATALOG_OPTION_SET_PUBLICATION");
              assert.equal(q.optionSetReference, id(500));
              assert.equal(q.policyReference, id(60));
              assert.equal(q.policyVersion, 1);
              assert.deepEqual(q.requiredFields, currentOptionSetPolicyFields);
              holds++;
              if (!allowed) throw Error("SYNTHETIC_FIELDS_DENIED");
              return { observedAt: q.observedAt, validUntil: "2026-09-11T10:00:30.000Z" };
            },
          },
        });
      const request = {
        optionSetReference: id(500),
        policyReference: id(60),
        policyVersion: 1,
        observedAt: at,
      };
      await transaction(async (tx) => {
        actualTx = tx;
        await makeSource().withCurrentPolicy(tx, request, async (policy) => {
          assert.equal(policy.content.profile, "PublishingOptionSetPublicationPolicyV1");
          assert.equal(policy.originalObservedAt, at);
          assert.equal(policy.observedAt, clock);
          assert.equal(policy.currentPublicationReference, a.release.releaseId);
          assert.equal(policy.validUntil, "2026-09-11T10:00:20.000Z");
          assert.equal(policy.eligibility, "NotEvaluated");
          assert.equal(policy.publishValidation, "Incomplete");
          assert.equal(
            (
              await tx.query(
                "SELECT count(*)::int AS held FROM pg_locks WHERE pid=pg_backend_pid() AND relation='bop_publishing.publishing_mutation_record'::regclass AND mode='ShareLock' AND granted",
              )
            ).rows[0].held,
            1,
          );
        });
      });
      assert.equal(holds, 2);
      assert.deepEqual(await count(), baseline);
      for (const mode of ["initial", "late", "expiry", "backward", "head"]) {
        let tentative = false;
        allowed = mode !== "initial";
        clock = at;
        await assert.rejects(
          transaction(async (tx) => {
            actualTx = tx;
            await makeSource().withCurrentPolicy(tx, request, async () => {
              const held = createPostgresPublishingMutationStore(
                { run: (work) => work(tx) },
                id(1),
                scope,
              );
              await held.commit(
                mutation(
                  "Archive",
                  a.published,
                  { ...a.published, version: 5, state: "Archived", changedAt: clock },
                  176,
                ),
              );
              assert.equal(
                (
                  await tx.query(
                    "SELECT mutation_json#>>'{next,state}' AS state FROM bop_publishing.publishing_mutation_record WHERE lifecycle_id=$1 ORDER BY lifecycle_version DESC LIMIT 1",
                    [a.published.lifecycleId],
                  )
                ).rows[0].state,
                "Archived",
              );
              tentative = true;
              if (mode === "late") allowed = false;
              if (mode === "expiry") clock = "2026-09-11T10:00:20.000Z";
              if (mode === "backward") clock = "2026-09-11T09:59:59.999Z";
            });
          }),
          (e) => e.code === "CATALOG_DEPENDENCY_UNAVAILABLE",
        );
        assert.equal(tentative, mode !== "initial");
        assert.deepEqual(await count(), baseline);
        clock = at;
        allowed = true;
        // The helper remembers a failure for the physical Tx object. A separate
        // source instance represents a new request on this reused pg connection.
        // Never turn a caught failed callback into continued work in the same UoW.
      }
      // Client Product content cannot establish Option authority, or reuse its family.
      await assert.rejects(
        publisher.resolveCurrentProductPublicationPolicy({
          policyReference: id(60),
          policyVersion: 1,
          observedAt: clock,
        }),
      );
      for (const change of [
        { policyVersion: 3, policyReference: id(62) },
        { tenantReference: id(9) },
        { familyReference: id(5) },
      ]) {
        const body = { ...a.body, ...change };
        await assert.rejects(
          publisher.commit(
            mutation(
              "CreateDraft",
              null,
              {
                ...a.draft,
                lifecycleId: id(180),
                snapshotReference: body.policyReference,
                familyReference: body.familyReference,
                snapshotDigest: publishingOptionSetPublicationPolicyDigest(body),
              },
              181,
              { optionSetPolicyContent: body },
            ),
          ),
        );
        assert.deepEqual(await count(), baseline);
      }
      const productBody = {
        ...a.body,
        profile: "PublishingProductPublicationPolicyV1",
        familyReference: id(5),
        policyReference: id(65),
      };
      const productDraft = {
        ...a.draft,
        familyReference: id(5),
        lifecycleId: id(190),
        snapshotReference: productBody.policyReference,
        configurationType: "PRODUCT_PUBLICATION_POLICY",
        purposeCode: "PRODUCT_PUBLICATION_POLICY",
        snapshotDigest: publishingProductPublicationPolicyDigest(productBody),
      };
      await publisher.commit(
        mutation("CreateDraft", null, productDraft, 191, { productPolicyContent: productBody }),
      );
      // Different typed domain family is not reusable for an Option policy.
      await assert.rejects(
        publisher.commit(
          mutation(
            "CreateDraft",
            null,
            {
              ...a.draft,
              lifecycleId: id(194),
              snapshotReference: id(65),
              snapshotDigest: publishingOptionSetPublicationPolicyDigest({
                ...a.body,
                policyReference: id(65),
              }),
            },
            195,
            { optionSetPolicyContent: { ...a.body, policyReference: id(65) } },
          ),
        ),
      );
      // Restore the comparison count after the intentionally committed unrelated Product Draft.
      Object.assign(baseline, await count());

      await assert.rejects(
        publisher.commit({
          ...a.start,
          optionSetPolicyContent: { ...a.body, mediaRequirement: "Optional" },
        }),
      );
      assert.deepEqual(await count(), baseline);
      const collision = { ...a.body, mediaRequirement: "Optional" };
      await assert.rejects(
        publisher.commit(
          mutation(
            "CreateDraft",
            null,
            {
              ...a.draft,
              lifecycleId: id(170),
              snapshotDigest: publishingOptionSetPublicationPolicyDigest(collision),
            },
            171,
            { optionSetPolicyContent: collision },
          ),
        ),
      );
      assert.deepEqual(await count(), baseline);
      await assert.rejects(
        publisher.resolveCurrentOptionSetPublicationPolicy({
          policyReference: id(60),
          policyVersion: 2,
          observedAt: clock,
        }),
      );
      await assert.rejects(
        createPostgresPublishingMutationStore(
          { run: transaction },
          id(9),
          scope,
        ).resolveCurrentOptionSetPublicationPolicy({
          policyReference: id(60),
          policyVersion: 1,
          observedAt: clock,
        }),
      );
      clock = "2026-09-11T10:00:05.000Z";
      const b = await publish(content(61, 2), 200, a.release);
      await assert.rejects(
        transaction(async (tx) => {
          actualTx = tx;
          await makeSource().withCurrentPolicy(
            tx,
            request,
            async () => "must not reach stale policy",
          );
        }),
        (e) => e.code === "CATALOG_DEPENDENCY_UNAVAILABLE",
      );

      await assert.rejects(
        publisher.resolveCurrentOptionSetPublicationPolicy({
          policyReference: id(60),
          policyVersion: 1,
          observedAt: clock,
        }),
      );
      assert.equal(
        (
          await publisher.resolveCurrentOptionSetPublicationPolicy({
            policyReference: id(61),
            policyVersion: 2,
            observedAt: clock,
          })
        ).current.release.releaseId,
        b.release.releaseId,
      );
      clock = "2026-09-11T10:00:10.000Z";
      const restored = await publish(a.body, 300, b.release, a.release);
      await transaction(async (tx) => {
        actualTx = tx;
        await makeSource().withCurrentPolicy(tx, request, async (policy) => {
          assert.equal(policy.currentPublicationReference, restored.release.releaseId);
          assert.equal(policy.originalObservedAt, at);
          assert.equal(policy.observedAt, clock);
          assert.equal(policy.validUntil, "2026-09-11T10:00:20.000Z");
        });
      });

      assert.equal(
        (
          await publisher.resolveCurrentOptionSetPublicationPolicy({
            policyReference: id(60),
            policyVersion: 1,
            observedAt: clock,
          })
        ).current.release.releaseId,
        restored.release.releaseId,
      );
      await assert.rejects(
        publisher.resolveCurrentOptionSetPublicationPolicy({
          policyReference: id(60),
          policyVersion: 1,
          observedAt: "2026-09-11T10:00:20.000Z",
        }),
      );
      await assert.rejects(
        createPostgresPublishingMutationStore({ run: transaction }, id(1), {
          ...scope,
          brandReference: id(3),
        }).resolveCurrentOptionSetPublicationPolicy({
          policyReference: id(60),
          policyVersion: 1,
          observedAt: clock,
        }),
      );
      await publisher.commit(
        mutation(
          "Archive",
          restored.published,
          { ...restored.published, version: 5, state: "Archived", changedAt: clock },
          320,
        ),
      );
      await assert.rejects(
        publisher.resolveCurrentOptionSetPublicationPolicy({
          policyReference: id(60),
          policyVersion: 1,
          observedAt: clock,
        }),
      );
      await assert.rejects(
        publisher.resolveCurrentOptionSetPublicationPolicy({
          policyReference: id(60),
          policyVersion: 1,
          observedAt: "2026-09-11T10:00:20.000Z",
        }),
      );
      await assert.rejects(
        transaction(async (tx) => {
          actualTx = tx;
          await makeSource().withCurrentPolicy(
            tx,
            request,
            async () => "must not reach archived policy",
          );
        }),
        (e) => e.code === "CATALOG_DEPENDENCY_UNAVAILABLE",
      );
      // New policy registration remains possible after bodyless rollback Create history.
      const c = content(62, 3);
      await publisher.commit(
        mutation(
          "CreateDraft",
          null,
          {
            ...a.draft,
            lifecycleId: id(400),
            snapshotReference: c.policyReference,
            snapshotDigest: publishingOptionSetPublicationPolicyDigest(c),
            createdAt: clock,
            changedAt: clock,
          },
          401,
          { optionSetPolicyContent: c },
        ),
      );
      await assert.rejects(
        publisher.resolveCurrentOptionSetPublicationPolicy({
          policyReference: id(62),
          policyVersion: 3,
          observedAt: clock,
        }),
      );

      // Milestone54: actual owning Draft and independently governed policy in one caller UoW.
      await admin.query("GRANT USAGE ON SCHEMA rms_catalog,platform_eventing TO " + role);
      await admin.query(
        "GRANT SELECT,INSERT,UPDATE,DELETE ON rms_catalog.option_set,rms_catalog.option_set_version,rms_catalog.option,rms_catalog.option_conflict TO " +
          role,
      );
      await admin.query(
        "GRANT SELECT,INSERT ON rms_catalog.option_set_operation_record,rms_catalog.option_set_draft_content_snapshot,platform_eventing.outbox_event TO " +
          role,
      );
      clock = "2026-09-11T10:00:10.000Z";
      const originalAt54 = clock,
        end54 = "2026-09-11T10:00:15.000Z";
      const body54 = {
        ...content(15001, 1),
        familyReference: id(15000),
        requiredLocales: ["en-CA", "fr-CA"],
      };
      const draft54 = {
        ...a.draft,
        lifecycleId: id(15100),
        familyReference: id(15000),
        snapshotReference: body54.policyReference,
        snapshotDigest: publishingOptionSetPublicationPolicyDigest(body54),
        createdAt: clock,
        changedAt: clock,
      };
      await publisher.commit(
        mutation("CreateDraft", null, draft54, 15101, { optionSetPolicyContent: body54 }),
      );
      const validation54 = {
        evidenceReference: id(15111),
        snapshotReference: body54.policyReference,
        snapshotDigest: draft54.snapshotDigest,
        scope,
        result: "Pass",
        checkedAt: clock,
        validUntil: until,
        checkCodes: ["OPTION_POLICY_STRUCTURE"],
      };
      const review54 = {
        ...draft54,
        version: 2,
        state: "InReview",
        validationEvidenceReference: validation54.evidenceReference,
      };
      await publisher.commit(
        mutation("SubmitReview", draft54, review54, 15103, { validationEvidence: validation54 }),
      );
      const approval54 = {
        evidenceReference: id(15112),
        reviewLifecycleId: draft54.lifecycleId,
        reviewVersion: 2,
        snapshotReference: body54.policyReference,
        snapshotDigest: draft54.snapshotDigest,
        scope,
        decision: "Accepted",
        approvedActorReference: id(21),
        approvedAt: clock,
        validUntil: until,
      };
      const approved54 = {
        ...review54,
        version: 3,
        state: "Approved",
        approvalEvidenceReference: approval54.evidenceReference,
      };
      await publisher.commit(
        mutation("Approve", review54, approved54, 15105, { approvalEvidence: approval54 }),
      );
      const release54 = {
        ...a.release,
        releaseId: id(15113),
        familyReference: id(15000),
        snapshotReference: body54.policyReference,
        snapshotDigest: draft54.snapshotDigest,
        sequence: 1,
        sourceLifecycleId: draft54.lifecycleId,
        createdAt: clock,
      };
      const published54 = { ...approved54, version: 4, state: "Published" };
      await publisher.commit(
        mutation("Publish", approved54, published54, 15107, {
          release: release54,
          validationEvidence: validation54,
          approvalEvidence: approval54,
        }),
      );
      let allocation54 = 16000;
      const writer54 = createPostgresFullOptionSetDraftStore({
        tenantReference: id(1),
        brandReference: id(2),
        actorReference: id(20),
        clock: { now: () => clock },
        transactions: { run: transaction },
        authority: {
          holdUntilTransactionCompletes: async (_tx, input) => ({
            observedAt: input.observedAt,
            validUntil: "2026-09-11T10:00:20.000Z",
          }),
        },
        creation: {
          authority: {
            holdUntilTransactionCompletes: async (_tx, input) => ({
              observedAt: input.observedAt,
              validUntil: "2026-09-11T10:00:20.000Z",
            }),
          },
          references: { generate: () => id(++allocation54) },
        },
        audit: {
          create(input) {
            return {
              auditId: id(17001),
              brandId: id(2),
              actor: { type: "User", reference: id(20) },
              actionCode: "CATALOG_OPTION_SET_CREATE",
              targetType: "CatalogOptionSet",
              targetId: input.result.sourceAggregate.optionSetReference,
              reasonCode: input.reasonCode,
              correlationId: input.operationReference,
              occurredAt: input.occurredAt,
              sourceChannel: "API",
              dataClassification: "Internal",
              retentionPolicyCode: "OPERATIONAL",
              retentionPolicyVersion: 1,
            };
          },
        },
        events: { generateReference: () => id(17002) },
      });
      const root54 = await writer54.create({
        internalCode: "CURRENT_COMBINED54",
        draft: {
          defaultLocale: "en-CA",
          localizedNames: { "en-CA": "Synthetic choices" },
          localizedDescriptions: {},
          displayStyle: "MultiChoice",
          minimumSelection: 0,
          maximumSelection: 1,
          allowRepeatedOption: false,
          perOptionMaximumQuantity: 1,
          maximumTotalQuantity: 1,
          options: [
            {
              stableCode: "ONLY",
              sortOrder: 0,
              lifecycle: "Draft",
              localizedNames: { "en-CA": "Synthetic option" },
              localizedDescriptions: {},
              defaultEligible: true,
              triggeredOptionSetReference: null,
              conflictOptionCodes: [],
            },
          ],
        },
        additionalContent: {
          profile: "CatalogOptionSetEditorContentV1",
          optionDetails: [
            {
              stableCode: "ONLY",
              quantityRule: { minimumQuantity: 0, maximumQuantity: 1 },
              media: null,
              pricingRule: null,
              consumption: null,
              triggeredOptionSetVersionReference: null,
            },
          ],
          conditionalRules: [],
          conflictRules: [],
          scopeSet: [{ level: "Brand", reference: null, channelCodes: [], orderTypeCodes: [] }],
          effectivePeriod: {
            timeZone: "UTC",
            effectiveFrom: { instant: at, localDateTime: at.slice(0, 23), utcOffsetMinutes: 0 },
            effectiveUntil: null,
          },
        },
        operationReference: id(17000),
        occurredAt: clock,
        reasonCode: "INITIAL_CONFIGURATION",
      });
      const { sourceAggregate: source54, ...additional54 } = root54.content;
      const prepared54 = parseCatalogOptionSetEditorContent(source54, additional54);
      const set54 = root54.content.sourceAggregate.optionSetReference;
      const request54 = {
        graphRequest: {
          optionSetReference: set54,
          versionReference: root54.content.sourceAggregate.draft.versionReference,
          expectedAggregateVersion: 1,
          sourceDigest: prepared54.sourceDigest,
          contentDigest: root54.contentDigest,
          configurationDigest: root54.configurationDigest,
          observedAt: originalAt54,
          validUntil: end54,
        },
        policyRequest: {
          optionSetReference: set54,
          policyReference: body54.policyReference,
          policyVersion: 1,
          observedAt: originalAt54,
        },
        originalIntentDigest: "sha256:" + "a".repeat(64),
        activationAt: originalAt54,
      };
      let readAllowed54 = true,
        policyAllowed54 = true,
        actual54 = null,
        readHolds54 = 0,
        policyHolds54 = 0;
      const provider54 = () =>
        createCurrentOptionSetDraftPolicySource({
          tenantReference: id(1),
          brandReference: id(2),
          actorReference: id(20),
          clock: { now: () => clock },
          readAuthority: {
            async holdUntilTransactionCompletes(tx, input) {
              assert.equal(tx, actual54);
              assert.equal(input.action, "catalog.option_set.read");
              assert.equal(input.purposeCode, "CATALOG_OPTION_SET_DRAFT");
              assert.equal(input.optionSetReference, set54);
              assert.ok(input.requiredFields.includes("optionDetails"));
              readHolds54++;
              if (!readAllowed54) throw new CatalogError("CATALOG_PERMISSION_DENIED");
              return { observedAt: input.observedAt, validUntil: "2026-09-11T10:00:20.000Z" };
            },
          },
          policyAuthority: {
            async holdUntilTransactionCompletes(tx, input) {
              assert.equal(tx, actual54);
              assert.equal(input.action, "catalog.option_set.publish");
              assert.equal(input.purposeCode, "CATALOG_OPTION_SET_PUBLICATION");
              assert.deepEqual(input.requiredFields, currentOptionSetPolicyFields);
              policyHolds54++;
              if (!policyAllowed54) throw new CatalogError("CATALOG_PERMISSION_DENIED");
              return { observedAt: input.observedAt, validUntil: "2026-09-11T10:00:20.000Z" };
            },
          },
        });
      const take54 = async () => {
        const result = {};
        for (const table of [
          "rms_catalog.option_set",
          "rms_catalog.option_set_version",
          "rms_catalog.option",
          "rms_catalog.option_conflict",
          "rms_catalog.option_set_operation_record",
          "rms_catalog.option_set_draft_content_snapshot",
          "bop_publishing.publishing_mutation_record",
          "platform_audit.audit_record",
          "platform_audit.audit_chain_head",
          "platform_eventing.outbox_event",
        ])
          result[table] = (
            await admin.query(
              "SELECT to_jsonb(t) row FROM " + table + " t ORDER BY to_jsonb(t)::text",
            )
          ).rows;
        return result;
      };
      const baseline54 = await take54();
      await transaction(async (tx) => {
        actual54 = tx;
        await provider54().withCurrentAssessment(tx, request54, async (value) => {
          assert.equal(value.currentRootEvidence.sourceAuthority, "CurrentDraftRootOnly");
          assert.equal(value.currentRootEvidence.sourceDigest, prepared54.sourceDigest);
          assert.equal(value.validUntil, end54);
          assert.equal(value.assessment.currentPolicyPublicationReference, release54.releaseId);
          assert.equal(value.assessment.originalIntentDigest, request54.originalIntentDigest);
          assert.equal(value.assessment.decision, "HardError");
          assert.equal(value.assessment.sourceAuthority, "NotEvaluated");
          assert.equal(value.eligibility, "NotEvaluated");
          for (const code of ["RequiredSetNames", "RequiredOptionNames", "RequiredMediaPresence"])
            assert.equal(
              value.assessment.checks.find((c) => c.code === code)?.outcome,
              "HardError",
            );
          assert.ok(Object.isFrozen(value));
          return value;
        });
      });
      assert.ok(readHolds54 >= 6);
      assert.ok(policyHolds54 >= 2);
      assert.deepEqual(await take54(), baseline54);
      for (const mode54 of [
        "read-denial",
        "policy-denial",
        "expiry",
        "backward",
        "root-head",
        "policy-head",
      ]) {
        clock = originalAt54;
        readAllowed54 = true;
        policyAllowed54 = true;
        await assert.rejects(
          transaction(async (tx) => {
            actual54 = tx;
            await provider54().withCurrentAssessment(tx, request54, async () => {
              // Controlled root update plus owning Publishing write/Audit are tentative.
              await tx.query(
                "UPDATE rms_catalog.option_set SET aggregate_version=2 WHERE option_set_id=$1",
                [set54],
              );
              assert.equal(
                (
                  await tx.query(
                    "SELECT aggregate_version FROM rms_catalog.option_set WHERE option_set_id=$1",
                    [set54],
                  )
                ).rows[0].aggregate_version,
                2,
              );
              const nested = createPostgresPublishingMutationStore(
                { run: async (work) => work(tx) },
                id(1),
                scope,
              );
              const nextBody54 = { ...body54, policyReference: id(18002), policyVersion: 2 };
              if (mode54 === "policy-head")
                await nested.commit(
                  mutation(
                    "Archive",
                    published54,
                    { ...published54, version: 5, state: "Archived", changedAt: clock },
                    18000,
                  ),
                );
              else
                await nested.commit(
                  mutation(
                    "CreateDraft",
                    null,
                    {
                      ...draft54,
                      lifecycleId: id(18003),
                      snapshotReference: nextBody54.policyReference,
                      snapshotDigest: publishingOptionSetPublicationPolicyDigest(nextBody54),
                      createdAt: clock,
                      changedAt: clock,
                    },
                    18000,
                    { optionSetPolicyContent: nextBody54 },
                  ),
                );
              assert.equal(
                (
                  await tx.query(
                    "SELECT count(*)::int n FROM bop_publishing.publishing_mutation_record WHERE lifecycle_id=$1 AND operation_code=$2",
                    [
                      mode54 === "policy-head" ? published54.lifecycleId : id(18003),
                      mode54 === "policy-head" ? "Archive" : "CreateDraft",
                    ],
                  )
                ).rows[0].n,
                1,
              );
              if (mode54 === "read-denial") readAllowed54 = false;
              if (mode54 === "policy-denial") policyAllowed54 = false;
              if (mode54 === "expiry") clock = end54;
              if (mode54 === "backward") clock = "2026-09-11T10:00:09.999Z";
              return "tentative";
            });
          }),
          (e) => e.code === "CATALOG_DEPENDENCY_UNAVAILABLE",
        );
        assert.deepEqual(await take54(), baseline54);
      }
      clock = originalAt54;
      // Milestone57: actual current root/policy-bound independent content review.
      const body57 = {
        ...body54,
        policyReference: id(20000),
        policyVersion: 2,
        requiredLocales: ["en-CA"],
        mediaRequirement: "Optional",
      };
      const pd57 = {
        ...draft54,
        lifecycleId: id(20010),
        snapshotReference: body57.policyReference,
        snapshotDigest: publishingOptionSetPublicationPolicyDigest(body57),
      };
      await publisher.commit(
        mutation("CreateDraft", null, pd57, 20011, { optionSetPolicyContent: body57 }),
      );
      const pv57 = {
        ...validation54,
        evidenceReference: id(20021),
        snapshotReference: body57.policyReference,
        snapshotDigest: pd57.snapshotDigest,
      };
      const pr57 = {
        ...pd57,
        version: 2,
        state: "InReview",
        validationEvidenceReference: pv57.evidenceReference,
      };
      await publisher.commit(
        mutation("SubmitReview", pd57, pr57, 20013, { validationEvidence: pv57 }),
      );
      const pa57 = {
        ...approval54,
        evidenceReference: id(20022),
        reviewLifecycleId: pd57.lifecycleId,
        snapshotReference: body57.policyReference,
        snapshotDigest: pd57.snapshotDigest,
      };
      const approvedPolicy57 = {
        ...pr57,
        version: 3,
        state: "Approved",
        approvalEvidenceReference: pa57.evidenceReference,
      };
      await publisher.commit(
        mutation("Approve", pr57, approvedPolicy57, 20015, { approvalEvidence: pa57 }),
      );
      const policyRelease57 = {
        ...release54,
        releaseId: id(20023),
        snapshotReference: body57.policyReference,
        snapshotDigest: pd57.snapshotDigest,
        sequence: 2,
        sourceLifecycleId: pd57.lifecycleId,
        previousReleaseId: release54.releaseId,
      };
      const publishedPolicy57 = { ...approvedPolicy57, version: 4, state: "Published" };
      await publisher.commit(
        mutation("Publish", approvedPolicy57, publishedPolicy57, 20017, {
          release: policyRelease57,
          supersededReleaseId: release54.releaseId,
          validationEvidence: pv57,
          approvalEvidence: pa57,
        }),
      );
      const request57 = {
        ...request54,
        activationAt: "2026-09-11T10:00:14.000Z",
        policyRequest: {
          ...request54.policyRequest,
          policyReference: body57.policyReference,
          policyVersion: 2,
        },
      };
      let actual57 = null,
        approvalAllowed57 = true,
        approvalLease57 = end54,
        reached57 = 0;
      const provider57 = () =>
        createCurrentOptionSetDraftApprovalSource({
          tenantReference: id(1),
          brandReference: id(2),
          actorReference: id(20),
          clock: { now: () => clock },
          readAuthority: {
            async holdUntilTransactionCompletes(tx, input) {
              assert.equal(tx, actual57);
              if (!readAllowed54) throw new CatalogError("CATALOG_PERMISSION_DENIED");
              return { observedAt: input.observedAt, validUntil: "2026-09-11T10:00:20.000Z" };
            },
          },
          policyAuthority: {
            async holdUntilTransactionCompletes(tx, input) {
              assert.equal(tx, actual57);
              assert.deepEqual(input.requiredFields, currentOptionSetPolicyFields);
              if (!policyAllowed54) throw new CatalogError("CATALOG_PERMISSION_DENIED");
              return { observedAt: input.observedAt, validUntil: "2026-09-11T10:00:20.000Z" };
            },
          },
          approvalAuthority: {
            async holdUntilTransactionCompletes(tx, input) {
              assert.equal(tx, actual57);
              assert.equal(input.permission, "catalog.manage");
              assert.equal(input.action, "catalog.option_set.publish");
              assert.equal(input.purposeCode, "CATALOG_OPTION_SET_PUBLICATION");
              assert.deepEqual(input.requiredFields, currentOptionSetApprovalFields);
              assert.equal(input.reviewBinding.optionSetReference, set54);
              if (!approvalAllowed57) throw new CatalogError("CATALOG_PERMISSION_DENIED");
              return { observedAt: input.observedAt, validUntil: approvalLease57 };
            },
          },
        });
      let prepared57;
      readAllowed54 = true;
      policyAllowed54 = true;
      await transaction(async (tx) => {
        actual57 = tx;
        prepared57 = await provider57().withCurrentReviewBinding(tx, request57, async (v) => v);
      });
      assert.equal(prepared57.limitedDecision, "PassForAssessedRules");
      assert.equal(prepared57.recordedApproval, null);
      assert.equal(
        prepared57.reviewBinding.currentPolicyPublicationReference,
        policyRelease57.releaseId,
      );
      const evidenceEnd57 = "2026-09-11T10:00:13.000Z";
      const createReview57 = async (
        seed,
        codes = optionContentReviewValidationCodes,
        self = false,
      ) => {
        const draft = {
          ...draft54,
          lifecycleId: id(seed),
          familyReference: set54,
          configurationType: "CATALOG_OPTION_SET",
          purposeCode: "CATALOG_OPTION_SET_PUBLICATION",
          snapshotReference: request57.graphRequest.versionReference,
          snapshotDigest: prepared57.reviewBinding.digest,
        };
        await publisher.commit(mutation("CreateDraft", null, draft, seed + 1));
        // Declared check outcomes are synthetic. Actual current sources are read separately.
        const validation = {
          ...validation54,
          evidenceReference: id(seed + 11),
          snapshotReference: draft.snapshotReference,
          snapshotDigest: draft.snapshotDigest,
          validUntil: evidenceEnd57,
          checkCodes: [...codes],
        };
        const review = {
          ...draft,
          version: 2,
          state: "InReview",
          validationEvidenceReference: validation.evidenceReference,
        };
        await publisher.commit(
          mutation("SubmitReview", draft, review, seed + 3, { validationEvidence: validation }),
        );
        const approval = {
          ...approval54,
          evidenceReference: id(seed + 12),
          reviewLifecycleId: draft.lifecycleId,
          snapshotReference: draft.snapshotReference,
          snapshotDigest: draft.snapshotDigest,
          approvedActorReference: self ? id(20) : id(21),
          validUntil: end54,
        };
        const approved = {
          ...review,
          version: 3,
          state: "Approved",
          approvalEvidenceReference: approval.evidenceReference,
        };
        const op = mutation("Approve", review, approved, seed + 5, { approvalEvidence: approval });
        if (self) op.audit.actor.reference = id(20);
        await publisher.commit(op);
        return { draft, validation, approval, approved };
      };
      const review57 = await createReview57(21000),
        schema57 = await createReview57(22000, ["SCHEMA"]),
        self57 = await createReview57(23000, optionContentReviewValidationCodes, true);
      const envelope57 = {
        assessmentRequest: request57,
        reviewLifecycleReference: review57.draft.lifecycleId,
        expectedReviewBindingDigest: prepared57.reviewBinding.digest,
      };
      const baseline57 = await take54();
      clock = "2026-09-11T10:00:10.001Z";
      await transaction(async (tx) => {
        actual57 = tx;
        const later = await provider57().withCurrentReviewBinding(tx, request57, async (v) => v);
        assert.equal(
          later.reviewBinding.digest,
          prepared57.reviewBinding.digest,
          "stable current review binding",
        );
        const owner57 = createPostgresPublishingMutationStore(
          { run: async (work) => work(tx) },
          id(1),
          scope,
        );
        const proof57 = await owner57.resolveCurrentIndependentApproval({
          familyReference: set54,
          lifecycleReference: review57.draft.lifecycleId,
          configurationType: "CATALOG_OPTION_SET",
          purposeCode: "CATALOG_OPTION_SET_PUBLICATION",
          snapshotReference: request57.graphRequest.versionReference,
          snapshotDigest: prepared57.reviewBinding.digest,
          requiredCheckCodes: optionContentReviewValidationCodes,
          observedAt: clock,
        });
        assert.equal(proof57.validUntil, evidenceEnd57, "original approval window");
        await provider57().withCurrentApproval(tx, envelope57, async (v) => {
          assert.equal(v.reviewBinding.digest, prepared57.reviewBinding.digest);
          assert.equal(v.validUntil, evidenceEnd57);
          assert.equal(v.recordedApproval.recordedIndependence, "Verified");
          assert.equal(v.recordedApproval.requestedByActorReference, id(20));
          assert.equal(v.recordedApproval.approvedByActorReference, id(21));
          assert.equal(v.publishValidation, "Incomplete");
          assert.equal(v.currentValidation, "NotEvaluated");
          assert.equal(v.eligibility, "NotEvaluated");
          return v;
        });
      });
      assert.deepEqual(await take54(), baseline57);
      for (const invalid of [
        { ...envelope57, expectedReviewBindingDigest: "sha256:" + "0".repeat(64) },
        { ...envelope57, reviewLifecycleReference: schema57.draft.lifecycleId },
        { ...envelope57, reviewLifecycleReference: self57.draft.lifecycleId },
        {
          ...envelope57,
          assessmentRequest: { ...request57, originalIntentDigest: "sha256:" + "0".repeat(64) },
        },
      ]) {
        await assert.rejects(
          transaction(async (tx) => {
            actual57 = tx;
            await provider57().withCurrentApproval(tx, invalid, async () => {
              throw Error("must refuse before callback");
            });
          }),
          (e) => e.code === "CATALOG_DEPENDENCY_UNAVAILABLE",
        );
        assert.deepEqual(await take54(), baseline57);
      }
      for (const mode57 of [
        "approval-fields",
        "approval-window",
        "read-fields",
        "policy-fields",
        "expiry",
        "backward",
        "approval-head",
        "root-head",
        "policy-head",
      ]) {
        clock = originalAt54;
        approvalAllowed57 = true;
        approvalLease57 = end54;
        readAllowed54 = true;
        policyAllowed54 = true;
        let reachedThis57 = false;
        await assert.rejects(
          transaction(async (tx) => {
            actual57 = tx;
            await provider57().withCurrentApproval(tx, envelope57, async () => {
              reached57++;
              reachedThis57 = true;
              const nested = createPostgresPublishingMutationStore(
                { run: async (work) => work(tx) },
                id(1),
                scope,
              );
              if (mode57 === "approval-head") {
                const release = {
                  ...policyRelease57,
                  releaseId: id(24013),
                  familyReference: set54,
                  configurationType: review57.draft.configurationType,
                  purposeCode: review57.draft.purposeCode,
                  snapshotReference: review57.draft.snapshotReference,
                  snapshotDigest: review57.draft.snapshotDigest,
                  sequence: 1,
                  previousReleaseId: null,
                  sourceLifecycleId: review57.draft.lifecycleId,
                };
                await nested.commit(
                  mutation(
                    "Publish",
                    review57.approved,
                    { ...review57.approved, version: 4, state: "Published" },
                    24001,
                    {
                      release,
                      validationEvidence: review57.validation,
                      approvalEvidence: review57.approval,
                    },
                  ),
                );
              } else if (mode57 === "policy-head") {
                await nested.commit(
                  mutation(
                    "Archive",
                    publishedPolicy57,
                    { ...publishedPolicy57, version: 5, state: "Archived" },
                    24001,
                  ),
                );
              } else {
                await nested.commit(
                  mutation(
                    "CreateDraft",
                    null,
                    { ...review57.draft, lifecycleId: id(24000) },
                    24001,
                  ),
                );
              }
              assert.equal(
                (
                  await tx.query(
                    "SELECT count(*)::int n FROM bop_publishing.publishing_mutation_record WHERE operation_id=$1",
                    [id(24001)],
                  )
                ).rows[0].n,
                1,
              );
              if (mode57 === "root-head") {
                await tx.query(
                  "UPDATE rms_catalog.option_set SET aggregate_version=2 WHERE option_set_id=$1",
                  [set54],
                );
                assert.equal(
                  (
                    await tx.query(
                      "SELECT aggregate_version FROM rms_catalog.option_set WHERE option_set_id=$1",
                      [set54],
                    )
                  ).rows[0].aggregate_version,
                  2,
                );
              }
              if (mode57 === "approval-fields") approvalAllowed57 = false;
              if (mode57 === "approval-window") approvalLease57 = "2026-09-11T10:00:12.000Z";
              if (mode57 === "read-fields") readAllowed54 = false;
              if (mode57 === "policy-fields") policyAllowed54 = false;
              if (mode57 === "expiry") clock = evidenceEnd57;
              if (mode57 === "backward") clock = "2026-09-11T10:00:09.999Z";
              return "tentative";
            });
          }),
          (e) => e.code === "CATALOG_DEPENDENCY_UNAVAILABLE",
        );
        assert.equal(reachedThis57, true);
        assert.deepEqual(await take54(), baseline57);
      }
      assert.equal(reached57, 9);
      clock = originalAt54;
    } finally {
      await client.end();
      if (created) {
        await admin.query("DROP OWNED BY " + role);
        await admin.query("DROP ROLE " + role);
      }
      await admin.end();
    }
  });
});
