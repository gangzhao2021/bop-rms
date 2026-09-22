import { additionalSourceFixture } from "./order-status-additional-source.fixture.js";
import { expect, it } from "vitest";
import { createOrderStatusAdditionalSource } from "../application/order-status-additional-source.js";
import { parseOrderSubmittedEnvelope } from "../application/order-submitted-event.js";
it("appends new summary while preserving original identity and batches", () => {
  const f = additionalSourceFixture();
  const result = createOrderStatusAdditionalSource(f);
  expect(result.batches).toHaveLength(2);
  expect(result.batches[0]).toEqual(f.previous.batches[0]);
  expect(result.submissionReference).toBe(f.previous.submissionReference);
  expect(result.guestSessionReference).toBe(f.previous.guestSessionReference);
  expect(result.orderNumber).toBe(f.previous.orderNumber);
  expect(result.sourceVersion).toBe(3);
  expect(result.batches[1]?.orderBatchReference).toBe(f.additional.batch.orderBatchReference);
});
it.each(["version", "sequence", "digest"])(
  "rejects mismatched %s before constructing projection",
  (kind) => {
    const f = additionalSourceFixture();
    if (kind === "version") f.previous.sourceVersion = 1;
    if (kind === "sequence") f.envelope.payload.batchSequence = 3;
    if (kind === "digest") f.envelope.payload.sourceSnapshotDigest = "sha256:" + "b".repeat(64);
    expect(() => createOrderStatusAdditionalSource(f)).toThrow();
  },
);
it("rejects unknown event fields and incorrect causation", () => {
  const f = additionalSourceFixture();
  expect(() =>
    parseOrderSubmittedEnvelope({
      ...f.envelope,
      payload: { ...f.envelope.payload, paymentStatus: "Paid" },
    }),
  ).toThrow();
  expect(() =>
    parseOrderSubmittedEnvelope({
      ...f.envelope,
      causationId: "0190ed31-0000-7000-8000-000000000099",
    }),
  ).toThrow();
});

it.each([
  ["Submitted", "Submitted"],
  ["Accepted", "Accepted"],
  ["In Progress", "In Progress"],
  ["Ready", "In Progress"],
  ["Rejected", "Submitted"],
  ["Cancelled", "Submitted"],
])("preserves approved progress when appending to %s", (before, after) => {
  const f = additionalSourceFixture();
  f.previous.canonicalPhase = before;
  const result = createOrderStatusAdditionalSource(f);
  expect(result.canonicalPhase).toBe(after);
  expect(result.batches[0]).toEqual(f.previous.batches[0]);
  expect(result.fulfillmentStatus).toBe("Unavailable");
});
it("does not report a newly appended Batch as already fulfilled", () => {
  const f = additionalSourceFixture();
  const previous = {
    ...f.previous,
    canonicalPhase: "Fulfilled",
    fulfillmentStatus: "Completed",
    fulfillmentReference: f.previous.sourceCheckpoint,
    fulfillmentCompletionEventReference: f.previous.sourceCheckpoint,
    fulfillmentCompletedAt: f.previous.submittedAt,
  };
  const result = createOrderStatusAdditionalSource({ ...f, previous });
  expect(result.canonicalPhase).toBe("In Progress");
  expect(result.fulfillmentStatus).toBe("Unavailable");
  expect(result.fulfillmentReference).toBeNull();
  expect(result.fulfillmentCompletionEventReference).toBeNull();
  expect(result.fulfillmentCompletedAt).toBeNull();
  expect(previous.fulfillmentStatus).toBe("Completed");
  expect(result.batches[0]).toEqual(previous.batches[0]);
});
