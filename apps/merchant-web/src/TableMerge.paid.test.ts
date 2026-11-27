import { afterEach, describe, expect, it } from "vitest";
import { setLanguageForTest } from "./i18n/i18n.js";
import type { StaffDiningTable } from "./dining-session-client.js";
import { mergeTargetProblem } from "./TableMerge.js";

/**
 * b63 (F32, v15 D62DV): the Merge into… list named a table paid in full "— checking out"
 * (zh "——正在结账") while its own row read "Paid · close when the guests leave".
 */
const table = (reference: string, phase: "Active" | "Closing") =>
  ({
    tableReference: reference,
    stableLabel: reference,
    currentDiningSessionReference: "s-" + reference,
    paymentTiming: "PayLater",
    session: { phase, version: 3, orderReference: "o-" + reference, paymentStarted: false },
  }) as unknown as StaffDiningTable;

describe("b63: a paid table in the Merge into… list", () => {
  afterEach(() => setLanguageForTest("en"));
  it("reads paid, as its row does, and checking out only while money is owed", () => {
    expect(mergeTargetProblem(table("C", "Active"), table("A", "Closing"), true)).toBe("paid");
    expect(mergeTargetProblem(table("C", "Active"), table("A", "Closing"), false)).toBe(
      "checking out",
    );
    setLanguageForTest("zh-Hans");
    expect(mergeTargetProblem(table("C", "Active"), table("A", "Closing"), true)).toBe("已付清");
  });
});
