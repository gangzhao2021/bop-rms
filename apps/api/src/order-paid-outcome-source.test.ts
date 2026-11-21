import { describe, expect, it, vi } from "vitest";

const doubles = vi.hoisted(() => ({
  expired: vi.fn(),
  pending: vi.fn(),
  evaluate: vi.fn(),
}));
vi.mock("@rms/ordering", async (original) => ({
  ...(await original<typeof import("@rms/ordering")>()),
  createOrderExpiredPaymentDisposition: doubles.expired,
}));
vi.mock("./order-pending-acceptance-source.js", () => ({
  parseExactPaidOutcomeEvent: (input: { paymentEvent: unknown }) => input.paymentEvent,
  createPendingAcceptanceCandidate: doubles.pending,
  currentAcceptanceDeadline: () => ({}),
}));
vi.mock("./order-paid-workflow.js", () => ({ evaluateOrderPaidWorkflow: doubles.evaluate }));
import { createOrderPaidOutcomeSource } from "./order-paid-outcome-source.js";

/**
 * WP-2423 item 9: what the Home row tells staff rests on this. A paid pickup order nobody accepted
 * goes through its deadline without asking any Workflow, so a refused or stale one does not hold the
 * refund back. If that changes, change the words of `orders.workflow` in pilot-alerts.mjs with it.
 */
describe("a paid order nobody accepted", () => {
  const source = () => {
    const resolveWorkflow = vi.fn(async () => {
      throw new Error("WORKFLOW_DEFINITION_UNAVAILABLE");
    });
    const context = {
      initialExecution: {
        phase: "Submitted",
        version: 1,
        checkpoint: "submission",
      },
      acceptance: null,
      order: {
        order: { canonicalPhase: "Submitted", aggregateVersion: 1, orderType: "Pickup" },
        submissionReference: "submission",
      },
      capacity: { commitment: { state: "PaymentPending" } },
      payment: { intent: { preparation: {} } },
      observedAt: "2026-10-15T12:00:00.000Z",
    };
    const outcome = createOrderPaidOutcomeSource({
      context: { resolve: async () => context } as never,
      release: {} as never,
      generateDispositionReference: () => "disposition",
      generateConfirmationReference: () => "confirmation",
      sha256: (value) => value,
      resolveWorkflow,
    });
    return { outcome, resolveWorkflow };
  };
  const load = (outcome: ReturnType<typeof source>["outcome"]) =>
    outcome.loadExact({ transaction: {}, paymentEvent: {} } as never);

  it("is closed at its deadline with a refusing Workflow, and the Workflow is never asked", async () => {
    doubles.expired.mockReturnValueOnce("closed and refunded");
    const { outcome, resolveWorkflow } = source();
    await expect(load(outcome)).resolves.toBe("closed and refunded");
    expect(resolveWorkflow).not.toHaveBeenCalled();
    expect(doubles.evaluate).not.toHaveBeenCalled();
  });
  it("waits for acceptance before its deadline, with no Workflow asked either", async () => {
    doubles.expired.mockReturnValueOnce(null);
    doubles.pending.mockReturnValueOnce("still waiting");
    const { outcome, resolveWorkflow } = source();
    await expect(load(outcome)).resolves.toBe("still waiting");
    expect(resolveWorkflow).not.toHaveBeenCalled();
    expect(doubles.evaluate).not.toHaveBeenCalled();
  });
});
