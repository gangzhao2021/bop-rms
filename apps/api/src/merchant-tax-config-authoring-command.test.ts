import { expect, it } from "vitest";
import {
  bindMerchantTaxConfigAuthoringCommand,
  bindMerchantTaxConfigAuthoringResolve,
  parseMerchantTaxConfigAuthoringScope,
} from "./merchant-tax-config-authoring-command.js";
const id = (n: number) => `018ff810-0000-7000-8000-${n.toString(16).padStart(12, "0")}`;
const content = {
  stableCode: "SYNTHETIC_TAX",
  effectivePeriod: {
    timeZone: "America/Toronto",
    effectiveFrom: {
      instant: "2026-08-01T04:00:00.000Z",
      localDateTime: "2026-08-01T00:00:00.000",
      utcOffsetMinutes: -240,
    },
    effectiveUntil: null,
  },
  rules: [],
};
const command = () => ({
  action: "CreateDraft",
  operationReference: id(5),
  configurationReference: null,
  expectedAggregateVersion: null,
  content,
});
const resolve = () => ({
  action: "CreateDraft",
  operationReference: id(5),
  configurationReference: null,
  expectedAggregateVersion: null,
  intentDigest: "sha256:" + "a".repeat(64),
});
it("binds an explicit first-create null identity without allocating a server root", () => {
  const parsed = bindMerchantTaxConfigAuthoringCommand(command());
  expect(parsed.configurationReference).toBeNull();
  expect(parsed.content.rules).toEqual([]);
  expect(Object.isFrozen(parsed.content)).toBe(true);
});
it("binds replacement only with the actual root and expected revision", () => {
  expect(
    bindMerchantTaxConfigAuthoringCommand({
      ...command(),
      action: "ReplaceDraft",
      configurationReference: id(6),
      expectedAggregateVersion: 1,
    }),
  ).toMatchObject({ action: "ReplaceDraft", expectedAggregateVersion: 1 });
});
it("preserves original payload-free Create identity on Resolve", () => {
  expect(bindMerchantTaxConfigAuthoringResolve(resolve())).toEqual(resolve());
});
it.each([
  "tenantReference",
  "actorReference",
  "currencyMetadata",
  "professionalEvidence",
  "approval",
  "purposeCode",
])("rejects injected %s", (field) => {
  expect(() =>
    bindMerchantTaxConfigAuthoringCommand({ ...command(), [field]: id(7) }),
  ).toThrowError(expect.objectContaining({ code: "TAX_CONFIG_INPUT_INVALID" }));
});
it("rejects Publish and mismatched first-create CAS pins", () => {
  for (const value of [
    { ...command(), action: "Publish" },
    { ...command(), configurationReference: id(6) },
    { ...command(), expectedAggregateVersion: 1 },
  ])
    expect(() => bindMerchantTaxConfigAuthoringCommand(value)).toThrow();
});
it("rejects getter input without invoking it", () => {
  let called = false;
  const value = { ...command() };
  Object.defineProperty(value, "content", {
    enumerable: true,
    get() {
      called = true;
      return content;
    },
  });
  expect(() => bindMerchantTaxConfigAuthoringCommand(value)).toThrow();
  expect(called).toBe(false);
});
it("does not accept content or result identity in a Resolve request", () => {
  expect(() => bindMerchantTaxConfigAuthoringResolve({ ...resolve(), content })).toThrow();
});
it("detaches the complete authored content before dispatch", () => {
  const value = structuredClone(command());
  const parsed = bindMerchantTaxConfigAuthoringCommand(value);
  value.content.stableCode = "CHANGED";
  expect(parsed.content.stableCode).toBe("SYNTHETIC_TAX");
});
it("validates exact scope4 independently of browser command fields", () => {
  const scope = {
    tenantReference: id(1),
    brandReference: id(2),
    storeReference: id(3),
    actorReference: id(4),
  };
  expect(parseMerchantTaxConfigAuthoringScope(scope)).toEqual(scope);
  expect(() =>
    parseMerchantTaxConfigAuthoringScope({ ...scope, sessionReference: id(9) }),
  ).toThrow();
});
