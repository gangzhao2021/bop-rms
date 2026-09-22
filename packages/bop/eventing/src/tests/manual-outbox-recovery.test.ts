import { describe, expect, it } from "vitest";
import {
  planExhaustedOutboxRecovery,
  type ExhaustedOutboxRecoveryFacts,
} from "../contracts/manual-outbox-recovery.js";
import { retryPolicy, type DeadLetterCommand } from "../contracts/retry-dead-letter.js";
const id = (n: number) => `0190fa58-0000-7000-8000-${n.toString(16).padStart(12, "0")}`;
const command: DeadLetterCommand = {
  deadLetterId: id(1),
  brandId: id(2),
  storeId: id(3),
  actorId: id(4),
  actionId: id(5),
  idempotencyKey: id(6),
  permission: "EVENTING_DEAD_LETTER_RETRY",
  purpose: "RELIABILITY_RECOVERY",
  reason: "DEPENDENCY_RECOVERED",
  expectedVersion: 2n,
};
const facts: ExhaustedOutboxRecoveryFacts = {
  deadLetterId: id(1),
  eventId: id(7),
  brandId: id(2),
  storeId: id(3),
  deadLetterVersion: 2n,
  status: "open",
  deliveryPath: "outbox",
  failureClass: "exhausted",
  safeCode: "TRANSPORT_UNAVAILABLE",
  automaticAttemptCount: 8,
  published: false,
  leased: false,
  orderingReleased: false,
  earlierUnpublishedEvent: false,
  activeRecovery: false,
};
const input = {
  command,
  facts,
  observedAt: "2026-09-20T14:00:00.000Z",
  registryDigest: "sha256:" + "a".repeat(64),
};
describe("explicit exhausted Outbox recovery eligibility", () => {
  it("retains original automatic history and bounds one manual invocation", () => {
    const result = planExhaustedOutboxRecovery(input);
    expect(result).toMatchObject({
      eventId: id(7),
      expectedDeadLetterVersion: 2n,
      originalAutomaticAttemptCount: 8,
      maximumHandoffs: 1,
      startDeadlineAt: "2026-09-20T14:05:00.000Z",
    });
    expect(retryPolicy.maximumActualHandoffs).toBe(8);
    expect(facts.automaticAttemptCount).toBe(8);
    expect(Object.isFrozen(result)).toBe(true);
  });
  it.each<Partial<ExhaustedOutboxRecoveryFacts>>([
    { brandId: id(99) },
    { storeId: id(99) },
    { deadLetterId: id(99) },
    { deadLetterVersion: 3n },
    { status: "retry_scheduled" },
    { status: "resolved" },
    { status: "discarded" },
    { deliveryPath: "consumer" },
    { failureClass: "commit_unknown" },
    { safeCode: "TRANSPORT_REJECTED" },
    { automaticAttemptCount: 7 },
    { automaticAttemptCount: 9 },
    { published: true },
    { leased: true },
    { orderingReleased: true },
    { earlierUnpublishedEvent: true },
    { activeRecovery: true },
  ])("denies ineligible retained facts case %#", (patch) => {
    expect(() => planExhaustedOutboxRecovery({ ...input, facts: { ...facts, ...patch } })).toThrow(
      "MANUAL_OUTBOX_RECOVERY_INELIGIBLE",
    );
  });
  it.each<Partial<DeadLetterCommand>>([
    { permission: "EVENTING_DEAD_LETTER_DISCARD" },
    { reason: "AUTHORIZED_DISCARD" },
    { reason: "ORDERING_RELEASE" },
    { expectedVersion: -1n },
    { actorId: "invalid" },
    { idempotencyKey: "invalid" },
  ])("denies invalid operator intent case %#", (patch) => {
    expect(() =>
      planExhaustedOutboxRecovery({ ...input, command: { ...command, ...patch } }),
    ).toThrow("MANUAL_OUTBOX_RECOVERY_INELIGIBLE");
  });
  it.each([
    "invalid",
    "2026-02-30T14:00:00.000Z",
    "2026-09-20T14:00:00Z",
    "9999-12-31T23:59:59.999Z",
  ])("rejects noncanonical or overflowing clock %s", (observedAt) => {
    expect(() => planExhaustedOutboxRecovery({ ...input, observedAt })).toThrow(
      "MANUAL_OUTBOX_RECOVERY_INELIGIBLE",
    );
  });
  it("requires an exact registry digest", () =>
    expect(() => planExhaustedOutboxRecovery({ ...input, registryDigest: "latest" })).toThrow(
      "MANUAL_OUTBOX_RECOVERY_INELIGIBLE",
    ));
});
