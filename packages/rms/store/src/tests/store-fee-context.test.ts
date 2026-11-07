import { describe, expect, it } from "vitest";
import {
  parseStoreFeeContexts,
  parseStoreCompleteFeeContexts,
} from "../contracts/store-fee-context.js";
const id = "01902501-0000-7000-8000-000000000001";
const fees = () => [
  {
    chargeType: "ServiceCharge",
    state: "Enabled",
    taxClassificationReference: id,
    orderTypes: ["Pickup", "DineIn"],
  },
  { chargeType: "DeliveryFee", state: "Disabled" },
  { chargeType: "Tip", state: "Disabled" },
];
describe("shared Store fee context parser", () => {
  it("detaches and canonicalizes explicit complete contexts without rates", () => {
    const input = fees(),
      result = parseStoreCompleteFeeContexts(input);
    input[0] = { chargeType: "Tip", state: "Disabled" };
    expect(result[0]).toMatchObject({
      chargeType: "ServiceCharge",
      orderTypes: ["DineIn", "Pickup"],
    });
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result[0])).toBe(true);
  });
  it("keeps partial intent distinct from complete Disabled", () => {
    const input = [{ chargeType: "ServiceCharge", state: "Unconfigured" }, ...fees().slice(1)];
    expect(parseStoreFeeContexts(input)[0]).toMatchObject({ state: "Unconfigured" });
    expect(() => parseStoreCompleteFeeContexts(input)).toThrow();
  });
  it("rejects getters without invoking them and rejects sparse arrays", () => {
    let invoked = false;
    const input = fees();
    const first = input[0];
    if (first === undefined) throw new Error("missing controlled fee");
    Object.defineProperty(first, "orderTypes", {
      enumerable: true,
      get() {
        invoked = true;
        return ["Pickup"];
      },
    });
    expect(() => parseStoreFeeContexts(input)).toThrow();
    expect(invoked).toBe(false);
    expect(() => parseStoreFeeContexts(new Array(3))).toThrow();
  });
  it("rejects charge reordering, unknown fields and duplicate modes", () => {
    expect(() => parseStoreFeeContexts(fees().reverse())).toThrow();
    expect(() =>
      parseStoreFeeContexts([{ ...fees()[0], rate: "0.1" }, ...fees().slice(1)]),
    ).toThrow();
    expect(() =>
      parseStoreFeeContexts([
        { ...fees()[0], orderTypes: ["Pickup", "Pickup"] },
        ...fees().slice(1),
      ]),
    ).toThrow();
  });
  it("lets an enabled Tip carry no tax classification, never a service charge or delivery fee", () => {
    const tip = {
      chargeType: "Tip",
      state: "Enabled",
      taxClassificationReference: null,
      orderTypes: ["Pickup"],
    };
    expect(parseStoreCompleteFeeContexts([...fees().slice(0, 2), tip])[2]).toEqual({
      chargeType: "Tip",
      state: "Enabled",
      taxClassificationReference: null,
      orderTypes: ["Pickup"],
    });
    // A classified Tip stays valid (data recorded before this decision).
    expect(
      parseStoreFeeContexts([...fees().slice(0, 2), { ...tip, taxClassificationReference: id }])[2],
    ).toMatchObject({ taxClassificationReference: id });
    expect(() =>
      parseStoreFeeContexts([
        { ...fees()[0], taxClassificationReference: null },
        ...fees().slice(1),
      ]),
    ).toThrow();
    expect(() =>
      parseStoreFeeContexts([
        fees()[0],
        {
          chargeType: "DeliveryFee",
          state: "Enabled",
          taxClassificationReference: null,
          orderTypes: ["Pickup"],
        },
        fees()[2],
      ]),
    ).toThrow();
    // Absent is not the same as none: the key stays, so recorded shapes keep four members.
    expect(() =>
      parseStoreFeeContexts([
        ...fees().slice(0, 2),
        { chargeType: "Tip", state: "Enabled", orderTypes: ["Pickup"] },
      ]),
    ).toThrow();
  });
});
