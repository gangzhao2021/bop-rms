import { expect, it } from "vitest";
import { resolveDiningExceptionTaskPolicy } from "../index.js";
const id = (n: number) => "0190fad1-0000-7000-8000-" + String(n).padStart(12, "0");
const policy = {
  policyReference: id(1),
  version: 1,
  brandReference: id(2),
  storeReference: id(3),
  managerQueueReference: id(4),
  escalationPolicyReference: id(5),
  dueAfterMilliseconds: 3600000,
  effectiveFrom: "2026-09-20T00:00:00.000Z",
  effectiveUntil: "2026-09-21T00:00:00.000Z",
};
const request = {
  brandReference: id(2),
  storeReference: id(3),
  requestedAt: "2026-09-20T23:30:00.000Z",
  observedAt: "2026-09-20T23:31:00.000Z",
};
it("derives immutable UTC due time from original request, including crossing midnight", () => {
  const result = resolveDiningExceptionTaskPolicy(policy, request);
  expect(result.dueAt).toBe("2026-09-21T00:30:00.000Z");
  expect(Object.isFrozen(result)).toBe(true);
  expect(
    resolveDiningExceptionTaskPolicy(policy, { ...request, observedAt: "2026-09-20T23:59:00.000Z" })
      .dueAt,
  ).toBe(result.dueAt);
});
it.each([0, -1, 0.5, Number.MAX_SAFE_INTEGER, NaN])(
  "rejects invalid or overflowing due duration %s",
  (duration) => {
    expect(() =>
      resolveDiningExceptionTaskPolicy({ ...policy, dueAfterMilliseconds: duration }, request),
    ).toThrow();
  },
);
it.each([
  { ...request, storeReference: id(9) },
  { ...request, brandReference: id(9) },
  { ...request, observedAt: policy.effectiveUntil },
  { ...request, requestedAt: "2026-09-19T23:59:59.999Z" },
  { ...request, observedAt: "2026-09-20T23:29:59.999Z" },
])("rejects foreign scope, expired policy or clock mismatch %#", (input) => {
  expect(() => resolveDiningExceptionTaskPolicy(policy, input)).toThrow();
});
it("rejects unknown browser override fields and invalid queue identity", () => {
  expect(() =>
    resolveDiningExceptionTaskPolicy({ ...policy, managerOverride: true }, request),
  ).toThrow();
  expect(() =>
    resolveDiningExceptionTaskPolicy({ ...policy, managerQueueReference: "manager" }, request),
  ).toThrow();
});
