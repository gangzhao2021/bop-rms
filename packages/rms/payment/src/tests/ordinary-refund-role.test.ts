import { expect, it } from "vitest";
import { createOrdinaryRefundRoleResolver as create } from "../application/ordinary-refund-role.js";
const config = () => ({ Manager: ["store_manager"], Owner: ["brand_owner"], Finance: ["finance"] });
it("requires explicit scoped mappings and selects eligibility for the exact action", () => {
  const resolve = create(config());
  expect(resolve("payment.refund.request", ["store_manager"])).toBe("Manager");
  expect(resolve("payment.refund.approve", ["finance"])).toBe("Finance");
  expect(resolve("payment.refund.approve", ["brand_owner", "finance"])).toBe("Owner");
  expect(resolve("payment.refund.request", ["brand_owner"])).toBeNull();
  expect(resolve("payment.refund.approve", ["store_manager"])).toBeNull();
  expect(resolve("payment.refund.approve", ["Owner"])).toBeNull();
  expect(() => resolve("payment.refund.execute", ["brand_owner"])).toThrow();
});
it("copies configuration and rejects ambiguous or duplicate role bindings", () => {
  const input = config();
  const resolve = create(input);
  input.Manager.push("untrusted");
  expect(resolve("payment.refund.request", ["untrusted"])).toBeNull();
  expect(() => create({ ...config(), Finance: ["store_manager"] })).toThrow();
  expect(() => create({ ...config(), Manager: ["store_manager", "store_manager"] })).toThrow();
  expect(() => create({ ...config(), extra: [] })).toThrow();
});
it("does not invoke accessor role lists or accept sparse input", () => {
  const list: unknown[] = [];
  let invoked = false;
  Object.defineProperty(list, "0", {
    enumerable: true,
    get: () => {
      invoked = true;
      return "finance";
    },
  });
  const resolve = create(config());
  expect(() => resolve("payment.refund.approve", list)).toThrow();
  expect(invoked).toBe(false);
  expect(() => resolve("payment.refund.approve", new Array(1))).toThrow();
});
