import { setTimeout, clearTimeout } from "node:timers";
import { createKitchenQueueWorkload } from "../../../apps/worker/src/kitchen-queue-workload.ts";
import assert from "node:assert/strict";
import { createPostgresKitchenQueueReadModel } from "../../rms/kitchen/src/index.ts";

/** Original paid-ticket rebuild and read path; synthetic policy authority is explicit. */
export async function exerciseKitchenQueueReadModel({
  admin,
  role,
  scoped,
  sourceOptions,
  ticket,
  refs,
  actor,
  initializeOnly = false,
  keepRunning = false,
  alreadyRefreshed = false,
}) {
  await admin.query(
    "GRANT SELECT,INSERT,UPDATE ON rms_kitchen.kitchen_work_queue_projection_generation TO " + role,
  );
  await admin.query("GRANT SELECT,INSERT ON rms_kitchen.kitchen_work_queue_projection TO " + role);
  await admin.query("GRANT EXECUTE ON FUNCTION platform_helpers.is_uuid_v7(uuid) TO " + role);
  const scope = {
    brandReference: sourceOptions.brandReference,
    storeReference: sourceOptions.storeReference,
  };
  let allowed = true;
  let observedAt = new Date().toISOString();
  const model = createPostgresKitchenQueueReadModel({
    source: sourceOptions,
    maxRows: 10000,
    nextRebuildReference: () => refs.next(),
    authorizeProjection: async () => allowed,
    authorizeQuery: async () => allowed,
    ports: {
      authorization: {
        authorize: async (input) =>
          allowed &&
          input.brandReference === scope.brandReference &&
          input.storeReference === scope.storeReference,
      },
      trustedContext: {
        resolveQueryAuthority: async () => ({ ...scope, actorReference: actor, observedAt }),
      },
      transactions: {
        withTransaction: (work) =>
          scoped(async (tx) => {
            await tx.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
              scope.brandReference + ":" + scope.storeReference + ":kitchen_work_queue_v1",
            ]);
            return work(tx);
          }),
      },
      tenantContext: {
        install: async (input) => {
          assert.equal(input.brandReference, scope.brandReference);
          assert.equal(input.storeReference, scope.storeReference);
        },
      },
      locks: {
        acquireStoreProjection: async ({ transaction }) => {
          await transaction.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
            scope.brandReference + ":" + scope.storeReference + ":kitchen_work_queue_v1",
          ]);
        },
      },
      references: { nextGenerationReference: () => refs.next() },
      clock: { now: () => new Date().toISOString() },
    },
  });
  const cycles = [];
  let finishCycle;
  const secondCycle = new Promise((resolve) => {
    finishCycle = resolve;
  });
  let closed = 0;
  const workload = createKitchenQueueWorkload({
    refresh: async () => {
      const result = await model.refresh();
      cycles.push(result);
      if (cycles.length >= 2) finishCycle();
      return result;
    },
    close: async () => {
      closed++;
    },
    pollIntervalMs: 20,
    drainDeadlineMs: 5000,
  });
  let timer;
  let started = false;
  try {
    await workload.start();
    await Promise.race([
      secondCycle,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error("Kitchen refresh cycle timeout")), 5000);
      }),
    ]);
    started = true;
  } finally {
    clearTimeout(timer);
    if (!keepRunning || !started) await workload.stop();
  }
  let initial;
  try {
    assert.equal(closed, keepRunning ? 0 : 1);
    assert.equal(cycles[0], alreadyRefreshed ? 0 : 1);
    assert.ok(cycles.slice(1).length > 0 && cycles.slice(1).every((value) => value === 0));
    initial = await scoped((tx) =>
      tx.query(
        "SELECT projection_generation_id FROM rms_kitchen.kitchen_work_queue_projection_generation WHERE brand_id=$1 AND store_id=$2 AND generation_status='Active'",
        [scope.brandReference, scope.storeReference],
      ),
    );
    assert.equal(initial.rows.length, 1);
    if (initializeOnly) return keepRunning ? { stop: () => workload.stop() } : undefined;
  } catch (error) {
    if (keepRunning) await workload.stop();
    throw error;
  }
  const request = {
    ...scope,
    action: "RebuildKitchenQueueProjection",
    purpose: "ProjectionRecovery",
    projectionName: "kitchen_work_queue_v1",
    projectionVersion: 1,
    rebuildReference: refs.next(),
    expectedActiveGenerationReference: initial.rows[0].projection_generation_id,
    requestedAt: new Date().toISOString(),
  };
  const first = await model.rebuild(request);
  assert.equal(first.workItemCount, ticket.workItems.length);
  assert.deepEqual(await model.rebuild(request), first);
  const second = await model.rebuild({
    ...request,
    rebuildReference: refs.next(),
    expectedActiveGenerationReference: first.projectionGenerationReference,
    requestedAt: new Date().toISOString(),
  });
  assert.notEqual(second.projectionGenerationReference, first.projectionGenerationReference);
  observedAt = new Date().toISOString();
  const query = { ...scope, actorReference: actor, observedAt };
  const listed = await model.list({
    ...query,
    filters: {
      orderReference: null,
      ticketReference: null,
      workItemReference: null,
      stationReference: null,
      status: null,
    },
    cursor: null,
    limit: 50,
  });
  assert.equal(listed.items.length, ticket.workItems.length);
  assert.ok(listed.items.every((item) => item.status === "Completed"));
  const detail = await model.get({
    ...query,
    workItemReference: ticket.workItems[0].workItemReference,
  });
  assert.equal(detail.item.workItemReference, ticket.workItems[0].workItemReference);
  assert.equal(detail.item.ticketReference, ticket.ticketReference);
  assert.equal(detail.item.status, "Completed");
  assert.equal(detail.item.completedQuantity, ticket.workItems[0].requiredQuantity);
  assert.ok(detail.item.acceptedAt);
  assert.ok(detail.item.orderItemReadyAt);
  assert.deepEqual(
    detail.item,
    listed.items.find((item) => item.workItemReference === detail.item.workItemReference),
  );
  assert.equal("sourceEventBindingDigest" in detail, false);
  const retained = await scoped((tx) =>
    tx.query(
      "SELECT generation_status,count(*)::int AS count FROM rms_kitchen.kitchen_work_queue_projection_generation WHERE brand_id=$1 AND store_id=$2 GROUP BY generation_status",
      [scope.brandReference, scope.storeReference],
    ),
  );
  const counts = Object.fromEntries(retained.rows.map((row) => [row.generation_status, row.count]));
  assert.equal(counts.Active, 1);
  if (alreadyRefreshed) assert.ok(counts.Retired >= ticket.workItems.length * 3 + 2);
  else assert.equal(counts.Retired, 3);
  allowed = false;
  await assert.rejects(
    model.list({
      ...query,
      filters: {
        orderReference: null,
        ticketReference: null,
        workItemReference: null,
        stationReference: null,
        status: null,
      },
      cursor: null,
      limit: 50,
    }),
    { code: "KITCHEN_QUEUE_PERMISSION_DENIED" },
  );
  await assert.rejects(
    model.get({ ...query, workItemReference: ticket.workItems[0].workItemReference }),
    { code: "KITCHEN_QUEUE_PERMISSION_DENIED" },
  );
  await assert.rejects(model.rebuild(request), { code: "KITCHEN_QUEUE_PERMISSION_DENIED" });
  await assert.rejects(model.refresh(), { code: "KITCHEN_QUEUE_PERMISSION_DENIED" });
}
