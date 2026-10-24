import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import {
  admissionStateForFailure,
  DiningAdmissionPanel,
  DiningAdmissionView,
  type DiningAdmissionUiState,
} from "./DiningAdmissionPanel.js";
import { DiningAdmissionJourneyError } from "./dining-admission-journey.js";
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
  it.each([
    [
      "CodeUsed",
      "This code was already used. Ask staff, or the person who invited you, for a new one.",
    ],
    [
      "CodeNotAccepted",
      "Check it and try again, or ask staff or the person who invited you for a new one.",
    ],
    ["TooManyAttempts", "Wait a few minutes before trying again, or ask staff for help."],
  ] as const)("returns to code entry with plain guidance for refused %s", (state, text) => {
    const html = renderToStaticMarkup(<DiningAdmissionView state={state} online />);
    expect(html).toContain(text);
    expect(html).toContain("<input");
    expect(html).toContain('aria-invalid="true"');
    expect(html).toContain('aria-describedby="dining-admission-help dining-admission-error"');
    expect(html).toContain('role="alert"');
    // A refusal is final: no recovery of the refused attempt is offered.
    expect(html).not.toContain("Recover this attempt");
    expect(html).not.toContain("couldn’t confirm");
    expect(html).not.toMatch(/dining_join|customer\.dining|409|429/u);
  });
  it.each([
    [new DiningAdmissionJourneyError("code-used"), "CodeUsed"],
    [new DiningAdmissionJourneyError("code-not-accepted"), "CodeNotAccepted"],
    [new DiningAdmissionJourneyError("too-many-attempts"), "TooManyAttempts"],
    [new DiningAdmissionJourneyError("outcome-unknown"), "Unknown"],
    [new DiningAdmissionJourneyError("request-invalid"), "Unknown"],
    [new Error("code-used"), "Unknown"],
    [{ code: "code-used" }, "Unknown"],
  ] as const)("maps failure %# to %s", (error, state) => {
    expect(admissionStateForFailure(error)).toBe(state);
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
