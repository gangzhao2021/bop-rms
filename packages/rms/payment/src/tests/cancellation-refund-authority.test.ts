import { beforeEach, expect, it, vi } from "vitest";
import type { ConsumerTransaction } from "@bop/eventing";
import { parseOrdinaryRefundRequest } from "../application/ordinary-refund-request.js";
import {
  cancellationRequestFixture,
  ordinaryRefundRequestFixture,
  must,
  refundRequestId as id,
} from "./ordinary-refund-request.fixture.js";

const state = vi.hoisted(() => ({ request: null as unknown }));
vi.mock("../infrastructure/persistence/ordinary-refund-request-store.js", () => ({
  createPostgresOrdinaryRefundExecutionBalanceSource: () => async () => {
    const request = state.request as ReturnType<typeof parseOrdinaryRefundRequest>;
    return {
      request,
      claimVersion: 1,
      observedAt: "2026-09-13T10:05:00.000Z",
      positions: request.payments.map((payment) => ({
        paymentAttemptReference: payment.paymentAttemptReference,
        requestAmountMinor: request.amountMinor,
      })),
    };
  },
  createPostgresOrdinaryRefundApprovalSubjectSource: () => async () => {
    const request = state.request as ReturnType<typeof parseOrdinaryRefundRequest>;
    return {
      subject: {},
      requesterReference: request.actorReference,
      claimVersion: 1,
      request,
    };
  },
}));
vi.mock("../infrastructure/persistence/ordinary-refund-capture-source.js", () => ({
  createPostgresOrdinaryRefundCaptureSource: () => async () => [],
}));
const { createPostgresOrdinaryRefundOperationExecutionSource } =
  await import("../infrastructure/ordinary-refund-operation-execution-source.js");
const { createPostgresOrdinaryRefundApprovalSource } =
  await import("../infrastructure/ordinary-refund-approval-source.js");

const tx = { query: vi.fn() } as unknown as ConsumerTransaction;
const scope = {
  tenantReference: id(1),
  brandReference: id(2),
  storeReference: id(3),
  providerAccountReference: id(60),
  environment: "Test" as const,
};
function operation(request: ReturnType<typeof parseOrdinaryRefundRequest>, overrides = {}) {
  const leg = must(request.payments[0]);
  return {
    tenantReference: id(1),
    brandReference: id(2),
    storeReference: id(3),
    orderReference: id(4),
    requestReference: request.requestReference,
    operationReference: id(61),
    providerOperationReference: id(61),
    paymentTransactionReference: leg.paymentTransactionReference,
    paymentIntentReference: leg.paymentIntentReference,
    paymentAttemptReference: leg.paymentAttemptReference,
    firstCaptureReference: leg.firstCaptureReference,
    providerAccountReference: id(60),
    executorReference: request.actorReference,
    auditReference: id(62),
    approvalReference: null,
    claimVersion: 1,
    claimsDigest: "sha256:" + "d".repeat(64),
    allocationDigest: "sha256:" + "e".repeat(64),
    preparedAt: "2026-09-13T10:01:00.000Z",
    environment: "Test",
    currencyCode: "CAD",
    amountMinor: request.amountMinor,
    policyVersion: "PILOT_ORDINARY_REFUND_V1",
    status: "Prepared",
    ...overrides,
  };
}
function source(
  cancellationAuthority?: (tx: ConsumerTransaction, query: unknown) => Promise<boolean>,
) {
  const executor = vi.fn(async (_tx: ConsumerTransaction, query: Record<string, unknown>) => ({
    ...query,
    permissionCode: "payment.refund.execute",
    active: true,
    allowed: true,
  }));
  const run = createPostgresOrdinaryRefundOperationExecutionSource({
    scope,
    authorize: async () => true,
    validatePricing: async () => true,
    executor,
    ...(cancellationAuthority ? { cancellationAuthority } : {}),
  });
  return { run, executor };
}
const at = "2026-09-13T10:02:00.000Z";
beforeEach(() => {
  state.request = parseOrdinaryRefundRequest(cancellationRequestFixture());
});

it("fails closed for a Cancellation claim without the cancellation authority port", async () => {
  const request = parseOrdinaryRefundRequest(cancellationRequestFixture());
  const { run, executor } = source();
  await expect(run(tx, operation(request), at)).rejects.toThrow(
    "ORDINARY_REFUND_CANCELLATION_AUTHORITY_DENIED",
  );
  expect(executor).not.toHaveBeenCalled();
});

it("fails closed when the cancellation record does not bind the request", async () => {
  const request = parseOrdinaryRefundRequest(cancellationRequestFixture());
  const { run } = source(async () => false);
  await expect(run(tx, operation(request), at)).rejects.toThrow(
    "ORDINARY_REFUND_CANCELLATION_AUTHORITY_DENIED",
  );
});

it("substitutes the cancellation record for the executor role and passes exact bindings", async () => {
  const request = parseOrdinaryRefundRequest(cancellationRequestFixture());
  const port = vi.fn(async () => true);
  const { run, executor } = source(port);
  await expect(run(tx, operation(request), at)).resolves.toMatchObject({ claimVersion: 1 });
  expect(executor).not.toHaveBeenCalled();
  expect(port).toHaveBeenCalledWith(tx, {
    tenantReference: id(1),
    brandReference: id(2),
    storeReference: id(3),
    orderReference: id(4),
    requestReference: request.requestReference,
    cancellationReference: id(40),
    cancellationDigest: "sha256:" + "c".repeat(64),
    actorReference: request.actorReference,
    amountMinor: 5500n,
    observedAt: "2026-09-13T10:05:00.000Z",
  });
});

it.each([
  ["another executor", { executorReference: id(70) }],
  ["an approval", { approvalReference: id(71) }],
])("refuses a Cancellation operation with %s", async (_name, overrides) => {
  const request = parseOrdinaryRefundRequest(cancellationRequestFixture());
  const port = vi.fn(async () => true);
  const { run } = source(port);
  await expect(run(tx, operation(request, overrides), at)).rejects.toThrow();
  expect(port).not.toHaveBeenCalled();
});

it("keeps the ordinary executor check unchanged and ignores the cancellation port", async () => {
  const request = parseOrdinaryRefundRequest(ordinaryRefundRequestFixture());
  state.request = request;
  const port = vi.fn(async () => true);
  const { run, executor } = source(port);
  await expect(run(tx, operation(request), at)).resolves.toMatchObject({ claimVersion: 1 });
  expect(executor).toHaveBeenCalledOnce();
  expect(port).not.toHaveBeenCalled();
  const denied = createPostgresOrdinaryRefundOperationExecutionSource({
    scope,
    authorize: async () => true,
    validatePricing: async () => true,
    executor: async () => ({ permissionCode: "payment.refund.execute" }),
    cancellationAuthority: port,
  });
  await expect(denied(tx, operation(request), at)).rejects.toThrow();
});

it("refuses independent approval of a Cancellation subject", async () => {
  const authority = vi.fn(async () => ({}));
  const approve = createPostgresOrdinaryRefundApprovalSource({
    scope: { tenantReference: id(1), brandReference: id(2), storeReference: id(3) },
    authorize: async () => true,
    authority,
  });
  await expect(
    approve(tx, {
      orderReference: id(4),
      requestReference: id(5),
      approvalReference: id(80),
      approverReference: id(81),
      observedAt: at,
    }),
  ).rejects.toThrow("ORDINARY_REFUND_APPROVAL_DENIED");
  expect(authority).not.toHaveBeenCalled();
});
