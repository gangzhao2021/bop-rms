import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  createKitchenWorkLifecycleService,
  createPostgresKitchenWorkLifecycleStore,
} from "../../rms/kitchen/src/index.ts";

/** Actual owner persistence and Audit/Outbox; authority/admission/Expo decisions are synthetic. */
export async function exerciseKitchenWorkLifecycleStore(client, value, id, mode = "Disabled") {
  const hash = (text) => "sha256:" + createHash("sha256").update(text).digest("hex");
  let sequence = 7000;
  let allowed = true;
  let active;
  let now = "2026-08-09T14:03:00.000Z";
  let fault = null;
  let faultReached;
  let lastEffect;
  const references = {
    next: () => id(++sequence),
    derive(purpose, identity) {
      const digest = createHash("sha256")
        .update(purpose + identity)
        .digest("hex");
      return (
        "0198abcd-" +
        digest.slice(0, 4) +
        "-7" +
        digest.slice(4, 7) +
        "-8" +
        digest.slice(7, 10) +
        "-" +
        digest.slice(10, 22)
      );
    },
  };
  const tx = {
    async query(sql, parameters) {
      if (fault && sql.startsWith(fault)) {
        faultReached = true;
        throw new Error("synthetic lifecycle write failure");
      }
      return client.query(sql, parameters);
    },
  };
  async function run(work) {
    await client.query("BEGIN");
    try {
      await client.query(
        "SELECT set_config('bop.brand_id',$1,true),set_config('bop.store_id',$2,true)",
        [value.brandId, value.storeId],
      );
      const result = await work(tx);
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    }
  }
  const repository = createPostgresKitchenWorkLifecycleStore({
    brandReference: value.brandId,
    storeReference: value.storeId,
    references,
    digests: { sha256: hash },
    authorize: async () => allowed,
    validateCurrentSource: async () => allowed,
  });
  const service = createKitchenWorkLifecycleService({
    trustedContext: {
      resolveAuthority: async () => ({
        actorReference: active.actorReference,
        brandReference: value.brandId,
        storeReference: value.storeId,
        observedAt: now,
      }),
    },
    correlationContext: { resolve: async () => ({ correlationReference: value.correlationId }) },
    authorization: { authorize: async () => allowed },
    transactions: { withTransaction: run },
    tenantContext: {
      install: async ({ transaction }) => {
        assert.equal(transaction, tx);
      },
    },
    idempotency: {
      acquireFence: async ({ transaction, idempotencyKey }) => {
        await transaction.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
          value.brandId + ":" + value.storeId + ":" + idempotencyKey,
        ]);
      },
    },
    repository: {
      ...repository,
      commit: async (input) => {
        lastEffect = input.effect;
        return repository.commit(input);
      },
    },
    references,
    digests: { sha256: hash },
    clock: { now: () => now },
    admission: {
      resolve: async ({ command, acceptedOperationReference }) => ({
        decisionReference: id(7900),
        decisionVersion: 1,
        decisionDigest: hash("synthetic admission"),
        producerContractVersion: 1,
        actorReference: command.actorReference,
        brandReference: value.brandId,
        storeReference: value.storeId,
        ticketReference: value.ticketId,
        workItemReference: value.workItemId,
        acceptedOperationReference,
        ticketVersion: BigInt(command.expectedTicketVersion),
        workItemVersion: BigInt(command.expectedWorkItemVersion),
        action: "StartKitchenWorkItem",
        purpose: "KitchenWorkExecution",
        outcome: "Allowed",
        evaluatedAt: now,
        validUntil: "2026-08-09T15:00:00.000Z",
      }),
    },
    expo: {
      resolve: async () => ({
        decisionReference: id(7901),
        decisionVersion: 1,
        decisionDigest: hash("synthetic Expo " + mode),
        producerContractVersion: 1,
        brandReference: value.brandId,
        storeReference: value.storeId,
        purpose: "KitchenReadiness",
        mode,
        evaluatedAt: now,
        validUntil: "2026-08-09T15:00:00.000Z",
      }),
    },
  });
  function command(action, version, extra = {}) {
    return {
      action,
      idempotencyKey: "lifecycle-real-" + value.ticketId + "-" + action + "-" + version,
      actorReference: id(7990),
      brandReference: value.brandId,
      storeReference: value.storeId,
      ticketReference: value.ticketId,
      workItemReference: value.workItemId,
      orderItemReference: value.orderItemId,
      expectedTicketVersion: String(version),
      expectedWorkItemVersion: String(version),
      correlationReference: value.correlationId,
      ...extra,
    };
  }
  const execute = async (c) => {
    active = c;
    return service.execute(c);
  };
  const accept = command("AcceptKitchenWorkItem", 1);
  // Force late failures after state/operation writes. Commit the caught outer transaction:
  // the writer's own savepoint must still remove every partial mandatory effect.
  for (const point of [
    "INSERT INTO platform_audit.audit_record",
    "INSERT INTO platform_eventing.outbox_event",
  ]) {
    fault = point;
    faultReached = false;
    await assert.rejects(execute(accept));
    assert.equal(faultReached, true);
    faultReached = false;
    await run(async (transaction) => {
      await assert.rejects(repository.commit({ effect: lastEffect, transaction }));
      assert.equal(faultReached, true);
    });
    const state = await client.query(
      "SELECT aggregate_version::text AS version FROM rms_kitchen.kitchen_ticket WHERE kitchen_ticket_id=$1",
      [value.ticketId],
    );
    assert.equal(state.rows[0].version, "1");
    const count = await client.query(
      "SELECT count(*)::int AS count FROM rms_kitchen.kitchen_work_lifecycle_operation WHERE kitchen_ticket_id=$1",
      [value.ticketId],
    );
    assert.equal(count.rows[0].count, 0);
  }
  fault = null;
  const accepted = await execute(accept);
  assert.equal(accepted.outcome, "Accepted");
  assert.deepEqual(await execute(accept), accepted);
  now = "2026-08-09T14:04:00.000Z";
  const started = await execute(command("StartKitchenWorkItem", 2));
  assert.equal(started.outcome, "Started");
  const quantity = (
    await client.query(
      "SELECT required_quantity FROM rms_kitchen.kitchen_work_item WHERE kitchen_work_item_id=$1",
      [value.workItemId],
    )
  ).rows[0].required_quantity;
  now = "2026-08-09T14:06:00.000Z";
  const complete = command("CompleteKitchenWorkItem", 3, { quantityDelta: quantity });
  const completed = await execute(complete);
  assert.equal(completed.outcome, mode === "Disabled" ? "CompletedAndOrderItemReady" : "Completed");
  assert.deepEqual(await execute(complete), completed);
  assert.deepEqual(await execute(accept), accepted);
  let ready = completed;
  if (mode === "Enabled") {
    now = "2026-08-09T14:07:00.000Z";
    const markReady = {
      action: "MarkKitchenOrderItemReady",
      idempotencyKey: "lifecycle-real-manual-ready-" + value.ticketId,
      actorReference: id(7991),
      brandReference: value.brandId,
      storeReference: value.storeId,
      ticketReference: value.ticketId,
      orderItemReference: value.orderItemId,
      expectedTicketVersion: completed.ticketVersion,
      workItems: [
        { workItemReference: value.workItemId, expectedWorkItemVersion: completed.workItemVersion },
      ],
      correlationReference: value.correlationId,
    };
    ready = await execute(markReady);
    assert.equal(ready.outcome, "OrderItemReady");
    assert.deepEqual(await execute(markReady), ready);
  }
  const current = await run((transaction) =>
    repository.loadSourceForUpdate({ command: complete, transaction }),
  );
  assert.equal(current.target.workItemStatus, "Completed");
  assert.equal(current.readyResult.readyResultReference, ready.readyResultReference);
  assert.equal(current.capturedExpo.mode, mode);
  assert.equal(current.acceptedOperation.operationReference, accepted.operationReference);
  assert.equal(current.startedOperation.operationReference, started.operationReference);
  const publication = await client.query(
    "SELECT count(*)::int AS count FROM rms_kitchen.kitchen_ready_publication WHERE kitchen_ticket_id=$1",
    [value.ticketId],
  );
  assert.equal(publication.rows[0].count, 1);
  const recovered = await run((transaction) =>
    repository.resolveByIdempotency({
      brandReference: value.brandId,
      storeReference: value.storeId,
      idempotencyKey: accept.idempotencyKey,
      transaction,
    }),
  );
  assert.equal(recovered.status, "Found");
  const stale = await run((transaction) =>
    repository.commit({ effect: recovered.effect, transaction }),
  );
  assert.equal(stale.status, "Conflict");
  await assert.rejects(
    run((transaction) =>
      repository.resolveByIdempotency({
        brandReference: value.brandId,
        storeReference: id(7999),
        idempotencyKey: accept.idempotencyKey,
        transaction,
      }),
    ),
  );
  allowed = false;
  await assert.rejects(
    run((transaction) =>
      repository.resolveByIdempotency({
        brandReference: value.brandId,
        storeReference: value.storeId,
        idempotencyKey: accept.idempotencyKey,
        transaction,
      }),
    ),
  );
}
