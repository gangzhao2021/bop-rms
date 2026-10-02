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

it("retains the exact accepted Section88 Option read identity in both owning parsers", () => {
  const action = "catalog.option_set.read";
  expect(parseBusinessAction(action)).toBe(action);
  expect(definition(action).action).toBe(action);
});
it.each([
  "catalog.option_set.write",
  "catalog.option__set.read",
  "catalog.option_set.read.other",
  "catalog.other_set.read",
  "catalog.option_set.read\n",
  "catalog.option_set.read.*",
])("does not accept arbitrary underscore actions %s", (action) => {
  expect(() => parseBusinessAction(action)).toThrow();
  expect(() => definition(action)).toThrow();
});
