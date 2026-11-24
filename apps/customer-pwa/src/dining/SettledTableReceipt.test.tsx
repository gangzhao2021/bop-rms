import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, expect, it } from "vitest";
import { LanguageRoot } from "../i18n/i18n.js";
import { parseSettledTableReceipt, SettledTableReceiptView } from "./SettledTableReceipt.js";

/**
 * Batch 60 (v15 b59 live, L59S B): staff comp 1 of 2 Beef noodles. The guest's receipt keeps the
 * line at its price and says one of the two bowls was on the house, never that both were.
 */
afterEach(() => {
  renderToStaticMarkup(<LanguageRoot initial="en">{() => null}</LanguageRoot>);
});
const receipt = (item: Record<string, unknown>) => ({
  schemaVersion: 1,
  receipt: {
    tableLabel: "L59S B (TEST)",
    rounds: [
      {
        roundNumber: 1,
        fromTableLabel: null,
        items: [item, { displayName: "Tea", subtotalMinor: "380", reduced: null }],
      },
    ],
    subtotalMinor: "1630",
    taxMinor: "212",
    ordersTotalMinor: "1842",
    tipMinor: "0",
    roundingMinor: "0",
    paidMinor: "1842",
    split: false,
    payments: [{ partNumber: null, method: "CardMachine", totalMinor: "1842" }],
  },
});
const noodles = {
  displayName: "Beef noodles (TEST)",
  subtotalMinor: "2500",
  reduced: "Comp",
  compedQuantity: 1,
  quantity: 2,
};
const html = (payload: unknown, language: "en" | "zh-Hans" = "en") =>
  renderToStaticMarkup(
    <LanguageRoot initial={language}>
      {() => <SettledTableReceiptView receipt={parseSettledTableReceipt(payload)} />}
    </LanguageRoot>,
  );

it("says 1 of 2 on the house beside the line, which keeps its price", () => {
  const page = html(receipt(noodles));
  expect(page).toContain("<dt>Beef noodles (TEST) · 1 of 2 on the house</dt><dd>$25.00</dd>");
  expect(page).not.toContain("Beef noodles (TEST) · On the house");
  // A line comped whole reads as before.
  const whole = html(receipt({ ...noodles, compedQuantity: undefined, quantity: undefined }));
  expect(whole).toContain("<dt>Beef noodles (TEST) · On the house</dt>");
});

it("says it in Chinese", () => {
  expect(html(receipt(noodles), "zh-Hans")).toContain(
    "Beef noodles (TEST) · 2 份中的 1 份店家赠送",
  );
});

it("reads the count strictly: only for a comp, and fewer than the line has", () => {
  for (const broken of [
    { ...noodles, compedQuantity: 0 },
    { ...noodles, compedQuantity: 2 },
    { ...noodles, quantity: undefined },
    { ...noodles, compedQuantity: "1" },
    { ...noodles, reduced: "Discount" },
  ])
    expect(() => parseSettledTableReceipt(receipt(broken))).toThrow();
});
