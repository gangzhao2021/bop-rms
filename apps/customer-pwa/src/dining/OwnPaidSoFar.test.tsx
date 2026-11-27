// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { LanguageRoot } from "../i18n/i18n.js";
import { OwnPaidSoFarView, parseOwnPaymentReceipt } from "./OwnPaymentReceipt.js";

// Batch 65 (v15 b64 live, guest-split-own-payment): one phone paid both parts of staff's even
// split ($16.01 with a $1.88 tip, $15.37 with $1.25) and the table was still open. Under "Every
// part of the bill is paid" each part's block ended in its own "Total paid by you" ($16.01, then
// $15.37), with no "Your payments" heading and no one total. The body is the own-payment read's.
const part = (partNumber: number, paidFor: string, tip: string, total: string) => ({
  covers: "Part",
  partNumber,
  partCount: 2,
  dishes: [],
  subtotalMinor: null,
  taxMinor: null,
  paidForMinor: paidFor,
  tipMinor: tip,
  totalMinor: total,
  method: "Online",
  paidAt: "2026-11-25T20:10:00.000Z",
});
const bothParts = {
  schemaVersion: 1,
  ownPayment: {
    tableLabel: "G64 A (TEST)",
    restClosedByStaff: false,
    tablePaidInFull: true,
    payments: [part(1, "1413", "188", "1601"), part(2, "1412", "125", "1537")],
    totalMinor: "3138",
  },
};
const onePart = {
  ...bothParts,
  ownPayment: {
    ...bothParts.ownPayment,
    tablePaidInFull: false,
    payments: [part(1, "1413", "188", "1601")],
    totalMinor: "1601",
  },
};

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let container: HTMLDivElement, root: Root;
beforeEach(() => {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
});
const rows = () =>
  [...container.querySelectorAll("dl > div")].map((row) =>
    (row.textContent ?? "").replace(/\s+/gu, " ").trim(),
  );
async function show(body: unknown, language: "en" | "zh-Hans") {
  await act(async () => {
    root.render(
      <LanguageRoot initial={language}>
        {() => <OwnPaidSoFarView receipt={parseOwnPaymentReceipt(body)} />}
      </LanguageRoot>,
    );
  });
}

describe("batch 65: both parts paid on this phone, table open", () => {
  it("one Your payments heading, each part with how and how much, one total (en)", async () => {
    await show(bothParts, "en");
    expect(container.querySelector(".dining-session__you-paid-line")?.textContent).toBe(
      "You paid $31.38 (tip $3.13) · Online by phone",
    );
    expect(container.querySelector("h3#own-your-payments")?.textContent).toBe("Your payments");
    expect(container.querySelectorAll("h3")).toHaveLength(1);
    expect(rows()).toEqual([
      "Part 1 · Online by phone$16.01",
      "Part 2 · Online by phone$15.37",
      "Total paid by you$31.38",
    ]);
  });

  it("zh-Hans: 您的付款 / 第 1 份 · 手机在线付款 / 您实付合计 once", async () => {
    await show(bothParts, "zh-Hans");
    expect(container.querySelector("h3#own-your-payments")?.textContent).toBe("您的付款");
    expect(rows()).toEqual([
      "第 1 份 · 手机在线付款$16.01",
      "第 2 份 · 手机在线付款$15.37",
      "您实付合计$31.38",
    ]);
  });

  it("one part paid: its own lines as before, no Your payments heading", async () => {
    await show(onePart, "en");
    expect(container.querySelector("#own-your-payments")).toBeNull();
    expect(container.textContent).toContain("Part 1 of 2 of your table’s bill");
    expect(rows()).toContain("Total paid by you$16.01");
  });
});
