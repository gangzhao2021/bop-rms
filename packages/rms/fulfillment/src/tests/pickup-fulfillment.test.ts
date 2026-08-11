import { createHash } from "node:crypto";

import type { ConsumerTransaction } from "@bop/eventing";
import {
  createOrderFulfillmentSourceEvidenceBinding,
  createOrderFulfillmentSourceLineBinding,
  parseConfirmedOrderFulfillmentSourceEvidence,
  parseOrderConfirmedEnvelope,
} from "@rms/ordering";
import { describe, expect, it } from "vitest";

import {
  createPickupFulfillmentService,
  PickupFulfillmentError,
  type PickupFulfillmentCreationEffect,
  type PickupFulfillmentPorts,
} from "../index.js";

const id = (value: number) => `00000000-0000-7000-8000-${String(value).padStart(12, "0")}`;
const sha = (value: string) => `sha256:${createHash("sha256").update(value).digest("hex")}`;
const occurredAt = "2026-08-11T18:00:00.000Z";

function event(eventReference = id(6)) {
  return parseOrderConfirmedEnvelope({
    eventId: eventReference,
    eventType: "OrderConfirmed",
    schemaVersion: 1,
    occurredAt,
    producerModule: "@rms/ordering",
    tenantId: id(1),
    storeId: id(2),
    aggregateType: "Order",
    aggregateId: id(3),
    aggregateVersion: 2n,
    correlationId: id(7),
    causationId: id(8),
    actor: { type: "System" },
    payload: {
      confirmationReference: id(5),
      orderReference: id(3),
      orderBatchReference: id(4),
      sourceSnapshotDigest: sha("order"),
      confirmedAt: occurredAt,
    },
    redactionClassification: "indirect_identifier",
    replayMetadata: { replaySafe: true },
  });
}

function sourceFor(
  sourceEventReference = id(6),
  orderType: "DineIn" | "Pickup" = "Pickup",
  quantity = 2,
) {
  const line = {
    orderItemReference: id(10),
    ordinal: 1,
    quantity,
    lineDigest: sha("placeholder"),
  };
  line.lineDigest = sha(createOrderFulfillmentSourceLineBinding(line));
  const raw = {
    evidenceReference: id(20),
    brandReference: id(1),
    storeReference: id(2),
    orderReference: id(3),
    orderBatchReference: id(4),
    confirmationReference: id(5),
    sourceEventReference,
    sourceAggregateVersion: 2n,
    sourceSnapshotDigest: sha("order"),
    orderType,
    capturedAt: "2026-08-11T17:59:59.000Z",
    evidenceVersion: 1,
    items: [line],
    evidenceDigest: sha("placeholder"),
  };
  raw.evidenceDigest = sha(createOrderFulfillmentSourceEvidenceBinding(raw));
  return parseConfirmedOrderFulfillmentSourceEvidence(raw);
}

function transaction() {
  const inbox = new Map<
    string,
    {
      event_type: string;
      schema_version: number;
      brand_id: string;
      store_id: string | null;
      status: string;
    }
  >();
  const tx: ConsumerTransaction = {
    async query<Row>(text: string, values: readonly unknown[]) {
      const key = `${String(values[0])}:${String(values[1])}`;
      if (text.startsWith("INSERT INTO platform_eventing.consumer_inbox")) {
        if (inbox.has(key)) return { rowCount: 0, rows: [] };
        inbox.set(key, {
          event_type: String(values[2]),
          schema_version: Number(values[3]),
          brand_id: String(values[4]),
          store_id: values[5] === null ? null : String(values[5]),
          status: "processing",
        });
        return { rowCount: 1, rows: [{ consumer_name: values[0] }] as Row[] };
      }
      if (text.startsWith("SELECT event_type")) {
        const row = inbox.get(key);
        return {
          rowCount: row === undefined ? 0 : 1,
          rows: (row === undefined ? [] : [row]) as Row[],
        };
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

function fixture(
  options: {
    readonly authorized?: boolean;
    readonly orderType?: "DineIn" | "Pickup";
    readonly quantity?: number;
  } = {},
) {
  let stored: PickupFulfillmentCreationEffect | null = null;
  let audits = 0;
  let sourceEventReference = id(6);
  let sourceQuantity = options.quantity ?? 2;
  const ports: PickupFulfillmentPorts = {
    authorization: { authorize: async () => options.authorized ?? true },
    orderingSource: {
      resolve: async (input) => {
        sourceEventReference = String(input.sourceEventReference);
        return sourceFor(sourceEventReference, options.orderType ?? "Pickup", sourceQuantity);
      },
    },
    references: {
      derive: (purpose, identity) => {
        const suffix = createHash("sha256")
          .update(`${purpose}:${identity}`)
          .digest("hex")
          .slice(0, 12);
        return `00000000-0000-7000-8000-${suffix}`;
      },
    },
    digests: { sha256: sha },
    repository: {
      resolveByOrder: async () =>
        stored === null ? { status: "NotFound" } : { status: "Resolved", effect: stored },
      create: async ({ effect }) => {
        if (stored !== null) return { status: "AlreadyCreated", effect: stored };
        stored = effect;
        return { status: "Created", effect };
      },
    },
    audit: {
      append: async () => {
        audits += 1;
      },
    },
  };
  return {
    service: createPickupFulfillmentService(ports),
    transaction: transaction(),
    get stored() {
      return stored;
    },
    get audits() {
      return audits;
    },
    get sourceEventReference() {
      return sourceEventReference;
    },
    setQuantity(value: number) {
      sourceQuantity = value;
    },
  };
}

describe("WP-1600 Pickup Fulfillment Aggregate", () => {
  it("creates one Pending Pickup Aggregate with exact item quantities and Audit", async () => {
    const f = fixture();
    await expect(f.service.consume(f.transaction, event())).resolves.toMatchObject({
      status: "Created",
      effect: {
        aggregate: {
          fulfillmentType: "Pickup",
          canonicalPhase: "Pending",
          aggregateVersion: 1,
          items: [
            {
              orderItemReference: id(10),
              orderedQuantity: 2,
              readyQuantity: 0,
              handedOverQuantity: 0,
              state: "Pending",
            },
          ],
        },
      },
    });
    expect(f.audits).toBe(1);
    expect(
      JSON.stringify(f.stored, (_, value) => (typeof value === "bigint" ? String(value) : value)),
    ).not.toMatch(/customer|note|price|payment|provider|health/iu);
  });

  it("converges same-Event and semantic redelivery without replacing provenance", async () => {
    const f = fixture();
    const first = await f.service.consume(f.transaction, event());
    const duplicate = await f.service.consume(f.transaction, event());
    const redelivery = await f.service.consume(f.transaction, event(id(66)));
    expect(first.status).toBe("Created");
    expect(duplicate.status).toBe("AlreadyCreated");
    expect(redelivery.status).toBe("AlreadyCreated");
    expect(f.stored?.aggregate.sourceEventReference).toBe(id(6));
    expect(f.sourceEventReference).toBe(id(66));
    expect(f.audits).toBe(1);
  });

  it("completes Dine-in as not applicable without a Fulfillment effect", async () => {
    const f = fixture({ orderType: "DineIn" });
    await expect(f.service.consume(f.transaction, event())).resolves.toEqual({
      status: "NotApplicable",
    });
    expect(f.stored).toBeNull();
    expect(f.audits).toBe(0);
  });

  it("fails before effects for denied or conflicting source", async () => {
    const denied = fixture({ authorized: false });
    await expect(denied.service.consume(denied.transaction, event())).rejects.toMatchObject({
      code: "PICKUP_FULFILLMENT_PERMISSION_DENIED",
    });
    expect(denied.stored).toBeNull();

    const f = fixture();
    await f.service.consume(f.transaction, event());
    f.setQuantity(3);
    await expect(f.service.consume(f.transaction, event(id(66)))).rejects.toMatchObject({
      code: "PICKUP_FULFILLMENT_CONFLICT",
    });
    expect(f.audits).toBe(1);
    expect(PickupFulfillmentError).toBeTypeOf("function");
  });
});
