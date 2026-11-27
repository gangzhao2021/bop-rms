import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { findInternalText, staticText } from "../e2e/internal-text-patterns.js";
import { createStaffPinClient, StaffPinError, type PinStatus } from "./staff-pin-client.js";
import {
  PIN_FULL_SIGN_IN_TEXT,
  PIN_SESSION_NOTICE,
  pinSaveFailureText,
  pinStateText,
  primePinStatus,
  StaffPinControls,
} from "./StaffPinControls.js";

const csrf = "a".repeat(43);
const at = "2026-10-14T19:45:00.000Z";
const render = (status: PinStatus | null) => {
  const client = createStaffPinClient(csrf, () => Promise.reject(new Error("not used")));
  if (status !== null) primePinStatus(client, status);
  return renderToStaticMarkup(
    <StaffPinControls csrf={csrf} timeZone="America/Toronto" client={client} />,
  );
};
const plain = (html: string) => expect(findInternalText([staticText(html)])).toEqual([]);

describe("My PIN", () => {
  it("describes each PIN state", () => {
    expect(pinStateText({ state: "NotSet", changedAt: null, lockedUntil: null }, undefined)).toBe(
      "Set a PIN to switch quickly on this store's shared tablets.",
    );
    expect(
      pinStateText({ state: "Set", changedAt: at, lockedUntil: null }, "America/Toronto"),
    ).toBe("PIN set on Oct 14, 2026.");
    expect(pinStateText({ state: "Reset", changedAt: at, lockedUntil: null }, undefined)).toBe(
      "A manager reset your PIN. Set a new one to use the shared tablets.",
    );
  });
  it("explains why a PIN was not saved", () => {
    expect(pinSaveFailureText(new StaffPinError("Invalid", { reason: "Format" }))).toBe(
      "Enter exactly 6 digits.",
    );
    expect(pinSaveFailureText(new StaffPinError("Invalid", { reason: "Mismatch" }))).toBe(
      "The two PINs don't match.",
    );
    expect(pinSaveFailureText(new StaffPinError("Invalid", { reason: "TooSimple" }))).toBe(
      "That PIN is too easy to guess. Choose a different one.",
    );
    expect(pinSaveFailureText(new StaffPinError("FullSignInRequired"))).toBe(PIN_FULL_SIGN_IN_TEXT);
    expect(pinSaveFailureText(new StaffPinError("Offline"))).toBe(
      "Your PIN couldn't be saved. Check the connection and try again.",
    );
  });
  it("offers My PIN with safe fields and asks an account sign-in without a PIN to set one", () => {
    const html = render({
      pin: { state: "NotSet", changedAt: null, lockedUntil: null },
      signIn: "Account",
      verifiedUntil: null,
    });
    expect(html).toContain(">My PIN</button>");
    expect(html).toContain(">Set your PIN</button>");
    expect(html).toContain('type="password"');
    expect(html).toContain('inputMode="numeric"');
    expect(html).toContain('autoComplete="new-password"');
    expect(html).toContain('maxLength="6"');
    expect(html).toContain("6 digits. Avoid easy PINs like 000000 or 123456.");
    expect(html).not.toContain(PIN_SESSION_NOTICE);
    plain(html);
  });
  it("asks for a new PIN after a reset", () => {
    expect(
      render({
        pin: { state: "Reset", changedAt: at, lockedUntil: null },
        signIn: "Account",
        verifiedUntil: null,
      }),
    ).toContain("Your PIN was reset. Set a new one.");
  });
  it("reminds a PIN sign-in what needs verification and offers the authenticator check", () => {
    const html = render({
      pin: { state: "Set", changedAt: at, lockedUntil: null },
      signIn: "Pin",
      verifiedUntil: null,
    });
    expect(html).toContain(PIN_SESSION_NOTICE);
    expect(html).toContain("Verify it&#x27;s you");
    expect(html).toContain("You signed in with a PIN. Confirm it&#x27;s you");
    expect(html).not.toContain(">Set your PIN</button>");
    plain(html);
  });
  it("shows a neutral loading state before the PIN details arrive", () => {
    const html = render(null);
    expect(html).toContain("Loading your PIN details…");
    expect(html).toContain(">My PIN</button>");
  });
});
