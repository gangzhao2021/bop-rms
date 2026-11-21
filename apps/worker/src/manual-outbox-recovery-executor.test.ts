import { afterEach, describe, expect, it, vi } from "vitest";
import type { DomainEventEnvelope } from "@bop/eventing";
import {
  createManualOutboxRecoveryExecutor,
  type ManualOutboxRecoveryClaim,
} from "./manual-outbox-recovery-executor.js";
const id = (n: number) => `0190fab4-0000-7000-8000-${String(n).padStart(12, "0")}`;
const at = Date.parse("2026-09-20T14:00:00.000Z"),
  digest = "sha256:" + "a".repeat(64);
const envelope: DomainEventEnvelope = {
  eventId: id(1),
  eventType: "SyntheticChanged",
  schemaVersion: 1,
  occurredAt: new Date(at).toISOString(),
  producerModule: "@bop/eventing",
  tenantId: id(2),
  storeId: id(3),
  aggregateType: "SyntheticAggregate",
  aggregateId: id(4),
  aggregateVersion: 4n,
  correlationId: id(5),
  actor: { type: "System" },
  payload: {},
  redactionClassification: "none",
  replayMetadata: {},
};
const claimed: ManualOutboxRecoveryClaim = {
  recoveryReference: id(6),
  leaseToken: id(7),
  leaseExpiresAt: new Date(at + 30000).toISOString(),
  registryDigest: digest,
  envelope,
};
function fixture() {
  const claim = vi.fn().mockResolvedValueOnce(claimed).mockResolvedValue(null);
  const record = vi.fn().mockResolvedValue("recorded");
  const publish = vi.fn().mockResolvedValue({ status: "acknowledged" });
  const now = vi.fn(() => at);
  const runner = createManualOutboxRecoveryExecutor({
    scope: { brandId: id(2), storeId: id(3) },
    registryDigest: digest,
    execution: { claim, record },
    adapter: { publish },
    adapterTimeoutMs: 100,
    now,
  });
  return { claim, record, publish, now, runner };
}
afterEach(() => vi.useRealTimers());
describe("single manual Outbox invocation", () => {
  it("shares concurrent flight, preserves Event identity and cannot reuse durable claim", async () => {
    const f = fixture();
    const first = f.runner.run(id(6)),
      second = f.runner.run(id(6));
    expect(second).toBe(first);
    expect(await first).toBe("recorded");
    expect(f.publish).toHaveBeenCalledExactlyOnceWith(envelope, { attemptCount: 1 });
    expect(f.record.mock.calls[0]?.[1]).toMatchObject({
      recoveryReference: id(6),
      leaseToken: id(7),
      result: { outcome: "acknowledged", safeCode: "ACKNOWLEDGED" },
    });
    expect(await f.runner.run(id(6))).toBe("not_claimed");
    expect(f.publish).toHaveBeenCalledTimes(1);
  });
  it("does not publish when claim commit fails", async () => {
    const f = fixture();
    f.claim.mockReset().mockRejectedValue(new Error("private database detail"));
    await expect(f.runner.run(id(6))).rejects.toThrow("MANUAL_RECOVERY_CLAIM_UNAVAILABLE");
    expect(f.publish).not.toHaveBeenCalled();
  });
  it.each([
    { ...claimed, registryDigest: "sha256:" + "b".repeat(64) },
    { ...claimed, recoveryReference: id(99) },
    { ...claimed, envelope: { ...envelope, storeId: id(99) } },
    { ...claimed, leaseExpiresAt: "invalid" },
  ])("rejects mismatched persisted claim %#", async (value) => {
    const f = fixture();
    f.claim.mockReset().mockResolvedValue(value);
    await expect(f.runner.run(id(6))).rejects.toThrow("MANUAL_RECOVERY_CLAIM_INVALID");
    expect(f.publish).not.toHaveBeenCalled();
    expect(f.record).not.toHaveBeenCalled();
  });
  it("records unknown for thrown transport errors", async () => {
    const f = fixture();
    f.publish.mockRejectedValue(new Error("private payload"));
    await f.runner.run(id(6));
    expect(f.record.mock.calls[0]?.[1].result).toEqual({
      outcome: "unknown",
      safeCode: "COMMIT_OUTCOME_UNKNOWN",
    });
  });
  it("records unknown on timeout and ignores late acknowledgement", async () => {
    vi.useFakeTimers();
    const f = fixture();
    let finish: (value: unknown) => void = () => undefined;
    f.publish.mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const pending = f.runner.run(id(6));
    await vi.advanceTimersByTimeAsync(101);
    expect(await pending).toBe("recorded");
    expect(f.record.mock.calls[0]?.[1].result.outcome).toBe("unknown");
    finish({ status: "acknowledged" });
    await Promise.resolve();
    expect(f.record).toHaveBeenCalledTimes(1);
  });
  it("does not publish an expired lease", async () => {
    const f = fixture();
    f.now.mockReturnValue(at + 30000);
    await f.runner.run(id(6));
    expect(f.publish).not.toHaveBeenCalled();
    expect(f.record.mock.calls[0]?.[1].result.outcome).toBe("unknown");
  });
  it("does not accept acknowledgement after lease expiry", async () => {
    const f = fixture();
    f.now.mockReturnValueOnce(at).mockReturnValue(at + 30000);
    await f.runner.run(id(6));
    expect(f.record.mock.calls[0]?.[1].result.outcome).toBe("unknown");
  });
  it("surfaces uncertain completion without another invocation", async () => {
    const f = fixture();
    f.record.mockRejectedValue(new Error("private commit error"));
    await expect(f.runner.run(id(6))).rejects.toThrow("MANUAL_RECOVERY_OUTCOME_UNCONFIRMED");
    expect(await f.runner.run(id(6))).toBe("not_claimed");
    expect(f.publish).toHaveBeenCalledTimes(1);
  });
  it("does not report lost lease as completion", async () => {
    const f = fixture();
    f.record.mockResolvedValue("lost_lease");
    expect(await f.runner.run(id(6))).toBe("lost_lease");
  });
  it("keeps a typed timeout unknown", async () => {
    const f = fixture();
    f.publish.mockResolvedValue({ status: "failed", errorCode: "TRANSPORT_TIMEOUT" });
    await f.runner.run(id(6));
    expect(f.record.mock.calls[0]?.[1].result.outcome).toBe("unknown");
  });
});
