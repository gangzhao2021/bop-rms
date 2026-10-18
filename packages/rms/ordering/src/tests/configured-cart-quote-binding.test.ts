import { describe, expect, it } from "vitest";
import { bindConfiguredCartQuote } from "../application/configured-cart-quote-binding.js";
import { fixture, id } from "./configured-cart-quote.fixture.js";
describe("configured Quote Cart binding", () => {
  it.each([false, true])("matches complete selected-option evidence for Dining=%s", (dining) => {
    const f = fixture(dining);
    expect(bindConfiguredCartQuote(f)).toEqual(f.quote);
  });
  it.each([
    "binding",
    "version",
    "quantity",
    "classification",
    "channel",
    "cartVersion",
    "missing",
    "future",
  ] as const)("rejects mismatched %s", (kind) => {
    const f = fixture(),
      row = f.catalogLines[0],
      item = f.cart.items[0];
    if (row === undefined || item === undefined) throw new Error("synthetic fixture missing");
    const option = row.snapshot.options[0];
    if (option === undefined) throw new Error("synthetic option missing");
    if (kind === "binding") {
      Object.assign(option, { bindingReference: id(80) });
      item.catalogSelectionEvidence.ruleEvidence.push({
        bindingReference: id(80) as never,
        optionSetVersionReference: id(64),
      });
    }
    if (kind === "version") option.optionSetVersionReference = id(81);
    if (kind === "quantity") option.quantity = 2;
    if (kind === "classification")
      Object.assign(row.snapshot, { taxClassificationReference: id(82) });
    if (kind === "channel") Object.assign(f, { pricingChannelCode: "OTHER_CHANNEL" });
    if (kind === "cartVersion") f.cart.aggregateVersion++;
    if (kind === "missing") f.catalogLines = [];
    if (kind === "future") row.snapshot.capturedAt = "2026-08-02T16:00:01.000Z";
    expect(() => bindConfiguredCartQuote(f)).toThrowError(
      expect.objectContaining({ code: "CART_QUOTE_INVALID" }),
    );
  });
  it("rejects expiry while retaining the dedicated refresh outcome", () => {
    const f = fixture();
    expect(() => bindConfiguredCartQuote({ ...f, observedAt: f.quote.expiresAt })).toThrowError(
      expect.objectContaining({ code: "CART_QUOTE_EXPIRED" }),
    );
  });
});
