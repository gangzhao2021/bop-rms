import { exercisePickupHandoffStore } from "./pickup-handoff-store.mjs";
import assert from "node:assert/strict";
import { appendAuditRecordInTransaction } from "../../bop/audit/src/index.ts";
import {
  createPostgresPickupProofStore,
  createPostgresFulfillmentReadinessStore,
  planPickupProofIssue,
  validatePickupProof,
} from "../../rms/fulfillment/src/index.ts";

/** Real owner proof records and Audit; synthetic authority, clock and hashed capabilities. */
export async function exercisePickupProofStore({
  client,
  run,
  scope,
  creation,
  id,
  sha,
  validateCurrentSource = async () => true,
  parallelTransactions = false,
  expectedReadyAt = new Date(Date.parse(creation.aggregate.createdAt) + 2000).toISOString(),
}) {
  let allowed = true,
    eligible = true,
    failAt = null,
    reached = false;
  let queryFailureCode = null;
  let now = new Date(Date.parse(expectedReadyAt) + 20 * 60000).toISOString();
  const orderReference = creation.aggregate.orderReference;
  const options = {
    ...scope,
    sha256: sha,
    now: () => now,
    authorize: async () => allowed,
    validateCurrentSource: async (tx, order) =>
      eligible && (await validateCurrentSource(tx, order)),
  };
  const store = createPostgresPickupProofStore({
    ...options,
    appendAudit: async (tx, fact) => {
      await appendAuditRecordInTransaction(tx, {
        auditId: id(2000 + Number.parseInt(fact.operationReference.slice(-6), 16)),
        brandId: scope.brandReference,
        storeId: scope.storeReference,
        actor: { type: "System" },
        actionCode: "PICKUP_PROOF_" + fact.kind.toUpperCase(),
        targetType: "Fulfillment",
        targetId: fact.fulfillmentReference,
        beforeSummary: null,
        afterSummary: { operation: fact.kind },
        reasonCode: "PICKUP_PROOF",
        correlationId: fact.correlationReference,
        occurredAt: fact.occurredAt,
        sourceChannel: "EVENT_CONSUMER",
        dataClassification: "Confidential",
        retentionPolicyCode: "FULFILLMENT_BUSINESS_RECORD",
        retentionPolicyVersion: 1,
      });
      if (failAt === "audit") {
        reached = true;
        throw new Error("synthetic proof audit failure");
      }
    },
  });
  const reader = createPostgresFulfillmentReadinessStore(options);
  const load = () => run((transaction) => store.lockByOrder({ transaction, orderReference }));
  const initial = await load();
  const initialVersion = BigInt(1 + creation.aggregate.items.length);
  const proofAt = (minutes) =>
    new Date(Date.parse(initial.source.readyAt) + minutes * 60000).toISOString();
  assert.equal(initial.source.aggregateVersion, initialVersion);
  assert.equal(initial.source.readyAt, expectedReadyAt);
  assert.equal(initial.capability, null);
  function candidate(n, readyAt = initial.source.readyAt) {
    return {
      capabilityReference: id(500 + n),
      purpose: "PickupHandoff",
      kind: "HumanCode",
      storeReference: scope.storeReference,
      fulfillmentReference: creation.aggregate.fulfillmentReference,
      publicOrderReference: "AAAAAAAAAAAAAAAAAAAAAA",
      selectorHash: String(n).repeat(64),
      pepperVersion: 1,
      generation: n,
      status: "Active",
      version: 1,
      readyAt,
      expiresAt: proofAt(60),
      revokedAt: null,
    };
  }
  const first = planPickupProofIssue({
    source: initial.source,
    candidate: candidate(1),
    previous: null,
    expectedAggregateVersion: initialVersion,
    observedAt: proofAt(1 / 10),
    operationReference: id(510),
    idempotencyReference: id(511),
    correlationReference: id(512),
    invalidationReference: null,
  });
  const counts = async () =>
    (
      await client.query(
        "SELECT (SELECT count(*)::int FROM rms_fulfillment.pickup_proof_generation WHERE brand_id=$1) AS generations," +
          "(SELECT count(*)::int FROM rms_fulfillment.pickup_proof_invalidation WHERE brand_id=$1) AS invalidations," +
          "(SELECT count(*)::int FROM rms_fulfillment.pickup_proof_verification WHERE brand_id=$1) AS verifications," +
          "(SELECT count(*)::int FROM rms_fulfillment.pickup_proof_operation WHERE brand_id=$1) AS operations," +
          "(SELECT count(*)::int FROM platform_audit.audit_record WHERE brand_id=$1) AS audits",
        [scope.brandReference],
      )
    ).rows[0];
  const wrap = (tx) => ({
    query: async (sql, args) => {
      if (failAt && sql.startsWith(failAt)) {
        reached = true;
        throw new Error("synthetic proof write failure");
      }
      try {
        return await tx.query(sql, args);
      } catch (error) {
        queryFailureCode =
          typeof error.code === "string" && /^[A-Z0-9_]{1,80}$/.test(error.code)
            ? error.code
            : "UNCLASSIFIED";
        throw error;
      }
    },
  });
  async function failedWrites(work, points) {
    const before = await counts();
    for (const point of points) {
      failAt = point;
      reached = false;
      queryFailureCode = null;
      // Deliberately catch inside caller transaction and commit: savepoint must undo all owner/Audit effects.
      await run(async (tx) => {
        await assert.rejects(work(wrap(tx)));
      });
      assert.equal(
        reached,
        true,
        "proof checkpoint " +
          points.indexOf(point) +
          ", database code " +
          (queryFailureCode ?? "none"),
      );
      assert.deepEqual(await counts(), before);
    }
    failAt = null;
  }
  const issue = (effect, transaction) => store.issue({ effect, transaction, orderReference });
  await failedWrites(
    (tx) => issue(first, tx),
    [
      "INSERT INTO rms_fulfillment.pickup_proof_generation",
      "INSERT INTO rms_fulfillment.pickup_proof_operation",
      "audit",
    ],
  );
  assert.equal((await run((tx) => issue(first, tx))).status, "Applied");
  assert.deepEqual((await run((tx) => issue(first, tx))).effect, first);
  const issued = await load();
  assert.equal(issued.source.aggregateVersion, initialVersion + 1n);
  assert.equal(issued.source.currentProofGeneration, 1);
  const makeVerification = (proof, n, at) =>
    validatePickupProof({
      source: proof.source,
      capability: proof.capability,
      selectorHash: String(n).repeat(64),
      generation: n,
      expectedCapabilityVersion: 1,
      observedAt: at,
      verificationReference: id(600 + n * 10),
      operationReference: id(601 + n * 10),
      idempotencyReference: id(602 + n * 10),
      correlationReference: id(603 + n * 10),
    });
  const v1 = makeVerification(issued, 1, proofAt(2 / 10));
  const verify = (record, selectorHash, transaction) =>
    store.verify({ record, selectorHash, transaction, orderReference });
  await failedWrites(
    (tx) => verify(v1, "1".repeat(64), tx),
    [
      "INSERT INTO rms_fulfillment.pickup_proof_verification",
      "INSERT INTO rms_fulfillment.pickup_proof_operation",
      "audit",
    ],
  );
  assert.equal((await run((tx) => verify(v1, "1".repeat(64), tx))).status, "Applied");
  await load(); // Require normalized verification history to remain readable before regeneration.
  const second = planPickupProofIssue({
    source: issued.source,
    previous: issued.capability,
    candidate: candidate(2, proofAt(5 / 10)),
    expectedAggregateVersion: initialVersion + 1n,
    observedAt: proofAt(5 / 10),
    operationReference: id(520),
    idempotencyReference: id(521),
    correlationReference: id(522),
    invalidationReference: id(523),
  });
  await failedWrites(
    (tx) => issue(second, tx),
    [
      "INSERT INTO rms_fulfillment.pickup_proof_invalidation",
      "INSERT INTO rms_fulfillment.pickup_proof_operation",
      "audit",
    ],
  );
  assert.equal((await run((tx) => issue(second, tx))).status, "Applied");
  const regenerated = await load();
  assert.equal(regenerated.source.aggregateVersion, initialVersion + 2n);
  assert.equal(regenerated.source.currentProofGeneration, 2);
  assert.equal(regenerated.source.readyAt, initial.source.readyAt);
  assert.equal(regenerated.capability.expiresAt, candidate(1).expiresAt);
  const ready = await run((transaction) =>
    reader.lockByOrder({ ...scope, orderReference, transaction }),
  );
  assert.equal(ready.aggregateVersion, initialVersion + 2n);
  assert.equal(ready.canonicalPhase, "Ready");
  const v2 = makeVerification(regenerated, 2, proofAt(6 / 10));
  assert.equal((await run((tx) => verify(v2, "2".repeat(64), tx))).status, "Applied");
  assert.equal((await load()).source.aggregateVersion, initialVersion + 2n); // Verify does not advance aggregate.
  await assert.rejects(
    run((tx) =>
      verify(
        {
          ...v1,
          verificationReference: id(650),
          operationReference: id(651),
          idempotencyReference: id(652),
          correlationReference: id(653),
          verifiedAt: proofAt(7 / 10),
        },
        "1".repeat(64),
        tx,
      ),
    ),
  );
  await assert.rejects(run((tx) => verify(v2, "3".repeat(64), tx)));
  const beforeRecovery = await counts();
  eligible = false;
  assert.deepEqual((await run((tx) => issue(first, tx))).effect, first);
  assert.deepEqual((await run((tx) => verify(v1, "1".repeat(64), tx))).record, v1);
  await assert.rejects(load());
  allowed = false;
  await assert.rejects(
    run((transaction) =>
      store.resolveByIdempotency({
        transaction,
        orderReference,
        idempotencyReference: first.operation.idempotencyReference,
      }),
    ),
  );
  assert.deepEqual(await counts(), beforeRecovery);
  allowed = true;
  eligible = true;
  now = proofAt(61);
  await assert.rejects(
    run((tx) =>
      verify(
        {
          ...v2,
          verificationReference: id(660),
          operationReference: id(661),
          idempotencyReference: id(662),
          correlationReference: id(663),
          verifiedAt: now,
        },
        "2".repeat(64),
        tx,
      ),
    ),
  );
  await assert.rejects(
    run((tx) =>
      verify(
        {
          ...v2,
          verificationReference: id(670),
          operationReference: id(671),
          idempotencyReference: id(672),
          correlationReference: id(673),
        },
        "2".repeat(64),
        tx,
      ),
    ),
  ); // A backdated new request cannot use an expired current proof.
  const final = await counts();
  assert.equal(final.generations, 2);
  assert.equal(final.invalidations, 1);
  assert.equal(final.verifications, 2);
  assert.equal(final.operations, 4);
  now = proofAt(20);
  return exercisePickupHandoffStore({
    client,
    run,
    scope,
    creation,
    id,
    options,
    verification: v2,
    proofAt,
    proofStore: store,
    parallelTransactions,
  });
}
