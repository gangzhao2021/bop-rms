import { describe, expect, it } from "vitest";
import { parseOrderPaymentPreparationEvidence } from "@rms/ordering";

import {
  cardMachinePaymentTakenMinor,
  cardMachineRefundGivenBackMinor,
  parseCardMachinePaymentRecord,
  planCounterCashTender,
} from "../index.js";
import { digest, id, preparation, refs } from "./payment-intent-creation.fixture.js";

const recordedAt = "2026-08-03T15:05:00.000Z";
// A counter order of $20.47 (tax included) and a $2.00 tip: $22.47, $22.45 in cash.
const prepared = parseOrderPaymentPreparationEvidence(
  preparation({
    orderAllocation: { amountMinor: 2_047n, currencyCode: "CAD" },
    tip: { amountMinor: 200n, currencyCode: "CAD" },
    total: { amountMinor: 2_247n, currencyCode: "CAD" },
  }),
);
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
    preparation: prepared,
    environment: "Test",
    slipReference: null,
    recordingReason: "AtCounter",
    takenAt: recordedAt,
    recordedAt,
    actorReference: id(35),
    eventReference: id(36),
    auditReference: id(37),
    ...overrides,
  };
}
const code = (value: string) => expect.objectContaining({ code: value }) as unknown as Error;

describe("counter cash payment (WP-2423 M52, the table's cash rules)", () => {
  it("rounds the cash total to 5 cents and gives the change for what was handed over", () => {
    expect(planCounterCashTender(prepared, 3_000n)).toEqual({
      roundingMinor: -2n,
      tenderedMinor: 3_000n,
      changeMinor: 755n,
    });
    // Exactly the cash total: no change.
    expect(planCounterCashTender(prepared, 2_245n).changeMinor).toBe(0n);
    // Less than the cash total is refused (never recorded short).
    expect(() => planCounterCashTender(prepared, 2_244n)).toThrowError(
      code("CARD_MACHINE_CASH_TENDER_SHORT"),
    );
    const up = parseOrderPaymentPreparationEvidence(
      preparation({
        orderAllocation: { amountMinor: 2_043n, currencyCode: "CAD" },
        total: { amountMinor: 2_243n, currencyCode: "CAD" },
      }),
    );
    expect(planCounterCashTender(up, 2_245n)).toEqual({
      roundingMinor: 2n,
      tenderedMinor: 2_245n,
      changeMinor: 0n,
    });
  });

  it("keeps the order's amount and records the rounding on its own", () => {
    const cash = planCounterCashTender(prepared, 3_000n);
    const saved = parseCardMachinePaymentRecord(record({ cash }));
    expect(saved.cash).toEqual(cash);
    expect(saved.preparation.total.amountMinor).toBe(2_247n);
    expect(cardMachinePaymentTakenMinor(saved)).toBe(2_245n);
    // A card-machine record is unchanged (no cash key).
    const card = parseCardMachinePaymentRecord(record({ slipReference: "AUTH 1" }));
    expect("cash" in card).toBe(false);
    expect(cardMachinePaymentTakenMinor(card)).toBe(2_247n);
  });

  it("refuses a cash record whose rounding, change or slip does not hold", () => {
    const invalid = (cash: unknown, overrides: Record<string, unknown> = {}) =>
      expect(() => parseCardMachinePaymentRecord(record({ cash, ...overrides }))).toThrowError(
        code("CARD_MACHINE_INPUT_INVALID"),
      );
    invalid({ roundingMinor: 0n, tenderedMinor: 3_000n, changeMinor: 753n });
    invalid({ roundingMinor: -2n, tenderedMinor: 3_000n, changeMinor: 750n });
    invalid({ roundingMinor: -2n, tenderedMinor: 2_000n, changeMinor: -245n });
    invalid(
      { roundingMinor: -2n, tenderedMinor: 3_000n, changeMinor: 755n },
      { slipReference: "AUTH 1" },
    );
  });

  it("gives cash back in whole nickels, never more than the drawer still holds (M131)", () => {
    const saved = parseCardMachinePaymentRecord(
      record({ cash: planCounterCashTender(prepared, 3_000n) }),
    );
    // $4.37 of dishes goes back as $4.35, $4.38 as $4.40.
    expect(cardMachineRefundGivenBackMinor(saved, 437n, 0n)).toBe(435n);
    expect(cardMachineRefundGivenBackMinor(saved, 438n, 0n)).toBe(440n);
    // The rest of the order after $4.35 went back: what the drawer still holds.
    expect(cardMachineRefundGivenBackMinor(saved, 2_247n - 437n, 435n)).toBe(1_810n);
    expect(cardMachineRefundGivenBackMinor(saved, 100n, 2_245n)).toBe(0n);
    // On the card machine the amount is the request's own, to the cent.
    const card = parseCardMachinePaymentRecord(record({ slipReference: "AUTH 1" }));
    expect(cardMachineRefundGivenBackMinor(card, 437n, 0n)).toBe(437n);
  });
});
