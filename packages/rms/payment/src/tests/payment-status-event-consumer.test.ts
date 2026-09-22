import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import type { ConsumerTransaction } from "@bop/eventing";
import {
  buildPaymentStatusProjection,
  createPaymentStatusEventConsumerService,
  parsePaymentTerminalEnvelope,
  type PaymentTerminalEnvelope,
  type PaymentStatusProjection,
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

function fixture(event = terminalEvent()) {
  let projection: PaymentStatusProjection | null = null;
  let completed = false;
  let snapshot: PaymentStatusProjection | null = null;
  let failCompletion = false;
  const statements: string[] = [];
  const tx: ConsumerTransaction = {
    async query<Row = Record<string, unknown>>(sql: string) {
      statements.push(sql);
      if (sql.startsWith("SAVEPOINT ")) {
        snapshot = projection;
        return { rows: [] as Row[], rowCount: 0 };
      }
      if (sql.startsWith("ROLLBACK TO SAVEPOINT ")) {
        projection = snapshot;
        return { rows: [] as Row[], rowCount: 0 };
      }
      if (sql.startsWith("RELEASE SAVEPOINT ")) return { rows: [] as Row[], rowCount: 0 };
      if (sql.startsWith("INSERT INTO platform_eventing.consumer_inbox"))
        return { rows: [] as Row[], rowCount: completed ? 0 : 1 };
      if (sql.startsWith("SELECT event_type"))
        return {
          rowCount: 1,
          rows: [
            {
              event_type: event.eventType,
              schema_version: 1,
              brand_id: id(1),
              store_id: id(2),
              status: "completed",
            } as Row,
          ],
        };
      if (sql.startsWith("UPDATE platform_eventing.consumer_inbox")) {
        if (failCompletion) throw new Error("synthetic completion failure");
        completed = true;
        return { rows: [] as Row[], rowCount: 1 };
      }
      throw new Error("unexpected query");
    },
  };
  const authorize = vi.fn().mockResolvedValue(true);
  const generateGeneration = vi.fn(() => id(100));
  const now = vi.fn(() => at);
  const write = vi.fn(
    async (input: { transaction: ConsumerTransaction; projection: PaymentStatusProjection }) => {
      expect(input.transaction).toBe(tx);
      projection = input.projection;
      return { status: "Completed" as const, projection };
    },
  );
  const service = createPaymentStatusEventConsumerService({
    scope: { brandReference: id(1), storeReference: id(2) },
    authorization: { authorize },
    projections: {
      load: async (input) => {
        expect(input.transaction).toBe(tx);
        return projection;
      },
      write,
    },
    references: { generateGeneration, now },
    sha256: (input) => createHash("sha256").update(input).digest("hex"),
  });
  return {
    service,
    tx,
    event,
    authorize,
    generateGeneration,
    now,
    write,
    statements,
    setProjection(value: PaymentStatusProjection) {
      projection = value;
    },
    failCompletion() {
      failCompletion = true;
    },
    projection: () => projection,
  };
}
describe("Payment terminal event projection consumer", () => {
  it.each(["Succeeded", "Failed"] as const)(
    "persists %s and recovers duplicate without new metadata",
    async (outcome) => {
      const f = fixture(terminalEvent(outcome));
      expect(await f.service.consume(f.tx, f.event)).toEqual({ status: "processed" });
      f.generateGeneration.mockImplementation(() => {
        throw new Error("must recover original");
      });
      f.now.mockImplementation(() => {
        throw new Error("must recover original");
      });
      expect(await f.service.consume(f.tx, f.event)).toEqual({ status: "duplicate_completed" });
      expect(f.write).toHaveBeenCalledTimes(1);
    },
  );
  it("recovers an existing projection before generating metadata", async () => {
    const f = fixture();
    f.setProjection(
      buildPaymentStatusProjection({
        event: f.event,
        generationReference: id(101),
        projectedAt: at,
      }),
    );
    expect(await f.service.consume(f.tx, f.event)).toEqual({ status: "processed" });
    expect(f.generateGeneration).not.toHaveBeenCalled();
    expect(f.now).not.toHaveBeenCalled();
    expect(f.write).not.toHaveBeenCalled();
    expect(f.projection()?.generationReference).toBe(id(101));
  });
  it("rejects revocation before Inbox duplicate SQL", async () => {
    const f = fixture();
    await f.service.consume(f.tx, f.event);
    f.statements.length = 0;
    f.authorize.mockResolvedValue(false);
    await expect(f.service.consume(f.tx, f.event)).rejects.toMatchObject({
      code: "PAYMENT_STATUS_PERMISSION_DENIED",
    });
    expect(f.statements).toEqual([]);
  });
  it("rejects a changed terminal source before duplicate admission", async () => {
    const f = fixture();
    await f.service.consume(f.tx, f.event);
    const changed = parsePaymentTerminalEnvelope({ ...f.event, eventId: id(999) });
    await expect(f.service.consume(f.tx, changed)).rejects.toMatchObject({
      code: "PAYMENT_STATUS_VERSION_CONFLICT",
    });
    expect(f.write).toHaveBeenCalledTimes(1);
  });
  it("rolls back projection if Inbox completion fails", async () => {
    const f = fixture();
    f.failCompletion();
    await expect(f.service.consume(f.tx, f.event)).rejects.toThrow("synthetic completion failure");
    expect(f.projection()).toBeNull();
    expect(f.statements).toContain("ROLLBACK TO SAVEPOINT payment_status_event_consumer");
  });
  it("uses one consumer identity with two exact registrations", () => {
    const f = fixture();
    expect(f.service.registrations.map((r) => [r.consumerName, r.eventType])).toEqual([
      ["payment.status-projection:v1", "PaymentSucceeded"],
      ["payment.status-projection:v1", "PaymentFailed"],
    ]);
  });
});
