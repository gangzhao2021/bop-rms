import { describe, expect, it } from "vitest";

import {
  createCancelIntentRequest,
  createCaptureIntentRequest,
  createCreateIntentRequest,
  createPaymentProviderFailure,
  createPaymentProviderSnapshot,
  createRefundPaymentRequest,
  createRetrieveIntentRequest,
  PaymentProviderContractError,
  type PaymentProviderContext,
  type PaymentProviderSnapshot,
} from "../index.js";

const references = {
  brand: "0198a001-0000-7000-8000-000000000001",
  store: "0198a001-0000-7000-8000-000000000002",
  attempt: "0198a001-0000-7000-8000-000000000003",
  operation: "0198a001-0000-7000-8000-000000000004",
} as const;

function context(): PaymentProviderContext {
  return {
    provider: "Stripe",
    environment: "Test",
    brandReference: references.brand as never,
    storeReference: references.store as never,
    paymentAttemptReference: references.attempt as never,
    operationReference: references.operation as never,
  };
}

function money(amountMinor: bigint) {
  return { amountMinor, currencyCode: "CAD" as never };
}

function snapshot(overrides: Partial<PaymentProviderSnapshot> = {}): PaymentProviderSnapshot {
  return {
    kind: "Snapshot",
    context: context(),
    providerIntentReference: "pi_SYNTHETIC_000001" as never,
    providerTransactionReference: "ch_SYNTHETIC_000001" as never,
    paymentMethod: "TerminalCard",
    captureMode: "ManualPreferred",
    status: "Captured",
    requestedAmount: money(1_000n),
    authorizedAmount: money(1_000n),
    capturedAmount: money(1_000n),
    refundedAmount: money(0n),
    observedAt: "2026-08-03T12:00:00.000Z",
    evidenceDigest: `sha256:${"a".repeat(64)}` as never,
    ...overrides,
  };
}

function expectCode(action: () => unknown, code: PaymentProviderContractError["code"]): void {
  try {
    action();
    throw new Error("expected payment provider contract error");
  } catch (error) {
    expect(error).toBeInstanceOf(PaymentProviderContractError);
    expect((error as PaymentProviderContractError).code).toBe(code);
  }
}

describe("Payment Provider adapter request contract", () => {
  it.each([
    ["OnlineCard", "Automatic"],
    ["TerminalCard", "ManualPreferred"],
    ["TerminalInterac", "ManualPreferred"],
  ] as const)("accepts the closed create policy for %s", (paymentMethod, captureMode) => {
    const request = createCreateIntentRequest({
      operation: "CreateIntent",
      purpose: "CreatePaymentIntent",
      context: context(),
      idempotencyKey: "BOP:PAYMENT:CREATE:0001" as never,
      paymentMethod,
      captureMode,
      amount: money(1_250n),
    });
    expect(request.paymentMethod).toBe(paymentMethod);
    expect(Object.isFrozen(request)).toBe(true);
    expect(Object.isFrozen(request.context)).toBe(true);
    expect(Object.isFrozen(request.amount)).toBe(true);
  });

  it("rejects invalid capture policy and Interac capture before the adapter boundary", () => {
    expectCode(
      () =>
        createCreateIntentRequest({
          operation: "CreateIntent",
          purpose: "CreatePaymentIntent",
          context: context(),
          idempotencyKey: "BOP:PAYMENT:CREATE:0001" as never,
          paymentMethod: "OnlineCard",
          captureMode: "ManualPreferred",
          amount: money(1_250n),
        }),
      "PAYMENT_PROVIDER_POLICY_VIOLATION",
    );
    expectCode(
      () =>
        createCaptureIntentRequest({
          operation: "CaptureIntent",
          purpose: "CapturePaymentIntent",
          context: context(),
          idempotencyKey: "BOP:PAYMENT:CAPTURE:0001" as never,
          providerIntentReference: "pi_SYNTHETIC_000001" as never,
          paymentMethod: "TerminalInterac" as never,
          amount: money(1_250n),
        }),
      "PAYMENT_PROVIDER_POLICY_VIOLATION",
    );
  });

  it("constructs retrieve, cancel, capture, and method-bounded refund operations", () => {
    expect(
      createRetrieveIntentRequest({
        operation: "RetrieveIntent",
        purpose: "RetrievePaymentIntent",
        context: context(),
        providerIntentReference: "pi_SYNTHETIC_000001" as never,
      }).operation,
    ).toBe("RetrieveIntent");
    expect(
      createCancelIntentRequest({
        operation: "CancelIntent",
        purpose: "CancelPaymentIntent",
        context: context(),
        idempotencyKey: "BOP:PAYMENT:CANCEL:0001" as never,
        providerIntentReference: "pi_SYNTHETIC_000001" as never,
      }).operation,
    ).toBe("CancelIntent");
    expect(
      createCaptureIntentRequest({
        operation: "CaptureIntent",
        purpose: "CapturePaymentIntent",
        context: context(),
        idempotencyKey: "BOP:PAYMENT:CAPTURE:0001" as never,
        providerIntentReference: "pi_SYNTHETIC_000001" as never,
        paymentMethod: "TerminalCard",
        amount: money(1_000n),
      }).paymentMethod,
    ).toBe("TerminalCard");
    expect(
      createRefundPaymentRequest({
        operation: "RefundPayment",
        purpose: "RefundPayment",
        context: context(),
        idempotencyKey: "BOP:PAYMENT:REFUND:0001" as never,
        providerIntentReference: "pi_SYNTHETIC_000001" as never,
        originalPaymentMethod: "TerminalInterac",
        amount: money(500n),
      }).originalPaymentMethod,
    ).toBe("TerminalInterac");
  });

  it("rejects non-CAD, floating-point, malformed scope, and extra fields", () => {
    const valid = {
      operation: "CreateIntent",
      purpose: "CreatePaymentIntent",
      context: context(),
      idempotencyKey: "BOP:PAYMENT:CREATE:0001",
      paymentMethod: "OnlineCard",
      captureMode: "Automatic",
      amount: money(1_000n),
    } as const;
    expectCode(
      () => createCreateIntentRequest({ ...valid, amount: money(1.25 as never) } as never),
      "PAYMENT_PROVIDER_INPUT_INVALID",
    );
    expectCode(
      () =>
        createCreateIntentRequest({
          ...valid,
          amount: { amountMinor: 1_000n, currencyCode: "USD" },
        } as never),
      "PAYMENT_PROVIDER_INPUT_INVALID",
    );
    expectCode(
      () => createCreateIntentRequest({ ...valid, rawProviderPayload: "forbidden" } as never),
      "PAYMENT_PROVIDER_INPUT_INVALID",
    );
    expectCode(
      () =>
        createCreateIntentRequest({
          ...valid,
          context: { ...context(), storeReference: "store_live_secret" },
        } as never),
      "PAYMENT_PROVIDER_INPUT_INVALID",
    );
  });

  it("rejects accessors and custom prototypes without evaluating them", () => {
    let evaluated = false;
    const accessor = {
      operation: "CreateIntent",
      purpose: "CreatePaymentIntent",
      context: context(),
      idempotencyKey: "BOP:PAYMENT:CREATE:0001",
      paymentMethod: "OnlineCard",
      captureMode: "Automatic",
      amount: money(1_000n),
      get rawProviderPayload() {
        evaluated = true;
        return "secret";
      },
    };
    expectCode(
      () => createCreateIntentRequest(accessor as never),
      "PAYMENT_PROVIDER_INPUT_INVALID",
    );
    expect(evaluated).toBe(false);
    expectCode(
      () => createCreateIntentRequest(Object.create({ inherited: true }) as never),
      "PAYMENT_PROVIDER_INPUT_INVALID",
    );
  });
});

describe("Payment Provider normalized outcome contract", () => {
  it("returns a deeply immutable normalized captured snapshot", () => {
    const result = createPaymentProviderSnapshot(snapshot());
    expect(result.status).toBe("Captured");
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.context)).toBe(true);
    expect(Object.isFrozen(result.requestedAmount)).toBe(true);
  });

  it("accepts manual Terminal Card authorization but rejects Interac authorization", () => {
    expect(
      createPaymentProviderSnapshot(
        snapshot({
          status: "Authorized",
          providerTransactionReference: null,
          capturedAmount: money(0n),
        }),
      ).status,
    ).toBe("Authorized");
    expectCode(
      () =>
        createPaymentProviderSnapshot(
          snapshot({
            paymentMethod: "TerminalInterac",
            status: "Authorized",
            providerTransactionReference: null,
            capturedAmount: money(0n),
          }),
        ),
      "PAYMENT_PROVIDER_STATE_INVALID",
    );
  });

  it("rejects impossible amount/status combinations", () => {
    expectCode(
      () => createPaymentProviderSnapshot(snapshot({ capturedAmount: money(1_001n) })),
      "PAYMENT_PROVIDER_STATE_INVALID",
    );
    expectCode(
      () =>
        createPaymentProviderSnapshot(
          snapshot({
            status: "Failed",
            authorizedAmount: money(1_000n),
            capturedAmount: money(0n),
          }),
        ),
      "PAYMENT_PROVIDER_STATE_INVALID",
    );
    expectCode(
      () => createPaymentProviderSnapshot(snapshot({ refundedAmount: money(1_001n) })),
      "PAYMENT_PROVIDER_STATE_INVALID",
    );
    expectCode(
      () => createPaymentProviderSnapshot(snapshot({ providerTransactionReference: null })),
      "PAYMENT_PROVIDER_STATE_INVALID",
    );
    expectCode(
      () => createPaymentProviderSnapshot(snapshot({ observedAt: "2026-02-31T12:00:00.000Z" })),
      "PAYMENT_PROVIDER_INPUT_INVALID",
    );
  });

  it("normalizes safe failures and rejects Provider messages or metadata", () => {
    const failure = createPaymentProviderFailure({
      kind: "Failure",
      context: context(),
      code: "Unavailable",
      retryDisposition: "SameOperation",
      safeReasonCode: "PROVIDER_TIMEOUT" as never,
    });
    expect(failure.safeReasonCode).toBe("PROVIDER_TIMEOUT");
    expect(Object.isFrozen(failure)).toBe(true);
    expectCode(
      () =>
        createPaymentProviderFailure({
          ...failure,
          providerMessage: "raw response",
        } as never),
      "PAYMENT_PROVIDER_INPUT_INVALID",
    );
  });
});
