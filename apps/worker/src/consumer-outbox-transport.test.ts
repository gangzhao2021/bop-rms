import { expect, it, vi } from "vitest";
import type { DomainEventEnvelope } from "@bop/eventing";
import { createConsumerOutboxTransport } from "./consumer-outbox-transport.js";

const envelope = { eventType: "SyntheticChanged" } as DomainEventEnvelope;
it("does not acknowledge partial fanout, and permits idempotent retry after partial commit", async () => {
  const deliver = vi
    .fn()
    .mockResolvedValueOnce({ status: "processed" })
    .mockResolvedValueOnce({ status: "retry_required", errorCode: "COMMIT_OUTCOME_UNKNOWN" })
    .mockResolvedValueOnce({ status: "duplicate_completed" })
    .mockResolvedValueOnce({ status: "processed" });
  const adapter = createConsumerOutboxTransport({
    delivery: { deliver },
    subscriptions: [{ eventType: "SyntheticChanged", consumerNames: ["first:v1", "second:v1"] }],
  });
  await expect(adapter.publish(envelope, { attemptCount: 1 })).resolves.toEqual({
    status: "failed",
    errorCode: "TRANSPORT_UNAVAILABLE",
  });
  await expect(adapter.publish(envelope, { attemptCount: 2 })).resolves.toEqual({
    status: "acknowledged",
  });
  expect(deliver).toHaveBeenNthCalledWith(3, "first:v1", envelope, 2);
  expect(deliver).toHaveBeenNthCalledWith(4, "second:v1", envelope, 2);
});
it("rejects unconfigured events without delivery and bounds thrown failures", async () => {
  const deliver = vi.fn().mockRejectedValue(new Error("secret-canary"));
  const adapter = createConsumerOutboxTransport({
    delivery: { deliver },
    subscriptions: [{ eventType: "SyntheticChanged", consumerNames: ["first:v1"] }],
  });
  await expect(
    adapter.publish({ ...envelope, eventType: "OtherChanged" }, { attemptCount: 1 }),
  ).resolves.toEqual({ status: "failed", errorCode: "TRANSPORT_REJECTED" });
  expect(deliver).not.toHaveBeenCalled();
  await expect(adapter.publish(envelope, { attemptCount: 1 })).resolves.toEqual({
    status: "failed",
    errorCode: "TRANSPORT_UNAVAILABLE",
  });
});

it.each(["retry", "throw", "reject"])(
  "delivers later subscriptions after an early %s without acknowledging partial fanout",
  async (failure) => {
    const deliver = vi.fn();
    if (failure === "throw") deliver.mockRejectedValueOnce(new Error("secret-canary"));
    else
      deliver.mockResolvedValueOnce({
        status: failure === "reject" ? "rejected" : "retry_required",
        errorCode: "CONSUMER_TEMPORARY_FAILURE",
      });
    deliver.mockResolvedValueOnce({ status: "processed" });
    const adapter = createConsumerOutboxTransport({
      delivery: { deliver },
      subscriptions: [
        { eventType: "SyntheticChanged", consumerNames: ["waiting:v1", "receipt:v1"] },
      ],
    });
    await expect(adapter.publish(envelope, { attemptCount: 1 })).resolves.toEqual({
      status: "failed",
      errorCode: failure === "reject" ? "TRANSPORT_REJECTED" : "TRANSPORT_UNAVAILABLE",
    });
    expect(deliver).toHaveBeenNthCalledWith(2, "receipt:v1", envelope, 1);
    deliver.mockResolvedValueOnce({ status: "processed" });
    deliver.mockResolvedValueOnce({ status: "duplicate_completed" });
    await expect(adapter.publish(envelope, { attemptCount: 2 })).resolves.toEqual({
      status: "acknowledged",
    });
  },
);
