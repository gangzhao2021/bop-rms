import { expect, it } from "vitest";
import { createOrdinaryRefundRoleResolver as create } from "../application/ordinary-refund-role.js";
const config = () => ({ Manager: ["store_manager"], Owner: ["brand_owner"], Finance: ["finance"] });
it("requires explicit scoped mappings and selects eligibility for the exact action", () => {
  const resolve = create(config());
  expect(resolve("payment.refund.request", ["store_manager"])).toBe("Manager");
  expect(resolve("payment.refund.approve", ["finance"])).toBe("Finance");
  expect(resolve("payment.refund.approve", ["brand_owner", "finance"])).toBe("Owner");
  // WP-2423 Q19: an Owner is named for a request; Payment admits it only under sole operator.
  expect(resolve("payment.refund.request", ["brand_owner"])).toBe("Owner");
  expect(resolve("payment.refund.request", ["brand_owner", "store_manager"])).toBe("Manager");
  expect(resolve("payment.refund.request", ["finance"])).toBeNull();
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

it("WP-2423 M14: a cashier (Staff) is named for a request only, and the group is optional", () => {
  const resolve = create({ ...config(), Staff: ["front_of_house"] });
  expect(resolve("payment.refund.request", ["front_of_house"])).toBe("Staff");
  expect(resolve("payment.refund.request", ["front_of_house", "store_manager"])).toBe("Manager");
  expect(resolve("payment.refund.approve", ["front_of_house"])).toBeNull();
  // Without the group a cashier holds no refund role.
  expect(create(config())("payment.refund.request", ["front_of_house"])).toBeNull();
  expect(() => create({ ...config(), Staff: ["store_manager"] })).toThrow();
});
