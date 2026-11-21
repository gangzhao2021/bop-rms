import { describe, expect, it } from "vitest";
import { findInternalText } from "../../e2e/internal-text-patterns.js";
import {
  cartIssueMessage,
  cartItemWarningMessage,
  cartText,
  checkoutText,
  commonText,
  lineEstimateLabel,
  orderStatusText,
  quoteIssueMessage,
} from "./messages.js";

describe("customer messages for server codes", () => {
  it("never echoes an unknown code and always gives a customer sentence", () => {
    for (const code of ["SYNTHETIC_WARNING", "SOMETHING_NEW", "X"]) {
      expect(cartItemWarningMessage(code)).not.toContain(code);
      expect(quoteIssueMessage(code, true)).not.toContain(code);
      expect(quoteIssueMessage(code, false)).not.toContain(code);
      expect(lineEstimateLabel(code)).not.toContain(code);
    }
    expect(cartIssueMessage("UNKNOWN_CODE")).toBeNull();
  });
  it("hides ownership warnings that the row already explains", () => {
    expect(cartItemWarningMessage("OTHER_PARTICIPANT_ITEM")).toBeNull();
  });
  it("distinguishes blocking reasons from warnings", () => {
    expect(quoteIssueMessage("SYNTHETIC_BLOCK", true)).toContain("can’t be paid yet");
    expect(quoteIssueMessage("SYNTHETIC_WARNING", false)).toContain("review your order");
    expect(quoteIssueMessage("STOCK_RESERVATION_INSUFFICIENT", true)).toContain("no longer");
  });
});

describe("customer text catalog", () => {
  /** Every sentence in the catalogs, with sample values filled into the worded functions. */
  function sentences(value: unknown): string[] {
    if (typeof value === "string") return [value];
    if (typeof value === "function")
      return sentences((value as (...args: unknown[]) => unknown)("$5.00", "$1.00", "$0.50"));
    if (Array.isArray(value)) return value.flatMap(sentences);
    if (value !== null && typeof value === "object") return Object.values(value).flatMap(sentences);
    return [];
  }
  const catalog = sentences([commonText, cartText, checkoutText, orderStatusText]);

  it("reads every state aloud in plain words, never the state's name", () => {
    for (const announcement of Object.values(cartText.stateAnnouncement)) {
      expect(announcement).not.toMatch(/\bstate\b|-/u);
      expect(findInternalText([announcement]), announcement).toEqual([]);
    }
  });
  it("shows the tip in the store currency's sign, not its code", () => {
    expect(checkoutText.tipCustomLabel("$")).toBe("Tip ($)");
  });
  it("keeps one voice: contractions and the typographic apostrophe", () => {
    for (const text of catalog) {
      expect(text, text).not.toMatch(
        /\b(?:cannot|could not|can not|do not|does not|did not|is not|are not|was not|were not|will not|has not|have not|You are|We are)\b/u,
      );
      expect(text, text).not.toMatch(/\w'\w/u);
    }
  });
  it("contains no internal codes or technical terms", () => {
    expect(findInternalText(catalog)).toEqual([]);
  });
});
