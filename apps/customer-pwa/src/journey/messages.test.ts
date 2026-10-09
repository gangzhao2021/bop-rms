import { describe, expect, it } from "vitest";
import {
  cartIssueMessage,
  cartItemWarningMessage,
  lineEstimateLabel,
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
