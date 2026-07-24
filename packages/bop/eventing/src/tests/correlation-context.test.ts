import { describe, expect, it } from "vitest";
import {
  continueTrustedCorrelationContext,
  createRootCorrelationContext,
  deriveCorrelationContextFromCommand,
  deriveCorrelationContextFromEvent,
  InvalidCorrelationContextError,
  preserveEventCorrelationContext,
  type DomainEventEnvelope,
} from "../index.js";

const correlationA = "018f1f48-7b5d-7aa1-8a1b-123456789abc";
const correlationB = "018f1f48-7b5d-7aa2-8a1b-123456789abc";
const commandA = "018f1f48-7b5d-7bb1-8a1b-123456789abc";
const commandB = "018f1f48-7b5d-7bb2-8a1b-123456789abc";
const sourceEventId = "018f1f48-7b5d-7cc1-8a1b-123456789abc";
const originalCause = "018f1f48-7b5d-7dd1-8a1b-123456789abc";

const sourceEvent: DomainEventEnvelope = {
  eventId: sourceEventId,
  eventType: "SyntheticChanged",
  schemaVersion: 1,
  occurredAt: "2026-07-24T12:00:00.000Z",
  producerModule: "@bop/eventing",
  tenantId: "018f1f48-7b5d-7ee1-8a1b-123456789abc",
  aggregateType: "Synthetic",
  aggregateId: "018f1f48-7b5d-7ee2-8a1b-123456789abc",
  aggregateVersion: 1n,
  correlationId: correlationA,
  causationId: originalCause,
  actor: { type: "System" },
  payload: {},
  redactionClassification: "none",
  replayMetadata: {},
};

describe("Correlation / Causation Context", () => {
  it("creates an immutable root from exactly one injected UUIDv7 with no causation", () => {
    let calls = 0;
    const root = createRootCorrelationContext(() => {
      calls += 1;
      return correlationA;
    });

    expect(root).toEqual({ correlationId: correlationA });
    expect(Object.isFrozen(root)).toBe(true);
    expect(calls).toBe(1);
  });

  it("derives only the immediate Command or Event cause while preserving correlation", () => {
    const root = createRootCorrelationContext(() => correlationA);
    expect(deriveCorrelationContextFromCommand(root, commandA)).toEqual({
      correlationId: correlationA,
      causationId: commandA,
    });
    expect(deriveCorrelationContextFromEvent(sourceEvent)).toEqual({
      correlationId: correlationA,
      causationId: sourceEventId,
    });
  });

  it.each(["retry", "replay", "redelivery", "lost-ack", "commit-unknown"])(
    "preserves original Event identity exactly for %s",
    () => {
      expect(preserveEventCorrelationContext(sourceEvent)).toEqual({
        correlationId: correlationA,
        causationId: originalCause,
      });
    },
  );

  it("keeps manual recovery lineage separate from the immutable original Event", () => {
    const preserved = preserveEventCorrelationContext(sourceEvent);
    const recoveryEvent = deriveCorrelationContextFromCommand(preserved, commandB);

    expect(preserveEventCorrelationContext(sourceEvent)).toEqual(preserved);
    expect(recoveryEvent).toEqual({
      correlationId: correlationA,
      causationId: commandB,
    });
  });

  it.each([
    null,
    {},
    { correlationId: "not-a-uuid" },
    { correlationId: correlationA, causationId: "not-a-uuid" },
    { correlationId: correlationA, tenantId: correlationB },
    { correlationId: correlationA, storeId: correlationB },
    { correlationId: correlationA, actor: { actorId: correlationB } },
    { correlationId: correlationA, traceparent: "00-secret" },
    { correlationId: correlationA, tracestate: "vendor=secret" },
    { correlationId: correlationA, baggage: "email=person@example.test" },
    { correlationId: correlationA, payload: { secret: "must-not-capture" } },
  ])("fails closed for invalid or untrusted context %#", (input) => {
    expect(() => continueTrustedCorrelationContext(input)).toThrow(InvalidCorrelationContextError);
  });

  it("does not echo rejected external values in errors", () => {
    const secret = "person@example.test?token=must-not-capture";
    try {
      continueTrustedCorrelationContext({ correlationId: secret });
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(InvalidCorrelationContextError);
      expect((error as Error).message).not.toContain(secret);
    }
  });

  it("isolates explicitly passed contexts across interleaved parallel work", async () => {
    const run = async (correlationId: string, commandId: string) => {
      const root = createRootCorrelationContext(() => correlationId);
      await Promise.resolve();
      const child = deriveCorrelationContextFromCommand(root, commandId);
      await Promise.resolve();
      return { child, root };
    };

    const [a, b] = await Promise.all([run(correlationA, commandA), run(correlationB, commandB)]);
    expect(a).toEqual({
      root: { correlationId: correlationA },
      child: { correlationId: correlationA, causationId: commandA },
    });
    expect(b).toEqual({
      root: { correlationId: correlationB },
      child: { correlationId: correlationB, causationId: commandB },
    });
  });

  it("exposes only the two lineage fields and no ambient telemetry or data carrier", () => {
    const context = continueTrustedCorrelationContext({
      correlationId: correlationA,
      causationId: originalCause,
    });
    expect(Object.keys(context)).toEqual(["correlationId", "causationId"]);
    expect(JSON.stringify(context)).not.toMatch(
      /tenant|store|actor|metric|analytics|url|payload|pii|secret|trace|baggage/iu,
    );
  });
});
