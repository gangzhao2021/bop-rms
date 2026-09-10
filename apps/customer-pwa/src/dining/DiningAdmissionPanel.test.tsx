import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import {
  DiningAdmissionPanel,
  DiningAdmissionView,
  type DiningAdmissionUiState,
} from "./DiningAdmissionPanel.js";
describe("contextual Dining admission screen", () => {
  it("defaults to unavailable without runtime injection", () => {
    const html = renderToStaticMarkup(<DiningAdmissionPanel />);
    expect(html).toContain("Table joining is unavailable");
    expect(html).not.toContain("<input");
  });
  it("provides protected unpopulated input with explicit help and accessible labels", () => {
    const html = renderToStaticMarkup(<DiningAdmissionView state="Ready" online />);
    expect(html).toContain('type="password"');
    expect(html).toContain('autoComplete="off"');
    expect(html).toContain('for="dining-join-credential"');
    expect(html).toContain('aria-describedby="dining-admission-help"');
    expect(html).not.toMatch(/value=|name=/u);
    expect(html).toContain("Scanning the table QR code alone does not join the table");
  });
  it.each([
    ["Invalid", "Enter the six-digit code"],
    ["Joining", "Checking your table connection"],
    ["Unknown", "Recover this attempt"],
    ["Bound", "No order has been placed"],
    ["Unavailable", "Ask staff for help"],
  ] as const)("renders explicit %s state", (state, text) => {
    const html = renderToStaticMarkup(<DiningAdmissionView state={state} online />);
    expect(html).toContain(text);
    if (state !== "Invalid") expect(html).not.toContain("<input");
    if (state === "Invalid") expect(html).toContain('aria-invalid="true"');
    if (state === "Joining") expect(html).toContain('aria-busy="true"');
    if (state === "Unknown") expect(html).toContain('role="alert"');
  });
  it.each(["Ready", "Invalid", "Unknown"] as DiningAdmissionUiState[])(
    "disables %s action offline",
    (state) => {
      const html = renderToStaticMarkup(<DiningAdmissionView state={state} online={false} />);
      expect(html).toContain("Joining and recovery are paused");
      expect(html).toContain('disabled=""');
    },
  );
});
