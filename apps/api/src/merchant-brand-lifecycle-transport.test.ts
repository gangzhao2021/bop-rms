import { expect, it } from "vitest";
import {
  parseMerchantBrandLifecycleRequest,
  parseMerchantBrandLifecycleReceipt,
} from "./merchant-brand-lifecycle-transport.js";
const id = (n: number) => `01902421-1013-7000-8000-${n.toString(16).padStart(12, "0")}`;
const command = {
  brandReference: id(1),
  action: "ActivateBrand" as const,
  expectedBrandVersion: 1,
  operationReference: id(2),
};
const at = "2026-10-06T12:00:00.000Z";
const receipt = () => ({
  profile: "MerchantBrandLifecycleReceiptV1",
  actorReference: id(3),
  ...command,
  status: "Applied",
  lifecycle: "Active",
  version: 2,
  occurredAt: at,
});
it("binds a closed scalar command and its actual historical receipt", () => {
  const parsed = parseMerchantBrandLifecycleRequest(command);
  expect(parsed).toEqual(command);
  expect(Object.isFrozen(parsed)).toBe(true);
  expect(parseMerchantBrandLifecycleReceipt(receipt(), command, id(3), at)).toEqual(receipt());
  expect(
    parseMerchantBrandLifecycleReceipt(
      { ...receipt(), status: "AlreadyApplied" },
      command,
      id(3),
      "2026-10-07T12:00:00.000Z",
    ).occurredAt,
  ).toBe(at);
  const archived = { ...command, action: "ArchiveBrand" as const };
  expect(
    parseMerchantBrandLifecycleReceipt(
      { ...receipt(), ...archived, lifecycle: "Archived" },
      archived,
      id(3),
      at,
    ).lifecycle,
  ).toBe("Archived");
});
it.each([
  { ...command, actorReference: id(3) },
  { ...command, expectedBrandVersion: 0 },
  { ...command, expectedBrandVersion: 2147483647 },
  { ...command, expectedBrandVersion: "1" },
  { ...command, action: "CreateBrand" },
  { ...command, operationReference: "bad" },
  { ...command, brandReference: "bad" },
  { ...command, occurredAt: at },
])("refuses caller authority and malformed command %j", (value) => {
  expect(() => parseMerchantBrandLifecycleRequest(value)).toThrow();
});
it.each([
  { profile: "Other" },
  { actorReference: id(4) },
  { brandReference: id(4) },
  { operationReference: id(4) },
  { action: "ArchiveBrand" },
  { expectedBrandVersion: 2 },
  { status: "Abandoned" },
  { lifecycle: "Draft" },
  { version: 3 },
  { version: "2" },
  { occurredAt: "2026-10-06T12:00:00.001Z" },
  { auditReference: id(8) },
])("refuses forged or unrelated successful output %j", (patch) => {
  expect(() =>
    parseMerchantBrandLifecycleReceipt({ ...receipt(), ...patch }, command, id(3), at),
  ).toThrow();
});
it("refuses accessors without invoking them", () => {
  let called = false;
  const value = { ...command };
  Object.defineProperty(value, "action", {
    enumerable: true,
    get() {
      called = true;
      return "ActivateBrand";
    },
  });
  expect(() => parseMerchantBrandLifecycleRequest(value)).toThrow();
  expect(called).toBe(false);
});
