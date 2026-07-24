import { describe, expect, it } from "vitest";
import {
  resolveRetry,
  retryPolicy,
  retryTelemetryBuckets,
} from "../contracts/retry-dead-letter.js";

describe("retry policy", () => {
  const firstAttemptAt = "2026-07-24T00:00:00.000Z";

  it("uses deterministic full jitter with the accepted exponential bounds", () => {
    expect(
      resolveRetry({
        actualAttemptNumber: 1,
        firstAttemptAt,
        now: firstAttemptAt,
        path: "outbox",
        random: 0,
        safeCode: "TRANSPORT_TIMEOUT",
      }),
    ).toMatchObject({
      decision: "retry_scheduled",
      delayMs: 0,
      nextAvailableAt: firstAttemptAt,
      policyName: "eventing_default",
      policyVersion: 1,
    });
    expect(
      resolveRetry({
        actualAttemptNumber: 7,
        firstAttemptAt,
        now: "2026-07-24T00:01:00.000Z",
        path: "consumer",
        random: 0.999_999,
        safeCode: "CONSUMER_TEMPORARY_FAILURE",
      }),
    ).toMatchObject({ decision: "retry_scheduled", delayMs: 63_999 });
    expect(retryPolicy.maximumDelayMs).toBe(300_000);
  });

  it("fails closed, exhausts at eight handoffs, and isolates commit unknown", () => {
    expect(
      resolveRetry({
        actualAttemptNumber: 1,
        firstAttemptAt,
        now: firstAttemptAt,
        path: "consumer",
        random: 0.5,
        safeCode: "NEW_UNKNOWN_CODE",
      }),
    ).toMatchObject({ decision: "dead_lettered", failureClass: "non_retryable" });
    expect(
      resolveRetry({
        actualAttemptNumber: 8,
        firstAttemptAt,
        now: firstAttemptAt,
        path: "outbox",
        random: 0.5,
        safeCode: "TRANSPORT_TIMEOUT",
      }),
    ).toMatchObject({ decision: "dead_lettered", failureClass: "exhausted" });
    expect(
      resolveRetry({
        actualAttemptNumber: 2,
        firstAttemptAt,
        now: firstAttemptAt,
        path: "consumer",
        random: 0.5,
        safeCode: "COMMIT_OUTCOME_UNKNOWN",
      }),
    ).toMatchObject({
      decision: "reconciliation_required",
      failureClass: "commit_unknown",
    });
    expect(
      resolveRetry({
        actualAttemptNumber: 2,
        firstAttemptAt,
        now: "2026-07-25T00:00:00.000Z",
        path: "consumer",
        random: 0.5,
        safeCode: "COMMIT_OUTCOME_UNKNOWN",
      }),
    ).toMatchObject({
      decision: "dead_lettered",
      failureClass: "exhausted",
    });
  });

  it("records validation-only rejection at attempt zero and fails cross-path codes closed", () => {
    expect(
      resolveRetry({
        actualAttemptNumber: 0,
        firstAttemptAt,
        now: firstAttemptAt,
        path: "consumer",
        random: 0.5,
        safeCode: "EVENT_SCHEMA_VERSION_UNSUPPORTED",
      }),
    ).toMatchObject({ decision: "dead_lettered", failureClass: "non_retryable" });
    expect(
      resolveRetry({
        actualAttemptNumber: 1,
        firstAttemptAt,
        now: firstAttemptAt,
        path: "outbox",
        random: 0.5,
        safeCode: "CONSUMER_TEMPORARY_FAILURE",
      }),
    ).toMatchObject({ decision: "dead_lettered", failureClass: "non_retryable" });
  });

  it("keeps aggregate gaps retryable without changing the retry identity", () => {
    expect(
      resolveRetry({
        actualAttemptNumber: 2,
        firstAttemptAt,
        now: firstAttemptAt,
        path: "consumer",
        random: 0.5,
        safeCode: "AGGREGATE_ORDER_GAP",
      }),
    ).toMatchObject({ decision: "retry_scheduled", failureClass: "ordering_gap" });
  });

  it("emits only bounded attempt and delay buckets", () => {
    expect(retryTelemetryBuckets(1)).toEqual({ attemptBucket: "1", delayBucket: "none" });
    expect(retryTelemetryBuckets(8, 300_000)).toEqual({
      attemptBucket: "8",
      delayBucket: "5m",
    });
  });
});
