import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { findInternalText, staticText } from "../e2e/internal-text-patterns.js";
import { StaffPinError } from "./staff-pin-client.js";
import {
  keyboardPinKey,
  pressPinKey,
  StaffSwitchView,
  switchMessageFor,
  switchMessageText,
  type SwitchEntry,
  type SwitchLoad,
} from "./StaffSwitchPage.js";

const entry = { path: "/internal-test/staff", testOnly: true };
const ready: SwitchLoad = {
  kind: "Ready",
  storeLabel: "Queen St",
  timeZone: "America/Toronto",
  staff: [
    { choice: "c-1", name: "Ana" },
    { choice: "c-2", name: "Ben" },
  ],
  fullSignIn: entry,
};
const noop = () => undefined;
const view = (load: SwitchLoad, current: SwitchEntry | null = null) =>
  renderToStaticMarkup(
    <StaffSwitchView
      load={load}
      entry={current}
      now={Date.parse("2026-10-14T19:30:00.000Z")}
      onRetry={noop}
      onChoose={noop}
      onKey={noop}
      onBack={noop}
    />,
  );
const plain = (html: string) => expect(findInternalText([staticText(html)])).toEqual([]);

describe("keypad", () => {
  it("adds up to six digits, deletes and clears", () => {
    let pin = "";
    for (const key of ["4", "8", "2", "9", "1", "3", "7"] as const) pin = pressPinKey(pin, key);
    expect(pin).toBe("482913");
    expect(pressPinKey(pin, "Delete")).toBe("48291");
    expect(pressPinKey(pin, "Clear")).toBe("");
  });
  it("maps a physical keyboard", () => {
    expect(keyboardPinKey("7")).toBe("7");
    expect(keyboardPinKey("Backspace")).toBe("Delete");
    expect(keyboardPinKey("Escape")).toBe("Clear");
    expect(keyboardPinKey("a")).toBeNull();
  });
});

describe("messages", () => {
  it("explains wrong, locked, busy and down answers in plain words", () => {
    expect(
      switchMessageText(switchMessageFor(new StaffPinError("Rejected")), "Ana", undefined),
    ).toBe("That PIN didn't match. Try again. After 5 wrong tries the PIN locks for 15 minutes.");
    expect(
      switchMessageText(
        switchMessageFor(new StaffPinError("Locked", { lockedUntil: "2026-10-14T19:45:00.000Z" })),
        "Ana",
        "America/Toronto",
      ),
    ).toBe(
      "Too many wrong PINs. Ana's PIN is locked until 3:45 PM. Ask a manager to reset it, or sign in with your account.",
    );
    expect(
      switchMessageText(
        switchMessageFor(new StaffPinError("Busy", { retryAfterSeconds: 61 })),
        "Ana",
        undefined,
      ),
    ).toBe("Too many tries on this tablet. Wait 2 minutes, or sign in with your account.");
    expect(
      switchMessageText(
        switchMessageFor(new StaffPinError("Busy", { retryAfterSeconds: 30 })),
        "Ana",
        undefined,
      ),
    ).toBe("Too many tries on this tablet. Wait 1 minute, or sign in with your account.");
    expect(switchMessageText(switchMessageFor(new Error("x")), "Ana", undefined)).toBe(
      "Couldn't check the PIN. Check the connection and try again.",
    );
  });
});

describe("screen", () => {
  it("lists names only, with the sign-in and the PIN hint", () => {
    const html = view(ready);
    expect(html).toContain("Switch staff · Queen St");
    expect(html).toContain("Who&#x27;s working?");
    expect(html).toContain(">Ana</button>");
    expect(html).toContain(">Ben</button>");
    expect(html).not.toContain("c-1");
    expect(html).toContain("Sign in with your account");
    expect(html).toContain("TEST-ONLY");
    expect(html).toContain("choose “My PIN” to set one");
    plain(html.replace("TEST-ONLY", ""));
  });
  it("shows only how many digits were typed, never the digits", () => {
    const html = view(ready, {
      person: { choice: "c-1", name: "Ana" },
      pinLength: 3,
      busy: false,
      message: { kind: "Rejected" },
      heldUntil: null,
    });
    expect(html).toContain("Enter Ana&#x27;s PIN");
    expect(html.match(/data-filled="true"/gu)).toHaveLength(3);
    expect(html).toContain("3 of 6 digits entered");
    expect(html).toContain("After 5 wrong tries the PIN locks for 15 minutes.");
    expect(html).toContain("Not Ana? Choose someone else");
    for (const key of ["0", "1", "9", "Delete", "Clear"])
      expect(html).toContain(`data-key="${key}"`);
    plain(html.replace("TEST-ONLY", ""));
  });
  it("holds the keypad while a PIN is locked", () => {
    const html = view(ready, {
      person: { choice: "c-1", name: "Ana" },
      pinLength: 0,
      busy: false,
      message: { kind: "Locked", until: "2026-10-14T19:45:00.000Z" },
      heldUntil: Date.parse("2026-10-14T19:45:00.000Z"),
    });
    expect(html).toContain("Ana&#x27;s PIN is locked until 3:45 PM");
    expect(html).toMatch(/data-key="5" disabled=""/u);
  });
  it("explains a tablet that is not set up, an empty list and a lost connection", () => {
    const unregistered = view({ kind: "NotRegistered", fullSignIn: { ...entry, testOnly: false } });
    expect(unregistered).toContain("This tablet isn&#x27;t set up for staff PINs");
    expect(unregistered).toContain("“Shared tablets &amp; PINs”");
    expect(unregistered).toContain("Sign in with your account");
    plain(unregistered);
    const empty = view({ ...ready, staff: [] } as SwitchLoad);
    expect(empty).toContain("No one has set a PIN for this store yet.");
    expect(empty).toContain("Sign in with your account");
    const offline = view({ kind: "Offline" });
    expect(offline).toContain("No connection");
    expect(offline).toContain("Try again");
    plain(offline);
    plain(view({ kind: "Unavailable" }));
  });
});
