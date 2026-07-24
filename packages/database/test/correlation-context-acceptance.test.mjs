import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { it } from "vitest";
import {
  appendEventInTransaction,
  claimOutboxBatch,
  consumeEventInTransaction,
  continueTrustedCorrelationContext,
  createRootCorrelationContext,
  deriveCorrelationContextFromCommand,
  deriveCorrelationContextFromEvent,
  preserveEventCorrelationContext,
} from "../../bop/eventing/src/index.ts";
import { withIsolatedDatabase } from "../test-support/isolated-database.mjs";

const { Client } = pg;
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const brandId = "018f1f48-7b5d-7a01-8a1b-123456789abc";
const aggregateId = "018f1f48-7b5d-7a02-8a1b-123456789abc";
const correlationId = "018f1f48-7b5d-7b01-8a1b-123456789abc";
const commandId = "018f1f48-7b5d-7b02-8a1b-123456789abc";
const sourceEventId = "018f1f48-7b5d-7c01-8a1b-123456789abc";
const childEventId = "018f1f48-7b5d-7c02-8a1b-123456789abc";
const firstLease = "018f1f48-7b5d-7d01-8a1b-123456789abc";
const secondLease = "018f1f48-7b5d-7d02-8a1b-123456789abc";

function event(eventId, context, overrides = {}) {
  return {
    eventId,
    eventType: "SyntheticChanged",
    schemaVersion: 1,
    occurredAt: "2026-07-24T12:00:00.000Z",
    producerModule: "@bop/eventing",
    tenantId: brandId,
    aggregateType: "SyntheticAggregate",
    aggregateId,
    aggregateVersion: 1n,
    correlationId: context.correlationId,
    ...(context.causationId ? { causationId: context.causationId } : {}),
    actor: { type: "System" },
    payload: { sentinel: "synthetic" },
    redactionClassification: "none",
    replayMetadata: { mode: "synthetic" },
    ...overrides,
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

async function claim(client, leaseToken) {
  return await inBrandTransaction(client, (transaction) =>
    claimOutboxBatch(transaction, {
      batchSize: 1,
      leaseDurationSeconds: 30,
      leaseOwner: "correlation_acceptance",
      leaseToken,
    }),
  );
}

async function prove(context) {
  const admin = new Client(context.clientConfig);
  await admin.connect();
  try {
    let factoryCalls = 0;
    const rootContext = createRootCorrelationContext(() => {
      factoryCalls += 1;
      return correlationId;
    });
    assert.deepEqual(rootContext, { correlationId });
    assert.equal(factoryCalls, 1);
    assert(Object.isFrozen(rootContext));
    assert.deepEqual(deriveCorrelationContextFromCommand(rootContext, commandId), {
      correlationId,
      causationId: commandId,
    });

    const sourceEvent = event(sourceEventId, rootContext);
    const childContext = deriveCorrelationContextFromEvent(sourceEvent);
    assert.deepEqual(childContext, { correlationId, causationId: sourceEventId });

    const registration = {
      consumerName: "synthetic.correlation:v1",
      consumerVersion: 1,
      eventType: sourceEvent.eventType,
      schemaVersions: [1],
      ownerModule: "@bop/eventing",
      tenantScope: "brand",
      ordering: "none",
      sideEffect: "synthetic-effect",
      replaySafe: true,
      handler: async ({ envelope, transaction }) => {
        const derived = deriveCorrelationContextFromEvent(envelope);
        await appendEventInTransaction(
          transaction,
          event(childEventId, derived, { aggregateVersion: 2n }),
        );
      },
    };
    await inBrandTransaction(admin, (transaction) =>
      consumeEventInTransaction(transaction, registration, sourceEvent),
    );

    const persisted = await admin.query(
      `SELECT correlation_id::text, causation_id::text, payload_json::text, replay_metadata_json::text
       FROM platform_eventing.outbox_event
       WHERE event_id = $1`,
      [childEventId],
    );
    assert.deepEqual(persisted.rows, [
      {
        correlation_id: correlationId,
        causation_id: sourceEventId,
        payload_json: '{"sentinel": "synthetic"}',
        replay_metadata_json: '{"mode": "synthetic"}',
      },
    ]);
    const serializedPayload = `${persisted.rows[0].payload_json}${persisted.rows[0].replay_metadata_json}`;
    assert(!serializedPayload.includes(correlationId));
    assert(!serializedPayload.includes(sourceEventId));

    const firstDelivery = await claim(admin, firstLease);
    assert.equal(firstDelivery.length, 1);
    assert.equal(firstDelivery[0].envelope.correlationId, correlationId);
    assert.equal(firstDelivery[0].envelope.causationId, sourceEventId);

    await admin.query(
      `UPDATE platform_eventing.outbox_event
       SET lease_expires_at = statement_timestamp() - interval '1 second'
       WHERE event_id = $1`,
      [childEventId],
    );
    const redelivery = await claim(admin, secondLease);
    assert.equal(redelivery.length, 1);
    assert.equal(redelivery[0].attemptCount, 2);
    assert.deepEqual(preserveEventCorrelationContext(redelivery[0].envelope), childContext);
    for (const mode of ["retry", "replay", "redelivery", "lost-ack", "commit-unknown"])
      assert.deepEqual(
        preserveEventCorrelationContext({ ...redelivery[0].envelope, replayMetadata: { mode } }),
        childContext,
      );

    const externalSecret = "person@example.test?token=must-not-capture";
    assert.throws(
      () =>
        continueTrustedCorrelationContext({
          correlationId,
          baggage: externalSecret,
        }),
      (error) => !error.message.includes(externalSecret),
    );

    const contractSource = await readFile(
      path.join(root, "packages/bop/eventing/src/contracts/correlation-context.ts"),
      "utf8",
    );
    assert(!/AsyncLocalStorage|traceparent|tracestate|OpenTelemetry|X-Ray/u.test(contractSource));
    assert(
      !/metric[^\n]*correlation|analytics[^\n]*correlation|https?:\/\//iu.test(contractSource),
    );
  } finally {
    await admin.query("ROLLBACK").catch(() => undefined);
    await admin.end();
  }
}

it("proves the complete WP-0034 Correlation / Causation Context acceptance matrix", async () => {
  await withIsolatedDatabase({ caseId: "correlation_context", root }, prove);
}, 180_000);
