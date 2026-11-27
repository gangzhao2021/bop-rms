import assert from "node:assert/strict";
import pg from "pg";
import { it } from "vitest";
import { createPostgresPublishingMutationStore } from "../../bop/publishing/src/index.ts";
import { withIsolatedDatabase } from "../test-support/isolated-database.mjs";
import { createPilotApiRole } from "../test-support/sole-operator-brand-gate.mjs";

const { Client } = pg;
const uuid = (prefix, n) => "0190" + prefix + "-0000-7000-8000-" + n.toString(16).padStart(12, "0");
const at = "2026-09-11T10:00:00.000Z",
  until = "2026-09-11T11:00:00.000Z";
const auditActions = {
  CreateDraft: "PUBLISHING_DRAFT_CREATED",
  SubmitReview: "PUBLISHING_REVIEW_SUBMITTED",
  Approve: "PUBLISHING_REVIEW_APPROVED",
  Publish: "PUBLISHING_RELEASE_PUBLISHED",
};

function merchant(prefix) {
  const id = (n) => uuid(prefix, n);
  const scope = { kind: "Brand", brandReference: id(2), storeReference: null };
  const lifecycleBase = (family, lifecycle, snapshot) => ({
    lifecycleId: id(lifecycle),
    familyReference: id(family),
    configurationType: "WORKFLOW_DEFINITION",
    purposeCode: "ORDER_FULFILLMENT",
    snapshotReference: id(snapshot),
    snapshotDigest: "sha256:" + "a".repeat(64),
    scope,
    version: 1,
    state: "Draft",
    validationEvidenceReference: null,
    approvalEvidenceReference: null,
    createdAt: at,
    changedAt: at,
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
      actor: { type: "User", reference: id(7) },
      actionCode: auditActions[operation],
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
  });
  return { id, scope, lifecycleBase, mutation };
}

async function publish(store, m, family, lifecycle, snapshot, base) {
  const draft = m.lifecycleBase(family, lifecycle, snapshot);
  await store.commit(m.mutation("CreateDraft", null, draft, base));
  const validation = {
    evidenceReference: m.id(base + 10),
    snapshotReference: draft.snapshotReference,
    snapshotDigest: draft.snapshotDigest,
    scope: m.scope,
    result: "Pass",
    checkCodes: ["SYNTHETIC_CHECK"],
    checkedAt: at,
    validUntil: until,
  };
  const review = {
    ...draft,
    version: 2,
    state: "InReview",
    validationEvidenceReference: validation.evidenceReference,
  };
  await store.commit(
    m.mutation("SubmitReview", draft, review, base + 20, { validationEvidence: validation }),
  );
  const approval = {
    evidenceReference: m.id(base + 30),
    reviewLifecycleId: draft.lifecycleId,
    reviewVersion: 2,
    snapshotReference: draft.snapshotReference,
    snapshotDigest: draft.snapshotDigest,
    scope: m.scope,
    decision: "Accepted",
    approvedActorReference: m.id(7),
    approvedAt: at,
    validUntil: until,
  };
  const approved = {
    ...review,
    version: 3,
    state: "Approved",
    approvalEvidenceReference: approval.evidenceReference,
  };
  await store.commit(
    m.mutation("Approve", review, approved, base + 40, { approvalEvidence: approval }),
  );
  const published = { ...approved, version: 4, state: "Published" };
  const release = {
    releaseId: m.id(base + 50),
    familyReference: draft.familyReference,
    configurationType: draft.configurationType,
    purposeCode: draft.purposeCode,
    snapshotReference: draft.snapshotReference,
    snapshotDigest: draft.snapshotDigest,
    scope: m.scope,
    sequence: 1,
    sourceLifecycleId: draft.lifecycleId,
    kind: "Publish",
    previousReleaseId: null,
    createdAt: at,
  };
  await store.commit(
    m.mutation("Publish", approved, published, base + 60, {
      validationEvidence: validation,
      approvalEvidence: approval,
      release,
    }),
  );
  return {
    family: draft.familyReference,
    configurationType: draft.configurationType,
    purposeCode: draft.purposeCode,
  };
}

/**
 * WP-2423 DEC-MERCHANT-LOCK-SCOPE: a fence's scope is the fact it protects. Publishing history is
 * one shared table, every read filters tenant and brand, and a table-wide lock made one merchant's
 * listing stop every other merchant's sign-in and orders. Under the restricted API role with the
 * rendered pilot ACL and the live 2 s lock_timeout:
 * - a merchant holding an uncommitted write of its family stops nobody outside that family;
 * - a reader or writer of a family still holds that family until COMMIT (the accepted guarantee);
 * - a raw INSERT still takes the family fence through the guard trigger (no write path skips it).
 */
it("one merchant's publishing write stops only its own family", async () => {
  await withIsolatedDatabase({ caseId: "wp2423_pub_iso" }, async (context) => {
    const admin = new Client(context.clientConfig);
    await admin.connect();
    const opened = [];
    const connect = async () => {
      const client = new Client(context.clientConfig);
      await client.connect();
      opened.push(client);
      return client;
    };
    try {
      const role = await createPilotApiRole(admin, context, "wp2423_pi");
      const open = async () => {
        const client = await connect();
        await client.query("BEGIN");
        await client.query("SET LOCAL ROLE " + role);
        await client.query("SET LOCAL lock_timeout='2s'");
        return client;
      };
      const borrowed = (client) => ({
        run: (work) => work({ query: (sql, values) => client.query(sql, [...values]) }),
      });
      const runner = () => ({
        async run(work) {
          const client = await open();
          try {
            const out = await work({ query: (sql, values) => client.query(sql, [...values]) });
            await client.query("COMMIT");
            return out;
          } catch (error) {
            await client.query("ROLLBACK").catch(() => undefined);
            throw error;
          } finally {
            opened.splice(opened.indexOf(client), 1);
            await client.end();
          }
        },
      });
      const timed = async (label, promise) => {
        const started = Date.now();
        try {
          await promise;
          return { label, outcome: "ok", ms: Date.now() - started };
        } catch {
          return { label, outcome: "failed", ms: Date.now() - started };
        }
      };
      const A = merchant("aaaa"),
        B = merchant("bbbb");
      const storeOf = (m) => createPostgresPublishingMutationStore(runner(), m.id(1), m.scope);
      const a = await publish(storeOf(A), A, 100, 101, 102, 1000);
      const b = await publish(storeOf(B), B, 100, 101, 102, 1000);
      const read = (m, f, port = runner()) =>
        createPostgresPublishingMutationStore(port, m.id(1), m.scope).resolveCurrentRelease({
          familyReference: f.family,
          configurationType: f.configurationType,
          purposeCode: f.purposeCode,
          observedAt: at,
        });
      await read(A, a);
      await read(B, b);

      // Merchant A's listing has written its menu family and has not committed.
      const holder = await open();
      await createPostgresPublishingMutationStore(borrowed(holder), A.id(1), A.scope).commit(
        A.mutation("CreateDraft", null, A.lifecycleBase(200, 201, 202), 2000),
      );
      const beside = [
        await timed("another merchant reads its current release", read(B, b)),
        await timed("the listing merchant's guests read another family", read(A, a)),
        await timed(
          "another merchant writes its own family",
          storeOf(B).commit(B.mutation("CreateDraft", null, B.lifecycleBase(300, 301, 302), 3000)),
        ),
      ];
      await holder.query("ROLLBACK");
      for (const step of beside) {
        assert.equal(step.outcome, "ok", step.label + " failed after " + step.ms + " ms");
        assert.ok(step.ms < 1000, step.label + " took " + step.ms + " ms");
      }

      // A reader in merchant A does not hold a writer in merchant B, nor a writer of A's other family.
      const readerInA = await open();
      await read(A, a, borrowed(readerInA));
      const besideReader = [
        await timed(
          "another merchant writes beside a reader",
          storeOf(B).commit(B.mutation("CreateDraft", null, B.lifecycleBase(320, 321, 322), 3200)),
        ),
        await timed(
          "the same merchant writes another family beside a reader",
          storeOf(A).commit(A.mutation("CreateDraft", null, A.lifecycleBase(330, 331, 332), 3300)),
        ),
      ];
      await readerInA.query("ROLLBACK");
      for (const step of besideReader) {
        assert.equal(step.outcome, "ok", step.label + " failed after " + step.ms + " ms");
        assert.ok(step.ms < 1000, step.label + " took " + step.ms + " ms");
      }

      // The fence did not weaken: whoever holds a current fact keeps it until COMMIT.
      const reader = await open();
      await read(A, a, borrowed(reader));
      const blockedWriter = await timed(
        "a writer of the family a reader holds",
        storeOf(A).commit(A.mutation("CreateDraft", null, A.lifecycleBase(100, 111, 112), 4000)),
      );
      await reader.query("ROLLBACK");
      assert.equal(blockedWriter.outcome, "failed", "a reader still holds its family");
      assert.ok(blockedWriter.ms >= 1900, "the writer waited for the reader: " + blockedWriter.ms);

      const writer = await open();
      await createPostgresPublishingMutationStore(borrowed(writer), A.id(1), A.scope).commit(
        A.mutation("CreateDraft", null, A.lifecycleBase(100, 121, 122), 4100),
      );
      const blockedReader = await timed("a reader of the family a writer holds", read(A, a));
      await writer.query("ROLLBACK");
      assert.equal(
        blockedReader.outcome,
        "failed",
        "a writer still excludes readers of its family",
      );

      // A raw INSERT takes the family fence through the guard trigger: no write path skips it.
      const rawReader = await open();
      await read(A, a, borrowed(rawReader));
      const raw = await open();
      await raw.query(
        "SELECT set_config('bop.tenant_id',$1,true),set_config('bop.brand_id',$2,true),set_config('bop.store_id','',true)",
        [A.id(1), A.id(2)],
      );
      const insertSql =
        "INSERT INTO bop_publishing.publishing_mutation_record(tenant_id,brand_id,store_id,family_id,lifecycle_id,lifecycle_version,operation_id,operation_code,actor_id,audit_id,intent_hash,release_id,release_sequence,changed_at,mutation_json) VALUES($1,$2,NULL,$3,$4,1,$5,'CreateDraft',$6,$7,$8,NULL,NULL,$9,$10::jsonb)";
      const rawMutation = A.mutation(
        "CreateDraft",
        null,
        { ...A.lifecycleBase(100, 141, 142) },
        5000,
      );
      const rawInsert = await timed(
        "a direct insert into the family a reader holds",
        raw.query(insertSql, [
          A.id(1),
          A.id(2),
          A.id(100),
          A.id(141),
          A.id(5000),
          A.id(7),
          A.id(5001),
          "sha256:" + "b".repeat(64),
          at,
          JSON.stringify(rawMutation),
        ]),
      );
      await raw.query("ROLLBACK").catch(() => undefined);
      await rawReader.query("ROLLBACK");
      assert.equal(rawInsert.outcome, "failed", "the trigger takes the family fence");
      assert.ok(rawInsert.ms >= 1900, "the direct insert waited: " + rawInsert.ms);

      // The guard takes no table lock any more: a held insert shows only the family's advisory lock.
      const held = await open();
      await createPostgresPublishingMutationStore(borrowed(held), A.id(1), A.scope).commit(
        A.mutation("CreateDraft", null, A.lifecycleBase(400, 401, 402), 6000),
      );
      const pid = (await held.query("SELECT pg_backend_pid() pid")).rows[0].pid;
      const locks = (
        await admin.query(
          "SELECT mode FROM pg_locks WHERE pid=$1 AND relation='bop_publishing.publishing_mutation_record'::regclass AND mode IN ('ShareLock','ShareRowExclusiveLock','ExclusiveLock','AccessExclusiveLock')",
          [pid],
        )
      ).rows;
      assert.deepEqual(locks, [], "no table lock that stops another merchant is held");
      await held.query("ROLLBACK");
    } finally {
      for (const client of opened) await client.end().catch(() => undefined);
      await admin.end();
    }
  });
});
