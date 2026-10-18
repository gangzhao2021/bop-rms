import { beforeEach, expect, it, vi } from "vitest";
import {
  createMerchantUnmatchedCaptureRefund,
  unmatchedCaptureRefundPermissions,
} from "./merchant-unmatched-capture-refund.js";
const doubles = vi.hoisted(() => ({
  options: [] as unknown[],
  scope: vi.fn(),
  store: {
    read: vi.fn(),
    request: vi.fn(),
    approve: vi.fn(),
    recordOutcome: vi.fn(),
    providerRequest: vi.fn(),
  },
}));
vi.mock("./merchant-store-scope.js", () => ({ createMerchantStoreScope: () => doubles.scope }));
vi.mock("@rms/payment", async (original) => ({
  ...(await original<object>()),
  createPostgresUnmatchedCaptureRefundStore: (options: unknown) => {
    doubles.options.push(options);
    return doubles.store;
  },
}));
const id = (n: number) => "01909985-0000-7000-8000-" + n.toString(16).padStart(12, "0");
const now = "2026-10-09T05:00:00.000Z";
type Options = Parameters<typeof createMerchantUnmatchedCaptureRefund>[0];
const state = (status: string, requester = id(30)) => ({
  reconciliationExceptionReference: id(7),
  status,
  amountMinor: "2260",
  currencyCode: "CAD",
  capturedAt: "2026-09-20T03:35:37.236Z",
  request:
    status === "Unrefunded" ? null : { requestedByActorReference: requester, requestedAt: now },
  approval:
    status === "Approved" || status === "Refunded"
      ? { approvedAt: now, operationReference: id(40) }
      : null,
  outcome: status === "Refunded" ? { recordedAt: now } : null,
});
const providerRequest = {
  idempotencyKey: "unmatched-capture-refund:" + id(40),
  context: { operationReference: id(40) },
};
function setup() {
  const authorize = vi.fn(async () => ({ sessionReference: id(1) })),
    allowed = vi.fn(async () => true),
    refundPayment = vi.fn();
  const run = vi.fn(async (work: (tx: object) => Promise<unknown>) => work({ query: vi.fn() }));
  doubles.scope.mockResolvedValue({
    actorReference: id(2),
    context: { brand: { brandReference: id(3) } },
    store: { storeReference: id(4) },
    allowed,
  });
  doubles.store.providerRequest.mockReturnValue(providerRequest);
  let next = 100;
  const command = createMerchantUnmatchedCaptureRefund({
    persistence: { transactions: { run }, now: () => now } as unknown as Options["persistence"],
    authentication: { authorize } as unknown as Options["authentication"],
    nextReference: () => id(next++),
    refundPayment,
  });
  const input = {
    sessionCookie: "synthetic-cookie",
    csrf: "synthetic-csrf",
    command: { exceptionReference: id(7), idempotencyReference: id(11) },
  };
  return { command, input, allowed, refundPayment, run };
}
const observation = {
  kind: "RefundObservation",
  context: { operationReference: id(40) },
  providerRefundReference: "re_DEMO0123456789",
  providerIntentReference: "pi_DEMO0123456789",
  amount: { amountMinor: 2260n, currencyCode: "CAD" },
  status: "succeeded",
  observedAt: now,
  evidenceDigest: "sha256:" + "a".repeat(64),
};
beforeEach(() => {
  vi.resetAllMocks();
  doubles.options.length = 0;
});

it("WP-2423 P6: a manager requests with refund-request authority and server time", async () => {
  const f = setup();
  doubles.store.request.mockResolvedValue(state("Requested", id(2)));
  expect(await f.command.request(f.input)).toMatchObject({
    status: "Requested",
    amountMinor: "2260",
    requestedByYou: true,
  });
  expect(doubles.scope.mock.calls[0]?.[2]).toBe("payment.refund.request");
  expect(doubles.store.request.mock.calls[0]?.[1]).toMatchObject({
    exceptionReference: id(7),
    actorReference: id(2),
    idempotencyReference: id(11),
    requestedAt: now,
  });
  expect(f.refundPayment).not.toHaveBeenCalled();
});

it("WP-2423 P6: approval sends the fixed Provider request and records the confirmed refund", async () => {
  const f = setup();
  doubles.store.read.mockResolvedValue(state("Requested"));
  doubles.store.approve.mockResolvedValue(state("Approved"));
  doubles.store.recordOutcome.mockResolvedValue(state("Refunded"));
  f.refundPayment.mockResolvedValue(observation);
  expect(await f.command.approve(f.input)).toMatchObject({ status: "Refunded", refundedAt: now });
  expect(doubles.scope.mock.calls.map((call) => call[2])).toEqual([
    unmatchedCaptureRefundPermissions.approve,
    unmatchedCaptureRefundPermissions.approve,
  ]);
  expect(f.refundPayment).toHaveBeenCalledWith(providerRequest);
  expect(doubles.store.recordOutcome.mock.calls[0]?.[1].observation).toMatchObject({
    amountMinor: 2260n,
    idempotencyKey: "unmatched-capture-refund:" + id(40),
  });
});

it("WP-2423 P6: an unknown Provider result keeps the approval and approving again resends it", async () => {
  const f = setup();
  doubles.store.read.mockResolvedValue(state("Requested"));
  doubles.store.approve.mockResolvedValue(state("Approved"));
  f.refundPayment.mockRejectedValueOnce(new Error("timeout"));
  expect(await f.command.approve(f.input)).toMatchObject({
    status: "Approved",
    providerResult: "Unknown",
  });
  expect(doubles.store.recordOutcome).not.toHaveBeenCalled();
  doubles.store.read.mockResolvedValue(state("Approved"));
  doubles.store.recordOutcome.mockResolvedValue(state("Refunded"));
  f.refundPayment.mockResolvedValue(observation);
  expect(await f.command.approve(f.input)).toMatchObject({ status: "Refunded" });
  expect(doubles.store.approve).toHaveBeenCalledTimes(1);
  expect(f.refundPayment).toHaveBeenCalledTimes(2);
});

it("WP-2423 P6: never resends a refunded capture and refuses a withdrawn permission", async () => {
  const f = setup();
  doubles.store.read.mockResolvedValue(state("Refunded"));
  expect(await f.command.approve(f.input)).toMatchObject({ status: "Refunded" });
  expect(f.refundPayment).not.toHaveBeenCalled();
  f.allowed.mockResolvedValue(false);
  await expect(f.command.approve(f.input)).rejects.toMatchObject({
    code: "UNMATCHED_REFUND_PERMISSION_DENIED",
  });
  await expect(
    f.command.request({ ...f.input, command: { ...f.input.command, amountMinor: "1" } }),
  ).rejects.toMatchObject({ code: "UNMATCHED_REFUND_INPUT_INVALID" });
});

it("WP-2423 P6: rejects a Provider observation for another operation", async () => {
  const f = setup();
  doubles.store.read.mockResolvedValue(state("Approved"));
  f.refundPayment.mockResolvedValue({ ...observation, context: { operationReference: id(41) } });
  await expect(f.command.approve(f.input)).rejects.toMatchObject({
    code: "UNMATCHED_REFUND_UNAVAILABLE",
  });
  expect(doubles.store.recordOutcome).not.toHaveBeenCalled();
});

it("WP-2423 P6: each step may read the current state but no other step, for the current staff only", async () => {
  const f = setup();
  type Authorize = (tx: unknown, step: string, actor: string | null) => Promise<boolean>;
  const during: boolean[] = [];
  doubles.store.read.mockImplementation(async (tx: unknown) => {
    const { authorize } = doubles.options.at(-1) as { authorize: Authorize };
    during.push(await authorize(tx, "Read", null));
    during.push(await authorize(tx, "Approve", id(2)));
    during.push(await authorize(tx, "Request", id(2)));
    during.push(await authorize(tx, "Approve", id(99)));
    during.push(await authorize({}, "Read", null));
    return state("Refunded");
  });
  await f.command.approve(f.input);
  expect(during).toEqual([true, true, false, false, false]);
  // WP-2423: the caller is resolved in full at the start and before the commit only.
  expect(f.allowed).toHaveBeenCalledTimes(2);
  // The owner callback is the run's guard; it ends with the run.
  const { authorize } = doubles.options.at(-1) as { authorize: Authorize };
  const tx = (doubles.store.read.mock.calls[0] as unknown[])[0];
  expect(await authorize(tx, "Read", null)).toBe(false);
});
it("WP-2423: a permission withdrawn during approval refuses it inside the transaction and sends nothing", async () => {
  const f = setup();
  let rolledBack: unknown = null;
  f.run.mockImplementation(async (work: (tx: object) => Promise<unknown>) =>
    work({ query: vi.fn() }).catch((error: unknown) => {
      rolledBack = error;
      throw error;
    }),
  );
  doubles.store.read.mockResolvedValue(state("Requested"));
  doubles.store.approve.mockResolvedValue(state("Approved"));
  f.allowed.mockResolvedValueOnce(true).mockResolvedValueOnce(false);
  await expect(f.command.approve(f.input)).rejects.toMatchObject({
    code: "UNMATCHED_REFUND_PERMISSION_DENIED",
  });
  // Thrown inside the transaction callback, so the approval does not commit; no Provider call.
  expect(rolledBack).toMatchObject({ code: "UNMATCHED_REFUND_PERMISSION_DENIED" });
  expect(doubles.store.approve).toHaveBeenCalledOnce();
  expect(f.refundPayment).not.toHaveBeenCalled();
  expect(f.allowed).toHaveBeenCalledTimes(2);
});
