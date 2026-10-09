import { env } from "node:process";
import { createPickupMerchantBrowser } from "./pickup-merchant-browser.mjs";
import { createPickupMerchantHttp } from "./pickup-merchant-http.mjs";
import { seedMerchantAcceptanceSession } from "./merchant-acceptance-session.mjs";
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { appendAuditRecordInTransaction } from "../../bop/audit/src/index.ts";
import { loadOutboxEnvelope } from "../../bop/eventing/src/index.ts";
import {
  createPostgresFulfillmentReadinessStore,
  createPostgresPickupProofStore,
  createPostgresPickupHandoffStore,
  createPickupCredentialProvider,
  createPostgresPickupProofIssuer,
  parseFulfillmentCompletedEnvelope,
} from "../../rms/fulfillment/src/index.ts";

/** Original current-clock Ready fulfillment; capability and staff/device/location
 * approvals are explicit synthetic inputs. No simulated future completion. */
export async function exerciseEntryPickupHandoff({
  admin,
  role,
  run,
  scope,
  ready,
  reference,
  onReadyForMerchantBff,
}) {
  const now = () => new Date().toISOString();
  const sha256 = (value) => "sha256:" + createHash("sha256").update(value).digest("hex");
  const fulfillmentReference = ready.creation.aggregate.fulfillmentReference;
  const orderReference = ready.creation.aggregate.orderReference;
  const validateCurrentSource = async (transaction, selectedOrder) => {
    const current = await ready.source.resolve({
      transaction,
      query: { ...ready.query, orderReference: selectedOrder },
    });
    return current.orderType === "Pickup" && current.orderReference === orderReference;
  };
  const options = { ...scope, now, sha256, authorize: async () => true, validateCurrentSource };
  const proofOptions = {
    ...options,
    appendAudit: (tx, fact, actorReference) =>
      appendAuditRecordInTransaction(tx, {
        auditId: reference(),
        brandId: scope.brandReference,
        storeId: scope.storeReference,
        actor: actorReference ? { type: "User", reference: actorReference } : { type: "System" },
        actionCode: "PICKUP_PROOF_" + fact.kind.toUpperCase(),
        targetType: "Fulfillment",
        targetId: fact.fulfillmentReference,
        afterSummary: { operation: fact.kind },
        reasonCode: "PICKUP_PROOF",
        correlationId: fact.correlationReference,
        occurredAt: fact.occurredAt,
        sourceChannel: actorReference ? "MERCHANT_WEB" : "EVENT_CONSUMER",
        dataClassification: "Confidential",
        retentionPolicyCode: "FULFILLMENT_BUSINESS_RECORD",
        retentionPolicyVersion: 1,
      }),
  };
  const proof = createPostgresPickupProofStore(proofOptions);
  let queueAllowed = true;
  const queue = createPostgresFulfillmentReadinessStore({
    ...options,
    authorizeQueue: async () => queueAllowed,
  });
  const listQueue = (includeCompleted = false, afterFulfillmentReference = null) =>
    run(async (transaction) => {
      await transaction.query(
        "SELECT set_config('bop.brand_id',$1,true),set_config('bop.store_id',$2,true)",
        [scope.brandReference, scope.storeReference],
      );
      return queue.listPickupQueue({
        transaction,
        afterFulfillmentReference,
        limit: 1,
        includeCompleted,
      });
    });
  const beforeProof = await listQueue();
  assert.equal(beforeProof.items.length, 1);
  assert.equal(beforeProof.items[0].fulfillmentReference, fulfillmentReference);
  assert.equal(beforeProof.items[0].proof, null);
  assert.equal(beforeProof.items[0].publicOrderReference, null);
  assert.equal(beforeProof.items[0].phase, "Ready");
  assert.equal(beforeProof.nextAfterFulfillmentReference, null);
  assert.equal((await listQueue(false, fulfillmentReference)).items.length, 0);
  const initial = await run((transaction) => proof.lockByOrder({ transaction, orderReference }));
  assert.equal(initial.source.canonicalPhase, "Ready");
  assert.equal(initial.capability, null);
  const credentialKeys = [
    { version: 1, derivationKey: randomBytes(32), selectorKey: randomBytes(32) },
  ];
  const credentials = createPickupCredentialProvider(credentialKeys);
  const issuer = createPostgresPickupProofIssuer({
    store: proofOptions,
    credentials,
    pepperVersion: 1,
    nextReference: reference,
    publicOrderReference: () => randomBytes(16).toString("base64url"),
  });
  const issueIntent = {
    orderReference,
    idempotencyReference: reference(),
    correlationReference: reference(),
  };
  const issued = await run((transaction) => issuer.ensureIssued({ transaction, ...issueIntent }));
  assert.equal(issued.status, "Issued");
  assert.equal(
    (await run((transaction) => issuer.ensureIssued({ transaction, ...issueIntent }))).status,
    "AlreadyAvailable",
  );
  const issuedSource = await run((transaction) =>
    proof.lockByOrder({ transaction, orderReference }),
  );
  // Restart-style recovery from configured keys and persisted capability, never persisted raw proof.
  const proofCredential = createPickupCredentialProvider(credentialKeys).recoverOpaque({
    brandReference: scope.brandReference,
    capability: issuedSource.capability,
    observedAt: now(),
  });
  const hashCredential = async (input) => credentials.hashCredential(input);
  const actorReference = reference(),
    deviceReference = reference(),
    pickupLocationReference = reference();
  let allowed = true;
  const handoffOptions = {
    ...options,
    actorReference,
    deriveCompletionReference: (kind, identity) => {
      const digest = sha256(kind + ":" + identity).slice(7);
      return (
        "0198cafe-" +
        digest.slice(0, 4) +
        "-7" +
        digest.slice(4, 7) +
        "-8" +
        digest.slice(7, 10) +
        "-" +
        digest.slice(10, 22)
      );
    },
    authorize: async () => allowed,
    admit: async (_tx, command) =>
      allowed &&
      command.deviceReference === deviceReference &&
      command.pickupLocationReference === pickupLocationReference,
    appendAudit: (tx, audit) =>
      appendAuditRecordInTransaction(tx, {
        auditId: audit.auditReference,
        brandId: scope.brandReference,
        storeId: scope.storeReference,
        actor: { type: "User", reference: audit.actorReference },
        actionCode: audit.actionCode,
        targetType: "Fulfillment",
        targetId: audit.fulfillmentReference,
        afterSummary: { action: "CompletePickupHandoff" },
        reasonCode: "PICKUP_HANDOFF",
        correlationId: audit.correlationReference,
        occurredAt: audit.occurredAt,
        sourceChannel: "MERCHANT_WEB",
        dataClassification: "Confidential",
        retentionPolicyCode: "FULFILLMENT_BUSINESS_RECORD",
        retentionPolicyVersion: 1,
      }),
  };
  const handoff = createPostgresPickupHandoffStore(handoffOptions);
  const current = await run((transaction) => handoff.lockByOrder({ transaction, orderReference }));
  // WP-2423: while a valid pickup proof exists the customer must show it; in person is refused.
  await assert.rejects(
    run((transaction) =>
      handoff.complete({
        transaction,
        orderReference,
        command: {
          fulfillmentReference,
          ...scope,
          expectedAggregateVersion: current.source.aggregateVersion,
          purpose: "CompletePickupHandoff",
          actorReference,
          actorPermissions: ["fulfillment.pickup.complete"],
          verification: {
            verificationReference: reference(),
            correlationReference: reference(),
            fulfillmentReference,
            ...scope,
            verificationMethod: "InPerson",
            identityCheck: "OrderNumberAndName",
            reason: "ProofExpired",
            verifiedByActorReference: actorReference,
            verifiedAt: now(),
          },
          recipientType: "Customer",
          recipientDisplayMask: "S***",
          pickupLocationReference,
          deviceReference,
          quantities: current.source.items.map((item) => ({
            fulfillmentItemReference: item.fulfillmentItemReference,
            quantity: item.readyQuantity,
          })),
          handoffReference: reference(),
          operationReference: reference(),
          auditReference: reference(),
          idempotencyReference: reference(),
          correlationReference: reference(),
          handedOverAt: now(),
        },
      }),
    ),
    (error) => error.code === "PICKUP_HANDOFF_VERIFICATION_FAILED",
  );
  const session = await seedMerchantAcceptanceSession({
    admin,
    runner: { run },
    role,
    scope,
    actor: actorReference,
    at: now(),
    pickupPermission: true,
    referencePrefix: "0190fa01",
    sessionReferencePrefix: "0190fa02",
  });
  let budgetAllowed = true,
    attempts = 0;
  const installContext = async (tx, selected) => {
    await tx.query("SELECT set_config('bop.brand_id',$1,true),set_config('bop.store_id',$2,true)", [
      selected.brandReference,
      selected.storeReference,
    ]);
  };
  const transportOptions = {
    session,
    proof: {
      store: proofOptions,
      appendAudit: proofOptions.appendAudit,
      hashCredential,
      installContext,
      nextReference: reference,
      consumeAttempt: async () => {
        attempts++;
        return budgetAllowed;
      },
    },
    handoff: {
      store: handoffOptions,
      nextReference: reference,
      installContext: async (tx, selected) => {
        await tx.query(
          "SELECT set_config('bop.brand_id',$1,true),set_config('bop.store_id',$2,true)",
          [selected.brandReference, selected.storeReference],
        );
      },
    },
  };
  const http = await createPickupMerchantHttp(transportOptions);
  let browser;
  try {
    if (env.BOP_PICKUP_BROWSER === "1")
      browser = await createPickupMerchantBrowser({
        ...transportOptions,
        scope,
        workstation: { deviceReference, pickupLocationReference },
      });
    const queueRequest = { afterFulfillmentReference: null, limit: 1, includeCompleted: false };
    const currentQueue = await listQueue();
    const httpQueue = await http.query(queueRequest);
    assert.equal(httpQueue.status, 200);
    assert.equal(httpQueue.body.source, "CurrentFulfillment");
    assert.equal(httpQueue.body.storeReference, scope.storeReference);
    assert(Number.isFinite(Date.parse(httpQueue.body.observedAt)));
    assert.equal(httpQueue.body.workstation, null);
    assert.equal(httpQueue.body.items.length, 1);
    assert.equal(httpQueue.body.items[0].fulfillmentReference, fulfillmentReference);
    assert.equal(httpQueue.body.items[0].phase, "Ready");
    assert.equal(
      httpQueue.body.items[0].aggregateVersion,
      currentQueue.items[0].aggregateVersion.toString(),
    );
    assert.equal(httpQueue.body.items[0].readyAt, currentQueue.items[0].readyAt);
    assert.equal(
      httpQueue.body.items[0].publicOrderReference,
      currentQueue.items[0].publicOrderReference,
    );
    assert.deepEqual(httpQueue.body.items[0].proof, currentQueue.items[0].proof);
    assert.deepEqual(httpQueue.body.items[0].items, currentQueue.items[0].items);
    assert.equal(typeof httpQueue.body.items[0].publicOrderReference, "string");
    assert.deepEqual(Object.keys(httpQueue.body.items[0].proof).sort(), [
      "expiresAt",
      "generation",
      "kind",
    ]);
    assert.equal("credential" in httpQueue.body.items[0], false);
    assert.equal("selectorHash" in httpQueue.body.items[0], false);
    const serializedQueue = JSON.stringify(httpQueue.body);
    assert.equal(serializedQueue.includes(proofCredential), false);
    assert.equal(serializedQueue.includes(issuedSource.capability.selectorHash), false);
    assert.equal((await http.query({ ...queueRequest, actorReference })).status, 400);
    const proofIntent = {
      orderReference,
      storeReference: scope.storeReference,
      fulfillmentReference,
      generation: 1,
      kind: "Opaque",
      credential: proofCredential,
      idempotencyReference: reference(),
      correlationReference: reference(),
    };
    const wrongCredential = (proofCredential[0] === "A" ? "B" : "A") + proofCredential.slice(1);
    assert.equal((await http.verify({ ...proofIntent, credential: wrongCredential })).status, 422);
    assert.equal((await http.verify({ ...proofIntent, generation: 2 })).status, 422);
    if (browser) assert.equal((await browser.verify(proofIntent)).status, "Applied");
    const verified = await Promise.all([http.verify(proofIntent), http.verify(proofIntent)]);
    for (const response of verified)
      assert.equal(
        response.status,
        200,
        "Pickup proof HTTP failed: " + response.status + " " + String(response.body.error),
      );
    assert.deepEqual(verified.map((response) => response.body.status).sort(), [
      "AlreadyApplied",
      browser ? "AlreadyApplied" : "Applied",
    ]);
    assert.equal(verified[0].body.verificationReference, verified[1].body.verificationReference);
    assert.equal(verified[0].body.grantsCompletionAuthority, false);
    assert.equal("selectorHash" in verified[0].body, false);
    assert.equal("credential" in verified[0].body, false);
    assert.equal((await http.verify({ ...proofIntent, credential: wrongCredential })).status, 422);
    assert.equal(
      (await http.verify({ ...proofIntent, correlationReference: reference() })).status,
      409,
    );
    budgetAllowed = false;
    assert.equal((await http.verify(proofIntent)).status, 422);
    budgetAllowed = true;
    assert.ok(attempts >= 7);
    const saved = await run(async (transaction) => {
      await installContext(transaction, scope);
      return proof.resolveByIdempotency({
        transaction,
        orderReference,
        idempotencyReference: proofIntent.idempotencyReference,
      });
    });
    assert.equal(saved.kind, "Verify");
    const verification = saved.record;
    const withProof = (await listQueue()).items[0];
    assert.equal(withProof.proof.kind, "Opaque");
    assert.equal(withProof.proof.generation, 1);
    assert.equal(withProof.aggregateVersion, current.source.aggregateVersion);
    assert.equal("selectorHash" in withProof.proof, false);
    assert.equal("verificationReference" in withProof.proof, false);
    assert.equal(withProof.items[0].handedOverQuantity, 0);
    if (onReadyForMerchantBff) await onReadyForMerchantBff(ready);

    const command = {
      ...scope,
      fulfillmentReference,
      expectedAggregateVersion: current.source.aggregateVersion,
      purpose: "CompletePickupHandoff",
      actorReference,
      actorPermissions: ["fulfillment.pickup.complete"],
      verification,
      recipientType: "Customer",
      recipientDisplayMask: "S***",
      pickupLocationReference,
      deviceReference,
      quantities: current.source.items.map((item) => ({
        fulfillmentItemReference: item.fulfillmentItemReference,
        quantity: item.orderedQuantity,
      })),
      handoffReference: reference(),
      operationReference: reference(),
      auditReference: reference(),
      idempotencyReference: reference(),
      correlationReference: reference(),
      handedOverAt: now(),
    };
    const intent = {
      orderReference,
      storeReference: scope.storeReference,
      fulfillmentReference,
      expectedAggregateVersion: command.expectedAggregateVersion.toString(),
      verificationReference: verification.verificationReference,
      recipientType: command.recipientType,
      recipientDisplayMask: command.recipientDisplayMask,
      pickupLocationReference,
      deviceReference,
      quantities: command.quantities,
      idempotencyReference: command.idempotencyReference,
      correlationReference: command.correlationReference,
    };
    assert.equal((await http.submit(intent, { "X-BOP-CSRF": "invalid" })).status, 403);
    assert.equal((await http.submit({ ...intent, actorReference })).status, 400);
    assert.equal((await http.submit({ ...intent, storeReference: reference() })).status, 403);
    assert.equal(
      (await http.submit({ ...intent, verificationReference: reference() })).status,
      422,
    );
    allowed = false;
    assert.equal((await http.submit(intent)).status, 403);
    allowed = true;
    if (browser) {
      assert.equal((await browser.handoff(intent)).status, "Applied");
      command.idempotencyReference = intent.idempotencyReference;
      command.correlationReference = intent.correlationReference;
    }
    const pair = await Promise.all([http.submit(intent), http.submit(intent)]);
    for (const response of pair)
      assert.equal(
        response.status,
        200,
        "Pickup handoff HTTP status: " + response.status + " " + String(response.body.error),
      );
    assert.deepEqual(pair.map((result) => result.body.status).sort(), [
      "AlreadyApplied",
      browser ? "AlreadyApplied" : "Applied",
    ]);
    assert.equal(pair[0].body.handoffReference, pair[1].body.handoffReference);
    const effect = await run(async (transaction) => {
      await transaction.query(
        "SELECT set_config('bop.brand_id',$1,true),set_config('bop.store_id',$2,true)",
        [scope.brandReference, scope.storeReference],
      );
      return handoff.resolveByIdempotency({
        transaction,
        orderReference,
        idempotencyReference: command.idempotencyReference,
      });
    });
    assert.ok(effect);
    const completed = { status: "Applied", effect };
    const replay = await http.submit(intent);
    assert.equal(replay.status, 200);
    assert.equal(replay.body.status, "AlreadyApplied");
    assert.equal(replay.body.nextAggregateVersion, effect.nextAggregateVersion.toString());
    assert.equal((await http.submit({ ...intent, recipientDisplayMask: "T***" })).status, 409);
    Object.assign(command, {
      handoffReference: effect.record.handoffReference,
      operationReference: effect.operation.operationReference,
      auditReference: effect.audit.auditReference,
      handedOverAt: effect.record.handedOverAt,
    });
    assert.equal((await listQueue()).items.length, 0);
    assert.equal((await http.query(queueRequest)).body.items.length, 0);
    assert.equal(
      (await http.query({ ...queueRequest, includeCompleted: true })).body.items[0].phase,
      "Completed",
    );
    const completedQueue = await listQueue(true);
    assert.equal(completedQueue.items.length, 1);
    assert.equal(completedQueue.items[0].phase, "Completed");
    assert.ok(
      completedQueue.items[0].items.every(
        (item) => item.handedOverQuantity === item.orderedQuantity,
      ),
    );
    queueAllowed = false;
    await assert.rejects(listQueue());
    queueAllowed = true;
    await session.revokePickup();
    assert.equal((await http.query(queueRequest)).status, 200);
    await session.revokePickupQueue();
    assert.equal((await http.query(queueRequest)).status, 403);
    if (browser) await browser.assertRevoked();
    assert.equal((await http.submit(intent)).status, 403);
    const publication = (
      await admin.query(
        "SELECT outbox_event_id FROM rms_fulfillment.fulfillment_completion_publication WHERE brand_id=$1 AND store_id=$2 AND fulfillment_id=$3",
        [scope.brandReference, scope.storeReference, fulfillmentReference],
      )
    ).rows;
    assert.equal(publication.length, 1);
    const event = await run(async (tx) => {
      await tx.query(
        "SELECT set_config('bop.brand_id',$1,true),set_config('bop.store_id',$2,true)",
        [scope.brandReference, scope.storeReference],
      );
      return loadOutboxEnvelope(tx, publication[0].outbox_event_id);
    });
    const envelope = parseFulfillmentCompletedEnvelope(event);
    assert.equal(envelope.aggregateId, fulfillmentReference);
    assert.equal(envelope.payload.orderReference, orderReference);
    assert.equal(envelope.occurredAt, command.handedOverAt);
    assert(Date.parse(envelope.occurredAt) <= Date.now());
    const counts = (
      await admin.query(
        "SELECT (SELECT count(*)::int FROM rms_fulfillment.pickup_proof_generation) proofs,(SELECT count(*)::int FROM rms_fulfillment.pickup_proof_verification) verifications,(SELECT count(*)::int FROM rms_fulfillment.pickup_handoff_record) handoffs,(SELECT count(*)::int FROM rms_fulfillment.fulfillment_completion_publication) completions",
      )
    ).rows[0];
    assert.deepEqual(counts, { proofs: 1, verifications: 1, handoffs: 1, completions: 1 });
    return { event: envelope, completed, command };
  } finally {
    try {
      await browser?.close();
    } finally {
      await http.close();
    }
  }
}
