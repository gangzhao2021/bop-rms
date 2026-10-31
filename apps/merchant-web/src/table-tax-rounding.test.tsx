import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { parseTableBill } from "./table-checkout-client.js";
import { splitBillFixture } from "./table-split.fixtures.js";

describe("WP-2423 DEC-TAX-WHOLE-RECEIPT: the bill's tax rounding at the Tables checkout", () => {
  it("reads the bill's and each round's tax rounding, signed, and 0 from an older server", () => {
    const value = splitBillFixture();
    const rounds = value.rounds as Record<string, unknown>[];
    expect(parseTableBill(value).taxRoundingMinor).toBe("0");
    expect(parseTableBill(value).rounds.map((round) => round.taxRoundingMinor)).toEqual(["0", "0"]);
    value.taxRoundingMinor = "-1";
    rounds[1] = { ...rounds[1], taxRoundingMinor: "-1" };
    const bill = parseTableBill(value);
    expect(bill.taxRoundingMinor).toBe("-1");
    expect(bill.rounds[1]?.taxRoundingMinor).toBe("-1");
    for (const broken of ["--1", "-0", "1.5", 1])
      expect(() => parseTableBill({ ...value, taxRoundingMinor: broken })).toThrow();
    expect(renderToStaticMarkup(<p>{bill.taxRoundingMinor}</p>)).toContain("-1");
  });
});
