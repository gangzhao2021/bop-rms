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
});
