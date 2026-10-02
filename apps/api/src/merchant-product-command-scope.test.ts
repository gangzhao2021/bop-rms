import { it, expect, vi } from "vitest";
import {
  parseMerchantProductCommandScope,
  bindMerchantProductCommandScope,
  decodeMerchantProductCommandScopeHeader,
} from "./merchant-product-command-scope.js";
const scope = {
  brandReference: "01902409-0000-7000-8000-000000000001",
  storeReference: "01902409-0000-7000-8000-000000000002",
};
const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
it("copies a closed intent scope without granting authority", () => {
  const input = { ...scope };
  const parsed = parseMerchantProductCommandScope(input);
  input.storeReference = scope.brandReference;
  expect(parsed).toEqual(scope);
  expect(Object.isFrozen(parsed)).toBe(true);
  expect(decodeMerchantProductCommandScopeHeader(encode(scope))).toEqual(scope);
});
it.each([
  null,
  [],
  {},
  { ...scope, permission: "Allow" },
  { ...scope, actorReference: scope.brandReference },
  { ...scope, brandReference: "wrong" },
  { ...scope, storeReference: undefined },
  Object.assign(Object.create({ permission: "Allow" }), scope),
])("rejects caller scope drift %#", (value) => {
  expect(() => parseMerchantProductCommandScope(value)).toThrow(
    expect.objectContaining({ code: "CATALOG_INPUT_INVALID" }),
  );
});
it("rejects scope accessors without invoking them", () => {
  const input = { ...scope },
    getter = vi.fn(() => scope.storeReference);
  Object.defineProperty(input, "storeReference", { get: getter, enumerable: true });
  expect(() => parseMerchantProductCommandScope(input)).toThrow();
  expect(getter).not.toHaveBeenCalled();
});
it.each([
  null,
  "",
  "a",
  "e30",
  encode(scope) + "=",
  "a".repeat(513),
  Buffer.from([0xff]).toString("base64url"),
  encode({ ...scope, storeReference: "wrong" }),
  encode({ ...scope, permission: "Allow" }),
])("rejects malformed scope header %#", (value) => {
  expect(() => decodeMerchantProductCommandScopeHeader(value)).toThrow(
    expect.objectContaining({ code: "CATALOG_INPUT_INVALID" }),
  );
});

it("distinguishes missing owning scope from a rebound request", () => {
  expect(() => bindMerchantProductCommandScope({}, scope)).toThrow(
    expect.objectContaining({ code: "CATALOG_DEPENDENCY_UNAVAILABLE" }),
  );
  expect(() =>
    bindMerchantProductCommandScope({ ...scope, storeReference: scope.brandReference }, scope),
  ).toThrow(expect.objectContaining({ code: "CATALOG_PERMISSION_DENIED" }));
  expect(bindMerchantProductCommandScope(scope, scope)).toEqual(scope);
});
