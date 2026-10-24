import { expect, it } from "vitest";
import { bindMerchantStoreSetupReferenceCommand } from "./merchant-store-setup-reference-command.js";
const id = (n: number) => `01902421-1020-7000-8000-${n.toString(16).padStart(12, "0")}`;
const scope = {
  tenantReference: id(1),
  brandReference: id(2),
  storeReference: id(3),
  actorReference: id(4),
};
const address = {
  countryCode: "CA",
  regionCode: "ON",
  locality: "Synthetic locality",
  postalCode: "A1A 1A1",
  addressLines: ["100 Synthetic Street"],
};
const save = () => ({
  command: "SaveReference",
  operationReference: id(5),
  expectedReference: null,
  expectedRevision: 0,
  content: address,
});
it("binds only actual acquired scope and selected reference kind to the full original intent", () => {
  const result = bindMerchantStoreSetupReferenceCommand(save(), scope, "Address");
  expect(result.method).toBe("save");
  expect(result.command).toEqual({
    profile: "StoreSetupReferenceSaveV1",
    ...scope,
    kind: "Address",
    operationReference: id(5),
    expectedReference: null,
    expectedRevision: 0,
    content: address,
    purposeCode: "STORE_SETUP_REFERENCE",
  });
  expect(Object.isFrozen(result.command)).toBe(true);
});
it("binds payload-free original resolution without an authored reference result", () => {
  const body = {
    command: "ResolveOriginal",
    operationReference: id(5),
    expectedReference: id(6),
    expectedRevision: 1,
    intentDigest: "sha256:" + "a".repeat(64),
  };
  const result = bindMerchantStoreSetupReferenceCommand(body, scope, "Contact");
  expect(result.method).toBe("resolve");
  expect(result.command).toEqual({
    profile: "StoreSetupReferenceResolveV1",
    ...scope,
    kind: "Contact",
    operationReference: id(5),
    expectedReference: id(6),
    expectedRevision: 1,
    intentDigest: body.intentDigest,
    purposeCode: "STORE_SETUP_REFERENCE",
  });
  expect(result.command).not.toHaveProperty("content");
});
it.each(["actorReference", "tenantReference", "kind", "reference", "purposeCode", "csrf"])(
  "refuses browser %s authority or generated fields",
  (key) => {
    expect(() =>
      bindMerchantStoreSetupReferenceCommand({ ...save(), [key]: id(9) }, scope, "Address"),
    ).toThrow();
  },
);
it.each([
  null,
  [],
  { ...save(), expectedReference: id(6) },
  { ...save(), expectedRevision: 1 },
  { ...save(), command: "Publish" },
  { ...save(), content: { ...address, notes: "unnecessary" } },
])("refuses nonclosed or mismatched reference intents", (value) => {
  expect(() => bindMerchantStoreSetupReferenceCommand(value, scope, "Address")).toThrow();
});
it("rejects a discriminator accessor before invoking it", () => {
  let calls = 0;
  const value = { ...save() };
  Object.defineProperty(value, "command", {
    enumerable: true,
    get() {
      calls++;
      return "SaveReference";
    },
  });
  expect(() => bindMerchantStoreSetupReferenceCommand(value, scope, "Address")).toThrow();
  expect(calls).toBe(0);
});
it("never borrows address content as a Contact or reads unknown scope accessors", () => {
  expect(() => bindMerchantStoreSetupReferenceCommand(save(), scope, "Contact")).toThrow();
  let calls = 0;
  const actual = { ...scope };
  Object.defineProperty(actual, "actorReference", {
    enumerable: true,
    get() {
      calls++;
      return id(4);
    },
  });
  expect(() => bindMerchantStoreSetupReferenceCommand(save(), actual, "Address")).toThrow();
  expect(calls).toBe(0);
});
