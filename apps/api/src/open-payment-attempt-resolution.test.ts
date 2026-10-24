import { expect, it, vi } from "vitest";
import {
  createPaymentIntentCreationService,
  createPaymentProviderFailure,
  createPaymentProviderSnapshot,
  parsePaymentIntentCreationRecord,
} from "@rms/payment";
import {
  harness,
  command,
  refs,
  id,
} from "../../../packages/rms/payment/src/tests/payment-intent-creation.fixture.js";
import {
  createOpenPaymentAttemptResolution,
  isPaymentUnconfirmed,
} from "./open-payment-attempt-resolution.js";

async function record() {
  return (await createPaymentIntentCreationService(harness().ports).create(command())).record;
}
function snapshotOf(
  base: Awaited<ReturnType<typeof record>>,
  status: "RequiresCustomerAction" | "Cancelled" | "Captured" | "Failed" | "Pending",
) {
  const created = base.providerOutcome;
  if (created?.kind !== "Snapshot") throw new Error("fixture invalid");
  const captured = status === "Captured" ? created.requestedAmount : { ...created.capturedAmount };
  return createPaymentProviderSnapshot({
    ...created,
    status,
    providerTransactionReference:
      status === "Captured"
        ? ("ch_SyntheticCapture01" as never)
        : created.providerTransactionReference,
    authorizedAmount: captured,
    capturedAmount: captured,
  });
}
async function fixture(
  retrieved: "RequiresCustomerAction" | "Cancelled" | "Captured" | "Failed" | "Pending",
  state: Partial<{ terminal: unknown; cardMachine: boolean; record: unknown }> = {},
) {
  const base = await record();
  const provider = {
    retrieveIntent: vi.fn(async () => snapshotOf(base, retrieved)),
    cancelIntent: vi.fn(async () => snapshotOf(base, "Cancelled")),
  };
  const recordTerminal = vi.fn(async () => undefined);
  let n = 100;
  const resolution = createOpenPaymentAttemptResolution({
    load: async () => ({ record: base, terminal: null, cardMachine: false, ...state }) as never,
    provider: provider as never,
    recordTerminal,
    newReference: () => id(n++),
  });
  return { base, provider, recordTerminal, resolution };
}

it("WP-2423: cancels an attempt the guest never confirmed, then records it as not completed", async () => {
  const f = await fixture("RequiresCustomerAction");
  expect(await f.resolution.resolve(refs.operation)).toEqual({
    status: "Failed",
    notCompleted: true,
  });
  expect(f.provider.cancelIntent).toHaveBeenCalledTimes(1);
  const [cancel] = f.provider.cancelIntent.mock.calls[0] as unknown as [{ idempotencyKey: string }];
  expect(cancel.idempotencyKey).toBe(
    "cancel-abandoned:" + String(f.base.attempt.paymentAttemptReference),
  );
  expect(f.recordTerminal).toHaveBeenCalledWith(
    expect.objectContaining({ status: "Failed", failureReason: "Cancelled" }),
  );
});

it("WP-2423: a payment that succeeded meanwhile is recorded as paid and never cancelled", async () => {
  const f = await fixture("Captured");
  expect(await f.resolution.resolve(refs.operation)).toEqual({ status: "Paid" });
  expect(f.provider.cancelIntent).not.toHaveBeenCalled();
  expect(f.recordTerminal).toHaveBeenCalledWith(
    expect.objectContaining({ status: "Captured", failureReason: null }),
  );
});

it("WP-2423: keeps waiting while processing, and records nothing when the Provider can't answer", async () => {
  const pending = await fixture("Pending");
  expect(await pending.resolution.resolve(refs.operation)).toEqual({ status: "Processing" });
  expect(pending.recordTerminal).not.toHaveBeenCalled();
  expect(pending.provider.cancelIntent).not.toHaveBeenCalled();
  const down = await fixture("Pending");
  down.provider.retrieveIntent.mockRejectedValueOnce(new Error("offline"));
  expect(await down.resolution.resolve(refs.operation)).toEqual({ status: "Unavailable" });
  expect(down.recordTerminal).not.toHaveBeenCalled();
});

it("WP-2423: answers from recorded facts without contacting the Provider", async () => {
  const declined = await fixture("Pending", {
    terminal: { outcome: "Failed", failureReason: "Declined" },
  });
  expect(await declined.resolution.resolve(refs.operation)).toEqual({
    status: "Failed",
    notCompleted: false,
  });
  const card = await fixture("Pending", { cardMachine: true });
  expect(await card.resolution.resolve(refs.operation)).toEqual({ status: "Paid" });
  const none = await fixture("Pending", { record: null });
  expect(await none.resolution.resolve(refs.operation)).toEqual({ status: "NoPayment" });
  for (const f of [declined, card, none]) expect(f.provider.retrieveIntent).not.toHaveBeenCalled();
});

it("WP-2423: a guest who confirms while the attempt is being cancelled is never recorded as cancelled", async () => {
  // Stripe refuses to cancel an intent that is processing or succeeded: nothing is recorded and
  // the next pass, with the same per-attempt cancel key, finds the payment captured.
  const f = await fixture("RequiresCustomerAction");
  f.provider.cancelIntent.mockResolvedValueOnce({ kind: "Failure" } as never);
  expect(await f.resolution.resolve(refs.operation)).toEqual({ status: "Unavailable" });
  expect(f.recordTerminal).not.toHaveBeenCalled();
  f.provider.cancelIntent.mockRejectedValueOnce(new Error("offline"));
  expect(await f.resolution.resolve(refs.operation)).toEqual({ status: "Unavailable" });
  expect(f.recordTerminal).not.toHaveBeenCalled();
  const keys = f.provider.cancelIntent.mock.calls.map(
    (call) => (call as unknown as [{ idempotencyKey: string }])[0].idempotencyKey,
  );
  expect(new Set(keys)).toEqual(
    new Set(["cancel-abandoned:" + String(f.base.attempt.paymentAttemptReference)]),
  );
  f.provider.retrieveIntent.mockResolvedValueOnce(snapshotOf(f.base, "Captured"));
  expect(await f.resolution.resolve(refs.operation)).toEqual({ status: "Paid" });
  expect(f.provider.cancelIntent).toHaveBeenCalledTimes(2);
  expect(f.recordTerminal).toHaveBeenCalledTimes(1);
  expect(f.recordTerminal).toHaveBeenCalledWith(
    expect.objectContaining({ status: "Captured", failureReason: null }),
  );
});

it("WP-2423: records what the Provider answered to the cancel, never an assumed cancellation", async () => {
  const f = await fixture("RequiresCustomerAction");
  f.provider.cancelIntent.mockResolvedValueOnce(snapshotOf(f.base, "Captured"));
  expect(await f.resolution.resolve(refs.operation)).toEqual({ status: "Paid" });
  expect(f.recordTerminal).toHaveBeenCalledWith(
    expect.objectContaining({ status: "Captured", failureReason: null }),
  );
});

async function unknownCreate(outcome: "Failure" | "None") {
  const base = await record();
  const created = base.providerOutcome;
  if (created?.kind !== "Snapshot") throw new Error("fixture invalid");
  const unknown = parsePaymentIntentCreationRecord({
    ...base,
    providerOutcome:
      outcome === "None"
        ? null
        : createPaymentProviderFailure({
            kind: "Failure",
            context: created.context,
            code: "Unknown",
            retryDisposition: "Unknown",
            safeReasonCode: "CREATE_RESULT_UNKNOWN" as never,
          }),
  });
  return { base, unknown };
}

it("WP-2423: asks the Provider again about an attempt whose create answer is unknown, then cancels it", async () => {
  for (const outcome of ["Failure", "None"] as const) {
    const { base, unknown } = await unknownCreate(outcome);
    const provider = {
      createIntent: vi.fn(async () => snapshotOf(base, "RequiresCustomerAction")),
      retrieveIntent: vi.fn(async () => snapshotOf(base, "RequiresCustomerAction")),
      cancelIntent: vi.fn(async () => snapshotOf(base, "Cancelled")),
    };
    const recordTerminal = vi.fn(async () => undefined);
    const createIdempotencyKey = vi.fn(
      () => "create-intent:" + String(base.attempt.paymentAttemptReference),
    );
    let n = 300;
    const resolution = createOpenPaymentAttemptResolution({
      load: async () => ({ record: unknown, terminal: null, cardMachine: false }),
      provider: provider as never,
      recordTerminal,
      createIdempotencyKey,
      newReference: () => id(n++),
    });
    expect(await resolution.resolve(refs.operation)).toEqual({
      status: "Failed",
      notCompleted: true,
    });
    // The same create again: same key, same amount, the original operation as context.
    expect(provider.createIntent).toHaveBeenCalledTimes(1);
    const [create] = provider.createIntent.mock.calls[0] as unknown as [
      {
        idempotencyKey: string;
        amount: { amountMinor: bigint };
        context: { operationReference: string; paymentAttemptReference: string };
      },
    ];
    expect(create.idempotencyKey).toBe(
      "create-intent:" + String(base.attempt.paymentAttemptReference),
    );
    expect(create.amount.amountMinor).toBe(base.intent.preparation.total.amountMinor);
    expect(create.context.operationReference).toBe(String(base.intent.paymentOperationReference));
    expect(create.context.paymentAttemptReference).toBe(
      String(base.attempt.paymentAttemptReference),
    );
    expect(provider.retrieveIntent).not.toHaveBeenCalled();
    expect(provider.cancelIntent).toHaveBeenCalledTimes(1);
    expect(recordTerminal).toHaveBeenCalledWith(
      expect.objectContaining({ status: "Failed", failureReason: "Cancelled" }),
    );
  }
});

it("WP-2423: keeps waiting, recording nothing, when an unknown create can't be asked about", async () => {
  const { base, unknown } = await unknownCreate("Failure");
  const provider = {
    createIntent: vi.fn(async () => snapshotOf(base, "RequiresCustomerAction")),
    retrieveIntent: vi.fn(),
    cancelIntent: vi.fn(),
  };
  const recordTerminal = vi.fn(async () => undefined);
  let n = 400;
  const options = {
    load: async () => ({ record: unknown, terminal: null, cardMachine: false }),
    provider: provider as never,
    recordTerminal,
    newReference: () => id(n++),
  };
  // No re-derivable key (an attempt created before keys were derived from the attempt).
  expect(await createOpenPaymentAttemptResolution(options).resolve(refs.operation)).toEqual({
    status: "Processing",
  });
  expect(
    await createOpenPaymentAttemptResolution({
      ...options,
      createIdempotencyKey: () => null,
    }).resolve(refs.operation),
  ).toEqual({ status: "Processing" });
  expect(provider.createIntent).not.toHaveBeenCalled();
  // The Provider can't answer, or answers for another attempt or amount.
  const keyed = createOpenPaymentAttemptResolution({
    ...options,
    createIdempotencyKey: () => "create-intent:" + String(base.attempt.paymentAttemptReference),
  });
  provider.createIntent.mockRejectedValueOnce(new Error("offline"));
  expect(await keyed.resolve(refs.operation)).toEqual({ status: "Unavailable" });
  provider.createIntent.mockResolvedValueOnce({ kind: "Failure" } as never);
  expect(await keyed.resolve(refs.operation)).toEqual({ status: "Unavailable" });
  const other = snapshotOf(base, "RequiresCustomerAction");
  provider.createIntent.mockResolvedValueOnce(
    createPaymentProviderSnapshot({
      ...other,
      requestedAmount: {
        ...other.requestedAmount,
        amountMinor: other.requestedAmount.amountMinor + 1n,
      },
    }),
  );
  expect(await keyed.resolve(refs.operation)).toEqual({ status: "Unavailable" });
  expect(provider.cancelIntent).not.toHaveBeenCalled();
  expect(recordTerminal).not.toHaveBeenCalled();
});

it("WP-2423: tells when an unresolved payment is handed to staff", () => {
  expect(isPaymentUnconfirmed("2026-10-18T12:00:00.000Z", "2026-10-18T12:04:59.999Z")).toBe(false);
  expect(isPaymentUnconfirmed("2026-10-18T12:00:00.000Z", "2026-10-18T12:05:00.000Z")).toBe(true);
  expect(isPaymentUnconfirmed("not a time", "2026-10-18T12:05:00.000Z")).toBe(false);
});
