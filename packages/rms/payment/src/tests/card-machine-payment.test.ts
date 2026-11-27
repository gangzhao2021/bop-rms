import { describe, expect, it, vi } from "vitest";
import { parseOrderPaymentPreparationEvidence } from "@rms/ordering";

import {
  CardMachinePaymentError,
  cardMachinePaymentIntentView,
  cardMachineTerminalView,
  createCardMachinePaymentEnvelope,
  createPaymentStatusEventConsumerService,
  parseCardMachinePaymentRecord,
  parseCardMachineRefundRecord,
  parseCardMachineSlipReference,
  parsePaymentIntentCreationRecord,
  reviveCardMachinePreparation,
  serializeCardMachinePreparation,
} from "../index.js";
import { digest, id, preparation, refs } from "./payment-intent-creation.fixture.js";

const recordedAt = "2026-08-03T15:05:00.000Z";
function record(overrides: Record<string, unknown> = {}) {
  return {
    tenantReference: id(30),
    brandReference: refs.brand,
    storeReference: refs.store,
    cardMachinePaymentReference: id(31),
    paymentIntentReference: id(32),
    paymentAttemptReference: id(33),
    paymentOperationReference: refs.operation,
    operationReference: id(34),
    intentDigest: digest("b"),
    orderReference: refs.order,
    orderBatchReference: refs.batch,
    submissionReference: refs.submission,
    preparation: parseOrderPaymentPreparationEvidence(preparation()),
    environment: "Test",
    slipReference: "AUTH 123456",
    recordingReason: "AtCounter",
    takenAt: recordedAt,
    recordedAt,
    actorReference: id(35),
    eventReference: id(36),
    auditReference: id(37),
    ...overrides,
  };
}
const invalid = (action: () => unknown) =>
  expect(action).toThrowError(
    expect.objectContaining({ code: "CARD_MACHINE_INPUT_INVALID" }) as unknown as Error,
  );

describe("card-machine payment record (WP-2423 Q7)", () => {
  it("keeps a short slip reference but never a card number", () => {
    expect(parseCardMachineSlipReference(null)).toBeNull();
    expect(parseCardMachineSlipReference("AUTH 123456")).toBe("AUTH 123456");
    expect(parseCardMachineSlipReference("RRN 0123-4567-89/01")).toBe("RRN 0123-4567-89/01");
    for (const value of [
      "1234 5678 9012 3456", // a card number (more than 12 digits)
      "1234567890123456",
      " leading space",
      "x".repeat(41),
      "name: Jane <script>",
      "",
      42,
    ])
      invalid(() => parseCardMachineSlipReference(value));
  });

  it("is paid at the counter now, or recorded after an outage within three days", () => {
    expect(parseCardMachinePaymentRecord(record()).recordingReason).toBe("AtCounter");
    const back = parseCardMachinePaymentRecord(
      record({ recordingReason: "RecordedAfterOutage", takenAt: "2026-08-03T11:40:00.000Z" }),
    );
    expect(back.takenAt).toBe("2026-08-03T11:40:00.000Z");
    // At the counter the money moved now; only an outage entry carries an earlier time.
    invalid(() => parseCardMachinePaymentRecord(record({ takenAt: "2026-08-03T15:00:00.000Z" })));
    invalid(() =>
      parseCardMachinePaymentRecord(
        record({ recordingReason: "RecordedAfterOutage", takenAt: "2026-08-03T15:06:00.000Z" }),
      ),
    );
    invalid(() =>
      parseCardMachinePaymentRecord(
        record({ recordingReason: "RecordedAfterOutage", takenAt: "2026-07-31T15:04:59.000Z" }),
      ),
    );
    invalid(() => parseCardMachinePaymentRecord(record({ recordingReason: "Cash" })));
    invalid(() => parseCardMachinePaymentRecord(record({ environment: "Prod" })));
    // The Order and Batch are the preparation's own.
    invalid(() => parseCardMachinePaymentRecord(record({ orderBatchReference: id(99) })));
    invalid(() => parseCardMachinePaymentRecord(record({ eventReference: id(31) })));
  });

  it("produces the same paid signal as an online capture, at the time it was recorded", () => {
    const saved = parseCardMachinePaymentRecord(
      record({ recordingReason: "RecordedAfterOutage", takenAt: "2026-08-03T11:40:00.000Z" }),
    );
    const event = createCardMachinePaymentEnvelope(saved);
    expect(event).toMatchObject({
      eventId: id(36),
      eventType: "PaymentSucceeded",
      aggregateType: "PaymentIntent",
      aggregateId: id(32),
      aggregateVersion: 2n,
      tenantId: refs.brand,
      storeId: refs.store,
      correlationId: refs.operation,
      causationId: id(34),
      actor: { type: "System" },
      occurredAt: recordedAt,
      payload: {
        paymentTransactionReference: id(31),
        paymentIntentReference: id(32),
        paymentAttemptReference: id(33),
        orderReference: refs.order,
        amountMinor: "2200",
        currencyCode: "CAD",
        evidenceKind: "Captured",
        terminalOccurredAt: recordedAt,
      },
    });
    const view = cardMachinePaymentIntentView(saved);
    expect(view.intent.paymentMethod).toBe("StoreCardMachine");
    expect(view.intent.creationStatus).toBe("Recorded");
    expect(view.attempt.provider).toBe("StoreCardMachine");
    expect(view.providerOutcome).toBeNull();
    expect(view.intent.preparation.total.amountMinor).toBe(2_200n);
    expect(cardMachineTerminalView(saved)).toMatchObject({
      outcome: "Succeeded",
      paymentTransactionReference: id(31),
      amount: { amountMinor: 2_200n, currencyCode: "CAD" },
      recordedAt,
    });
  });

  it("never passes as an online card payment with a Provider outcome", () => {
    const view = cardMachinePaymentIntentView(parseCardMachinePaymentRecord(record()));
    expect(() =>
      parsePaymentIntentCreationRecord({
        ...view,
        attempt: { ...view.attempt, provider: "Stripe" },
      }),
    ).toThrow();
    expect(() =>
      parsePaymentIntentCreationRecord({
        ...view,
        intent: { ...view.intent, creationStatus: "ProviderCreatePending" },
      }),
    ).toThrow();
  });

  it("stores the preparation with exact money and reads it back", () => {
    const prepared = parseOrderPaymentPreparationEvidence(preparation());
    const json = JSON.parse(serializeCardMachinePreparation(prepared));
    expect(json.total).toEqual({ amountMinor: "2200", currencyCode: "CAD" });
    expect(reviveCardMachinePreparation(json)).toEqual(prepared);
    expect(() =>
      reviveCardMachinePreparation({ ...json, total: { amountMinor: 22.5, currencyCode: "CAD" } }),
    ).toThrow(CardMachinePaymentError);
  });

  it("records a refund made on the machine by its source", () => {
    const refund = parseCardMachineRefundRecord({
      tenantReference: id(30),
      brandReference: refs.brand,
      storeReference: refs.store,
      cardMachineRefundReference: id(40),
      cardMachinePaymentReference: id(31),
      orderReference: refs.order,
      operationReference: id(41),
      intentDigest: digest("c"),
      sourceKind: "StaffCancellation",
      sourceReference: id(42),
      amountMinor: 2_200n,
      slipReference: null,
      refundedAt: recordedAt,
      recordedAt,
      actorReference: id(35),
      auditReference: id(43),
    });
    expect(refund.amountMinor).toBe(2_200n);
    expect(() => parseCardMachineRefundRecord({ ...refund, amountMinor: 0n })).toThrow(
      CardMachinePaymentError,
    );
    expect(() => parseCardMachineRefundRecord({ ...refund, sourceKind: "Provider" })).toThrow(
      CardMachinePaymentError,
    );
  });

  it("projects no Provider status for a card-machine payment", async () => {
    const event = createCardMachinePaymentEnvelope(parseCardMachinePaymentRecord(record()));
    const write = vi.fn();
    const service = createPaymentStatusEventConsumerService({
      scope: { brandReference: refs.brand, storeReference: refs.store },
      authorization: { authorize: async () => true },
      projections: { load: async () => null, write },
      references: { generateGeneration: () => id(50), now: () => recordedAt },
      sha256: () => "f".repeat(64),
      cardMachine: { isCardMachinePayment: async () => true },
    });
    const registration = service.registrations[0];
    const result = await registration?.handler({
      transaction: { query: async () => ({ rows: [], rowCount: 0 }) },
      envelope: event,
    } as never);
    expect(result).toEqual({ status: "completed", resultHash: "f".repeat(64) });
    expect(write).not.toHaveBeenCalled();
  });
});
