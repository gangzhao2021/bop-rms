import { describe, expect, it } from "vitest";

import {
  createPaymentIntentCreationService,
  PaymentIntentCreationError,
  type PaymentIntentCreationRecord,
} from "../index.js";
import { command, harness, id, refs } from "./payment-intent-creation.fixture.js";

const later = "2026-08-03T15:10:00.000Z";
const resumeCommand = {
  paymentOperationReference: refs.operation,
  submissionReference: refs.submission,
  requestedAt: later,
};

/** WP-2423 abandoned payment: the guest who started paying comes back to the same payment. */
async function firstAttempt(): Promise<PaymentIntentCreationRecord> {
  return (await createPaymentIntentCreationService(harness().ports).create(command())).record;
}
const code = (promise: Promise<unknown>) =>
  promise.then(
    () => null,
    (error: unknown) => (error instanceof PaymentIntentCreationError ? error.code : error),
  );

describe("Payment resume of an open attempt", () => {
  it("returns the stored attempt without a new attempt, Provider call or order preparation", async () => {
    const prior = await firstAttempt();
    const test = harness({ prior, clockNow: later });
    const result = await createPaymentIntentCreationService(test.ports).resume(resumeCommand);
    expect(result.status).toBe("AlreadyCreated");
    expect(result.record).toEqual(prior);
    expect(test.providerCalls()).toBe(0);
    expect(test.calls).not.toContain("prepare-order");
    expect(test.calls).not.toContain("claim");
  });

  it("refuses after the payment window, without access, for another submission or no payment", async () => {
    const prior = await firstAttempt();
    const run = (options: Parameters<typeof harness>[0], value: object = resumeCommand) =>
      code(createPaymentIntentCreationService(harness(options).ports).resume(value));
    expect(await run({ prior, clockNow: "2026-08-03T15:30:00.000Z" })).toBe(
      "PAYMENT_INTENT_PREPARATION_EXPIRED",
    );
    expect(await run({ prior, clockNow: later, denied: true })).toBe(
      "PAYMENT_INTENT_PERMISSION_DENIED",
    );
    expect(
      await run({ prior, clockNow: later }, { ...resumeCommand, submissionReference: id(77) }),
    ).toBe("PAYMENT_INTENT_IDEMPOTENCY_CONFLICT");
    expect(await run({ clockNow: later })).toBe("PAYMENT_INTENT_ORDER_NOT_READY");
    expect(await run({ prior, clockNow: later }, { ...resumeCommand, tip: "100" })).toBe(
      "PAYMENT_INTENT_INPUT_INVALID",
    );
  });
});
