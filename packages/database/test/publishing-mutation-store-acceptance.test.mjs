import assert from "node:assert/strict";
import pg from "pg";
import { it } from "vitest";
import { createPostgresPublishingMutationStore } from "../../bop/publishing/src/index.ts";
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
                  return client.query(sql, [...values]);
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
      await runner().run(async (tx) => {
        const bound = createPostgresPublishingMutationStore(
          { run: async (work) => work(tx) },
          id(1),
          scope,
        );
        await bound.resolveCurrentRelease(query);
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
      const archived = { ...rolledNext, state: "Archived", version: 5 };
      const archive = mutation("Archive", rolledNext, archived, 430);
      archive.audit = { ...archive.audit, occurredAt: rollbackAt };
      await store.commit(archive);
      await assert.rejects(store.resolveCurrentRelease({ ...query, observedAt: rollbackAt }));
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
    } finally {
      if (created) {
        await admin.query("DROP OWNED BY " + role);
        await admin.query("DROP ROLE " + role);
      }
      await admin.end();
    }
  });
});
