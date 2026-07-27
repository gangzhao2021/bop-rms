import assert from "node:assert/strict";
import { createServer } from "node:http";
import pg from "pg";
import { it } from "vitest";
import {
  appendEventInTransaction,
  claimOutboxBatch,
  consumeEventInTransaction,
  deriveCorrelationContextFromEvent,
  preserveEventCorrelationContext,
} from "../../bop/eventing/src/index.ts";
import { createApp } from "../../../apps/api/src/app.ts";
import {
  correlationForEventEmittedByCommand,
  createRequestCommandCorrelation,
} from "../../../apps/api/src/request-correlation.ts";
import { withIsolatedDatabase } from "../test-support/isolated-database.mjs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const { Client } = pg;
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const brandId = "018f1f48-7b5d-7a01-8a1b-123456789abc";
const aggregateId = "018f1f48-7b5d-7a02-8a1b-123456789abc";
const requestId = "018f1f48-7b5d-7b01-8a1b-123456789abc";
const correlationId = "018f1f48-7b5d-7b02-8a1b-123456789abc";
const commandId = "018f1f48-7b5d-7b03-8a1b-123456789abc";
const sourceEventId = "018f1f48-7b5d-7c01-8a1b-123456789abc";
const childEventId = "018f1f48-7b5d-7c02-8a1b-123456789abc";
const leaseToken = "018f1f48-7b5d-7d01-8a1b-123456789abc";

function event(eventId, context, aggregateVersion) {
  return {
    eventId,
    eventType: "SyntheticRequestAccepted",
    schemaVersion: 1,
    occurredAt: "2026-07-24T12:00:00.000Z",
    producerModule: "@bop/eventing",
    tenantId: brandId,
    aggregateType: "SyntheticRequest",
    aggregateId,
    aggregateVersion,
    correlationId: context.correlationId,
    ...(context.causationId === undefined ? {} : { causationId: context.causationId }),
    actor: { type: "System" },
    payload: { sentinel: "synthetic" },
    redactionClassification: "none",
    replayMetadata: { mode: "synthetic" },
  };
}

async function inBrandTransaction(client, action) {
  await client.query("BEGIN");
  try {
    await client.query("SELECT set_config('bop.brand_id', $1, true)", [brandId]);
    const result = await action(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  }
}

async function listen(app) {
  const server = createServer(app);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("missing address");
  return { origin: `http://127.0.0.1:${address.port}`, server };
}

async function close(server) {
  await new Promise((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
}

async function prove(context) {
  const admin = new Client(context.clientConfig);
  await admin.connect();
  let server;
  try {
    const generated = [requestId, correlationId];
    const app = createApp({
      uuidV7Factory: () => {
        const value = generated.shift();
        if (value === undefined) throw new Error("UUID sequence exhausted");
        return value;
      },
      correlationAcceptanceHandler: async (request, response) => {
        const command = createRequestCommandCorrelation(request, () => commandId);
        const eventContext = correlationForEventEmittedByCommand(command);
        await inBrandTransaction(admin, (transaction) =>
          appendEventInTransaction(transaction, event(sourceEventId, eventContext, 1n)),
        );
        response.status(202).json({ accepted: true });
      },
    });
    const listening = await listen(app);
    server = listening.server;

    const response = await globalThis.fetch(
      `${listening.origin}/__acceptance/request-command-event`,
      {
        method: "POST",
        headers: {
          "x-correlation-id": "raw-correlation-secret",
          "x-request-id": "raw-request-secret",
        },
      },
    );
    assert.equal(response.status, 202);
    assert.equal(response.headers.get("x-request-id"), requestId);
    assert.equal(response.headers.get("x-correlation-id"), correlationId);
    const responseBody = await response.json();
    assert.deepEqual(responseBody, { accepted: true });

    const persistedSource = await admin.query(
      `SELECT correlation_id::text, causation_id::text
       FROM platform_eventing.outbox_event
       WHERE event_id = $1`,
      [sourceEventId],
    );
    assert.deepEqual(persistedSource.rows, [
      { correlation_id: correlationId, causation_id: commandId },
    ]);

    const [claimed] = await inBrandTransaction(admin, (transaction) =>
      claimOutboxBatch(transaction, {
        batchSize: 1,
        leaseDurationSeconds: 30,
        leaseOwner: "request_correlation_acceptance",
        leaseToken,
      }),
    );
    assert(claimed);
    assert.equal(claimed.envelope.eventId, sourceEventId);
    assert.equal(claimed.envelope.correlationId, correlationId);
    assert.equal(claimed.envelope.causationId, commandId);

    const registration = {
      consumerName: "synthetic.request-correlation:v1",
      consumerVersion: 1,
      eventType: claimed.envelope.eventType,
      schemaVersions: [1],
      ownerModule: "@bop/eventing",
      tenantScope: "brand",
      ordering: "none",
      sideEffect: "synthetic-child-event",
      replaySafe: true,
      handler: async ({ envelope, transaction }) => {
        const childContext = deriveCorrelationContextFromEvent(envelope);
        await appendEventInTransaction(transaction, event(childEventId, childContext, 2n));
      },
    };
    const outcome = await inBrandTransaction(admin, (transaction) =>
      consumeEventInTransaction(transaction, registration, claimed.envelope),
    );
    assert.deepEqual(outcome, { status: "processed" });

    const persistedChild = await admin.query(
      `SELECT correlation_id::text, causation_id::text
       FROM platform_eventing.outbox_event
       WHERE event_id = $1`,
      [childEventId],
    );
    assert.deepEqual(persistedChild.rows, [
      { correlation_id: correlationId, causation_id: sourceEventId },
    ]);
    const inbox = await admin.query(
      `SELECT correlation_id::text
       FROM platform_eventing.consumer_inbox
       WHERE consumer_name = $1 AND event_id = $2`,
      [registration.consumerName, sourceEventId],
    );
    assert.deepEqual(inbox.rows, [{ correlation_id: correlationId }]);

    for (const mode of ["retry", "replay", "redelivery", "commit-unknown"])
      assert.deepEqual(
        preserveEventCorrelationContext({
          ...claimed.envelope,
          replayMetadata: { mode },
        }),
        { correlationId, causationId: commandId },
      );
    assert(!JSON.stringify(responseBody).includes("raw-"));
  } finally {
    if (server) await close(server);
    await admin.query("ROLLBACK").catch(() => undefined);
    await admin.end();
  }
}

it("proves HTTP Request → Command → Event → Outbox → Consumer correlation", async () => {
  await withIsolatedDatabase({ caseId: "request_correlation", root }, prove);
}, 180_000);
