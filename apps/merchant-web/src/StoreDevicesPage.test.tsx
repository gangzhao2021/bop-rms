import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { findInternalText, staticText } from "../e2e/internal-text-patterns.js";
import { StaffPinError, type StoreDevicesRead } from "./staff-pin-client.js";
import {
  commandFailureOutcome,
  commandFailureText,
  FULL_SIGN_IN_GUIDANCE,
  removedText,
  staffPinStatusText,
  StoreDevicesView,
  type DevicesLoad,
} from "./StoreDevicesPage.js";

const at = "2026-10-14T18:00:00.000Z";
const now = Date.parse("2026-10-14T19:30:00.000Z");
const device = {
  device: "d-1",
  label: "Front counter",
  registeredAt: at,
  registeredBy: "Mia Manager",
  lastUsedAt: null,
};
const full: StoreDevicesRead = {
  thisDevice: null,
  devices: [device],
  staffPins: [
    { staff: "s-1", name: "Ana", state: "Set", changedAt: at, lockedUntil: null },
    { staff: "s-2", name: "Ben", state: "NotSet", changedAt: null, lockedUntil: null },
    {
      staff: "s-3",
      name: "Cy",
      state: "Set",
      changedAt: at,
      lockedUntil: "2026-10-14T19:45:00.000Z",
    },
    { staff: "s-4", name: "Di", state: "Reset", changedAt: at, lockedUntil: null },
  ],
};
const noop = () => undefined;
const view = (
  load: DevicesLoad,
  needsVerification = false,
  message: { readonly tone: "neutral" | "error"; readonly text: string } | null = null,
) =>
  renderToStaticMarkup(
    <StoreDevicesView
      load={load}
      storeLabel="Queen St"
      timeZone="America/Toronto"
      now={now}
      label=""
      busy={false}
      message={message}
      needsVerification={needsVerification}
      verification={<button type="button">Verify with authenticator app</button>}
      pending={null}
      onLabel={noop}
      onRegister={noop}
      onAsk={noop}
      onRefresh={noop}
    />,
  );
const plain = (html: string) => expect(findInternalText([staticText(html)])).toEqual([]);

describe("Shared tablets & PINs", () => {
  it("offers to set up this tablet and lists tablets and staff PINs", () => {
    const html = view({ kind: "Ready", read: full });
    expect(html).toContain("Shared tablets &amp; PINs");
    expect(html).toContain("This tablet");
    expect(html).toContain("Tablet name");
    expect(html).toContain("Set up this tablet for staff PINs");
    expect(html).toContain(
      "Staff can then switch to themselves here with their 6-digit PIN. Refunds, price and staff changes still need a full sign-in.",
    );
    expect(html).toContain("Front counter");
    expect(html).toContain("Mia Manager");
    expect(html).toContain("Oct 14, 2:00 PM");
    expect(html).toContain("Not used yet");
    expect(html).toContain('aria-label="Remove Front counter"');
    expect(html).toContain("Locked until 3:45 PM");
    expect(html).toContain("Reset — waiting for a new PIN");
    expect(html).toContain("No PIN");
    // Reset is offered only where a PIN is set.
    expect(html.match(/>Reset PIN</gu)).toHaveLength(2);
    expect(html).not.toContain("d-1");
    expect(html).not.toContain("s-1");
    plain(html);
  });
  it("names this tablet once it is set up", () => {
    const html = view({
      kind: "Ready",
      read: { ...full, thisDevice: { device: "d-1", label: "Front counter" } },
    });
    expect(html).toContain("This tablet is set up as “Front counter”.");
    expect(html).toContain("Front counter (this tablet)");
    expect(html).not.toContain("Set up this tablet for staff PINs");
  });
  it("hides sections the person may not use, with no placeholder", () => {
    const pinsOnly = view({ kind: "Ready", read: { ...full, devices: null } });
    expect(pinsOnly).not.toContain("This tablet");
    expect(pinsOnly).not.toContain("Shared tablets</h2>");
    expect(pinsOnly).toContain("Staff PINs");
    const tabletsOnly = view({ kind: "Ready", read: { ...full, staffPins: null } });
    expect(tabletsOnly).not.toContain("Staff PINs");
    expect(tabletsOnly).toContain("Shared tablets</h2>");
    plain(pinsOnly);
    plain(tabletsOnly);
  });
  it("shows loading, no access, offline and verification guidance in plain words", () => {
    plain(view({ kind: "Loading" }));
    expect(view({ kind: "Denied" })).toContain("No access");
    const offline = view({ kind: "Offline" });
    expect(offline).toContain("Try again");
    plain(offline);
    plain(view({ kind: "Failed" }));
    const verify = view({ kind: "Ready", read: full }, true);
    expect(verify).toContain("You signed in with a PIN. Confirm it&#x27;s you");
    expect(verify).toContain("Verify with authenticator app");
  });
  it("shows the PIN sign-in guidance once when a change or the list needs verification", () => {
    const guidance = "You signed in with a PIN. Confirm it&#x27;s you";
    const outcome = commandFailureOutcome(new StaffPinError("FullSignInRequired"), "Register");
    expect(outcome).toEqual({ needsVerification: true, message: null });
    const afterCommand = view({ kind: "Ready", read: full }, true, outcome.message);
    expect(afterCommand.split(guidance)).toHaveLength(2);
    expect(afterCommand).not.toContain("Not done");
    const afterLoad = view({ kind: "NeedsVerification" }, true);
    expect(afterLoad.split(guidance)).toHaveLength(2);
    expect(afterLoad).not.toContain("Couldn&#x27;t load this page");
    expect(afterLoad).toContain("Verify with authenticator app");
    plain(afterLoad);
    expect(commandFailureOutcome(new StaffPinError("Denied"), "Register")).toEqual({
      needsVerification: false,
      message: {
        tone: "error",
        text: "You don't have permission to do this. Ask the store owner.",
      },
    });
  });
  it("explains outcomes and conflicts", () => {
    expect(removedText("Front counter", 0)).toBe(
      "Front counter is removed. No one was signed in on it with a PIN.",
    );
    expect(removedText("Front counter", 2)).toBe(
      "Front counter is removed. 2 people were signed out.",
    );
    expect(commandFailureText(new StaffPinError("FullSignInRequired"), "Register")).toBe(
      FULL_SIGN_IN_GUIDANCE,
    );
    expect(commandFailureText(new StaffPinError("AlreadyRegistered"), "Register")).toBe(
      "This tablet is already set up. The page is refreshed.",
    );
    expect(commandFailureText(new StaffPinError("NotFound"), { kind: "Remove", device })).toBe(
      "Front counter was already removed. The list is refreshed.",
    );
    const person = full.staffPins?.[0];
    if (person === undefined) throw new Error("fixture");
    expect(commandFailureText(new StaffPinError("PinNotSet"), { kind: "Reset", person })).toBe(
      "Ana has no PIN to reset. The list is refreshed.",
    );
    expect(staffPinStatusText(person, "America/Toronto", now)).toBe("PIN set");
  });
});
