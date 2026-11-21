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
  it("offers one tap to join the scanned table, and the code entry only on request", () => {
    const html = renderToStaticMarkup(<DiningAdmissionView state="Ready" online />);
    expect(html).toContain("Join this table</button>");
    expect(html).toContain("I have a join code");
    expect(html).not.toContain("<input");
  });
  it.each([
    ["QrPaused", "paused joining by scan", true],
    ["NotOpen", "isn’t open yet", false],
    ["CheckingOut", "paying the bill", false],
    ["TableBusy", "Many phones joined", false],
  ] as const)("explains a %s refusal in plain words", (state, text, code) => {
    const html = renderToStaticMarkup(<DiningAdmissionView state={state} online />);
    expect(html).toContain(text);
    expect(html.includes("<input")).toBe(code);
    // Paused: only the code entry; otherwise the guest can tap again once staff have helped.
    expect(html.includes("Join this table</button>")).toBe(!code);
  });
  describe("DEC-DINING-GUEST-TABLE-START: a guest who came to start this table", () => {
    const starting = (state: DiningAdmissionUiState) =>
      renderToStaticMarkup(<DiningAdmissionView state={state} online starting />);
    it("is not told to join people or to ask anyone for a code", () => {
      for (const state of ["NotOpen", "TableBusy", "BeingCleaned", "TableInUse"] as const) {
        const html = starting(state);
        expect(html).toContain("Order at this table");
        expect(html).not.toContain("Tap to join the people");
        expect(html).not.toContain("I have a join code");
      }
    });
    it.each(["NotOpen", "TableBusy"] as const)(
      "%s says this table can't be started, and can be tried again",
      (state) => {
        const html = starting(state);
        expect(html).toContain("This table can’t be started just now");
        expect(html).toContain("Try again</button>");
        expect(html).not.toContain("Join this table</button>");
        expect(html).not.toContain("Many phones joined");
      },
    );
    it("people turning up at the table first can be joined, and that is true of whoever they are", () => {
      const html = starting("TableInUse");
      expect(html).toContain("People are using this table. If you’re together, join them");
      expect(html).toContain("Join this table</button>");
      expect(html).not.toContain("just ordered");
    });
    it("a staff pause still asks for the code", () => {
      expect(starting("QrPaused")).toContain("<input");
    });
    it("shows no choice while the join is on its way", () => {
      expect(starting("Ready")).not.toContain("<button");
    });
  });
  it("provides protected unpopulated input with explicit help and accessible labels", () => {
    const html = renderToStaticMarkup(<DiningAdmissionView state="Ready" online codeMode />);
    expect(html).toContain('type="password"');
    expect(html).toContain('autoComplete="off"');
    expect(html).toContain('for="dining-join-credential"');
    expect(html).toContain('aria-describedby="dining-admission-help"');
    expect(html).not.toMatch(/value=|name=/u);
    expect(html).toContain("for the table’s join code");
  });
  it.each([
    ["Invalid", "Enter the six-digit code"],
    ["Joining", "Checking your table connection"],
    ["Unknown", "We couldn’t add you to the table just now. Please try again."],
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
    expect(html).not.toContain("Try again</button>");
    expect(html).not.toContain("couldn’t add you to the table");
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
