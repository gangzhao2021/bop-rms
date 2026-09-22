import process from "node:process";
import { createKitchenMerchantBrowser } from "./kitchen-merchant-browser.mjs";
import { exerciseKitchenQueueReadModel } from "./kitchen-queue-read-model.mjs";
import { createKitchenMerchantHttp } from "./kitchen-merchant-http.mjs";
import assert from "node:assert/strict";
import {
  createKitchenWorkLifecycleService,
  createKitchenQueueLifecycleProofBundle,
  createPostgresKitchenQueueSourceReader,
  createPostgresKitchenCustomerStatusReader,
  createPostgresKitchenWorkLifecycleStore,
} from "../../rms/kitchen/src/index.ts";

/** Real multi-item Kitchen lifecycle persistence. Operator/admission/Expo policy facts are synthetic. */
export async function exercisePaidKitchenLifecycle({
  merchantKitchen,
  kitchenNow,
  onItemReady,
  admin,
  role,
  runner,
  scope: ownerScope,
  ticket,
  source,
  sourceQuery,
  hash,
  references,
  id,
}) {
  const scope = {
    brandReference: ownerScope.brandReference,
    storeReference: ownerScope.storeReference,
  };
  await admin.query(
    "GRANT SELECT,INSERT ON rms_kitchen.kitchen_work_lifecycle_operation," +
      "rms_kitchen.kitchen_order_item_ready_result,rms_kitchen.kitchen_ready_publication TO " +
      role,
  );
  await admin.query(
    "GRANT UPDATE ON rms_kitchen.kitchen_ticket,rms_kitchen.kitchen_work_item TO " + role,
  );
  const queryFailures = [];
  let next = 30000;
  let allowed = true;
  const clockStart = Date.parse(ticket.createdAt);
  let step = 0;
  const nextTime = () => kitchenNow?.() ?? new Date(clockStart + ++step * 1000).toISOString();
  const refs = { ...references, next: () => id(next++) };
  const scoped = (work) =>
    runner().run(async (tx) => {
      await tx.query(
        "SELECT set_config('bop.brand_id',$1,true),set_config('bop.store_id',$2,true)",
        [scope.brandReference, scope.storeReference],
      );
      return work({
        query: async (sql, parameters) => {
          try {
            return await tx.query(sql, parameters);
          } catch (error) {
            queryFailures.push({ code: error.code });
            throw error;
          }
        },
      });
    });
  const repository = createPostgresKitchenWorkLifecycleStore({
    ...scope,
    references: refs,
    digests: { sha256: hash },
    authorize: async () => allowed,
    validateCurrentSource: async (transaction) => {
      const current = await source.resolve({ transaction, query: sourceQuery });
      return current.evidenceDigest === ticket.sourceEvidenceDigest;
    },
  });
  function createPorts(command, at) {
    return {
      trustedContext: {
        resolveAuthority: async () => ({
          actorReference: command.actorReference,
          ...scope,
          observedAt: at,
        }),
      },
      correlationContext: {
        resolve: async () => ({ correlationReference: ticket.correlationReference }),
      },
      authorization: { authorize: async () => allowed },
      transactions: { withTransaction: scoped },
      tenantContext: {
        install: async ({ transaction }) => {
          await transaction.query(
            "SELECT set_config('bop.brand_id',$1,true),set_config('bop.store_id',$2,true)",
            [scope.brandReference, scope.storeReference],
          );
        },
      },
      idempotency: {
        acquireFence: async ({ transaction, idempotencyKey }) => {
          await transaction.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
            scope.brandReference + ":" + scope.storeReference + ":" + idempotencyKey,
          ]);
        },
      },
      repository,
      references: refs,
      digests: { sha256: hash },
      clock: { now: () => at },
      admission: {
        resolve: async ({ command: authorizedCommand, acceptedOperationReference }) => ({
          decisionReference: id(40000 + step),
          decisionVersion: 1,
          decisionDigest: hash("synthetic Start admission"),
          producerContractVersion: 1,
          actorReference: authorizedCommand.actorReference,
          ...scope,
          ticketReference: ticket.ticketReference,
          workItemReference: authorizedCommand.workItemReference,
          acceptedOperationReference,
          ticketVersion: BigInt(authorizedCommand.expectedTicketVersion),
          workItemVersion: BigInt(authorizedCommand.expectedWorkItemVersion),
          action: "StartKitchenWorkItem",
          purpose: "KitchenWorkExecution",
          outcome: "Allowed",
          evaluatedAt: at,
          validUntil: new Date(Date.parse(at) + 60000).toISOString(),
        }),
      },
      expo: {
        resolve: async () => ({
          decisionReference: id(50000 + step),
          decisionVersion: 1,
          decisionDigest: hash("synthetic Expo disabled"),
          producerContractVersion: 1,
          ...scope,
          purpose: "KitchenReadiness",
          mode: "Disabled",
          evaluatedAt: at,
          validUntil: new Date(Date.parse(at) + 60000).toISOString(),
        }),
      },
    };
  }
  const http = merchantKitchen
    ? await createKitchenMerchantHttp({
        session: merchantKitchen.session,
        createPorts,
        sha256: hash,
        validateCurrentSource: async (transaction) => {
          const current = await source.resolve({ transaction, query: sourceQuery });
          return current.evidenceDigest === ticket.sourceEvidenceDigest;
        },
      })
    : null;
  const queueSourceOptions = {
    ...scope,
    maxTickets: 100,
    maxItemsPerTicket: 100,
    maxOperationsPerTicket: 1000,
    creationValidation: { references: refs, digests: { sha256: hash } },
    lifecycleValidation: { references: refs, digests: { sha256: hash } },
    nextSnapshotReference: () => refs.next(),
    authorize: async () => allowed,
  };
  let browser, continuousQueue;
  const attemptedCommands = new Map();
  const execute = (command, at) => {
    attemptedCommands.set(command.idempotencyKey, command);
    return http
      ? http.execute(command)
      : createKitchenWorkLifecycleService(createPorts(command, at)).execute(command);
  };
  const executeNew = async (command, at) => {
    if (!browser) return execute(command, at);
    const result = await browser.execute(command);
    attemptedCommands.set(command.idempotencyKey, command);
    return result;
  };
  const customerStatus = createPostgresKitchenCustomerStatusReader({
    ...scope,
    authorize: async (_transaction, requested) =>
      allowed &&
      requested.brandReference === scope.brandReference &&
      requested.storeReference === scope.storeReference &&
      requested.orderReference === ticket.orderReference,
  });
  const readCustomerStatus = () =>
    scoped((transaction) =>
      customerStatus.loadByOrder({ transaction, orderReference: ticket.orderReference }),
    );
  const assertCustomerStatus = async (expected, version) => {
    const status = await readCustomerStatus();
    assert.ok(status);
    assert.equal(status.orderReference, ticket.orderReference);
    const batch = status.batches.find(
      (candidate) => candidate.orderBatchReference === ticket.orderBatchReference,
    );
    assert.ok(batch);
    assert.equal(batch.status, expected);
    assert.equal(batch.ticketReference, ticket.ticketReference);
    assert.equal(batch.ticketVersion, BigInt(version));
    assert.deepEqual(
      batch.items.map((item) => item.orderItemReference).sort(),
      [...new Set(ticket.workItems.map((item) => item.orderItemReference))].sort(),
    );
    for (const item of batch.items) {
      assert.deepEqual(Object.keys(item).sort(), ["orderItemReference", "status"]);
      if (expected === "Ready" || expected === "Queued") assert.equal(item.status, expected);
    }
    assert.deepEqual(Object.keys(batch).sort(), [
      "items",
      "orderBatchReference",
      "status",
      "ticketReference",
      "ticketVersion",
      "updatedAt",
    ]);
  };
  try {
    const browserEnabled = kitchenNow && process.env.BOP_KITCHEN_BROWSER === "1";
    if (kitchenNow)
      continuousQueue = await exerciseKitchenQueueReadModel({
        admin,
        role,
        scoped,
        sourceOptions: queueSourceOptions,
        ticket,
        refs,
        actor: merchantKitchen.actor,
        initializeOnly: true,
        keepRunning: Boolean(browserEnabled),
      });
    if (browserEnabled)
      browser = await createKitchenMerchantBrowser({
        session: merchantKitchen.session,
        scope: ownerScope,
        createPorts,
        sha256: hash,
        validateCurrentSource: async (transaction) => {
          const current = await source.resolve({ transaction, query: sourceQuery });
          return current.evidenceDigest === ticket.sourceEvidenceDigest;
        },
      });
    await assertCustomerStatus("Queued", "1");
    let ticketVersion = "1";
    const acceptedCommands = [];
    for (const [index, item] of ticket.workItems.entries()) {
      let itemVersion = "1";
      const make = (action, extra = {}) => ({
        action,
        idempotencyKey: "paid-kitchen-" + item.workItemReference + "-" + action,
        actorReference: merchantKitchen?.actor ?? id(39000),
        ...scope,
        ticketReference: ticket.ticketReference,
        workItemReference: item.workItemReference,
        orderItemReference: item.orderItemReference,
        expectedTicketVersion: ticketVersion,
        expectedWorkItemVersion: itemVersion,
        correlationReference: ticket.correlationReference,
        ...extra,
      });
      let accept = make("AcceptKitchenWorkItem");
      let at = nextTime();
      if (http && index === 0) {
        assert.equal(
          (await http.submit(accept, { "X-BOP-CSRF": "synthetic-invalid" })).status,
          403,
        );
        assert.equal((await http.submit({ ...accept, actorReference: id(39000) })).status, 403);
      }
      let accepted;
      if (browser) {
        accepted = await executeNew(accept, at);
      } else if (index === 0) {
        const competing = { ...accept, idempotencyKey: accept.idempotencyKey + "-competing" };
        const race = await Promise.allSettled([execute(accept, at), execute(competing, at)]);
        if (race.every((r) => r.status === "rejected")) {
          const failure = new Error("Kitchen HTTP race failed");
          failure.code =
            "KITCHEN_HTTP_RACE_" +
            race
              .map((r) => String(r.reason.status) + "_" + String(r.reason.code).toUpperCase())
              .join("_")
              .slice(0, 45);
          throw failure;
        }
        assert.equal(
          race.filter((r) => r.status === "fulfilled").length,
          1,
          JSON.stringify({
            errors: race.map((r) => (r.status === "rejected" ? r.reason.code : null)),
            queryFailures,
          }),
        );
        assert.equal(race.filter((r) => r.status === "rejected").length, 1);
        const winner = race.findIndex((r) => r.status === "fulfilled");
        accept = winner === 0 ? accept : competing;
        accepted = race[winner].value;
      } else {
        const duplicate = await Promise.all([execute(accept, at), execute(accept, at)]);
        assert.deepEqual(duplicate[0], duplicate[1]);
        accepted = duplicate[0];
      }
      acceptedCommands.push({ command: accept, at, result: accepted });
      ticketVersion = accepted.ticketVersion;
      itemVersion = accepted.workItemVersion;
      at = nextTime();
      const started = await executeNew(make("StartKitchenWorkItem"), at);
      ticketVersion = started.ticketVersion;
      itemVersion = started.workItemVersion;
      await assertCustomerStatus("InProgress", ticketVersion);
      at = nextTime();
      const complete = make("CompleteKitchenWorkItem", { quantityDelta: item.requiredQuantity });
      const completed = await executeNew(complete, at);
      assert.equal(completed.outcome, "CompletedAndOrderItemReady");
      assert.deepEqual(await execute(complete, at), completed);
      ticketVersion = completed.ticketVersion;
      await assertCustomerStatus(
        index === ticket.workItems.length - 1 ? "Ready" : "InProgress",
        ticketVersion,
      );

      const state = await scoped((transaction) =>
        repository.loadSourceForUpdate({ command: complete, transaction }),
      );
      assert.equal(state.readyResult.readyResultReference, completed.readyResultReference);
      const ready = await scoped((tx) =>
        tx.query(
          "SELECT count(*)::int AS items,count(order_outbox_event_id)::int AS orders " +
            "FROM rms_kitchen.kitchen_ready_publication WHERE brand_id=$1 AND store_id=$2 AND kitchen_ticket_id=$3",
          [scope.brandReference, scope.storeReference, ticket.ticketReference],
        ),
      );
      assert.equal(ready.rows[0].items, index + 1);
      assert.equal(ready.rows[0].orders, index === ticket.workItems.length - 1 ? 1 : 0);
      // Validate producer current state before downstream fulfillment can close its action window.
      if (onItemReady) {
        const original = await scoped((transaction) =>
          repository.resolveByIdempotency({
            ...scope,
            idempotencyKey: complete.idempotencyKey,
            transaction,
          }),
        );
        assert.equal(original.status, "Found");
        await onItemReady(original.effect.readyPublication.itemEvent);
      }
    }
    for (const saved of acceptedCommands)
      assert.deepEqual(await execute(saved.command, saved.at), saved.result);
    const effects = [];
    for (const command of attemptedCommands.values()) {
      const record = await scoped((transaction) =>
        repository.resolveByIdempotency({
          ...scope,
          idempotencyKey: command.idempotencyKey,
          transaction,
        }),
      );
      if (record.status === "Found") effects.push(record.effect);
    }
    const proofBundle = createKitchenQueueLifecycleProofBundle({
      ticketReference: ticket.ticketReference,
      effects,
      validation: { references: refs, digests: { sha256: hash } },
    });
    assert.equal(proofBundle.operationCount, ticket.workItems.length * 4);
    assert.equal(proofBundle.readyResultCount, ticket.workItems.length);
    assert.equal(
      proofBundle.proofs.filter((proof) => proof.kind === "AutomaticReady").length,
      ticket.workItems.length,
    );
    assert.throws(() =>
      createKitchenQueueLifecycleProofBundle({
        ticketReference: ticket.ticketReference,
        effects: effects.slice(1),
        validation: { references: refs, digests: { sha256: hash } },
      }),
    );
    if (kitchenNow) {
      const queueSource = createPostgresKitchenQueueSourceReader(queueSourceOptions);
      const snapshot = await scoped((tx) => queueSource.read(tx));
      const original = snapshot.tickets.find(
        (value) => value.ticketReference === ticket.ticketReference,
      );
      assert.ok(original);
      assert.equal(original.items.length, ticket.workItems.length);
      assert.equal(original.proofBundle.operationCount, ticket.workItems.length * 4);
      assert.ok(
        original.items.every(
          (item) => item.status === "Completed" && item.orderItemReadyAt !== null,
        ),
      );
      const truncated = createPostgresKitchenQueueSourceReader({
        ...queueSourceOptions,
        maxOperationsPerTicket: 1,
      });
      await assert.rejects(
        scoped((tx) => truncated.read(tx)),
        { code: "KITCHEN_QUEUE_DEPENDENCY_UNAVAILABLE" },
      );
      allowed = false;
      await assert.rejects(
        scoped((tx) => queueSource.read(tx)),
        { code: "KITCHEN_QUEUE_DEPENDENCY_UNAVAILABLE" },
      );
      allowed = true;
      await continuousQueue?.stop();
      continuousQueue = undefined;
      await exerciseKitchenQueueReadModel({
        alreadyRefreshed: Boolean(browser),
        admin,
        role,
        scoped,
        sourceOptions: queueSourceOptions,
        ticket,
        refs,
        hash,
        actor: merchantKitchen.actor,
      });
    }
    if (http) {
      const response = await http.query({
        kind: "List",
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
      assert.equal(response.status, 200);
      assert.equal(response.body.items.length, ticket.workItems.length);
      assert.ok(
        response.body.items.every(
          (item) =>
            item.status === "Completed" &&
            typeof item.ticketAggregateVersion === "string" &&
            typeof item.workItemVersion === "string",
        ),
      );
      const detail = await http.query({
        kind: "Get",
        workItemReference: ticket.workItems[0].workItemReference,
      });
      assert.equal(detail.status, 200);
      assert.equal(detail.body.item.workItemReference, ticket.workItems[0].workItemReference);
      assert.deepEqual(
        detail.body.item,
        response.body.items.find(
          (item) => item.workItemReference === detail.body.item.workItemReference,
        ),
      );
      await merchantKitchen.session.revokeKitchen();
      await browser?.assertRevoked();
      assert.equal(
        (
          await http.query({
            kind: "Get",
            workItemReference: ticket.workItems[0].workItemReference,
          })
        ).status,
        403,
      );
    }
    allowed = false;
    await assert.rejects(readCustomerStatus(), { code: "KITCHEN_WORK_DEPENDENCY_UNAVAILABLE" });
    await assert.rejects(execute(acceptedCommands[0].command, acceptedCommands[0].at));
    return { readyItems: ticket.workItems.length, readyOrders: 1 };
  } finally {
    try {
      await browser?.close();
    } finally {
      try {
        await continuousQueue?.stop();
      } finally {
        await http?.close();
      }
    }
  }
}
