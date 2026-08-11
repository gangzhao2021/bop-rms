import { createHash } from "node:crypto";

import type { ConsumerTransaction } from "@bop/eventing";
import { parseKitchenItemReadyEnvelope } from "@rms/kitchen";
import { describe, expect, it } from "vitest";

import {
  canonicalReadinessValue,
  createFulfillmentReadinessService,
  FulfillmentReadinessError,
  parseReadinessDigest,
  type FulfillmentReadinessPorts,
  type FulfillmentReadyEffect,
} from "../index.js";

const id = (value: number) => `00000000-0000-7000-8000-${String(value).padStart(12, "0")}`;
const sha = (value: string) => `sha256:${createHash("sha256").update(value).digest("hex")}`;
const readyAt = "2026-08-11T18:00:00.000Z";

function readyEvent(
  orderItemReference = id(10),
  readyResultReference = id(30),
  eventReference = id(31),
  quantity = 2,
) {
  return parseKitchenItemReadyEnvelope({
    eventId: eventReference,
    eventType: "KitchenItemReady",
    schemaVersion: 1,
    occurredAt: readyAt,
    producerModule: "@rms/kitchen",
    tenantId: id(1),
    storeId: id(2),
    aggregateType: "KitchenOrderItemReadyResult",
    aggregateId: readyResultReference,
    aggregateVersion: 1n,
    correlationId: id(32),
    causationId: id(33),
    actor: { type: "System" },
    payload: {
      kitchenTicketReference: id(20),
      orderReference: id(3),
      orderBatchReference: id(4),
      orderItemReference,
      readyResultReference,
      readyQuantity: quantity,
      requiredQuantity: quantity,
      readyAt,
    },
    redactionClassification: "indirect_identifier",
    replayMetadata: { replaySafe: true },
  });
}

function transaction() {
  const inbox = new Map<string, Record<string, unknown>>();
  const tx: ConsumerTransaction = {
    async query<Row>(text: string, values: readonly unknown[]) {
      const key = `${String(values[0])}:${String(values[1])}`;
      if (text.startsWith("INSERT INTO platform_eventing.consumer_inbox")) {
        if (inbox.has(key)) return { rowCount: 0, rows: [] };
        inbox.set(key, {
          event_type: values[2],
          schema_version: values[3],
          brand_id: values[4],
          store_id: values[5],
          status: "processing",
        });
        return { rowCount: 1, rows: [{ consumer_name: values[0] }] as Row[] };
      }
      if (text.startsWith("SELECT event_type")) {
        const row = inbox.get(key);
        return { rowCount: row === undefined ? 0 : 1, rows: (row ? [row] : []) as Row[] };
      }
      if (text.startsWith("UPDATE platform_eventing.consumer_inbox")) {
        const row = inbox.get(key);
        if (row === undefined || row.status !== "processing") return { rowCount: 0, rows: [] };
        row.status = "completed";
        return { rowCount: 1, rows: [] };
      }
      throw new Error("unexpected transaction query");
    },
  };
  return tx;
}

function fixture(options: { readonly authorized?: boolean } = {}) {
  const effects = new Map<string, FulfillmentReadyEffect>();
  let audits = 0;
  let source = {
    fulfillmentReference: id(40),
    brandReference: id(1),
    storeReference: id(2),
    orderReference: id(3),
    orderBatchReference: id(4),
    canonicalPhase: "Pending" as "Pending" | "Ready",
    aggregateVersion: 1n,
    lockedAt: "2026-08-11T18:00:01.000Z",
    items: [
      {
        fulfillmentItemReference: id(41),
        orderItemReference: id(10),
        orderedQuantity: 2,
        readyQuantity: 0,
        handedOverQuantity: 0 as const,
        state: "Pending" as "Pending" | "Ready",
      },
      {
        fulfillmentItemReference: id(42),
        orderItemReference: id(11),
        orderedQuantity: 1,
        readyQuantity: 0,
        handedOverQuantity: 0 as const,
        state: "Pending" as "Pending" | "Ready",
      },
    ],
  };
  const ports: FulfillmentReadinessPorts = {
    authorization: { authorize: async () => options.authorized ?? true },
    references: {
      derive: (purpose, identity) =>
        `00000000-0000-7000-8000-${createHash("sha256")
          .update(`${purpose}:${identity}`)
          .digest("hex")
          .slice(0, 12)}`,
    },
    digests: { sha256: sha },
    repository: {
      resolveByKitchenReadyResult: async ({ kitchenReadyResultReference }) => {
        const effect = effects.get(String(kitchenReadyResultReference));
        return effect === undefined ? { status: "NotFound" } : { status: "Resolved", effect };
      },
      lockByOrder: async () => source,
      apply: async ({ effect }) => {
        const key = String(effect.result.kitchenReadyResultReference);
        const existing = effects.get(key);
        if (existing !== undefined) return { status: "AlreadyApplied", effect: existing };
        effects.set(key, effect);
        source = {
          ...source,
          canonicalPhase: effect.operation.phaseAfter,
          aggregateVersion: effect.operation.aggregateVersionAfter,
          items: source.items.map((item) =>
            item.fulfillmentItemReference === effect.result.fulfillmentItemReference
              ? {
                  ...item,
                  readyQuantity: effect.result.readyQuantity,
                  state: "Ready" as const,
                }
              : item,
          ),
        };
        return { status: "Applied", effect };
      },
    },
    audit: { append: async () => void (audits += 1) },
  };
  return {
    service: createFulfillmentReadinessService(ports),
    tx: transaction(),
    get source() {
      return source;
    },
    get audits() {
      return audits;
    },
    get effects() {
      return effects;
    },
  };
}

describe("WP-1601 Fulfillment Ready intake", () => {
  it("records exact Item Ready and derives Ready only after the last item", async () => {
    const f = fixture();
    const first = await f.service.consume(f.tx, readyEvent());
    expect(first).toMatchObject({
      status: "Applied",
      effect: {
        result: { orderItemReference: id(10), readyQuantity: 2 },
        operation: {
          aggregateVersionBefore: 1n,
          aggregateVersionAfter: 2n,
          phaseAfter: "Pending",
        },
      },
    });
    const last = await f.service.consume(f.tx, readyEvent(id(11), id(34), id(35), 1));
    expect(last.effect.operation).toMatchObject({
      aggregateVersionBefore: 2n,
      aggregateVersionAfter: 3n,
      phaseAfter: "Ready",
    });
    expect(f.source.canonicalPhase).toBe("Ready");
    expect(f.audits).toBe(2);
  });

  it("converges same Event and semantic redelivery while preserving first provenance", async () => {
    const f = fixture();
    const first = await f.service.consume(f.tx, readyEvent());
    const duplicate = await f.service.consume(f.tx, readyEvent());
    const redelivery = await f.service.consume(f.tx, readyEvent(id(10), id(30), id(36)));
    expect(first.status).toBe("Applied");
    expect(duplicate.status).toBe("AlreadyApplied");
    expect(redelivery.status).toBe("AlreadyApplied");
    expect(redelivery.effect.result.sourceEventReference).toBe(id(31));
    expect(f.effects.size).toBe(1);
    expect(f.audits).toBe(1);
  });

  it("fails before effects for denied, partial, unknown or cross-scope source", async () => {
    const denied = fixture({ authorized: false });
    await expect(denied.service.consume(denied.tx, readyEvent())).rejects.toMatchObject({
      code: "FULFILLMENT_READINESS_PERMISSION_DENIED",
    });
    expect(denied.effects.size).toBe(0);

    const partial = fixture();
    await expect(
      partial.service.consume(partial.tx, readyEvent(id(10), id(30), id(31), 1)),
    ).rejects.toMatchObject({
      code: "FULFILLMENT_READINESS_CONFLICT",
    });
    expect(partial.effects.size).toBe(0);

    const unknown = fixture();
    await expect(
      unknown.service.consume(unknown.tx, readyEvent(id(12), id(30), id(31), 1)),
    ).rejects.toMatchObject({ code: "FULFILLMENT_READINESS_NOT_FOUND" });
    expect(unknown.effects.size).toBe(0);
    expect(FulfillmentReadinessError).toBeTypeOf("function");
  });

  it("fails closed for accessor-bearing dependency responses", async () => {
    const f = fixture();
    Object.defineProperty(f.source, "canonicalPhase", {
      enumerable: true,
      get: () => "Pending",
    });
    await expect(f.service.consume(f.tx, readyEvent())).rejects.toMatchObject({
      code: "FULFILLMENT_READINESS_CONFLICT",
    });
    expect(f.effects.size).toBe(0);
  });

  it("rejects a stored effect whose inner semantic binding was replaced", async () => {
    const f = fixture();
    const applied = await f.service.consume(f.tx, readyEvent());
    const operation = {
      ...applied.effect.operation,
      semanticBindingDigest: parseReadinessDigest(sha("replaced")),
    };
    const withoutDigest = {
      result: applied.effect.result,
      operation,
      audit: applied.effect.audit,
    };
    f.effects.set(id(30), {
      ...withoutDigest,
      effectDigest: parseReadinessDigest(sha(canonicalReadinessValue(withoutDigest))),
    });
    await expect(f.service.consume(f.tx, readyEvent(id(10), id(30), id(36)))).rejects.toMatchObject(
      { code: "FULFILLMENT_READINESS_DEPENDENCY_UNAVAILABLE" },
    );
    expect(f.audits).toBe(1);
  });
});
