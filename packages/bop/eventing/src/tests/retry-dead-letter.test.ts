import { describe, expect, it } from "vitest";
import {
  resolveRetry,
  retryPolicy,
  retryTelemetryBuckets,
} from "../contracts/retry-dead-letter.js";
import {
  expediteConsumerRetries,
  type ConsumerRetryExpediteCommand,
} from "../infrastructure/messaging/retry-dead-letter.js";

describe("retry policy", () => {
  const firstAttemptAt = "2026-07-24T00:00:00.000Z";

  it("uses equal jitter over 2 s x 4 capped at 30 min (version 2)", () => {
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
      delayMs: 1_000,
      nextAvailableAt: "2026-07-24T00:00:01.000Z",
      policyName: "eventing_default",
      policyVersion: 2,
    });
    expect(
      resolveRetry({
        actualAttemptNumber: 3,
        firstAttemptAt,
        now: firstAttemptAt,
        path: "consumer",
        random: 0.999_999,
        safeCode: "AGGREGATE_ORDER_GAP",
      }),
    ).toMatchObject({ decision: "retry_scheduled", failureClass: "ordering_gap", delayMs: 31_999 });
    expect(
      resolveRetry({
        actualAttemptNumber: 7,
        firstAttemptAt,
        now: "2026-07-24T00:01:00.000Z",
        path: "consumer",
        random: 0,
        safeCode: "CONSUMER_TEMPORARY_FAILURE",
      }),
    ).toMatchObject({ decision: "retry_scheduled", delayMs: 900_000 });
    expect(retryPolicy).toMatchObject({
      version: 2,
      maximumActualHandoffs: 8,
      maximumDelayMs: 1_800_000,
      maximumHorizonMs: 86_400_000,
    });
  });

  it("keeps a temporary failure retrying for at least half an hour before a dead letter", () => {
    // v15 2026-10-15: version 1 dead-lettered a receipt consumer failure after about a minute.
    const schedule = (random: number) => {
      let at = Date.parse(firstAttemptAt);
      for (let attempt = 1; attempt < retryPolicy.maximumActualHandoffs; attempt++) {
        const resolution = resolveRetry({
          actualAttemptNumber: attempt,
          firstAttemptAt,
          now: new Date(at).toISOString(),
          path: "consumer",
          random,
          safeCode: "CONSUMER_TEMPORARY_FAILURE",
        });
        expect(resolution.decision).toBe("retry_scheduled");
        if (resolution.decision === "retry_scheduled") at = Date.parse(resolution.nextAvailableAt);
      }
      expect(
        resolveRetry({
          actualAttemptNumber: retryPolicy.maximumActualHandoffs,
          firstAttemptAt,
          now: new Date(at).toISOString(),
          path: "consumer",
          random,
          safeCode: "CONSUMER_TEMPORARY_FAILURE",
        }),
      ).toMatchObject({ decision: "dead_lettered", failureClass: "exhausted" });
      return at - Date.parse(firstAttemptAt);
    };
    // Retries 1-7 wait 2, 8, 32, 128, 512, 1800 and 1800 s before jitter.
    expect(schedule(0)).toBe(2_141_000);
    expect(schedule(0.999_999)).toBeGreaterThan(4_281_000);
    expect(schedule(0.999_999)).toBeLessThanOrEqual(4_282_000);
    expect(schedule(0)).toBeGreaterThan(30 * 60_000);
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

describe("WP-2423 consumer retry expedite command", () => {
  const brandId = "018f1f48-7b5d-7001-8a1b-123456789abc";
  const actorId = "018f1f48-7b5d-7006-8a1b-123456789abc";
  const idempotencyKey = "018f1f48-7b5d-7008-8a1b-123456789abc";
  const command = {
    brandId,
    consumerName: "inventory.order-line-kitchenworkstarted:v1",
    actorId,
    permission: "EVENTING_DEAD_LETTER_RETRY",
    purpose: "RELIABILITY_RECOVERY",
    reason: "DEPENDENCY_RECOVERED",
    idempotencyKey,
    dryRun: true,
    actionId: () => "018f1f48-7b5d-7009-8a1b-123456789abc",
  } as const;
  const recording = () => {
    const statements: string[] = [];
    return {
      statements,
      transaction: {
        query: async (text: string) => {
          statements.push(text);
          return { rowCount: 0, rows: [] };
        },
      },
    };
  };

  it.each([
    [{ brandId: "not-a-uuid" }],
    [{ actorId: "018f1f48-7b5d-4006-8a1b-123456789abc" }],
    [{ storeId: "" }],
    [{ consumerName: "Bad Name" }],
    [{ permission: "EVENTING_DEAD_LETTER_DISCARD" }],
    [{ reason: "TRANSIENT_RECOVERED" }],
    [{ purpose: "OTHER" }],
    [{ dryRun: "yes" }],
  ])("refuses %j before reading", async (override) => {
    const { statements, transaction } = recording();
    await expect(
      expediteConsumerRetries(transaction, {
        ...command,
        ...override,
      } as unknown as ConsumerRetryExpediteCommand),
    ).rejects.toThrow(TypeError);
    expect(statements).toEqual([]);
  });

  it("reads only in a dry run and locks the retries it moves", async () => {
    const dry = recording();
    expect(await expediteConsumerRetries(dry.transaction, command)).toEqual({
      status: "dry_run",
      retries: [],
    });
    expect(dry.statements).toHaveLength(2);
    expect(dry.statements.some((sql) => /\b(INSERT|UPDATE|FOR UPDATE)\b/u.test(sql))).toBe(false);
    const live = recording();
    expect(
      await expediteConsumerRetries(live.transaction, {
        ...command,
        consumerName: null,
        dryRun: false,
      }),
    ).toEqual({ status: "applied", retries: [] });
    expect(live.statements[1]).toMatch(/state = 'scheduled'[\s\S]*FOR UPDATE$/u);
  });
});
