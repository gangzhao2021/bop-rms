import { expect, it } from "vitest";
import { teaAfterCheckProblem, teaStepProblem } from "./merchant-dining-tea-charge.js";

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

it("M28: a change that took tea off but could not add it back says so, never silent", () => {
  const after = { problem: null, tookOff: true, expected: 4, paid: false };
  // Took off, the add failed: told it was taken off and not added back.
  expect(teaAfterCheckProblem({ ...after, problem: "Unavailable", charged: 2 })).toBe(
    "NotAddedBack",
  );
  expect(teaAfterCheckProblem({ ...after, charged: 2 })).toBe("NotAddedBack");
  // A refusal with its own reason keeps it (the table is paying).
  expect(teaAfterCheckProblem({ ...after, problem: "CheckingOut", charged: 2 })).toBe(
    "CheckingOut",
  );
  // Nothing was taken off and it still doesn't match: not confirmed.
  expect(teaAfterCheckProblem({ ...after, tookOff: false, charged: 2 })).toBe("Unavailable");
  // Matches now, or paid: nothing to say.
  expect(teaAfterCheckProblem({ ...after, charged: 4 })).toBeNull();
  expect(teaAfterCheckProblem({ ...after, paid: true, charged: 2 })).toBeNull();
});
