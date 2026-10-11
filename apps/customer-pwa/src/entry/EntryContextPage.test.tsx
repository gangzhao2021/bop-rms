import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router";
import { describe, expect, it, vi } from "vitest";
import { EntryContextView } from "./EntryContextPage.js";
import type { CustomerEntryEstablishedContext, CustomerEntryScreenState } from "./types.js";

const context: CustomerEntryEstablishedContext = Object.freeze({
  brandDisplayName: "BOP Test Kitchen",
  storeDisplayName: "Harbour Test Store",
  publicStoreReference: "018f2a1b-7c3d-7a4e-8b5c-1234567890ab",
  publicTableReference: "018f2a1b-7c3d-7a4e-9b5c-1234567890ab",
  channel: "DineIn",
  operatingState: "Open",
  availableServiceModes: Object.freeze(["DineIn", "Pickup"] as const),
  locale: "en-CA",
  contextExpiresAt: "2026-08-11T20:00:00.000Z",
  csrfToken: "A".repeat(43),
});

function render(state: CustomerEntryScreenState): string {
  return renderToStaticMarkup(
    <MemoryRouter>
      <EntryContextView onContinue={vi.fn()} onRetry={vi.fn()} state={state} />
    </MemoryRouter>,
  );
}

describe("CUST-ENTRY-CONTEXT", () => {
  it("shows the safe public context and never renders credentials or public references", () => {
    const html = render({ kind: "Established", context });
    expect(html).toContain("BOP Test Kitchen");
    expect(html).toContain("Harbour Test Store");
    expect(html).toContain("Ready to order");
    expect(html).toContain("Your table at Harbour Test Store is confirmed for dine-in");
    expect(html).toContain("Dine in, Pickup");
    expect(html).toContain("Continue to menu");
    expect(html).not.toContain(context.publicStoreReference);
    expect(html).not.toContain(String(context.publicTableReference));
    expect(html).not.toContain(context.csrfToken);
  });

  it.each([
    { ...context, channel: "Pickup" as const, publicTableReference: null },
    { ...context, publicTableReference: null },
    { ...context, operatingState: "Closed" as const },
    { ...context, availableServiceModes: ["Pickup"] as const },
  ])("does not offer table admission outside eligible entry context", (next) => {
    expect(render({ kind: "Established", context: next })).not.toContain(
      "dining-admission-heading",
    );
  });
  it("shows unavailable admission honestly for eligible context without runtime", () => {
    expect(render({ kind: "Established", context })).toContain("Table joining is unavailable");
  });

  it("uses explicit non-colour status and blocks continuation when closed", () => {
    const html = render({
      kind: "Established",
      context: { ...context, operatingState: "Closed", availableServiceModes: [] },
    });
    expect(html).toContain("Not accepting orders");
    expect(html).toContain("This location is not accepting orders");
    expect(html).not.toContain("Continue to menu");
  });

  it.each([
    ["Missing", "Scan the location QR code", "No store search is shown"],
    ["RequestInvalid", "This entry link can’t be used", "ask a staff member"],
    ["EntryUnavailable", "This entry link can’t be used", "ask a staff member"],
    ["ServiceUnavailable", "Ordering is unavailable", "No order was submitted"],
    ["CommandFailed", "Ordering is unavailable", "No order was submitted"],
    ["Offline", "You’re offline", "No request or order was submitted"],
  ] as const)("renders the %s state with recovery", (kind, heading, recovery) => {
    const html = render({ kind } as CustomerEntryScreenState);
    expect(html).toContain(heading);
    expect(html).toContain(recovery);
  });

  it("keeps service failure bounded and explicitly retryable", () => {
    const html = render({ kind: "ServiceUnavailable" });
    expect(html).toContain("Try again");
    expect(html).toContain('role="alert"');
    expect(html).not.toContain("synthetic entry failure");
  });

  it("always supplies accessibility and allergen assistance", () => {
    const html = render({ kind: "Loading" });
    expect(html).toContain("accessible ordering option");
    expect(html).toContain("allergies");
    expect(html).toContain('aria-live="polite"');
  });
});

it("shows a rate-limit wait without enabling retry or revealing context", () => {
  const html = render({ kind: "RateLimited", retryAfterSeconds: 5 });
  expect(html).toContain("Please wait before trying again");
  expect(html).toContain("Try again in 5 seconds.");
  expect(html).toContain('disabled=""');
  expect(html).toContain('aria-live="off"');
  expect(html).not.toContain("Continue to menu");
  expect(html).not.toContain(context.csrfToken);
});

describe("WP-2423 Q4 not accepting orders", () => {
  it("names the store, says why and gives today's hours instead of a dead link", () => {
    const closed = render({
      kind: "NotAccepting",
      storeDisplayName: "Synthetic Store",
      paused: false,
      todayHours: [{ start: "11:00:00", end: "21:30:00", endsNextDay: false }],
    });
    expect(closed).toContain("Synthetic Store isn’t taking orders right now");
    expect(closed).toContain("The store is closed now.");
    expect(closed).toContain("Today’s hours: 11:00 AM–9:30 PM");
    expect(closed).not.toContain("can’t be used");
    const paused = render({
      kind: "NotAccepting",
      storeDisplayName: "Synthetic Store",
      paused: true,
      todayHours: [],
    });
    expect(paused).toContain("Online ordering is paused for a short while.");
    expect(paused).toContain("Closed today.");
  });
});
