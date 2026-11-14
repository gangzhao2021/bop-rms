import { it, expect, vi, afterEach } from "vitest";
import { resolveInternalDiningTaskPolicy } from "./pilot-dining-task-policy.mjs";
const id = (n) => "0190fad7-0000-7000-8000-" + String(n).padStart(12, "0");
afterEach(() => vi.unstubAllEnvs());
function fixture() {
  vi.stubEnv("NODE_ENV", "development");
  const scope = { tenantReference: id(1), brandReference: id(2), storeReference: id(3) };
  const policy = {
    policyReference: id(4),
    version: 1,
    brandReference: id(2),
    storeReference: id(3),
    managerQueueReference: id(5),
    escalationPolicyReference: id(6),
    dueAfterMilliseconds: 3600000,
    effectiveFrom: "2026-09-21T00:00:00.000Z",
    effectiveUntil: "2026-09-23T00:00:00.000Z",
  };
  return {
    scope,
    observedAt: "2026-09-22T00:00:00.000Z",
    queue: {
      environment: "InternalTest",
      ...scope,
      queueReference: id(5),
      effectiveFrom: policy.effectiveFrom,
      effectiveUntil: policy.effectiveUntil,
      exceptionTaskPolicy: policy,
    },
  };
}
it("binds explicit policy to existing queue without fixing a retry deadline", () => {
  const f = fixture(),
    result = resolveInternalDiningTaskPolicy(f);
  expect(result).toEqual(f.queue.exceptionTaskPolicy);
  expect(result).not.toHaveProperty("dueAt");
  expect(Object.isFrozen(result)).toBe(true);
});
it("keeps existing settled-only behavior when policy absent", () => {
  const f = fixture();
  delete f.queue.exceptionTaskPolicy;
  expect(resolveInternalDiningTaskPolicy(f)).toBeUndefined();
});
it.each(["scope", "queue", "expired", "interval", "live", "delay"])(
  "rejects invalid %s",
  (kind) => {
    const f = fixture();
    if (kind === "scope") f.queue.storeReference = id(9);
    if (kind === "queue") f.queue.exceptionTaskPolicy.managerQueueReference = id(9);
    if (kind === "expired") f.observedAt = f.queue.effectiveUntil;
    if (kind === "interval")
      f.queue.exceptionTaskPolicy.effectiveUntil = "2026-09-24T00:00:00.000Z";
    if (kind === "live") vi.stubEnv("NODE_ENV", "production");
    if (kind === "delay") f.queue.exceptionTaskPolicy.dueAfterMilliseconds = 0;
    expect(() => resolveInternalDiningTaskPolicy(f)).toThrow(
      "INTERNAL_DINING_TASK_POLICY_UNAVAILABLE",
    );
  },
);
