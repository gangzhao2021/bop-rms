import { describe, expect, it } from "vitest";
import { supportCasePageFixture } from "./support-case-pages.fixtures.js";
import { parseSupportCasePageView } from "./support-case-pages.js";
describe("WP-2198 Support Case screen contract", () => {
  it("parses exact Platform access and safe Case metadata", () => {
    const view = parseSupportCasePageView(supportCasePageFixture);
    expect(view.screenId).toBe("PLT-SUPPORT-CASE");
    expect(view.cases[0]?.accessExpiresAt).toBe("2026-08-15T16:15:00.000Z");
  });
  it("rejects surplus, unverified and malformed grant metadata", () => {
    expect(() => parseSupportCasePageView({ ...supportCasePageFixture, secret: "leak" })).toThrow(
      "SUPPORT_CASE_PAGE_INVALID",
    );
    expect(() =>
      parseSupportCasePageView({
        ...supportCasePageFixture,
        cases: [{ ...supportCasePageFixture.cases[0], accessExpiresAt: "15 minutes" }],
      }),
    ).toThrow("SUPPORT_CASE_PAGE_INVALID");
  });
});
