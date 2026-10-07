import assert from "node:assert/strict";
import pg from "pg";
import { canonicalizeRfc8785, sha256Hex } from "../../bop/audit/src/index.ts";
import { createBrand, createTenantContext } from "../../bop/tenant/src/index.ts";
import { evaluatePermission } from "../../bop/permission/src/index.ts";
import {
  createPostgresPublishingMutationStore,
  executePublishingMutation,
  optionSetPolicyScopeLevels,
  publishingOptionSetPublicationPolicyDigest,
  parsePublishingOptionSetReviewPolicy,
} from "../../bop/publishing/src/index.ts";
import { withIsolatedDatabase } from "./isolated-database.mjs";

const id = (n) => "01902421-7400-7000-8000-" + n.toString(16).padStart(12, "0");
const digest = (value) => "sha256:" + sha256Hex(canonicalizeRfc8785(value));
const actions = {
  CreateDraft: "PUBLISHING_DRAFT_CREATED",
  SubmitReview: "PUBLISHING_REVIEW_SUBMITTED",
  Approve: "PUBLISHING_REVIEW_APPROVED",
  Publish: "PUBLISHING_RELEASE_PUBLISHED",
  Rollback: "PUBLISHING_RELEASE_ROLLED_BACK",
};

/** Controlled synthetic identities, ExplicitAllow permission evidence and snapshot validation.
 * This proves actual Publishing service/owner transactions, forced RLS, immutable policy/review
 * provenance, Audit and SQL guards. It is not native IAM or actual Catalog content validation. */
export async function exerciseOptionSetApprovalWaiver() {
  await withIsolatedDatabase({ caseId: "wp2421_optwaiver" }, async (context) => {
    const admin = new pg.Client(context.clientConfig);
    const role = "wp2421_optwaiver_" + context.runId;
    assert.match(role, /^wp2421_optwaiver_[a-f0-9]+$/u);
    let roleCreated = false;
    let sequence = 100;
    let permissionAllowed = true;
    let expectedPolicy = null;
    const reference = () => id(sequence++);
    const tenant = id(1),
      brand = id(2),
      submittingActor = id(3),
      approvingActor = id(4);
    const family = id(7);
    const scope = { kind: "Brand", brandReference: brand, storeReference: null };
    const dbClock = async (tx) => {
      const result = await tx.query(
        "SELECT date_trunc('milliseconds',clock_timestamp()) AS observed_at",
      );
      return result.rows[0].observed_at.toISOString();
    };
    const counts = async () =>
      (
        await admin.query(`SELECT
      (SELECT count(*)::int FROM bop_publishing.publishing_mutation_record) mutations,
      (SELECT count(*)::int FROM platform_audit.audit_record) audits,
      (SELECT coalesce(jsonb_agg(to_jsonb(h) ORDER BY h.brand_id,h.scope_store_key),'[]'::jsonb)
       FROM platform_audit.audit_chain_head h) chains`)
      ).rows[0];
    const transaction = async (work, options = {}) => {
      const client = new pg.Client({ ...context.clientConfig, connectionTimeoutMillis: 10000 });
      let committed = false,
        began = false;
      try {
        await client.connect();
        await client.query("BEGIN");
        began = true;
        await client.query("SET LOCAL ROLE " + role);
        await client.query("SET LOCAL lock_timeout = '5s'");
        await client.query("SET LOCAL statement_timeout = '15s'");
        const result = await work(client);
        await client.query("COMMIT");
        committed = true;
        if (options.loseAck) throw new Error("synthetic original response loss after commit");
        return result;
      } catch (error) {
        if (began && !committed) await client.query("ROLLBACK");
        throw error;
      } finally {
        await client.end();
      }
    };
    const owner = (tx, configured = true, tenantReference = tenant) =>
      createPostgresPublishingMutationStore(
        { run: (work) => work(tx) },
        tenantReference,
        scope,
        configured ? { optionSetPolicyFamilyReference: family } : undefined,
      );
    const until = (clock) => new Date(Date.parse(clock) + 3600000).toISOString();
    function mutation(operation, current, next, clock, extra = {}) {
      const operationReference = reference();
      return {
        operation,
        expectedVersion: current?.version ?? 1,
        idempotencyKey: operationReference,
        current,
        next,
        release: null,
        supersededReleaseId: null,
        rollbackTargetReleaseId: null,
        validationEvidence: null,
        approvalEvidence: null,
        audit: {
          auditId: reference(),
          brandId: brand,
          actor: {
            type: "User",
            reference: ["CreateDraft", "SubmitReview"].includes(operation)
              ? submittingActor
              : approvingActor,
          },
          actionCode: actions[operation],
          targetType: "PublishingLifecycle",
          targetId: next.lifecycleId,
          reasonCode: actions[operation],
          correlationId: operationReference,
          occurredAt: clock,
          sourceChannel: "MERCHANT_WEB",
          dataClassification: "Confidential",
          retentionPolicyCode: "PUBLISHING_LIFECYCLE_AUDIT",
          retentionPolicyVersion: 1,
        },
        ...extra,
      };
    }
    async function apply(store, input) {
      const clock = input.audit.occurredAt;
      const tenantContext = createTenantContext(
        {
          actorType: "User",
          accountKind: "Workforce",
          actorReference: input.audit.actor.reference,
          status: "Active",
          authenticationMethod: "Oidc",
          verificationLevel: "SingleFactor",
          authenticatedAt: clock,
          recentMfaAt: null,
        },
        createBrand({
          brandReference: brand,
          code: "SYNTH_OPTION_WAIVER",
          displayName: "Synthetic waiver Brand",
          defaultLocale: "en-CA",
          currencyCode: "CAD",
          lifecycle: "Active",
          version: 1,
          createdAt: clock,
          updatedAt: clock,
        }),
        null,
        clock,
      );
      return executePublishingMutation(
        {
          tenantContext,
          operation: input.operation,
          expectedVersion: input.expectedVersion,
          current: input.current,
          next: input.next,
          idempotencyKey: input.idempotencyKey,
          auditId: input.audit.auditId,
          correlationId: input.audit.correlationId,
          occurredAt: clock,
          sourceChannel: input.audit.sourceChannel,
          ...(input.validationEvidence ? { validationEvidence: input.validationEvidence } : {}),
          ...(input.approvalEvidence ? { approvalEvidence: input.approvalEvidence } : {}),
          ...(input.optionSetPolicyContent
            ? { optionSetPolicyContent: input.optionSetPolicyContent }
            : {}),
          ...(input.optionSetReviewPolicy
            ? { optionSetReviewPolicy: input.optionSetReviewPolicy }
            : {}),
          ...(input.optionSetApprovalWaiver
            ? { optionSetApprovalWaiver: input.optionSetApprovalWaiver }
            : {}),
          ...(input.release ? { release: input.release } : {}),
          ...(input.previousRelease ? { previousRelease: input.previousRelease } : {}),
          ...(input.rollbackTarget ? { rollbackTarget: input.rollbackTarget } : {}),
        },
        {
          unitOfWork: store,
          authorization: {
            authorize: async (request) =>
              evaluatePermission({
                tenantContext: request.tenantContext,
                action: request.action,
                resourceScope: request.resourceScope,
                policySnapshotReference: id(5),
                policyVersion: 1,
                evidence: permissionAllowed
                  ? [
                      {
                        source: "ExplicitAllow",
                        evidenceReference: id(6),
                        action: request.action,
                        actorReference: request.tenantContext.actor.actorReference,
                        roleReference: null,
                        brandReference: brand,
                        storeReference: null,
                        effectiveFrom: clock,
                        effectiveUntil: until(clock),
                      },
                    ]
                  : [],
              }),
          },
        },
      );
    }
    function draft(
      clock,
      configurationType,
      purposeCode,
      familyReference,
      snapshotReference,
      snapshotDigest,
    ) {
      return {
        lifecycleId: reference(),
        familyReference,
        configurationType,
        purposeCode,
        snapshotReference,
        snapshotDigest,
        scope,
        version: 1,
        state: "Draft",
        validationEvidenceReference: null,
        approvalEvidenceReference: null,
        createdAt: clock,
        changedAt: clock,
      };
    }
    function validation(record, clock) {
      return {
        evidenceReference: reference(),
        snapshotReference: record.snapshotReference,
        snapshotDigest: record.snapshotDigest,
        scope,
        result: "Pass",
        checkedAt: clock,
        validUntil: until(clock),
        checkCodes: ["SYNTHETIC_OPTION_CONTENT_VALID"],
      };
    }
    function release(record, clock, previous = null, rollback = null) {
      return {
        releaseId: reference(),
        familyReference: record.familyReference,
        configurationType: record.configurationType,
        purposeCode: record.purposeCode,
        snapshotReference: record.snapshotReference,
        snapshotDigest: record.snapshotDigest,
        scope,
        sequence: (previous?.sequence ?? 0) + 1,
        sourceLifecycleId: record.lifecycleId,
        kind: rollback ? "Rollback" : "Publish",
        previousReleaseId: previous?.releaseId ?? null,
        createdAt: clock,
      };
    }
    async function publishPolicy(body, previous = null, rollback = null) {
      const result = await transaction(async (tx) => {
        const clock = await dbClock(tx),
          store = owner(tx);
        const start = draft(
          clock,
          "OPTION_SET_PUBLICATION_POLICY",
          "OPTION_SET_PUBLICATION_POLICY",
          family,
          body.policyReference,
          publishingOptionSetPublicationPolicyDigest(body),
        );
        await apply(
          store,
          mutation(
            "CreateDraft",
            null,
            start,
            clock,
            rollback ? {} : { optionSetPolicyContent: body },
          ),
        );
        const checked = validation(start, clock);
        const review = {
          ...start,
          state: "InReview",
          version: 2,
          validationEvidenceReference: checked.evidenceReference,
        };
        await apply(
          store,
          mutation("SubmitReview", start, review, clock, { validationEvidence: checked }),
        );
        const proof = {
          evidenceReference: reference(),
          reviewLifecycleId: start.lifecycleId,
          reviewVersion: 2,
          snapshotReference: start.snapshotReference,
          snapshotDigest: start.snapshotDigest,
          scope,
          decision: "Accepted",
          approvedActorReference: approvingActor,
          approvedAt: clock,
          validUntil: until(clock),
        };
        const approved = {
          ...review,
          state: "Approved",
          version: 3,
          approvalEvidenceReference: proof.evidenceReference,
        };
        await apply(
          store,
          mutation("Approve", review, approved, clock, { approvalEvidence: proof }),
        );
        const published = { ...approved, state: "Published", version: 4 };
        const publication = release(published, clock, previous, rollback);
        const input = mutation(rollback ? "Rollback" : "Publish", approved, published, clock, {
          release: publication,
          supersededReleaseId: previous?.releaseId ?? null,
          rollbackTargetReleaseId: rollback?.releaseId ?? null,
          validationEvidence: checked,
          approvalEvidence: proof,
          ...(previous ? { previousRelease: previous } : {}),
          ...(rollback ? { rollbackTarget: rollback } : {}),
        });
        // Service DTO has contextual prior releases; the owning immutable command does not.
        await apply(store, input);
        return { body, release: publication, published };
      });
      expectedPolicy = result;
      return result;
    }
    async function contentReview(tx) {
      const clock = await dbClock(tx);
      const trace = { sqlPhase: "none", rowCount: 0, sqlCode: "none" };
      const traced = {
        query: async (sql, values) => {
          trace.sqlPhase = sql.includes("transaction_isolation")
            ? "isolation"
            : sql.startsWith("SELECT set_config")
              ? "scope"
              : sql.startsWith("LOCK TABLE")
                ? "source-lock"
                : sql.includes("optionSetPolicyContent")
                  ? "policy-registration"
                  : sql.includes("release_id IS NOT NULL")
                    ? "policy-release"
                    : sql.includes("operation_code IN ('SubmitReview','Approve')")
                      ? "governance-provenance"
                      : sql.includes("lifecycle_id=")
                        ? "lifecycle"
                        : "other-owner";
          try {
            const result = await tx.query(sql, values);
            trace.rowCount = Math.min(result.rows?.length ?? 0, 1025);
            return result;
          } catch (error) {
            trace.sqlCode =
              typeof error?.code === "string" && /^[0-9A-Z]{5}$/u.test(error.code)
                ? error.code
                : "unavailable";
            throw error;
          }
        },
      };
      const store = owner(traced);
      const phase = async (name, work) => {
        trace.sqlPhase = "none";
        trace.rowCount = 0;
        trace.sqlCode = "none";
        try {
          return await work();
        } catch (error) {
          const code =
            typeof error?.code === "string" && /^PUBLISHING_[A-Z_]{1,48}$/u.test(error.code)
              ? error.code
              : "unavailable";
          throw new Error(
            "Option waiver native phase " +
              name +
              "; publicCode=" +
              code +
              "; sqlPhase=" +
              trace.sqlPhase +
              "; rows=" +
              trace.rowCount +
              "; sqlCode=" +
              trace.sqlCode,
            { cause: error },
          );
        }
      };
      assert.ok(expectedPolicy, "actual committed governing policy is required");
      const published = await phase("legacy-current-release", () =>
        store.resolveCurrentRelease({
          familyReference: family,
          configurationType: "OPTION_SET_PUBLICATION_POLICY",
          purposeCode: "OPTION_SET_PUBLICATION_POLICY",
          observedAt: clock,
        }),
      );
      const held = await phase("legacy-current-policy", () =>
        store.resolveCurrentOptionSetPublicationPolicy({
          policyReference: expectedPolicy.body.policyReference,
          policyVersion: expectedPolicy.body.policyVersion,
          observedAt: clock,
        }),
      );
      assert.equal(published.release.releaseId, expectedPolicy.release.releaseId);
      assert.equal(held.current.release.releaseId, published.release.releaseId);
      const snapshotReference = reference();
      const start = draft(
        clock,
        "CATALOG_OPTION_SET",
        "CATALOG_OPTION_SET_PUBLICATION",
        reference(),
        snapshotReference,
        digest({ syntheticOptionContentReference: snapshotReference }),
      );
      await apply(store, mutation("CreateDraft", null, start, clock));
      const checked = validation(start, clock);
      const review = {
        ...start,
        state: "InReview",
        version: 2,
        validationEvidenceReference: checked.evidenceReference,
      };
      const input = mutation("SubmitReview", start, review, clock, { validationEvidence: checked });
      const preparedInput = {
        reviewOperationReference: input.idempotencyKey,
        reviewLifecycle: review,
        validationEvidence: checked,
        submittedActorReference: submittingActor,
        submittedAt: clock,
      };
      await phase("binding-parser", async () =>
        parsePublishingOptionSetReviewPolicy({
          profile: "PublishingOptionSetReviewPolicyV1",
          tenantReference: tenant,
          policyContent: held.content,
          policyReleaseReference: held.current.release.releaseId,
          policyReleaseSequence: held.current.release.sequence,
          policySnapshotDigest: held.current.release.snapshotDigest,
          ...preparedInput,
        }),
      );
      const binding = await phase("configured-owner-binding", () =>
        store.resolveOptionSetReviewPolicy(preparedInput),
      );
      input.optionSetReviewPolicy = binding;
      await apply(store, input);
      return { review, checked, binding, reviewInput: input };
    }
    async function preparePublish(tx, reviewed) {
      const clock = await dbClock(tx),
        store = owner(tx);
      const waiver = await store.resolveOptionSetApprovalWaiver({
        familyReference: reviewed.review.familyReference,
        lifecycleReference: reviewed.review.lifecycleId,
        observedAt: clock,
      });
      const next = { ...reviewed.review, state: "Published", version: 3, changedAt: clock };
      return mutation("Publish", reviewed.review, next, clock, {
        release: release(next, clock),
        validationEvidence: reviewed.checked,
        optionSetApprovalWaiver: waiver,
      });
    }
    async function unchangedAfter(work, predicate) {
      const before = await counts();
      await assert.rejects(work, predicate);
      assert.deepEqual(await counts(), before);
    }
    async function directInsert(tx, input) {
      await tx.query(
        "SELECT set_config('bop.tenant_id',$1,true),set_config('bop.brand_id',$2,true),set_config('bop.store_id','',true)",
        [tenant, brand],
      );
      return tx.query(
        `INSERT INTO bop_publishing.publishing_mutation_record
        (tenant_id,brand_id,store_id,family_id,lifecycle_id,lifecycle_version,operation_id,operation_code,actor_id,audit_id,intent_hash,release_id,release_sequence,changed_at,mutation_json)
        VALUES ($1,$2,NULL,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14::jsonb)`,
        [
          tenant,
          brand,
          input.next.familyReference,
          input.next.lifecycleId,
          input.next.version,
          input.idempotencyKey,
          input.operation,
          input.audit.actor.reference,
          input.audit.auditId,
          digest(input),
          input.release?.releaseId ?? null,
          input.release?.sequence ?? null,
          input.next.changedAt,
          JSON.stringify(input),
        ],
      );
    }
    try {
      await admin.connect();
      await admin.query("CREATE ROLE " + role + " NOLOGIN NOSUPERUSER NOBYPASSRLS");
      roleCreated = true;
      await admin.query(
        "GRANT USAGE ON SCHEMA bop_publishing,platform_audit,platform_helpers TO " + role,
      );
      await admin.query(
        "GRANT SELECT,INSERT ON bop_publishing.publishing_mutation_record,platform_audit.audit_record TO " +
          role,
      );
      // SHARE owner fences require UPDATE ACL; immutable history triggers still reject edits.
      await admin.query("GRANT UPDATE ON bop_publishing.publishing_mutation_record TO " + role);
      await admin.query("GRANT SELECT,INSERT,UPDATE ON platform_audit.audit_chain_head TO " + role);
      await admin.query(
        "GRANT EXECUTE ON FUNCTION platform_helpers.current_brand_id(),platform_helpers.current_store_id(),platform_helpers.is_uuid_v7(uuid) TO " +
          role,
      );
      await admin.query("GRANT USAGE ON TYPE platform_helpers.uuid_v7 TO " + role);
      const initialClock = await dbClock(admin);
      const body = (approvalPolicy, version) => ({
        profile: "PublishingOptionSetPublicationPolicyV1",
        tenantReference: tenant,
        brandReference: brand,
        familyReference: family,
        policyReference: reference(),
        policyVersion: version,
        scopeOrder: [...optionSetPolicyScopeLevels],
        approvalPolicy,
        warningOverrideAllowed: false,
        requiredLocales: ["en-CA"],
        mediaRequirement: "Optional",
        effectiveFrom: initialClock,
        effectiveUntil: until(initialClock),
      });
      const firstPolicy = await publishPolicy(body("NotRequired", 1));
      const reviewed = await transaction(contentReview);
      const original = await transaction((tx) => preparePublish(tx, reviewed));
      await unchangedAfter(() =>
        transaction((tx) => {
          const absent = { ...original };
          delete absent.optionSetApprovalWaiver;
          return apply(owner(tx), absent);
        }),
      );
      await unchangedAfter(() =>
        transaction((tx) => {
          const changed = globalThis.structuredClone(original);
          changed.optionSetApprovalWaiver.reviewPolicy.reviewOperationReference = reference();
          return apply(owner(tx), changed);
        }),
      );
      await unchangedAfter(
        () => transaction((tx) => owner(tx, false).commit(original)),
        (error) => error.code === "PUBLISHING_INPUT_INVALID",
      );
      for (const change of ["missing", "operation", "policyDigest", "policyRelease", "scope"]) {
        await unchangedAfter(
          () =>
            transaction((tx) => {
              const fake = globalThis.structuredClone(original);
              fake.idempotencyKey = reference();
              fake.audit.auditId = reference();
              fake.audit.correlationId = fake.idempotencyKey;
              if (change === "missing") delete fake.optionSetApprovalWaiver;
              if (change === "operation")
                fake.optionSetApprovalWaiver.reviewPolicy.reviewOperationReference = reference();
              if (change === "policyDigest")
                fake.optionSetApprovalWaiver.reviewPolicy.policySnapshotDigest =
                  "sha256:" + "f".repeat(64);
              if (change === "policyRelease")
                fake.optionSetApprovalWaiver.reviewPolicy.policyReleaseReference = reference();
              if (change === "scope")
                fake.optionSetApprovalWaiver.reviewPolicy.policyContent.brandReference = id(90);
              return directInsert(tx, fake);
            }),
          (error) => error.code === "23514",
        );
      }
      permissionAllowed = false;
      await unchangedAfter(
        () => transaction((tx) => apply(owner(tx), original)),
        (error) => error.code === "PUBLISHING_PERMISSION_DENIED",
      );
      permissionAllowed = true;
      const beforeLostReply = await counts();
      await assert.rejects(
        () =>
          transaction(
            async (tx) => {
              const committed = await apply(owner(tx), original);
              assert.equal(committed.auditReference, original.audit.auditId);
              return committed;
            },
            { loseAck: true },
          ),
        (error) => error.message === "synthetic original response loss after commit",
      );
      const baseline = await counts();
      assert.equal(baseline.mutations, beforeLostReply.mutations + 1);
      assert.equal(baseline.audits, beforeLostReply.audits + 1);
      const recover = async (tx) => {
        const store = owner(tx),
          observedAt = await dbClock(tx);
        const current = await store.resolveCurrentOptionSetRelease({
          familyReference: original.next.familyReference,
          observedAt,
        });
        assert.equal(current.approvalDisposition, "PolicyWaived");
        assert.equal(current.approvalEvidence, null);
        assert.equal(current.lifecycle.approvalEvidenceReference, null);
        assert.equal(current.release.releaseId, original.release.releaseId);
        assert.deepEqual(current.waiver, original.optionSetApprovalWaiver);
        const referenced = await store.resolveCurrentOptionSetReleaseForReference({
          publicationReference: original.release.releaseId,
          observedAt,
        });
        assert.equal(referenced.recorded.approvalDisposition, "PolicyWaived");
        assert.equal(referenced.current.release.releaseId, original.release.releaseId);
        const saved = await store.resolveOperation({
          operationReference: original.idempotencyKey,
          familyReference: original.next.familyReference,
          lifecycleReference: original.next.lifecycleId,
          configurationType: "CATALOG_OPTION_SET",
          purposeCode: "CATALOG_OPTION_SET_PUBLICATION",
          observedAt,
        });
        assert.deepEqual(saved, original);
        assert.deepEqual(await store.commit(original), { auditReference: original.audit.auditId });
      };
      await transaction(recover);
      assert.deepEqual(await counts(), baseline);
      await unchangedAfter(() =>
        transaction(async (tx) =>
          owner(tx).resolveCurrentRelease({
            familyReference: original.next.familyReference,
            configurationType: "CATALOG_OPTION_SET",
            purposeCode: "CATALOG_OPTION_SET_PUBLICATION",
            observedAt: await dbClock(tx),
          }),
        ),
      );
      await unchangedAfter(() =>
        transaction(async (tx) =>
          owner(tx, true, id(91)).resolveCurrentOptionSetRelease({
            familyReference: original.next.familyReference,
            observedAt: await dbClock(tx),
          }),
        ),
      );
      await unchangedAfter(
        () =>
          transaction(async (tx) => {
            const pending = await contentReview(tx),
              input = await preparePublish(tx, pending);
            await apply(owner(tx), input);
            throw new Error("synthetic outer transaction rollback");
          }),
        (error) => error.message === "synthetic outer transaction rollback",
      );
      const staleReview = await transaction(contentReview);
      const staleInput = await transaction((tx) => preparePublish(tx, staleReview));
      const requiredPolicy = await publishPolicy(body("Required", 2), firstPolicy.release);
      await unchangedAfter(() => transaction((tx) => apply(owner(tx), staleInput)));
      await unchangedAfter(
        () =>
          transaction((tx) => {
            const fake = globalThis.structuredClone(staleInput);
            fake.idempotencyKey = reference();
            fake.audit.auditId = reference();
            fake.audit.correlationId = fake.idempotencyKey;
            return directInsert(tx, fake);
          }),
        (error) => error.code === "23514",
      );
      await unchangedAfter(() =>
        transaction(async (tx) =>
          owner(tx).resolveOptionSetApprovalWaiver({
            familyReference: staleReview.review.familyReference,
            lifecycleReference: staleReview.review.lifecycleId,
            observedAt: await dbClock(tx),
          }),
        ),
      );
      await transaction(recover);
      const afterSupersession = await counts();
      await transaction(recover);
      assert.deepEqual(await counts(), afterSupersession);
      const requiredReview = await transaction(contentReview);
      await unchangedAfter(() =>
        transaction(async (tx) =>
          owner(tx).resolveOptionSetApprovalWaiver({
            familyReference: requiredReview.review.familyReference,
            lifecycleReference: requiredReview.review.lifecycleId,
            observedAt: await dbClock(tx),
          }),
        ),
      );
      await unchangedAfter(
        () =>
          transaction(async (tx) => {
            const clock = await dbClock(tx),
              next = { ...requiredReview.review, version: 3, state: "Published", changedAt: clock };
            return directInsert(
              tx,
              mutation("Publish", requiredReview.review, next, clock, {
                release: release(next, clock),
                validationEvidence: requiredReview.checked,
                optionSetApprovalWaiver: {
                  profile: "PublishingOptionSetApprovalWaiverV1",
                  reviewPolicy: requiredReview.binding,
                  recordedAt: clock,
                },
              }),
            );
          }),
        (error) => error.code === "23514",
      );
      // Governance Rollback deliberately omits the body: it reuses the existing immutable registration.
      const restored = await publishPolicy(
        firstPolicy.body,
        requiredPolicy.release,
        firstPolicy.release,
      );
      await transaction(async (tx) => {
        const store = owner(tx),
          clock = await dbClock(tx);
        const policy = await store.resolveCurrentOptionSetPublicationPolicy({
          policyReference: firstPolicy.body.policyReference,
          policyVersion: 1,
          observedAt: clock,
        });
        assert.equal(policy.current.release.kind, "Rollback");
        assert.equal(policy.current.release.releaseId, restored.release.releaseId);
        const pending = await contentReview(tx);
        assert.equal(pending.binding.policyReleaseReference, restored.release.releaseId);
        const input = await preparePublish(tx, pending);
        await apply(store, input);
        const proof = await store.resolveCurrentOptionSetRelease({
          familyReference: input.next.familyReference,
          observedAt: await dbClock(tx),
        });
        assert.equal(proof.approvalDisposition, "PolicyWaived");
        assert.equal(proof.waiver.reviewPolicy.policyReleaseReference, restored.release.releaseId);
      });
      await transaction(recover);
    } finally {
      try {
        if (roleCreated) {
          await admin.query("DROP OWNED BY " + role);
          await admin.query("DROP ROLE " + role);
        }
      } finally {
        await admin.end();
      }
    }
  });
}
