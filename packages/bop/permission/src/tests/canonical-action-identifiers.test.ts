import { expect, it } from "vitest";
import { parseBusinessAction, createPermissionDefinition } from "../index.js";
const definition = (action: string) =>
  createPermissionDefinition({
    permissionReference: "0190ed91-0000-7000-8000-000000000001",
    action,
    lifecycle: "Active",
    version: 1,
    createdAt: "2026-09-12T00:00:00.000Z",
    updatedAt: "2026-09-12T00:00:00.000Z",
  });
it("accepts the canonical operations permission identically in policy and evaluation", () => {
  const action = "operations.order-exception.manage";
  expect(parseBusinessAction(action)).toBe(action);
  expect(definition(action).action).toBe(action);
});
it.each([
  "operations.-exception.manage",
  "operations.exception-.manage",
  "operations.order--exception.manage",
  "operations..manage",
  "Operations.exception.manage",
  "operations.exception.*",
  "operations.exception.manage/other",
  "operations.exception.manage\n",
])("rejects malformed action %s", (action) => {
  expect(() => parseBusinessAction(action)).toThrow();
  expect(() => definition(action)).toThrow();
});
