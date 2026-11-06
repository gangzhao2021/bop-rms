import { expect, it } from "vitest";
import { teaStepProblem } from "./merchant-dining-tea-charge.js";

it("M29: a refused tea step is named for what it is, not as a busy system", () => {
  const refused = (code: string) => teaStepProblem(Object.assign(new Error(code), { code }));
  expect(refused("UNPAID_ITEM_REMOVAL_PERMISSION_DENIED")).toBe("NeedsManager");
  expect(refused("UNPAID_ITEM_REMOVAL_ALREADY_PAID")).toBe("CheckingOut");
  expect(refused("STAFF_ROUND_TABLE_CHECKOUT_IN_PROGRESS")).toBe("CheckingOut");
  expect(refused("UNPAID_ITEM_REMOVAL_NOT_REMOVABLE")).toBe("AlreadyServed");
  expect(refused("UNPAID_ITEM_REMOVAL_PREPARATION_STARTED")).toBe("AlreadyServed");
  expect(refused("UNPAID_ITEM_REMOVAL_VERSION_CONFLICT")).toBe("Changed");
  expect(refused("UNPAID_ITEM_REMOVAL_UNAVAILABLE")).toBe("Unavailable");
  expect(teaStepProblem(new Error("offline"))).toBe("Unavailable");
});
