import { expect, it } from "vitest";
import { assertOrdinaryRefundExecutor as check } from "../application/ordinary-refund-executor.js";
import { refundRequestId as id } from "./ordinary-refund-request.fixture.js";
const at = "2026-09-13T12:15:00.000Z";
function fixture() {
  const expected = {
    tenantReference: id(1),
    brandReference: id(2),
    storeReference: id(3),
    orderReference: id(4),
    actorReference: id(5),
  };
  return {
    expected,
    observedAt: at,
    authority: {
      ...expected,
      permissionCode: "payment.refund.execute",
      active: true,
      allowed: true,
      observedAt: at,
    },
  };
}
it("accepts only current exact executor capability", () => {
  expect(() => check(fixture())).not.toThrow();
});
it.each(["payment.refund.request", "payment.refund.approve"])(
  "does not substitute %s for execution",
  (permissionCode) => {
    const f = fixture();
    f.authority.permissionCode = permissionCode;
    expect(() => check(f)).toThrow("ORDINARY_REFUND_EXECUTOR_DENIED");
  },
);
it.each([
  "tenantReference",
  "brandReference",
  "storeReference",
  "orderReference",
  "actorReference",
] as const)("rejects mismatched %s", (key) => {
  const f = fixture();
  f.authority[key] = id(99);
  expect(() => check(f)).toThrow("ORDINARY_REFUND_EXECUTOR_DENIED");
});
it("rejects revoked, inactive or stale observations", () => {
  for (const patch of [
    { allowed: false },
    { active: false },
    { observedAt: "2026-09-13T12:14:59.999Z" },
  ]) {
    const f = fixture();
    Object.assign(f.authority, patch);
    expect(() => check(f)).toThrow("ORDINARY_REFUND_EXECUTOR_DENIED");
  }
});
