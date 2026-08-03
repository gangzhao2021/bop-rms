import { describe, expect, it } from "vitest";

import {
  buildPaymentStatusProjection,
  createPaymentStatusProjectionService,
  createPaymentStatusQueryService,
  parsePaymentStatusProjection,
  parsePaymentTerminalEnvelope,
  PaymentStatusProjectionError,
  type PaymentStatusProjection,
  type PaymentStatusProjectionPorts,
  type PaymentStatusQueryPorts,
  type PaymentTerminalEnvelope,
} from "../index.js";

const id = (n: number) => `0198a106-0000-7000-8000-${n.toString(16).padStart(12, "0")}`;
const at = "2026-08-03T18:00:00.000Z";

function terminalEvent(
  outcome: "Succeeded" | "Failed" = "Succeeded",
  offset = 0,
): PaymentTerminalEnvelope {
  const intent = id(10 + offset);
  const common = {
    eventId: id(20 + offset),
    eventType: outcome === "Succeeded" ? "PaymentSucceeded" : "PaymentFailed",
    schemaVersion: 1,
    occurredAt: at,
    producerModule: "@rms/payment",
    tenantId: id(1),
    storeId: id(2),
    aggregateType: "PaymentIntent",
    aggregateId: intent,
    aggregateVersion: 2n,
    correlationId: id(3),
    causationId: id(4),
    actor: { type: "System" },
    redactionClassification: "payment",
    replayMetadata: { replaySafe: true },
  };
  return parsePaymentTerminalEnvelope({
    ...common,
    payload: {
      paymentTransactionReference: id(30 + offset),
      paymentIntentReference: intent,
      paymentAttemptReference: id(40 + offset),
      orderReference: id(50 + offset),
      terminalOccurredAt: at,
      ...(outcome === "Succeeded"
        ? { amountMinor: "1250", currencyCode: "CAD", evidenceKind: "Captured" }
        : { reason: "Declined", retryDisposition: "NewOperation" }),
    },
  });
}

async function errorCode(promise: Promise<unknown>) {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(PaymentStatusProjectionError);
    return (error as PaymentStatusProjectionError).code;
  }
  throw new Error("expected PaymentStatusProjectionError");
}

function projectionFixture(
  options: { conflict?: boolean; deny?: boolean; crossStore?: boolean } = {},
) {
  const stored = new Map<string, PaymentStatusProjection>();
  const rebuildCalls: PaymentStatusProjection[][] = [];
  let reference = 100;
  const ports: PaymentStatusProjectionPorts = {
    references: {
      generateGeneration: () => id(reference++),
      now: () => at,
    },
    repository: {
      consume: async ({ event, projection }) => {
        const existing = stored.get(event.eventId);
        if (options.conflict) return { status: "Conflict" as const, projection };
        if (existing !== undefined) return { status: "Duplicate" as const, projection: existing };
        stored.set(event.eventId, projection);
        return { status: "Completed" as const, projection };
      },
      rebuild: async ({ projections }) => {
        rebuildCalls.push([...projections]);
        return projections;
      },
    },
    rebuild: {
      authorize: async () => !options.deny,
      loadTerminalEvents: async () => {
        const first = terminalEvent("Succeeded");
        return [
          options.crossStore ? ({ ...first, storeId: id(6) } as PaymentTerminalEnvelope) : first,
          terminalEvent("Failed", 1),
        ];
      },
    },
  };
  return { service: createPaymentStatusProjectionService(ports), rebuildCalls };
}

describe("WP-1306 Payment status projection", () => {
  it("builds minimal success and failure snapshots with explicit freshness", () => {
    const success = buildPaymentStatusProjection({
      event: terminalEvent(),
      generationReference: id(100),
      projectedAt: at,
    });
    const failed = buildPaymentStatusProjection({
      event: terminalEvent("Failed", 1),
      generationReference: id(101),
      projectedAt: at,
      lastRebuiltAt: at,
    });
    expect(success).toMatchObject({
      projectionName: "payment_status_v1",
      projectionVersion: 1,
      freshnessStatus: "Fresh",
      lastRebuiltAt: null,
      snapshot: { terminalStatus: "Succeeded", amount: { amountMinor: 1250n } },
    });
    expect(failed.snapshot).toMatchObject({
      terminalStatus: "Failed",
      amount: null,
      failureReason: "Declined",
      retryDisposition: "NewOperation",
    });
    expect(JSON.stringify(failed)).not.toMatch(/provider|guest|email|digest|payload/iu);
  });

  it("consumes atomically, returns an identical duplicate and rejects conflict", async () => {
    const fixture = projectionFixture();
    const first = await fixture.service.consume(terminalEvent());
    const duplicate = await fixture.service.consume(terminalEvent());
    expect(first.status).toBe("Completed");
    expect(duplicate.status).toBe("Duplicate");
    expect(duplicate.projection).toStrictEqual(first.projection);
    expect(
      await errorCode(projectionFixture({ conflict: true }).service.consume(terminalEvent())),
    ).toBe("PAYMENT_STATUS_VERSION_CONFLICT");
  });

  it("authorizes and atomically composes one exact shadow rebuild generation", async () => {
    const fixture = projectionFixture();
    const result = await fixture.service.rebuild({
      brandReference: id(1),
      storeReference: id(2),
      actorReference: id(5),
      requestedAt: at,
    });
    expect(result).toMatchObject({ status: "Rebuilt", count: 2 });
    expect(new Set(result.projections.map((row) => row.generationReference))).toEqual(
      new Set([result.generationReference]),
    );
    expect(result.projections.every((row) => row.lastRebuiltAt === at)).toBe(true);
    expect(fixture.rebuildCalls).toHaveLength(1);
    expect(
      await errorCode(
        projectionFixture({ deny: true }).service.rebuild({
          brandReference: id(1),
          storeReference: id(2),
          actorReference: id(5),
          requestedAt: at,
        }),
      ),
    ).toBe("PAYMENT_STATUS_PERMISSION_DENIED");
  });

  it("rejects malformed projection metadata and cross-Store rebuild sources", async () => {
    const valid = buildPaymentStatusProjection({
      event: terminalEvent(),
      generationReference: id(100),
      projectedAt: at,
    });
    expect(() => parsePaymentStatusProjection({ ...valid, projectionVersion: 2 })).toThrow(
      PaymentStatusProjectionError,
    );
    expect(
      await errorCode(
        projectionFixture({ crossStore: true }).service.rebuild({
          brandReference: id(1),
          storeReference: id(2),
          actorReference: id(5),
          requestedAt: at,
        }),
      ),
    ).toBe("PAYMENT_STATUS_DEPENDENCY_UNAVAILABLE");
  });
});

function queryFixture(rows: readonly PaymentStatusProjection[], deny = false) {
  const calls: string[] = [];
  const ports: PaymentStatusQueryPorts = {
    authorization: {
      authorize: async () => {
        calls.push("authorize");
        return !deny;
      },
    },
    projections: {
      load: async ({ paymentIntentReference }) => {
        calls.push("load");
        return (
          rows.find((row) => row.snapshot.paymentIntentReference === paymentIntentReference) ?? null
        );
      },
      list: async () => {
        calls.push("list");
        return rows;
      },
    },
  };
  return { service: createPaymentStatusQueryService(ports), calls };
}

function queryInput() {
  return {
    brandReference: id(1),
    storeReference: id(2),
    actorReference: id(5),
    observedAt: at,
    exactPaymentOrOrderReference: null,
    terminalStatus: null,
    occurredFrom: null,
    occurredUntil: null,
    afterOccurredAt: null,
    afterPaymentIntentReference: null,
    freshnessStatus: null,
    limit: 10,
  };
}

describe("WP-1306 Payment status queries", () => {
  const rows = [
    buildPaymentStatusProjection({
      event: terminalEvent(),
      generationReference: id(100),
      projectedAt: at,
    }),
  ];

  it("authorizes before exact detail and bounded list reads", async () => {
    const fixture = queryFixture(rows);
    const detail = await fixture.service.get({
      brandReference: id(1),
      storeReference: id(2),
      actorReference: id(5),
      paymentIntentReference: id(10),
      observedAt: at,
    });
    expect(detail.sourceCheckpoint).toBe(id(20));
    expect(await fixture.service.list(queryInput())).toEqual(rows);
    expect(fixture.calls).toEqual(["authorize", "load", "authorize", "list"]);
  });

  it("denies before reading and rejects cursor/filter dependency violations", async () => {
    const denied = queryFixture(rows, true);
    expect(await errorCode(denied.service.list(queryInput()))).toBe(
      "PAYMENT_STATUS_PERMISSION_DENIED",
    );
    expect(denied.calls).toEqual(["authorize"]);
    const malformedDetail = queryFixture(rows);
    expect(
      await errorCode(
        malformedDetail.service.get({
          brandReference: id(1),
          storeReference: id(2),
          actorReference: id(5),
          paymentIntentReference: "unsafe",
          observedAt: at,
        }),
      ),
    ).toBe("PAYMENT_STATUS_INPUT_INVALID");
    expect(malformedDetail.calls).toEqual(["authorize"]);
    const invalidCursor = queryFixture(rows);
    expect(
      await errorCode(invalidCursor.service.list({ ...queryInput(), afterOccurredAt: at })),
    ).toBe("PAYMENT_STATUS_INPUT_INVALID");
    const mismatch = queryFixture(rows);
    expect(
      await errorCode(mismatch.service.list({ ...queryInput(), terminalStatus: "Failed" })),
    ).toBe("PAYMENT_STATUS_DEPENDENCY_UNAVAILABLE");
  });
});
